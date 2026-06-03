#!/usr/bin/env python3
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from websocket import create_connection


CAPTCHA_PREFIX = "https://no8xfe.captcha-open-southeast.aliyuncs.com/"
CHAT_PREFIX = "https://chat.z.ai/api/v2/chat/completions"
TARGET_PREFIXES = (
    CAPTCHA_PREFIX,
    CHAT_PREFIX,
    "https://chat.z.ai/api/v1/chats/new",
)


class CDP:
    def __init__(self, ws_url: str):
        self.ws = create_connection(ws_url, timeout=60, suppress_origin=True)
        self.next_id = 0
        self.pending_events = []

    def call(self, method: str, params=None, timeout: float = 20):
        self.next_id += 1
        msg_id = self.next_id
        self.ws.send(json.dumps({
            "id": msg_id,
            "method": method,
            "params": params or {},
        }))
        deadline = time.time() + timeout
        while True:
            if time.time() > deadline:
                raise TimeoutError(f"CDP call timeout: {method}")
            raw = self.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"{method} failed: {msg['error']}")
                return msg.get("result", {})
            self.pending_events.append(msg)

    def recv_event(self, timeout: float = 1.0):
        if self.pending_events:
            return self.pending_events.pop(0)
        self.ws.settimeout(timeout)
        try:
            raw = self.ws.recv()
            return json.loads(raw)
        finally:
            self.ws.settimeout(60)


def get_chat_target_ws(debug_base: str) -> str:
    with urllib.request.urlopen(f"{debug_base}/json/list", timeout=10) as resp:
        tabs = json.load(resp)
    for tab in tabs:
        if tab.get("type") == "page":
            return tab["webSocketDebuggerUrl"]
    raise RuntimeError("no page target found")


def parse_form(post_data: str | None):
    if not post_data:
        return None
    parsed = urllib.parse.parse_qs(post_data, keep_blank_values=True)
    out = {}
    for key, values in parsed.items():
        out[key] = values[-1] if values else ""
    return out


def summarize_page_state(cdp: CDP):
    result = cdp.call("Runtime.evaluate", {
        "expression": """(() => ({
          href: location.href,
          title: document.title,
          body: (document.body?.innerText || '').slice(0, 800),
          cookie: document.cookie.slice(0, 240),
          token: localStorage.getItem('token'),
          hasTextarea: !!document.querySelector('textarea'),
          hasSendButton: !!document.querySelector('#send-message-button'),
          textareaPlaceholder: document.querySelector('textarea')?.getAttribute('placeholder') || null
        }))()""",
        "returnByValue": True,
    }, timeout=20)
    return result.get("result", {}).get("value")


def wait_for_ui_ready(cdp: CDP, timeout: float = 20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = summarize_page_state(cdp)
        if state and state.get("hasTextarea") and state.get("hasSendButton"):
            return state
        time.sleep(0.5)
    raise TimeoutError("chat input UI not ready")


def send_message(cdp: CDP, prompt: str):
    prep_expr = """
    (() => {{
      const textarea = document.querySelector('textarea');
      const sendButton = document.querySelector('#send-message-button');
      if (!textarea || !sendButton) {{
        return {{ ok: false, reason: 'missing-ui', hasTextarea: !!textarea, hasSendButton: !!sendButton }};
      }}
      textarea.focus();
      return {{
        ok: true,
        beforeValue: textarea.value,
        sendDisabled: !!sendButton.disabled
      }};
    }})()
    """
    result = cdp.call("Runtime.evaluate", {
        "expression": prep_expr,
        "returnByValue": True,
        "userGesture": True,
    }, timeout=20)
    prep_value = result.get("result", {}).get("value")
    if not prep_value or not prep_value.get("ok"):
        return prep_value
    cdp.call("Input.insertText", {"text": prompt}, timeout=10)
    click_result = cdp.call("Runtime.evaluate", {
        "expression": """(() => {
          const textarea = document.querySelector('textarea');
          const sendButton = document.querySelector('#send-message-button');
          if (!textarea || !sendButton) return { ok: false, reason: 'missing-after-type' };
          sendButton.click();
          return {
            ok: true,
            value: textarea.value,
            sendDisabled: !!sendButton.disabled
          };
        })()""",
        "returnByValue": True,
        "userGesture": True,
    }, timeout=20)
    return {
        "prepare": prep_value,
        "after_click": click_result.get("result", {}).get("value"),
    }


def decode_body(body_obj):
    body = body_obj.get("body", "")
    if body_obj.get("base64Encoded"):
        try:
            import base64
            return base64.b64decode(body).decode("utf-8", errors="replace")
        except Exception:
            return body
    return body


def main():
    debug_base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9224"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/browser_verify_capture_live.json")
    prompt = sys.argv[3] if len(sys.argv) > 3 else f"test captcha capture {int(time.time())}"

    cdp = CDP(get_chat_target_ws(debug_base))
    cdp.call("Page.enable")
    cdp.call("Runtime.enable")
    cdp.call("Network.enable", {
        "maxTotalBufferSize": 100000000,
        "maxResourceBufferSize": 10000000,
        "maxPostDataSize": 10000000,
    })
    cdp.call("Page.navigate", {"url": "https://chat.z.ai/"}, timeout=30)
    time.sleep(8)
    initial_state = wait_for_ui_ready(cdp, timeout=20)
    submit_result = send_message(cdp, prompt)

    capture = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "prompt": prompt,
        "page_state_before_send": initial_state,
        "submit_result": submit_result,
        "init_form": None,
        "init_headers": None,
        "upload_form": None,
        "upload_headers": None,
        "verify_form": None,
        "verify_headers": None,
        "verify_response": None,
        "chat_request_headers": None,
        "chat_request_body": None,
        "chat_response_status": None,
        "chat_response_preview": None,
        "events": [],
    }

    request_map = {}
    deadline = time.time() + 25
    verify_seen = False
    while time.time() < deadline:
        try:
            msg = cdp.recv_event(timeout=1)
        except Exception:
            continue
        method = msg.get("method")
        params = msg.get("params", {})
        if method == "Network.requestWillBeSent":
            req = params.get("request", {})
            url = req.get("url", "")
            if not any(url.startswith(prefix) for prefix in TARGET_PREFIXES):
                continue
            req_id = params.get("requestId")
            request_map[req_id] = req
            row = {
                "type": "request",
                "url": url,
                "method": req.get("method"),
            }
            capture["events"].append(row)
            form = parse_form(req.get("postData"))
            if url.startswith(CAPTCHA_PREFIX) and form:
                action = form.get("Action")
                if action == "InitCaptchaV3" and capture["init_form"] is None:
                    capture["init_form"] = form
                    capture["init_headers"] = req.get("headers", {})
                elif action == "UploadLog" and capture["upload_form"] is None:
                    capture["upload_form"] = form
                    capture["upload_headers"] = req.get("headers", {})
                elif action == "VerifyCaptchaV3" and capture["verify_form"] is None:
                    capture["verify_form"] = form
                    capture["verify_headers"] = req.get("headers", {})
            elif url.startswith(CHAT_PREFIX):
                capture["chat_request_headers"] = req.get("headers", {})
                capture["chat_request_body"] = req.get("postData")
        elif method == "Network.responseReceived":
            req_id = params.get("requestId")
            resp = params.get("response", {})
            req = request_map.get(req_id, {})
            url = req.get("url", resp.get("url", ""))
            if not any(url.startswith(prefix) for prefix in TARGET_PREFIXES):
                continue
            if url.startswith(CAPTCHA_PREFIX):
                try:
                    body_obj = cdp.call("Network.getResponseBody", {"requestId": req_id}, timeout=10)
                    body_text = decode_body(body_obj)
                    parsed = json.loads(body_text)
                except Exception as exc:
                    body_text = None
                    parsed = {"body_error": str(exc)}
                action = parse_form(req.get("postData") or "") or {}
                if action.get("Action") == "VerifyCaptchaV3":
                    capture["verify_response"] = {
                        "status": resp.get("status"),
                        "body": parsed,
                    }
                    verify_seen = True
            elif url.startswith(CHAT_PREFIX):
                capture["chat_response_status"] = resp.get("status")
                try:
                    body_obj = cdp.call("Network.getResponseBody", {"requestId": req_id}, timeout=10)
                    body_text = decode_body(body_obj)
                except Exception as exc:
                    body_text = f"[body_error] {exc}"
                capture["chat_response_preview"] = body_text[:2000] if body_text else None
        if verify_seen and capture.get("chat_request_body") is not None:
            break

    capture["page_state_after_send"] = summarize_page_state(cdp)
    out.write_text(json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "saved": str(out),
        "has_init_form": capture["init_form"] is not None,
        "has_upload_form": capture["upload_form"] is not None,
        "has_verify_form": capture["verify_form"] is not None,
        "verify_code": ((capture.get("verify_response") or {}).get("body") or {}).get("Result", {}).get("VerifyCode"),
        "chat_status": capture["chat_response_status"],
        "page_title": capture["page_state_after_send"]["title"] if capture.get("page_state_after_send") else None,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
