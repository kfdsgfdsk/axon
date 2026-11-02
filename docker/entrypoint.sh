#!/usr/bin/env bash
#
# All-in-one container entrypoint: initialize everything, then start it.
#
# First boot:
#   1. Generate + persist secrets in /data/secrets.env (explicit `docker run -e`
#      values always win; persisted values survive restarts via the /data volume).
#   2. initdb a Postgres cluster in /data/postgres, create role + database.
#   3. Start temp Postgres + Redis, wait for readiness.
#   4. `prisma db push` (repo uses push, no migrations dir).
#   5. Seed the token catalog (insert-only, safe to re-run).
#   6. Init the master wallet vault if empty (mnemonic printed ONCE — back it up).
#   7. Stop temp services, exec supervisord (PID 1) managing:
#      postgres, redis, signer, api, worker, nginx (+ approval/agent when enabled).
#
# Reboot: steps 1-6 are idempotent no-ops; step 7 just starts everything.
#
set -euo pipefail

# `docker run <image> <cmd...>` executes a debug command instead of booting
# (e.g. `docker run --rm -v exchange-data:/data <image> cat /data/secrets.env`
# would print secrets — only do this on your own machine).
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

DATA=/data
SECRETS_FILE="$DATA/secrets.env"
PGDATA="$DATA/postgres"
REDIS_DIR="$DATA/redis"

mkdir -p "$DATA" "$REDIS_DIR" /app/logs /var/log/supervisor
touch "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

log() { echo "[entrypoint] $*"; }

# ---------------------------------------------------------------- secrets ---
# Precedence: explicit env (-e) > persisted /data/secrets.env > generated.
load_persisted() {
  local name="$1" fileval
  if [ -z "${!name:-}" ]; then
    fileval="$(grep -E "^${name}=" "$SECRETS_FILE" | cut -d= -f2- || true)"
    if [ -n "$fileval" ]; then
      export "$name=$fileval"
    fi
  fi
}

ensure_secret() {
  # $1=name, $2=byte length for openssl (hex output is 2x)
  local name="$1" nbytes="$2" val from_env=0
  if [ -n "${!name:-}" ]; then from_env=1; fi
  load_persisted "$name"
  val="${!name:-}"
  if [ -z "$val" ]; then
    val="$(openssl rand -hex "$nbytes")"
    export "$name=$val"
    log "$name generated (persisted in /data/secrets.env)"
  elif [ "$from_env" = "1" ]; then
    log "$name provided via container environment"
  else
    log "$name reused from persisted volume"
  fi
  # Persist current effective value (covers first boot + -e overrides so a
  # restart without -e flags keeps working against the persisted volume).
  grep -v -E "^${name}=" "$SECRETS_FILE" > "${SECRETS_FILE}.tmp" || true
  echo "${name}=${!name}" >> "${SECRETS_FILE}.tmp"
  mv "${SECRETS_FILE}.tmp" "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
}

ensure_secret JWT_SECRET 32
ensure_secret APP_ENCRYPTION_KEY 32
ensure_secret WALLET_ENCRYPTION_KEY 32
ensure_secret SIGNER_SHARED_SECRET 32
ensure_secret APPROVAL_SHARED_SECRET 32
ensure_secret APPROVAL_ED25519_PRIVATE_KEY 32

# IMPORTANT: WALLET_ENCRYPTION_KEY + Postgres must stay in sync. Both live in
# /data, so keep using the same volume across restarts or the vault cannot be
# decrypted (fresh volume = fresh wallet).

# -------------------------------------------------------------- database ---
export POSTGRES_USER="${POSTGRES_USER:-exchange}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-exchange}"
export POSTGRES_DB="${POSTGRES_DB:-exchange}"
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

PG_BIN="$(dirname "$(find /usr/lib/postgresql -name initdb -type f | head -1)")"
export PATH="$PG_BIN:$PATH"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "Initializing Postgres cluster in $PGDATA ..."
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  su postgres -c "$PG_BIN/initdb -D $PGDATA -E UTF8" > "$DATA/initdb.log" 2>&1
fi
chown -R postgres:postgres "$PGDATA"
chown postgres:postgres "$DATA"

log "Starting temporary Postgres for init ..."
if ! su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -l $DATA/postgres-init.log -w -t 60 start"; then
  log "Postgres failed to start — log tail:"
  tail -n 20 "$DATA/postgres-init.log" || true
  exit 1
fi

log "Starting temporary Redis for init ..."
redis-server --appendonly yes --dir "$REDIS_DIR" --port 6379 --bind 127.0.0.1 --daemonize yes
for _ in $(seq 1 30); do
  redis-cli -h 127.0.0.1 ping > /dev/null 2>&1 && break
  sleep 1
done
redis-cli -h 127.0.0.1 ping > /dev/null || { log "Redis failed to start"; exit 1; }

log "Ensuring role + database ..."
# NOTE: plain SELECT + \gexec on purpose — psql does not interpolate :'vars'
# inside DO $$ blocks, so CREATE/ALTER must be generated outside dollar quotes.
su postgres -c "psql -v ON_ERROR_STOP=1 -v pguser='$POSTGRES_USER' -v pgpass='$POSTGRES_PASSWORD' -v pgdb='$POSTGRES_DB'" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'pguser', :'pgpass')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'pguser') \gexec
SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'pguser', :'pgpass')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = :'pguser') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'pgdb', :'pguser')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'pgdb') \gexec
SQL

# ------------------------------------------------------------ app init ------
cd /app

log "Pushing Prisma schema ..."
npx prisma db push --accept-data-loss

log "Seeding token catalog ..."
npm run tokens:seed

VAULT_COUNT="$(su postgres -c "psql -d '$POSTGRES_DB' -tAc 'SELECT count(*) FROM \"WalletVault\"'")"
if [ "${VAULT_COUNT:-0}" = "0" ]; then
  log "No wallet vault found — initializing master wallet ..."
  if [ -z "${MASTER_MNEMONIC:-}" ]; then
    log "WARNING: no MASTER_MNEMONIC provided; a fresh mnemonic will be generated."
  fi
  npm run wallet:init 2>&1 | tee "$DATA/wallet-init-first-boot.log"
  chmod 600 "$DATA/wallet-init-first-boot.log"
  log "================================================================"
  log "VAULT CREATED. The mnemonic was printed above (also saved 0600 in"
  log "/data/wallet-init-first-boot.log). BACK IT UP — it cannot be shown again."
  log "================================================================"
else
  log "Wallet vault exists ($VAULT_COUNT row) — skipping wallet:init."
fi

# ------------------------------------------------------- hand over to run ---
log "Stopping temporary Postgres/Redis (supervisord takes over) ..."
redis-cli -h 127.0.0.1 shutdown nosave > /dev/null 2>&1 || true
su postgres -c "$PG_BIN/pg_ctl -D $PGDATA stop -m fast" > /dev/null 2>&1 || true

log "Writing supervisord program conf ..."
cat > /etc/supervisor/conf.d/postgres.conf <<EOF
[program:postgres]
command=$PG_BIN/postgres -D $PGDATA
user=postgres
autorestart=true
autorestart_delay=2
startsecs=5
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
stopasgroup=true
killasgroup=true
EOF

rm -f /etc/supervisor/conf.d/optional.conf
if [ "${ENABLE_APPROVAL:-false}" = "true" ]; then
  cat > /etc/supervisor/conf.d/optional.conf <<'EOF'
[program:approval]
command=node /app/dist/approval-entry.js
directory=/app
environment=NODE_OPTIONS="--dns-result-order=ipv4first"
autorestart=true
autorestart_delay=2
startsecs=3
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
stopasgroup=true
killasgroup=true
EOF
  log "Approval service enabled (port 3200, localhost-only)."
fi
if [ "${ENABLE_AGENT:-false}" = "true" ]; then
  cat >> /etc/supervisor/conf.d/optional.conf <<'EOF'
[program:agent]
command=node /app/dist/agent-entry.js
directory=/app
environment=NODE_OPTIONS="--dns-result-order=ipv4first"
autorestart=true
autorestart_delay=2
startsecs=3
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
stopasgroup=true
killasgroup=true
EOF
  log "Standalone agent enabled (port 3220, localhost-only)."
fi

mkdir -p /run/nginx /var/log/nginx /var/cache/nginx /var/lib/nginx
cat > /etc/supervisor/supervisord-docker.conf <<'EOF'
[supervisord]
nodaemon=true
user=root
logfile=/var/log/supervisor/supervisord.log
logfile_maxbytes=10485760
logfile_backups=2
pidfile=/tmp/supervisord.pid

[include]
files=/etc/supervisor/conf.d/*.conf

[unix_http_server]
file=/tmp/supervisor.sock

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///tmp/supervisor.sock
EOF

log "Checking nginx config ..."
nginx -t

log "Starting supervisord (postgres, redis, signer, api, worker, nginx) ..."
exec /usr/bin/supervisord -c /etc/supervisor/supervisord-docker.conf
