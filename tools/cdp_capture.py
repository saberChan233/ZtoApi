#!/usr/bin/env python3
import json
import sys
import time
import urllib.request
from pathlib import Path

from websocket import create_connection
from websocket._exceptions import WebSocketTimeoutException


TARGET_PREFIXES = (
    "https://chat.z.ai/api/v1/files/",
    "https://chat.z.ai/api/v1/chats/new",
    "https://chat.z.ai/api/v2/chat/completions",
    "https://no8xfe.captcha-open-southeast.aliyuncs.com/",
    "https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com/",
)


class CDP:
    def __init__(self, ws_url: str):
        self.ws = create_connection(ws_url, timeout=60)
        self.next_id = 0
        self.bodies = {}
        self.requests = {}

    def call(self, method: str, params=None):
        self.next_id += 1
        msg_id = self.next_id
        self.ws.send(json.dumps({
            "id": msg_id,
            "method": method,
            "params": params or {},
        }))
        deadline = time.time() + 60
        while True:
            if time.time() > deadline:
                raise TimeoutError(f"CDP call timeout: {method}")
            try:
                raw = self.ws.recv()
            except WebSocketTimeoutException:
                continue
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"{method} failed: {msg['error']}")
                return msg.get("result", {})
            self._handle_event(msg)

    def _handle_event(self, msg):
        method = msg.get("method")
        params = msg.get("params", {})
        if method == "Network.requestWillBeSent":
            req = params.get("request", {})
            url = req.get("url", "")
            if any(url.startswith(prefix) for prefix in TARGET_PREFIXES):
                self.requests[params["requestId"]] = {
                    "ts": time.time(),
                    "type": "request",
                    "url": url,
                    "method": req.get("method"),
                    "headers": req.get("headers", {}),
                    "postData": req.get("postData"),
                    "initiator": params.get("initiator"),
                }
                print(json.dumps(self.requests[params["requestId"]], ensure_ascii=False), flush=True)
        elif method == "Network.requestWillBeSentExtraInfo":
            rid = params.get("requestId")
            cached = self.requests.get(rid)
            if cached:
                row = {
                    "ts": time.time(),
                    "type": "request_extra",
                    "url": cached["url"],
                    "headers": params.get("headers", {}),
                    "associatedCookies": params.get("associatedCookies", []),
                    "connectTiming": params.get("connectTiming"),
                    "siteHasCookieInOtherPartition": params.get("siteHasCookieInOtherPartition"),
                }
                cached["extraHeaders"] = row["headers"]
                cached["associatedCookies"] = row["associatedCookies"]
                print(json.dumps(row, ensure_ascii=False), flush=True)
        elif method == "Network.responseReceived":
            rid = params.get("requestId")
            cached = self.requests.get(rid)
            if cached:
                resp = params.get("response", {})
                row = {
                    "ts": time.time(),
                    "type": "response",
                    "url": cached["url"],
                    "status": resp.get("status"),
                    "statusText": resp.get("statusText"),
                    "headers": resp.get("headers", {}),
                    "mimeType": resp.get("mimeType"),
                }
                print(json.dumps(row, ensure_ascii=False), flush=True)
                try:
                    body = self.call("Network.getResponseBody", {"requestId": rid})
                    body_text = body.get("body", "")
                    self.bodies[rid] = body_text
                    print(json.dumps({
                        "ts": time.time(),
                        "type": "response_body",
                        "url": cached["url"],
                        "body": body_text[:12000],
                    }, ensure_ascii=False), flush=True)
                except Exception as e:
                    print(json.dumps({
                        "ts": time.time(),
                        "type": "response_body_error",
                        "url": cached["url"],
                        "error": str(e),
                    }, ensure_ascii=False), flush=True)
        elif method == "Network.responseReceivedExtraInfo":
            rid = params.get("requestId")
            cached = self.requests.get(rid)
            if cached:
                row = {
                    "ts": time.time(),
                    "type": "response_extra",
                    "url": cached["url"],
                    "statusCode": params.get("statusCode"),
                    "headers": params.get("headers", {}),
                    "headersText": params.get("headersText"),
                }
                cached["responseExtraHeaders"] = row["headers"]
                print(json.dumps(row, ensure_ascii=False), flush=True)

    def drain(self):
        while True:
            try:
                raw = self.ws.recv()
            except WebSocketTimeoutException:
                print(json.dumps({
                    "ts": time.time(),
                    "type": "idle_timeout",
                }, ensure_ascii=False), flush=True)
                continue
            msg = json.loads(raw)
            self._handle_event(msg)


def get_chat_target_ws(debug_base: str) -> str:
    with urllib.request.urlopen(f"{debug_base}/json/list", timeout=10) as resp:
        tabs = json.load(resp)
    for tab in tabs:
        if tab.get("type") == "page" and tab.get("url", "").startswith("https://chat.z.ai/"):
            return tab["webSocketDebuggerUrl"]
    raise RuntimeError("chat.z.ai page target not found")


def main():
    debug_base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9224"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/ztoapi-cdp-capture.jsonl")
    eval_expr = sys.argv[3] if len(sys.argv) > 3 else ""
    eval_delay_ms = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    drain_seconds = int(sys.argv[5]) if len(sys.argv) > 5 else 45
    ws_url = get_chat_target_ws(debug_base)
    out.parent.mkdir(parents=True, exist_ok=True)

    orig_stdout = sys.stdout
    with out.open("a", encoding="utf-8") as fp:
        class Tee:
            def write(self, s):
                fp.write(s)
                fp.flush()
                orig_stdout.write(s)
                orig_stdout.flush()

            def flush(self):
                if not fp.closed:
                    fp.flush()
                orig_stdout.flush()

        sys.stdout = Tee()
        cdp = CDP(ws_url)
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        cdp.call("Network.enable", {
            "maxTotalBufferSize": 100000000,
            "maxResourceBufferSize": 10000000,
            "maxPostDataSize": 10000000,
        })
        state = cdp.call("Runtime.evaluate", {
            "expression": """(() => ({
              href: location.href,
              title: document.title,
              localStorageToken: localStorage.getItem('token'),
              sessionStorageKeys: Object.keys(sessionStorage),
              cookie: document.cookie,
              hasTextarea: !!document.querySelector('textarea'),
              text: (document.body?.innerText || '').slice(0, 500)
            }))()""",
            "returnByValue": True,
        })
        print(json.dumps({
            "ts": time.time(),
            "type": "page_state",
            "state": state.get("result", {}).get("value"),
        }, ensure_ascii=False), flush=True)

        if eval_expr:
            if eval_delay_ms > 0:
                time.sleep(eval_delay_ms / 1000)
            eval_result = cdp.call("Runtime.evaluate", {
                "expression": eval_expr,
                "awaitPromise": True,
                "returnByValue": True,
            })
            print(json.dumps({
                "ts": time.time(),
                "type": "eval_result",
                "result": eval_result.get("result", {}).get("value"),
            }, ensure_ascii=False), flush=True)

        deadline = time.time() + drain_seconds
        while time.time() < deadline:
            try:
                raw = cdp.ws.recv()
            except WebSocketTimeoutException:
                print(json.dumps({
                    "ts": time.time(),
                    "type": "idle_timeout",
                }, ensure_ascii=False), flush=True)
                continue
            msg = json.loads(raw)
            cdp._handle_event(msg)


if __name__ == "__main__":
    main()
