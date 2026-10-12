#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PAIRING_B64URL="${1:-}"
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

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip openssl docker.io docker-compose-v2 python3

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

JUDGE_ZIP=/tmp/judge0-v1.13.1.zip
curl --fail --location --proto '=https' --tlsv1.2 \
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
chmod 600 judge0.conf

# Judge0 API is reachable only from localhost; the VM uses NAT and has no forwarded ports.
sed -i 's/- "2358:2358"/- "127.0.0.1:2358:2358"/' docker-compose.yml
sed -i 's/max-size: 100M/max-size: 20M/' docker-compose.yml
docker compose pull
docker compose up -d db redis
sleep 12
docker compose up -d

CLOUDFLARED_VERSION=2026.10.0
CLOUDFLARED=/tmp/cloudflared
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
  --output "$CLOUDFLARED"
echo '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2  /tmp/cloudflared' | sha256sum --check --strict
install -m 755 "$CLOUDFLARED" /usr/local/bin/cloudflared
rm -f "$CLOUDFLARED"

NODE_AGENT=/tmp/jc-oj-node-agent.py
curl --fail --location --proto '=https' --tlsv1.2 \
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

# The temporary unattended-install user is no longer needed after provisioning.
passwd -l jcnode >/dev/null 2>&1 || true
rm -f /root/.bash_history /home/jcnode/.bash_history

systemctl start jc-oj-node.service || true
sync
shutdown -r +1 'Finishing JC OJ judge node isolation setup'
