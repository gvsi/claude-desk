#!/usr/bin/env bash
# Root, on the disposable Ubuntu 24.04 arm64 test machine. Safe to retry via SSM.
set -euo pipefail
exec > >(tee -a /var/log/desk-testbox-bootstrap.log) 2>&1
trap 'echo "testbox bootstrap failed at line $LINENO"' ERR
# Ending without readiness (a failed step, a drain that ran out of time, an interruption) records a failed
# setup, so runs report it instead of asking callers to retry. Only a bootstrap that completes clears it.
trap 'test -f /opt/testbox/ready || touch /opt/testbox/bootstrap-failed' EXIT
# Direct runs and provisioning both drain shared run leases before mutation.
rm -f /opt/testbox/ready
if [ "${TESTBOX_BOOTSTRAP_LOCKED:-0}" != 1 ]; then
  exec 9>/opt/testbox/bootstrap.lock
  flock -x -w 1500 9
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential pkg-config libssl-dev curl unzip git rsync openssh-server postgresql-16 postgresql-client-16 python3 acl iproute2 iptables socat fonts-liberation
install -d -o ubuntu -g ubuntu /srv/testbox /srv/testbox/lanes /srv/testbox/cache
install -d -o root -g root /opt/testbox
# Every lane on a laptop shares one SSH connection, and sshd allows 10 sessions on a connection by default, so with
# a dozen lanes at once new calls were refused ("no more sessions"). 256 stays inside the 1024 open files each
# connection's sshd process may hold (about two per session). Reload only when the setting changes: a reload keeps
# open connections, and each new connection gets the new limits. sshd keeps the first value it reads, so confirm
# the one in effect; on any failure remove the file, so a retry sees a change and checks again.
# A laptop's connection can die while Session Manager keeps sshd's local socket open. sshd then keeps that
# connection's processes, and the lane locks they hold, so every later call to those lanes waits. ClientAlive closes
# a connection whose client stops answering for ten minutes, long enough for a live connection's reply queued behind
# slow uploads.
cat > /tmp/desk-testbox-sshd.conf <<'SSHD'
MaxSessions 256
MaxStartups 200:30:400
ClientAliveInterval 60
ClientAliveCountMax 10
SSHD
if ! cmp -s /tmp/desk-testbox-sshd.conf /etc/ssh/sshd_config.d/90-testbox.conf; then
  install -m 644 /tmp/desk-testbox-sshd.conf /etc/ssh/sshd_config.d/90-testbox.conf
  # The check needs sshd's runtime directory, which only a started ssh.service creates (it starts on first connection).
  install -d -o root -g root -m 0755 /run/sshd
  if ! { sshd -t && effective=$(sshd -T) && grep -qx 'maxsessions 256' <<<"$effective" \
         && grep -qx 'clientaliveinterval 60' <<<"$effective" && systemctl try-reload-or-restart ssh.service; }; then
    rm -f /etc/ssh/sshd_config.d/90-testbox.conf
    echo "testbox bootstrap: sshd rejected or overrode the session limits or keepalive" >&2
    exit 1
  fi
fi
# This server holds only disposable test data. Never apply these settings elsewhere.
pg_changed=0
cat > /tmp/desk-testbox-postgres.conf <<'PG'
listen_addresses = '127.0.0.1,10.200.0.1'
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 1000
shared_buffers = '8GB'
PG
if ! cmp -s /tmp/desk-testbox-postgres.conf /etc/postgresql/16/main/conf.d/testbox.conf; then
  install -m 644 /tmp/desk-testbox-postgres.conf /etc/postgresql/16/main/conf.d/testbox.conf
  pg_changed=1
fi
# A bridge provides internet egress while each lane keeps its own loopback and fixed test ports.
cat > /opt/testbox/network.sh <<'NET'
#!/usr/bin/env bash
set -euo pipefail
ip link show testbox0 >/dev/null 2>&1 || ip link add testbox0 type bridge
ip addr replace 10.200.0.1/16 dev testbox0
ip link set testbox0 up
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -C POSTROUTING -s 10.200.0.0/16 ! -d 10.200.0.0/16 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.200.0.0/16 ! -d 10.200.0.0/16 -j MASQUERADE
NET
chmod 755 /opt/testbox/network.sh
cat > /etc/systemd/system/desk-testbox-network.service <<'UNIT'
[Unit]
Description=Disposable test lane network
Before=postgresql.service
After=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/testbox/network.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /etc/systemd/system/postgresql@16-main.service.d
cat > /etc/systemd/system/postgresql@16-main.service.d/testbox.conf <<'UNIT'
[Unit]
Requires=desk-testbox-network.service
After=desk-testbox-network.service
UNIT
# Resolve the host name inside lane namespaces too, without a DNS lookup by sudo.
python3 - <<'HOSTS'
import socket
from pathlib import Path
hosts = Path('/etc/hosts')
name = socket.gethostname()
if not any(name in line.split()[1:] for line in hosts.read_text().splitlines()):
    with hosts.open('a') as output:
        output.write('127.0.1.1 ' + name + '\n')
HOSTS
systemctl daemon-reload
systemctl enable --now desk-testbox-network
if ! grep -q '10.200.0.0/16' /etc/postgresql/16/main/pg_hba.conf; then
  pg_changed=1
  echo 'host all all 10.200.0.0/16 scram-sha-256' >> /etc/postgresql/16/main/pg_hba.conf
fi
if [ "$pg_changed" = 1 ]; then
  systemctl restart postgresql
else
  systemctl start postgresql
fi
runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE ROLE desk_admin LOGIN SUPERUSER PASSWORD ''change-me-admin'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'desk_admin') \gexec
ALTER ROLE desk_admin PASSWORD 'change-me-admin';
SQL
# No passwords, cloud credentials, model keys or owner environment files are installed.
cat > /opt/testbox/install-user.sh <<'USER'
#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
cd /opt/testbox
mkdir -p /tmp/desk-testbox-install
if ! command -v rustup >/dev/null; then
  curl -fsSLo /tmp/desk-testbox-install/rustup-init https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-unknown-linux-gnu/rustup-init
  echo '15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433  /tmp/desk-testbox-install/rustup-init' | sha256sum -c --strict
  chmod +x /tmp/desk-testbox-install/rustup-init
  /tmp/desk-testbox-install/rustup-init -y --profile minimal --default-toolchain none --no-modify-path
fi
rustup toolchain install 1.99.1 --profile minimal --no-self-update
rustup default 1.99.1
if ! uv --version 2>/dev/null | grep -q 'uv 0.13.0'; then
  curl -fsSL https://github.com/astral-sh/uv/releases/download/0.13.0/uv-aarch64-unknown-linux-gnu.tar.gz -o /tmp/testbox-uv.tar.gz
  echo '3ccfb6af6e242433eb552f7d9676abd5412c6595c497e990d9c8cb7b5bd4d2c3  /tmp/testbox-uv.tar.gz' | sha256sum -c --strict
  tar -xzf /tmp/testbox-uv.tar.gz -C /tmp
  install -D /tmp/uv-aarch64-unknown-linux-gnu/uv "$HOME/.local/bin/uv"
fi
uv python install 3.13
USER
chmod 755 /opt/testbox/install-user.sh
runuser -l ubuntu -c 'bash /opt/testbox/install-user.sh'
if ! /usr/local/bin/node --version 2>/dev/null | grep -q '^v24.21.0$'; then
  cd /tmp
  curl -fsSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz
  curl -fsSLO https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
  grep ' node-v24.21.0-linux-arm64.tar.xz$' SHASUMS256.txt | sha256sum -c --strict
  tar -xJf node-v24.21.0-linux-arm64.tar.xz -C /usr/local --strip-components=1
fi
cd /opt/testbox
if [ ! -x cvc5/bin/cvc5 ]; then
  curl -fsSLo cvc5-Linux-arm64-static.zip https://github.com/cvc5/cvc5/releases/download/cvc5-1.4.2/cvc5-Linux-arm64-static.zip
  grep ' cvc5-Linux-arm64-static.zip$' cvc5.sha256 | sha256sum -c --strict
  unzip -qo cvc5-Linux-arm64-static.zip
  mv cvc5-Linux-arm64-static cvc5
fi
# Browser binaries are shared, browser profiles and test output remain per lane.
PLAYWRIGHT_BROWSERS_PATH=/opt/testbox/browsers npx --yes playwright@1.64.0 install --with-deps chromium webkit
# The minimal arm64 CI image installs Fontconfig with Playwright's font set, without
# DejaVu. The server AMI supplies DejaVu first, changing system-ui/serif fallback
# metrics in browser tests. Match CI's installed fonts, without browser overrides.
apt-get remove -y fonts-dejavu-core fonts-dejavu-mono
fc-cache -f
chmod -R a+rX /opt/testbox
chown -R ubuntu:ubuntu /opt/testbox/browsers
# Ubuntu's AppArmor user namespace restriction otherwise prevents Chromium sandbox startup.
# Playwright's CI browser processes run only on this disposable host.
sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
printf 'kernel.apparmor_restrict_unprivileged_userns=0\n' > /etc/sysctl.d/60-testbox.conf
chown root:root /opt/testbox/lane-exec.py
chmod 755 /opt/testbox/lane-exec.py
rm -f /opt/testbox/bootstrap-failed
printf 'ready\n' > /opt/testbox/ready
