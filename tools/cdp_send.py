#!/usr/bin/env python3
import json
import sys
import urllib.request

from websocket import create_connection


def get_ws(debug_base: str) -> str:
    with urllib.request.urlopen(f"{debug_base}/json/list", timeout=10) as resp:
        tabs = json.load(resp)
    for tab in tabs:
        if tab.get("type") == "page" and tab.get("url", "").startswith("https://chat.z.ai/"):
            return tab["webSocketDebuggerUrl"]
    raise RuntimeError("chat.z.ai page target not found")


def main():
    debug_base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9224"
    message = sys.argv[2] if len(sys.argv) > 2 else "debug ping"
    ws = create_connection(get_ws(debug_base), timeout=30)
    try:
        for i, method in enumerate(("Page.enable", "Runtime.enable"), start=1):
            ws.send(json.dumps({"id": i, "method": method, "params": {}}))
            ws.recv()
        expr = r"""
(() => {
  const resolveSendButton = () => {
    return document.querySelector('#send-message-button')
      || document.querySelector('#chat-captcha-trigger')
      || Array.from(document.querySelectorAll('button')).find((btn) => {
        const aria = btn.getAttribute('aria-label') || '';
        const id = btn.id || '';
        const cls = String(btn.className || '');
        return aria.includes('Send')
          || aria.includes('发送')
          || id.includes('send')
          || id.includes('captcha-trigger')
          || cls.includes('sendMessageButton');
      })
      || null;
  };
  const textarea = document.querySelector('#chat-input');
  const button = resolveSendButton();
  if (!textarea) throw new Error('chat input not found');
  if (!button) throw new Error('send button not found');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter ? setter.call(textarea, %s) : (textarea.value = %s);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: %s }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();
  return new Promise((resolve, reject) => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const btn = resolveSendButton();
      if (btn && !btn.disabled) {
        clearInterval(timer);
        btn.click();
        resolve({ ok: true, tries, href: location.href, buttonId: btn.id || null, buttonAria: btn.getAttribute('aria-label') || null });
        return;
      }
      if (tries >= 50) {
        clearInterval(timer);
        reject(new Error('send button did not become enabled'));
      }
    }, 100);
  });
})()
""" % (json.dumps(message), json.dumps(message), json.dumps(message))
        ws.send(json.dumps({
            "id": 99,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expr,
                "awaitPromise": True,
                "returnByValue": True,
            },
        }))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 99:
                print(json.dumps(msg, ensure_ascii=False))
                return
    finally:
        ws.close()


if __name__ == "__main__":
    main()
