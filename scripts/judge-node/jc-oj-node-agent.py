#!/usr/bin/env python3
"""Minimal trusted gateway between Cloudflare Worker and a local Judge0 instance."""

import base64
import hmac
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"
STATE_DIR = "/var/lib/jc-oj-node"
PAIRING_FILE = "/etc/jc-oj-node/pairing.json"
CONFIG_FILE = os.path.join(STATE_DIR, "credentials.json")
JUDGE0_URL = "http://127.0.0.1:2358"
GATEWAY_HOST = "127.0.0.1"
GATEWAY_PORT = 2359
MAX_REQUEST_BYTES = 2 * 1024 * 1024
ALLOWED_LANGUAGE_IDS = {92, 103, 105}
TUNNEL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)

state_lock = threading.Lock()
state = {"busy": 0, "endpoint": "", "last_error": "", "stopping": False}
config = {}
slot_semaphore = None
self_test = {"checked_at": 0.0, "ok": False, "error": "尚未完成实际编译自检"}


def atomic_json_write(path, value, mode=0o600):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def api_post(api_url, payload, timeout=20):
    request = urllib.request.Request(
        api_url.rstrip("/"),
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(1024 * 1024).decode("utf-8"))


def load_or_pair():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        if value.get("format") != "jc-oj-judge-node-credentials-v1":
            raise RuntimeError("本地节点凭证格式不正确")
        return value
    with open(PAIRING_FILE, "r", encoding="utf-8") as handle:
        pairing = json.load(handle)
    if pairing.get("format") != "jc-oj-judge-node-pairing-v1":
        raise RuntimeError("配对文件格式不正确")
    if int(pairing.get("expiresAt") or 0) < int(time.time() * 1000):
        raise RuntimeError("一次性配对信息已经过期，请从管理端重新生成安装包")
    result = api_post(pairing["apiUrl"], {
        "type": "judge_node_pair",
        "pairingCode": pairing["pairingCode"],
        "platform": "Ubuntu 22.04 isolated VM",
        "agentVersion": VERSION,
    })
    credentials = {
        "format": "jc-oj-judge-node-credentials-v1",
        "apiUrl": result["apiUrl"],
        "nodeId": result["nodeId"],
        "nodeToken": result["nodeToken"],
        "gatewayToken": result["gatewayToken"],
        "maxSlots": max(1, min(16, int(pairing.get("maxSlots") or 2))),
    }
    atomic_json_write(CONFIG_FILE, credentials)
    try:
        os.remove(PAIRING_FILE)
    except FileNotFoundError:
        pass
    return credentials


def judge0_ready():
    try:
        with urllib.request.urlopen(f"{JUDGE0_URL}/system_info", timeout=4) as response:
            return response.status == 200
    except Exception:
        return False


def run_judge0_self_test(force=False):
    now = time.time()
    retry_interval = 3600 if self_test["ok"] else 30
    if not force and now - self_test["checked_at"] < retry_interval:
        return self_test["ok"]
    source = base64.b64encode(
        b'#include <stdio.h>\nint main(void){puts("JCOJ_OK");return 0;}\n'
    ).decode("ascii")
    payload = {
        "source_code": source,
        "stdin": "",
        "language_id": 103,
        "cpu_time_limit": 2,
        "wall_time_limit": 6,
        "memory_limit": 131072,
        "max_processes_and_or_threads": 8,
        "max_file_size": 1024,
        "enable_network": False,
    }
    request = urllib.request.Request(
        f"{JUDGE0_URL}/submissions?base64_encoded=true&wait=true",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read(MAX_REQUEST_BYTES).decode("utf-8"))
        stdout = base64.b64decode(result.get("stdout") or "").decode("utf-8", "replace").strip()
        ok = result.get("status", {}).get("id") == 3 and stdout == "JCOJ_OK"
        self_test.update({
            "checked_at": now,
            "ok": ok,
            "error": "" if ok else "Judge0实际编译自检未通过",
        })
    except Exception as error:
        self_test.update({"checked_at": now, "ok": False, "error": f"Judge0自检失败：{error}"[:300]})
    return self_test["ok"]


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "JCOJNode/1"
    sys_version = ""

    def log_message(self, fmt, *args):
        # Never write submitted source code or request bodies to logs.
        print(f"gateway {self.client_address[0]} {fmt % args}", flush=True)

    def send_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ready": judge0_ready(), "version": VERSION})
        else:
            self.send_json(404, {"error": "Not Found"})

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/judge0/submissions":
            self.send_json(404, {"error": "Not Found"})
            return
        supplied_token = self.headers.get("X-JCOJ-Node-Token", "")
        if not hmac.compare_digest(supplied_token, str(config.get("gatewayToken", ""))):
            self.send_json(401, {"error": "Unauthorized"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length < 2 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "Request body too large"})
            return
        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except Exception:
            self.send_json(400, {"error": "Invalid JSON"})
            return
        language_id = body.get("language_id")
        if language_id not in ALLOWED_LANGUAGE_IDS:
            # Worker sees 404 as an unavailable local capability and safely uses its fallback.
            self.send_json(404, {"error": "Language is not enabled on this node"})
            return
        source = body.get("source_code")
        stdin = body.get("stdin", "")
        if not isinstance(source, str) or not isinstance(stdin, str) or len(source) > 1500000 or len(stdin) > 1500000:
            self.send_json(400, {"error": "Invalid submission payload"})
            return
        try:
            base64.b64decode(source, validate=True)
            base64.b64decode(stdin, validate=True)
        except Exception:
            self.send_json(400, {"error": "Submission must use valid Base64"})
            return
        if not slot_semaphore.acquire(blocking=False):
            self.send_json(429, {"error": "Node is busy"})
            return
        with state_lock:
            state["busy"] += 1
        try:
            safe_payload = {
                "source_code": source,
                "stdin": stdin,
                "language_id": language_id,
                "cpu_time_limit": 3,
                "wall_time_limit": 8,
                "memory_limit": 262144,
                "stack_limit": 131072,
                "max_processes_and_or_threads": 16,
                "max_file_size": 4096,
                "enable_network": False,
            }
            request = urllib.request.Request(
                f"{JUDGE0_URL}/submissions?base64_encoded=true&wait=true",
                data=json.dumps(safe_payload, separators=(",", ":")).encode("utf-8"),
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    response_data = response.read(MAX_REQUEST_BYTES)
                    self.send_response(response.status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(response_data)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(response_data)
            except urllib.error.HTTPError as error:
                response_data = error.read(MAX_REQUEST_BYTES)
                self.send_response(error.code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(response_data)))
                self.end_headers()
                self.wfile.write(response_data)
            except Exception:
                self.send_json(502, {"error": "Local Judge0 unavailable"})
        finally:
            with state_lock:
                state["busy"] = max(0, state["busy"] - 1)
            slot_semaphore.release()


def tunnel_reader(process):
    for line in iter(process.stderr.readline, ""):
        match = TUNNEL_PATTERN.search(line)
        if match:
            with state_lock:
                state["endpoint"] = match.group(0).lower()
                state["last_error"] = ""


def start_tunnel():
    process = subprocess.Popen(
        ["/usr/local/bin/cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2",
         "--url", f"http://{GATEWAY_HOST}:{GATEWAY_PORT}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1,
    )
    threading.Thread(target=tunnel_reader, args=(process,), daemon=True).start()
    return process


def heartbeat(status_override=None):
    with state_lock:
        endpoint = state["endpoint"]
        busy = state["busy"]
        last_error = state["last_error"]
    ready = judge0_ready() and run_judge0_self_test() and bool(endpoint)
    if not ready and not last_error:
        last_error = self_test["error"]
    status = status_override or ("ready" if ready else "installing")
    return api_post(config["apiUrl"], {
        "type": "judge_node_heartbeat",
        "nodeId": config["nodeId"],
        "nodeToken": config["nodeToken"],
        "platform": "Ubuntu 22.04 isolated VM",
        "agentVersion": VERSION,
        "judgeVersion": "1.13.1",
        "endpointUrl": endpoint,
        "maxSlots": config["maxSlots"],
        "busySlots": busy,
        "status": status,
        "lastError": last_error,
    })


def stop_handler(_signum, _frame):
    with state_lock:
        state["stopping"] = True


def main():
    global config, slot_semaphore
    config = load_or_pair()
    slot_semaphore = threading.BoundedSemaphore(config["maxSlots"])
    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    gateway = ThreadingHTTPServer((GATEWAY_HOST, GATEWAY_PORT), GatewayHandler)
    gateway.daemon_threads = True
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    tunnel = start_tunnel()
    next_heartbeat = 0
    try:
        while True:
            with state_lock:
                if state["stopping"]:
                    break
            if tunnel.poll() is not None:
                with state_lock:
                    state["endpoint"] = ""
                    state["last_error"] = "安全隧道已断开，正在自动重连"
                time.sleep(5)
                tunnel = start_tunnel()
            if time.time() >= next_heartbeat:
                try:
                    heartbeat()
                    next_heartbeat = time.time() + (300 if self_test["ok"] else 30)
                except urllib.error.HTTPError as error:
                    if error.code == 401:
                        # Revoked nodes stop exposing their gateway and do not repeatedly consume API resources.
                        break
                    next_heartbeat = time.time() + 60
                except Exception as error:
                    with state_lock:
                        state["last_error"] = str(error)[:300]
                    next_heartbeat = time.time() + 60
            time.sleep(2)
    finally:
        gateway.shutdown()
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()


if __name__ == "__main__":
    main()
