#!/usr/bin/env python3
import base64
import json
import sys
import urllib.request
from pathlib import Path

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

def check_captcha_validity(param: str):
    """解码并检测凭证中是否包含阿里的垃圾拦截标记"""
    try:
        decoded = base64.b64decode(param).decode("utf-8", errors="ignore")
        if "probe-security-token" in decoded or "probe-certify-id" in decoded:
            return False, "检测到凭证内部包含 'probe-security-token'，这说明此凭证已在产生时被阿里安全网关标记为拦截拦截，属于无效凭证！"
        return True, "该凭证结构合法，不含阿里拦截标记，属于高纯度、可用的真实凭证！"
    except Exception as e:
        return False, f"凭证 Base64 解码失败: {e}"

def inject(captcha_param: str):
    config = load_env_config()
    print("=" * 60)
    print("           ZtoApi 手动人机验证凭证注入工具")
    print("=" * 60)
    
    captcha_param = captcha_param.strip()
    if not captcha_param:
        print("\033[91m错误: 凭证参数不能为空！\033[0m")
        return
        
    is_valid, msg = check_captcha_validity(captcha_param)
    print(f"[验证] 凭证自检结果: {msg}")
    
    if not is_valid:
        print("\033[93m[警告] 正在注入一个可能无效的凭证，若后续对话依旧 405，请从真实正常运行的浏览器重新提取！\033[0m")
        
    url = f"http://127.0.0.1:{config['port']}/internal/session-state"
    payload = {
        "captcha_verify_param": captcha_param,
        "source": "manual-inject-tool"
    }

    headers = {
        "Authorization": f"Bearer {config['api_key']}",
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
                print(f"\033[92m[注入成功] 已成功将新鲜人机验证参数注入到 Deno 状态机中！\033[0m")
                print(f"[状态] Deno 网关端口: {config['port']}")
                print(f"[状态] Token 同步状态: {'已绑定' if result['state'].get('has_token') else '未绑定'}")
                print(f"[状态] 人机同步状态: {'已就绪' if result['state'].get('has_captcha') else '未就绪'}")
            else:
                print(f"\033[91m[注入失败] Deno 服务端返回错误: {result}\033[0m")
    except Exception as e:
        print(f"\033[91m[注入失败] 无法连接到 Deno 服务端 (127.0.0.1:{config['port']}): {e}\033[0m")

def main():
    if len(sys.argv) > 1:
        inject(sys.argv[1])
    else:
        print("提示: 您可以直接通过命令行参数传入凭证，例如: python3 inject_captcha.py <ey...>")
        try:
            val = input("请输入您在浏览器中抓取到的真实 aliyun_captcha_verify_param Base64 字符串:\n> ")
            inject(val)
        except KeyboardInterrupt:
            print("\n已取消。")

if __name__ == "__main__":
    main()
