#!/usr/bin/env python3
import argparse
import base64
import json
import re
import sys
import urllib.request
from pathlib import Path

from websocket import create_connection


DEFAULT_LOADER_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
DEFAULT_DYNAMIC_URL = "https://g.alicdn.com/captcha-frontend/dynamicJS/3.25.0/pe.092.5b9f44e900a2b7c5.js"
DEFAULT_FEILIN_URL = "https://g.alicdn.com/captcha-frontend/FeiLin/1.4.2/feilin050.613d0930758597fa3bd6259470267d0c251b971ced77e86280217002235f682f.js"


def fetch(url: str, path: Path) -> str:
    if path.exists():
      return path.read_text("utf-8", errors="ignore")
    with urllib.request.urlopen(url, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="ignore")
    path.write_text(text, encoding="utf-8")
    return text


def summarize_refs(text: str) -> dict:
    patterns = {
        "navigator": r"navigator\.[A-Za-z_]+",
        "screen": r"screen\.[A-Za-z_]+",
        "document": r"document\.[A-Za-z_]+",
        "window": r"window\.[A-Za-z_]+",
        "storage": r"(?:localStorage|sessionStorage|indexedDB)",
        "media": r"(?:matchMedia|getComputedStyle|AudioContext|RTCPeerConnection|WebGLRenderingContext|OffscreenCanvas)",
    }
    out = {}
    for key, pat in patterns.items():
        out[key] = sorted(set(re.findall(pat, text)))
    return out


def find_snippets(text: str, keywords: list[str], radius: int = 220) -> dict[str, str]:
    out = {}
    for key in keywords:
        idx = text.find(key)
        if idx >= 0:
            out[key] = text[max(0, idx - radius): idx + radius]
    return out


def decode_device_token(token: str) -> dict:
    raw = base64.b64decode(token).decode("utf-8", errors="replace")
    parts = raw.split("#")
    return {
        "raw_preview": raw[:800],
        "parts": parts,
        "part_count": len(parts),
        "parsed": {
            "prefix": parts[0] if len(parts) > 0 else None,
            "session_blob": parts[1] if len(parts) > 1 else None,
            "opaque_blob_len": len(parts[2]) if len(parts) > 2 else None,
            "numeric_flag": parts[3] if len(parts) > 3 else None,
            "hash_tail": parts[4] if len(parts) > 4 else None,
        },
    }


def get_ws(debug_base: str) -> str:
    with urllib.request.urlopen(f"{debug_base}/json/list", timeout=10) as resp:
        tabs = json.load(resp)
    for tab in tabs:
        if tab.get("type") == "page" and tab.get("url", "").startswith("https://chat.z.ai/"):
            return tab["webSocketDebuggerUrl"]
    raise RuntimeError("chat.z.ai page target not found")


def cdp_eval(debug_base: str, expression: str):
    ws = create_connection(get_ws(debug_base), timeout=30)
    try:
        for i, method in enumerate(("Page.enable", "Runtime.enable"), start=1):
            ws.send(json.dumps({"id": i, "method": method, "params": {}}))
            ws.recv()
        ws.send(json.dumps({
            "id": 99,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
            },
        }))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 99:
                if "exceptionDetails" in msg:
                    raise RuntimeError(msg["exceptionDetails"]["text"])
                return msg["result"]["result"]["value"]
    finally:
        ws.close()


def collect_live_runtime(debug_base: str) -> dict:
    return cdp_eval(debug_base, """(() => {
      const token = window.um && typeof window.um.getToken === 'function' ? window.um.getToken() : null;
      const zToken = window.z_um && typeof window.z_um.getToken === 'function' ? window.z_um.getToken() : null;
      return {
        token,
        zToken,
        ua: navigator.userAgent,
        webdriver: navigator.webdriver,
        lang: navigator.language,
        screen: [screen.width, screen.height],
        viewport: [innerWidth, innerHeight],
        hasCanvas2d: !!document.createElement('canvas').getContext('2d'),
        hasWebgl: (() => { try { const c=document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch(e){ return false; } })(),
        hasAudio: typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined',
        scripts: [...document.scripts].map(s => s.src).filter(Boolean).filter(s => /captcha|alicdn|aliyun|um/i.test(s)).slice(0, 50),
      };
    })()""")


def main():
    parser = argparse.ArgumentParser(description="Analyze Aliyun captcha runtime dependencies toward a browserless path.")
    parser.add_argument("--loader-cache", default="/tmp/AliyunCaptcha.js")
    parser.add_argument("--dynamic-cache", default="/tmp/aliyun-pe.js")
    parser.add_argument("--feilin-cache", default="/tmp/feilin.js")
    parser.add_argument("--loader-url", default=DEFAULT_LOADER_URL)
    parser.add_argument("--dynamic-url", default=DEFAULT_DYNAMIC_URL)
    parser.add_argument("--feilin-url", default=DEFAULT_FEILIN_URL)
    parser.add_argument("--device-token")
    parser.add_argument("--debug-base")
    args = parser.parse_args()

    loader_text = fetch(args.loader_url, Path(args.loader_cache))
    dynamic_text = fetch(args.dynamic_url, Path(args.dynamic_cache))
    feilin_text = fetch(args.feilin_url, Path(args.feilin_cache))

    loader_refs = summarize_refs(loader_text)
    dynamic_refs = summarize_refs(dynamic_text)
    feilin_refs = summarize_refs(feilin_text)
    loader_snippets = find_snippets(loader_text, [
        "getDeviceToken", "window.um", "window.z_um", "CAPTCHA_LANG", "UP_LANG"
    ])
    dynamic_snippets = find_snippets(dynamic_text, [
        "navigator.platform", "navigator.userAgent", "screen", "MediaSource", "window.location"
    ])
    feilin_snippets = find_snippets(feilin_text, [
        "MediaSource", "webkitRequestFullscreen", "navigator.vendor", "navigator.serviceWorker",
        "window.indexedDB", "document.cookie", "window.location", "localStorage"
    ])

    report = {
        "loader_url": args.loader_url,
        "dynamic_url": args.dynamic_url,
        "feilin_url": args.feilin_url,
        "loader_size": len(loader_text),
        "dynamic_size": len(dynamic_text),
        "feilin_size": len(feilin_text),
        "loader_refs": loader_refs,
        "dynamic_refs": dynamic_refs,
        "feilin_refs": feilin_refs,
        "loader_snippets": loader_snippets,
        "dynamic_snippets": dynamic_snippets,
        "feilin_snippets": feilin_snippets,
    }

    runtime = None
    if args.debug_base:
        runtime = collect_live_runtime(args.debug_base)
        report["live_runtime"] = runtime

    device_token = args.device_token or (runtime or {}).get("token")
    if device_token:
        report["device_token_analysis"] = decode_device_token(device_token)

    report["conclusion"] = {
        "device_token_source_hint": "Aliyun loader exports getDeviceToken and directly reads window.z_um || window.um .getToken().",
        "feilin_runtime_hint": "FeiLin script contains browser/incognito/environment probes (MediaSource, webkitRequestFullscreen, indexedDB, serviceWorker, cookie/domain/location) and is the strongest candidate for populating window.um/z_um.",
        "browserless_focus": [
            "reproduce or replace window.um.getToken()",
            "identify minimal browser APIs required by Aliyun loader/dynamic bundle",
            "validate whether canvas/webgl/audio presence is materially required or only opportunistic",
            "test whether FeiLin can run inside a shimmed JS runtime with indexedDB/cookie/location/navigator stubs",
        ],
    }

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
