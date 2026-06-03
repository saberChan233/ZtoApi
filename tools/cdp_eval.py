#!/usr/bin/env python3
import json
import sys
import time
import urllib.request

from websocket import create_connection
from websocket._exceptions import WebSocketTimeoutException


def get_ws(debug_base: str) -> str:
    with urllib.request.urlopen(f"{debug_base}/json/list", timeout=10) as resp:
        tabs = json.load(resp)
    for tab in tabs:
        if tab.get("type") == "page" and tab.get("url", "").startswith("https://chat.z.ai/"):
            return tab["webSocketDebuggerUrl"]
    raise RuntimeError("chat.z.ai page target not found")


def main():
    debug_base = sys.argv[1]
    expr = sys.argv[2]
    ws = create_connection(get_ws(debug_base), timeout=30)
    try:
        for i, method in enumerate(("Page.enable", "Runtime.enable"), start=1):
            ws.send(json.dumps({"id": i, "method": method, "params": {}}))
            deadline = time.time() + 30
            while True:
                if time.time() > deadline:
                    raise TimeoutError(f"CDP init timeout: {method}")
                try:
                    raw = ws.recv()
                except WebSocketTimeoutException:
                    continue
                msg = json.loads(raw)
                if msg.get("id") == i:
                    break
        ws.send(json.dumps({
            "id": 99,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expr,
                "awaitPromise": True,
                "returnByValue": True,
            },
        }))
        deadline = time.time() + 60
        while True:
            if time.time() > deadline:
                raise TimeoutError("CDP Runtime.evaluate timeout")
            try:
                raw = ws.recv()
            except WebSocketTimeoutException:
                continue
            msg = json.loads(raw)
            if msg.get("id") == 99:
                print(json.dumps(msg, ensure_ascii=False))
                return
    finally:
        ws.close()


if __name__ == "__main__":
    main()
