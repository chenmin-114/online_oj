#!/usr/bin/env python3
"""Trusted pull worker between the JC OJ broker and a local Judge0 instance."""

import base64
import concurrent.futures
import json
import os
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import websocket
except ImportError:
    websocket = None

VERSION = "3.0.0"
STATE_DIR = "/var/lib/jc-oj-node"
PAIRING_FILE = "/etc/jc-oj-node/pairing.json"
CONFIG_FILE = os.path.join(STATE_DIR, "credentials.json")
JUDGE0_URL = "http://127.0.0.1:2358"
MAX_RESPONSE_BYTES = 1536 * 1024
ALLOWED_LANGUAGE_IDS = {92, 103, 105}

state_lock = threading.Lock()
socket_lock = threading.Lock()
state = {
    "busy": 0,
    "last_error": "",
    "stopping": False,
    "socket": None,
    "connection_id": "",
    "sequence": 0,
    "active_jobs": set(),
}
config = {}
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
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RuntimeError("server response is too large")
        return json.loads(raw.decode("utf-8"))


def load_or_pair():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        if value.get("format") not in {
            "jc-oj-judge-node-credentials-v1",
            "jc-oj-judge-node-credentials-v2",
        }:
            raise RuntimeError("本地节点凭证格式不正确")
        if not value.get("pullToken") and value.get("gatewayToken"):
            value["pullToken"] = value["gatewayToken"]
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
        "format": "jc-oj-judge-node-credentials-v2",
        "apiUrl": result["apiUrl"],
        "nodeId": result["nodeId"],
        "nodeToken": result["nodeToken"],
        "pullToken": result.get("pullToken") or result["gatewayToken"],
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


def execute_judge0(payload):
    if not isinstance(payload, dict) or payload.get("language_id") not in ALLOWED_LANGUAGE_IDS:
        return 404, {"error": "Language is not enabled on this node"}
    source = payload.get("source_code")
    stdin = payload.get("stdin", "")
    if not isinstance(source, str) or not isinstance(stdin, str) \
            or len(source) > 1500000 or len(stdin) > 1500000:
        return 400, {"error": "Invalid submission payload"}
    try:
        base64.b64decode(source, validate=True)
        base64.b64decode(stdin, validate=True)
    except Exception:
        return 400, {"error": "Submission must use valid Base64"}
    safe_payload = {
        "source_code": source,
        "stdin": stdin,
        "language_id": payload["language_id"],
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
        with urllib.request.urlopen(request, timeout=24) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                return 200, {
                    "stdout": None,
                    "stderr": base64.b64encode("程序输出过多，已被安全终止".encode()).decode(),
                    "exit_code": 153,
                    "status": {"id": 11, "description": "Runtime Error"},
                }
            return response.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read(MAX_RESPONSE_BYTES).decode("utf-8"))
        except Exception:
            return error.code, {"error": "Local Judge0 request failed"}
    except Exception as error:
        return 502, {"error": f"Local Judge0 unavailable: {error}"[:300]}


def run_judge0_self_test(force=False):
    now = time.time()
    retry_interval = 3600 if self_test["ok"] else 30
    if not force and now - self_test["checked_at"] < retry_interval:
        return self_test["ok"]
    source = base64.b64encode(
        b'#include <stdio.h>\nint main(void){puts("JCOJ_OK");return 0;}\n'
    ).decode("ascii")
    status, result = execute_judge0({"source_code": source, "stdin": "", "language_id": 103})
    try:
        stdout = base64.b64decode(result.get("stdout") or "").decode("utf-8", "replace").strip()
    except Exception:
        stdout = ""
    ok = status < 400 and result.get("status", {}).get("id") == 3 and stdout == "JCOJ_OK"
    self_test.update({
        "checked_at": now,
        "ok": ok,
        "error": "" if ok else "Judge0实际编译自检未通过",
    })
    return ok


def heartbeat(status_override=None):
    with state_lock:
        busy = state["busy"]
        last_error = state["last_error"]
    ready = judge0_ready() and run_judge0_self_test()
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
        "endpointUrl": "",
        "maxSlots": config["maxSlots"],
        "busySlots": busy,
        "status": status,
        "lastError": last_error,
    })


def complete_job(slot_id, job, status, result):
    deadline = int(job.get("leaseExpiresAt") or 0) / 1000
    payload = {
        "type": "judge_node_complete",
        "nodeId": config["nodeId"],
        "pullToken": config["pullToken"],
        "slotId": slot_id,
        "jobId": job["jobId"],
        "leaseToken": job["leaseToken"],
        "status": status,
        "result": result,
    }
    while not state["stopping"] and time.time() < deadline:
        try:
            api_post(config["apiUrl"], payload, timeout=15)
            return
        except urllib.error.HTTPError as error:
            if error.code in {400, 401, 403, 409}:
                return
        except Exception:
            pass
        time.sleep(1)


def websocket_url(api_url):
    parsed = urllib.parse.urlsplit(api_url.rstrip("/"))
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise RuntimeError("API address is invalid")
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = f"{parsed.path.rstrip('/')}/judge-node/socket"
    query = urllib.parse.urlencode({"nodeId": config["nodeId"]})
    return urllib.parse.urlunsplit((scheme, parsed.netloc, path, query, ""))


def socket_send(payload):
    with socket_lock:
        ws = state["socket"]
        if ws is None:
            raise RuntimeError("judge socket is disconnected")
        state["sequence"] += 1
        payload["sequence"] = state["sequence"]
        ws.send(json.dumps(payload, separators=(",", ":")), opcode=websocket.ABNF.OPCODE_TEXT)


def report_capacity():
    # Capacity snapshots and their sequence numbers must be emitted atomically;
    # otherwise two jobs finishing together could send an older snapshot last.
    with socket_lock:
        ws = state["socket"]
        if ws is None:
            raise RuntimeError("judge socket is disconnected")
        with state_lock:
            free_slots = max(0, config["maxSlots"] - state["busy"])
        state["sequence"] += 1
        ws.send(json.dumps({
            "type": "capacity",
            "freeSlots": free_slots,
            "sequence": state["sequence"],
        }, separators=(",", ":")), opcode=websocket.ABNF.OPCODE_TEXT)


def run_socket_job(job):
    job_id = str(job.get("jobId") or "")
    slot_id = int(job.get("slotId", -1))
    with state_lock:
        if state["stopping"] or job_id in state["active_jobs"] \
                or state["busy"] >= config["maxSlots"]:
            return
        state["active_jobs"].add(job_id)
        state["busy"] += 1
    try:
        status, result = execute_judge0(job["payload"])
        completion = {
            "type": "complete",
            "connectionId": job.get("connectionId"),
            "slotId": slot_id,
            "jobId": job_id,
            "leaseToken": job["leaseToken"],
            "status": status,
            "result": result,
        }
        try:
            socket_send(completion)
        except Exception:
            # If the socket breaks after execution, the authenticated HTTP endpoint
            # can still deliver the same lease exactly once.
            complete_job(slot_id, job, status, result)
    finally:
        with state_lock:
            state["active_jobs"].discard(job_id)
            state["busy"] = max(0, state["busy"] - 1)
        try:
            report_capacity()
        except Exception:
            pass


def socket_worker():
    if websocket is None:
        raise RuntimeError("python3-websocket is not installed")
    backoff = 1
    with concurrent.futures.ThreadPoolExecutor(
            max_workers=config["maxSlots"], thread_name_prefix="judge-slot") as executor:
        while True:
            with state_lock:
                if state["stopping"]:
                    return
            ws = None
            try:
                ws = websocket.create_connection(
                    websocket_url(config["apiUrl"]),
                    header=[f"Authorization: Bearer {config['pullToken']}"],
                    timeout=75,
                    enable_multithread=True,
                    suppress_origin=True,
                )
                with socket_lock:
                    state["socket"] = ws
                    state["sequence"] = 0
                    state["connection_id"] = ""
                backoff = 1
                while True:
                    try:
                        raw = ws.recv()
                    except websocket.WebSocketTimeoutException:
                        # Durable Object answers this without waking from hibernation.
                        with socket_lock:
                            ws.send("ping", opcode=websocket.ABNF.OPCODE_TEXT)
                        continue
                    if raw is None or raw == "":
                        raise RuntimeError("judge socket closed")
                    if raw == "pong":
                        continue
                    if not isinstance(raw, str) or len(raw) > MAX_RESPONSE_BYTES:
                        raise RuntimeError("invalid judge socket message")
                    message = json.loads(raw)
                    message_type = message.get("type")
                    if message_type == "connected":
                        server_slots = max(1, min(16, int(message.get("maxSlots") or 1)))
                        config["maxSlots"] = min(config["maxSlots"], server_slots)
                        with state_lock:
                            state["connection_id"] = str(message.get("connectionId") or "")
                        report_capacity()
                    elif message_type == "job":
                        if message.get("connectionId") != state["connection_id"] \
                                or not message.get("jobId") or not message.get("leaseToken") \
                                or not isinstance(message.get("payload"), dict):
                            raise RuntimeError("invalid judge job")
                        executor.submit(run_socket_job, message)
                    elif message_type in {"accepted", "rejected"}:
                        continue
                    else:
                        raise RuntimeError("unknown judge socket message")
            except Exception as error:
                with state_lock:
                    state["last_error"] = str(error)[:300]
                with socket_lock:
                    if state["socket"] is ws:
                        state["socket"] = None
                        state["connection_id"] = ""
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass
                with state_lock:
                    if state["stopping"]:
                        return
                status_code = getattr(error, "status_code", None)
                if status_code == 401:
                    with state_lock:
                        state["stopping"] = True
                    return
                # Paused/disabled nodes retry slowly instead of consuming Worker
                # requests in a tight reconnect loop.
                time.sleep(300 if status_code in {403, 409} else backoff)
                backoff = min(300, backoff * 2)


def slot_worker(slot_id):
    backoff = 1
    while True:
        with state_lock:
            if state["stopping"]:
                return
        try:
            job = api_post(config["apiUrl"], {
                "type": "judge_node_claim",
                "nodeId": config["nodeId"],
                "pullToken": config["pullToken"],
                "slotId": slot_id,
            }, timeout=60)
            backoff = 1
            if job.get("empty"):
                time.sleep(max(0.1, min(2, float(job.get("retryAfterMs") or 500) / 1000)))
                continue
            if not job.get("jobId") or not job.get("leaseToken") or not isinstance(job.get("payload"), dict):
                time.sleep(2)
                continue
            with state_lock:
                state["busy"] += 1
            try:
                status, result = execute_judge0(job["payload"])
                complete_job(slot_id, job, status, result)
            finally:
                with state_lock:
                    state["busy"] = max(0, state["busy"] - 1)
        except urllib.error.HTTPError as error:
            if error.code == 401:
                with state_lock:
                    state["stopping"] = True
                return
            time.sleep(60 if error.code == 409 else backoff)
            backoff = min(30, backoff * 2)
        except Exception as error:
            with state_lock:
                state["last_error"] = str(error)[:300]
            time.sleep(backoff)
            backoff = min(30, backoff * 2)


def stop_handler(_signum, _frame):
    with state_lock:
        state["stopping"] = True


def main():
    global config
    config = load_or_pair()
    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    # Register the node with the single broker before any slot starts claiming work.
    # A failed first heartbeat is retried instead of letting an unregistered slot interpret 401 as revocation.
    while True:
        try:
            heartbeat()
            break
        except urllib.error.HTTPError as error:
            if error.code == 401:
                return
        except Exception as error:
            with state_lock:
                state["last_error"] = str(error)[:300]
        time.sleep(10)
    # One connection represents the whole computer. The server sends at most the
    # reported number of free slots, while the local executor enforces the same cap.
    # Keep the legacy pull workers only as a compatibility fallback for machines
    # whose old image does not yet contain python3-websocket.
    if websocket is not None:
        threading.Thread(target=socket_worker, daemon=True).start()
    else:
        for slot_id in range(config["maxSlots"]):
            threading.Thread(target=slot_worker, args=(slot_id,), daemon=True).start()
    next_heartbeat = time.time() + (300 if self_test["ok"] else 30)
    while True:
        with state_lock:
            if state["stopping"]:
                break
        if time.time() >= next_heartbeat:
            try:
                heartbeat()
                with state_lock:
                    state["last_error"] = ""
                next_heartbeat = time.time() + (300 if self_test["ok"] else 30)
            except urllib.error.HTTPError as error:
                if error.code == 401:
                    break
                next_heartbeat = time.time() + 60
            except Exception as error:
                with state_lock:
                    state["last_error"] = str(error)[:300]
                next_heartbeat = time.time() + 60
        time.sleep(1)
    with state_lock:
        state["stopping"] = True


if __name__ == "__main__":
    main()
