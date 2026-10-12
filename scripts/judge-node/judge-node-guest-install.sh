#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PAIRING_B64URL="${1:-}"
INSTALL_MODE="${2:-}"
if [[ ! "$PAIRING_B64URL" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Invalid pairing payload" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
install -d -m 700 /etc/jc-oj-node /var/lib/jc-oj-node
python3 - "$PAIRING_B64URL" <<'PY'
import base64, json, os, sys
raw = sys.argv[1]
raw += '=' * (-len(raw) % 4)
data = base64.urlsafe_b64decode(raw.encode('ascii'))
value = json.loads(data.decode('utf-8'))
if value.get('format') != 'jc-oj-judge-node-pairing-v1':
    raise SystemExit('invalid pairing format')
path = '/etc/jc-oj-node/pairing.json'
with open(path, 'wb') as handle:
    handle.write(data)
os.chmod(path, 0o600)
PY

if [[ "$INSTALL_MODE" == "--defer" ]]; then
  echo '[准备阶段] 已写入安全配对信息，正在安排首次开机安装任务...'
  install -m 700 "$0" /usr/local/sbin/jc-oj-node-bootstrap.sh
  printf '%s\n' "$PAIRING_B64URL" >/etc/jc-oj-node/pairing.b64
  chmod 600 /etc/jc-oj-node/pairing.b64
  cat >/etc/systemd/system/jc-oj-node-bootstrap.service <<'UNIT'
[Unit]
Description=Install JC OJ local judge node on first boot
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=5

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'exec /usr/local/sbin/jc-oj-node-bootstrap.sh "$(cat /etc/jc-oj-node/pairing.b64)" --install'
StandardOutput=journal+console
StandardError=journal+console
TimeoutStartSec=infinity
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
UNIT
  install -d -m 755 /etc/systemd/system/multi-user.target.wants
  ln -sfn /etc/systemd/system/jc-oj-node-bootstrap.service \
    /etc/systemd/system/multi-user.target.wants/jc-oj-node-bootstrap.service
  echo '[准备完成] Ubuntu 首次启动后将继续安装 Docker、Judge0 和节点代理。'
  exit 0
fi

echo '[1/6] 正在更新 Ubuntu 软件索引...'
apt-get update
echo '[2/6] 正在安装 Docker 和节点运行依赖...'
apt-get install -y --no-install-recommends ca-certificates curl unzip openssl docker.io docker-compose-v2 python3 python3-websocket

# Judge0 1.13.1 currently requires cgroup v1. This applies only inside the dedicated VM.
if ! grep -q 'systemd.unified_cgroup_hierarchy=0' /etc/default/grub; then
  sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="systemd.unified_cgroup_hierarchy=0"/' /etc/default/grub
  sed -i 's/^GRUB_CMDLINE_LINUX=.*/GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=0"/' /etc/default/grub
  update-grub
fi

install -d -m 755 /etc/docker
cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" },
  "live-restore": true,
  "userland-proxy": false
}
JSON
systemctl enable --now docker

echo '[3/6] 正在下载并校验 Judge0...'
JUDGE_ZIP=/tmp/judge0-v1.13.1.zip
curl --fail --location --proto '=https' --tlsv1.2 \
  --retry 5 --retry-all-errors --retry-delay 5 \
  'https://github.com/judge0/judge0/releases/download/v1.13.1/judge0-v1.13.1.zip' \
  --output "$JUDGE_ZIP"
echo 'd83f002c98f2c3935fc4fec3abcb863191e7c863ffcd202401d03a8f7e1fa513  /tmp/judge0-v1.13.1.zip' | sha256sum --check --strict
rm -rf /opt/judge0
install -d -m 700 /opt/judge0
unzip -q "$JUDGE_ZIP" -d /opt/judge0
rm -f "$JUDGE_ZIP"
cd /opt/judge0/judge0-v1.13.1

REDIS_PASSWORD="$(openssl rand -hex 32)"
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
set_conf() {
  local key="$1" value="$2"
  sed -i "s|^${key}=.*|${key}=${value}|" judge0.conf
}
set_conf REDIS_PASSWORD "$REDIS_PASSWORD"
set_conf POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
set_conf ENABLE_WAIT_RESULT true
set_conf MAX_QUEUE_SIZE 100
set_conf CPU_TIME_LIMIT 3
set_conf MAX_CPU_TIME_LIMIT 3
set_conf WALL_TIME_LIMIT 8
set_conf MAX_WALL_TIME_LIMIT 8
set_conf MEMORY_LIMIT 262144
set_conf MAX_MEMORY_LIMIT 262144
set_conf STACK_LIMIT 131072
set_conf MAX_STACK_LIMIT 131072
set_conf MAX_PROCESSES_AND_OR_THREADS 16
set_conf MAX_MAX_PROCESSES_AND_OR_THREADS 16
set_conf MAX_FILE_SIZE 4096
set_conf MAX_MAX_FILE_SIZE 4096
set_conf MAX_NUMBER_OF_RUNS 1
set_conf MAX_EXTRACT_SIZE 10240
set_conf ALLOW_ENABLE_NETWORK false
# The parent directory is root-only (0700), while the non-root Judge0 process
# must be able to read this bind-mounted file inside its container.
chmod 644 judge0.conf

# Judge0 API is reachable only from localhost; the VM uses NAT and has no forwarded ports.
sed -i 's/- "2358:2358"/- "127.0.0.1:2358:2358"/' docker-compose.yml
sed -i 's/max-size: 100M/max-size: 20M/' docker-compose.yml
echo '[4/6] 正在下载 Judge0 容器镜像，此阶段通常耗时最长...'
pull_complete=false
for attempt in 1 2 3 4 5; do
  if docker compose pull; then
    pull_complete=true
    break
  fi
  if [[ "$attempt" -lt 5 ]]; then
    delay=$((attempt * 15))
    echo "容器镜像下载遇到网络中断，${delay}秒后进行第$((attempt + 1))/5次尝试；已完成的镜像层会复用。"
    sleep "$delay"
  fi
done
if [[ "$pull_complete" != true ]]; then
  echo '容器镜像连续5次下载失败，首次启动服务稍后会进行有限次数的整体重试。' >&2
  exit 1
fi
docker compose up -d db redis
sleep 12
docker compose up -d

echo '[5/6] 正在安装并保护机创OJ节点代理...'
NODE_AGENT=/tmp/jc-oj-node-agent.py
curl --fail --location --proto '=https' --tlsv1.2 \
  --retry 5 --retry-all-errors --retry-delay 5 \
  'https://jc-oj.online/downloads/jc-oj-node-agent.py' --output "$NODE_AGENT"
echo '__NODE_AGENT_SHA256__  /tmp/jc-oj-node-agent.py' | sha256sum --check --strict
install -m 700 "$NODE_AGENT" /usr/local/lib/jc-oj-node-agent.py
rm -f "$NODE_AGENT"

cat >/etc/systemd/system/jc-oj-node.service <<'UNIT'
[Unit]
Description=JC OJ trusted local judge node
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/lib/jc-oj-node-agent.py
Restart=on-failure
RestartSec=15
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/jc-oj-node /etc/jc-oj-node
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable jc-oj-node.service

# Keep the randomly generated maintenance account usable through VirtualBox
# Guest Control. The VM uses NAT with no forwarded inbound ports.
rm -f /root/.bash_history /home/jcnode/.bash_history

echo '[6/6] 正在启动节点并完成安全清理...'
systemctl start jc-oj-node.service || true
systemctl disable jc-oj-node-bootstrap.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/jc-oj-node-bootstrap.service \
  /etc/systemd/system/multi-user.target.wants/jc-oj-node-bootstrap.service \
  /etc/jc-oj-node/pairing.b64 /usr/local/sbin/jc-oj-node-bootstrap.sh
systemctl daemon-reload
sync
shutdown -r +1 'Finishing JC OJ judge node isolation setup'
