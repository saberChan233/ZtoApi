#!/usr/bin/env python3
import json
import sys

from curl_cffi import requests


def main() -> int:
    payload = json.load(sys.stdin)
    proxy_url = payload.get("proxy_url") or None
    auth_url = payload["auth_url"]
    target_url = payload["target_url"]
    auth_headers = payload.get("auth_headers") or {}
    final_headers = payload.get("final_headers") or {}
    body = payload.get("body") or ""
    impersonate = payload.get("impersonate") or "chrome136"

    proxies = None
    if proxy_url:
      proxies = {"http": proxy_url, "https": proxy_url}

    session = requests.Session()
    try:
        session.get(
            auth_url,
            headers=auth_headers,
            proxies=proxies,
            impersonate=impersonate,
            timeout=30,
            allow_redirects=True,
        )

        response = session.post(
            target_url,
            headers=final_headers,
            data=body.encode("utf-8"),
            proxies=proxies,
            impersonate=impersonate,
            timeout=60,
            allow_redirects=True,
        )

        print(json.dumps({
            "status": response.status_code,
            "reason": response.reason,
            "headers": dict(response.headers),
            "body": response.text,
        }, ensure_ascii=False))
        return 0
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
