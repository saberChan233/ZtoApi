#!/usr/bin/env python3
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import base64
from pathlib import Path

try:
    from websocket import create_connection
except ImportError:
    print("错误: 缺少 websocket-client 库，请先运行: pip install websocket-client")
    sys.exit(1)


TARGET_PREFIXES = (
    "https://chat.z.ai/api/v1/chats/new",
    "https://chat.z.ai/api/v2/chat/completions",
)

def load_env_config():
    """从本地 .env 中读取 API Key 和 端口配置"""
    config = {
        "api_key": "sk-local-test",
        "port": "9191"
    }
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        with env_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip()
                    if k == "DEFAULT_KEY":
                        config["api_key"] = v
                    elif k == "PORT":
                        config["port"] = v
    return config

class CDPSyncBridge:
    def __init__(self, ws_url: str, api_key: str, port: str):
        self.ws_url = ws_url
        self.api_key = api_key
        self.port = port
        self.ws = None
        self.next_id = 0
        self.requests = {}

    def connect(self):
        print(f"[连接] 正在建立到 Chrome CDP WebSocket 的连接: {self.ws_url}")
        self.ws = create_connection(self.ws_url, timeout=30)
        print("[连接] 连接成功！")

    def call(self, method: str, params=None):
        self.next_id += 1
        msg_id = self.next_id
        self.ws.send(json.dumps({
            "id": msg_id,
            "method": method,
            "params": params or {},
        }))
        while True:
            raw = self.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"{method} 失败: {msg['error']}")
                return msg.get("result", {})
            self._handle_event(msg)

    def is_valid_captcha(self, param: str) -> bool:
        """验证验证码是否合法（不含 probe-security-token）"""
        try:
            decoded = base64.b64decode(param).decode("utf-8", errors="ignore")
            if "probe-security-token" in decoded or "probe-certify-id" in decoded:
                return False
            return True
        except Exception:
            return False

    def sync_to_deno(self, captcha_verify_param: str, token: str = None, source: str = "cdp-sync-bridge"):
        """将最新的合规凭证通过 POST 推送给本地 Deno 服务"""
        url = f"http://127.0.0.1:{self.port}/internal/session-state"
        payload = {
            "captcha_verify_param": captcha_verify_param,
            "source": source
        }
        if token:
            payload["token"] = token

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("ok"):
                    print(f"\033[92m[同步成功] 已成功向 Deno 推送新鲜合规人机验证参数！来源: {source}\033[0m")
                else:
                    print(f"\033[91m[同步失败] Deno 服务端返回错误: {result}\033[0m")
        except Exception as e:
            print(f"\033[91m[同步失败] 无法连接到 Deno 服务端 (127.0.0.1:{self.port}): {e}\033[0m")

    def _handle_event(self, msg):
        method = msg.get("method")
        params = msg.get("params", {})
        
        if method == "Network.requestWillBeSent":
            req = params.get("request", {})
            url = req.get("url", "")
            
            # 判断是否为目标聊天/新建请求
            if any(url.startswith(prefix) for prefix in TARGET_PREFIXES):
                post_data_str = req.get("postData")
                if post_data_str:
                    try:
                        post_data = json.loads(post_data_str)
                        captcha = post_data.get("captcha_verify_param")
                        if captcha:
                            print(f"[捕获] 从请求中检测到 captcha_verify_param: {captcha[:25]}...")
                            if self.is_valid_captcha(captcha):
                                # 尝试从 headers 中提取 Bearer Token
                                auth_header = req.get("headers", {}).get("Authorization", "")
                                token = None
                                if auth_header.startswith("Bearer "):
                                    token = auth_header[7:]
                                
                                # 同步到 Deno
                                self.sync_to_deno(captcha, token=token, source="cdp-network-capture")
                            else:
                                print("\033[93m[过滤] 该 captcha_verify_param 包含被阿里网关拦截的垃圾特征，已自动忽略\033[0m")
                    except Exception as e:
                        print(f"[错误] 解析请求体失败: {e}")

    def run_sync_loop(self):
        # 启用 CDP 相应域
        self.call("Page.enable")
        self.call("Runtime.enable")
        self.call("Network.enable", {
            "maxTotalBufferSize": 10000000,
            "maxResourceBufferSize": 1000000,
            "maxPostDataSize": 1000000,
        })
        
        print("\033[94m[运行中] 正在实时监控 Chrome 中的 chat.z.ai 请求流量...\033[0m")
        print("\033[94m[运行中] 您可以在真实的 Chrome 浏览器中随意发送一条测试消息以产生验证码。\033[0m")
        
        last_check_token_time = 0
        
        while True:
            try:
                # 检查网络事件
                raw = self.ws.recv()
                msg = json.loads(raw)
                self._handle_event(msg)
                
                # 每隔 15 秒主动拉取一次 localStorage 中的 token 和临时 captcha 并尝试同步
                now = time.time()
                if now - last_check_token_time > 15:
                    last_check_token_time = now
                    try:
                        res = self.call("Runtime.evaluate", {
                            "expression": """(() => ({
                              token: localStorage.getItem('token'),
                              captcha: localStorage.getItem('aliyun_captcha_verify_param') || window.aliyun_captcha_verify_param
                            }))()""",
                            "returnByValue": True,
                        })
                        val = res.get("result", {}).get("value", {})
                        token = val.get("token")
                        captcha = val.get("captcha")
                        
                        if captcha and self.is_valid_captcha(captcha):
                            print(f"[轮询] 从浏览器环境中主动读取到 captcha_verify_param")
                            self.sync_to_deno(captcha, token=token, source="cdp-browser-poll")
                        elif token:
                            # 即使没有 captcha，也可以单向同步 token
                            self.sync_to_deno(captcha_verify_param=None, token=token, source="cdp-token-only-poll")
                    except Exception as e:
                        # 轮询异常不中断网络监听
                        pass
                        
            except KeyboardInterrupt:
                print("\n[退出] 用户手动中止。")
                break
            except Exception as e:
                print(f"\033[91m[网络异常] 发生异常: {e}，将在 5 秒后尝试重连...\033[0m")
                time.sleep(5)
                try:
                    self.connect()
                    # 重新启用 CDP 域
                    self.call("Page.enable")
                    self.call("Runtime.enable")
                    self.call("Network.enable")
                except Exception as reconnect_error:
                    print(f"[连接失败] 重新连接失败: {reconnect_error}")

def get_chat_target_ws(debug_base: str) -> str:
    try:
        with urllib.request.urlopen(f"{debug_base}/json/list", timeout=5) as resp:
            tabs = json.load(resp)
        for tab in tabs:
            url = tab.get("url", "")
            if tab.get("type") == "page" and ("chat.z.ai" in url or url.startswith("https://chat.z.ai/")):
                return tab["webSocketDebuggerUrl"]
        raise RuntimeError("未在 Chrome 中找到打开了 chat.z.ai 的标签页，请确保浏览器已经加载该页面。")
    except Exception as e:
        raise RuntimeError(f"无法连接到 Chrome 调试端口 ({debug_base}): {e}\n请确保 Chrome 已经以 --remote-debugging-port=9224 端口启动。")

def main():
    print("=" * 60)
    print("           ZtoApi CDP 真实浏览器状态同步桥接工具")
    print("=" * 60)
    
    # 加载配置
    config = load_env_config()
    debug_base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9224"
    
    print(f"[配置] 目标 Deno 端口: {config['port']}")
    print(f"[配置] Deno API Key: {config['api_key']}")
    print(f"[配置] Chrome 调试地址: {debug_base}")
    
    try:
        ws_url = get_chat_target_ws(debug_base)
        bridge = CDPSyncBridge(ws_url, config["api_key"], config["port"])
        bridge.connect()
        bridge.run_sync_loop()
    except Exception as e:
        print(f"\033[91m[致命错误] {e}\033[0m")
        print("\n友情提示: 请关闭所有 Chrome 窗口，并在终端中运行以下命令以启用远程调试启动 Chrome:")
        print("google-chrome --remote-debugging-port=9224 --user-data-dir=/tmp/chrome-cdp-profile")
        sys.exit(1)

if __name__ == "__main__":
    main()
