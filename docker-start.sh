#!/usr/bin/env bash
#
# Host helper: build the all-in-one image and run EVERYTHING in one container
# behind ONE published port (nginx on :8080 serving the terminal SPA plus a
# same-origin /api proxy; API/postgres/redis/signer/worker/approval/agent all
# run inside, unreachable from the host). Override the port: PORT=8080.
#
# Usage:
#   ./docker-start.sh [up|down|restart|logs|status|fresh|demo-user|mnemonic|demo]
#
#   up       Build image,create/start container, wait for readiness (default)
#   down     Stop + remove the container (volume with DB + secrets is kept)
#   down -v  Also delete the data volume (wipes DB, vault, secrets — fresh boot)
#   restart  Restart the container (init steps are idempotent no-ops)
#   logs     Follow container logs
#   status   Show container + probe every endpoint
#   fresh    down -v + up (nuclear fresh boot for the big moment)
#   demo-user Create the judge-ready demo account via the API
#   mnemonic Show where the first-boot mnemonic lives
#   demo     Print the 60-second demo talk track
#
# First boot takes a few minutes: Postgres init, schema push, token seed,
# wallet creation. Watch with: ./docker-start.sh logs
#
set -euo pipefail

IMAGE="exchange-allinone:local"
NAME="exchange-allinone"
VOLUME="exchange-data"
# Single published port (nginx). API_PORT/WEB_PORT are honored as legacy
# aliases so old muscle memory keeps working.
PORT="${PORT:-${WEB_PORT:-${API_PORT:-8080}}}"

DEMO_EMAIL="${DEMO_EMAIL:-demo@axon.local}"
DEMO_PASSWORD="${DEMO_PASSWORD:-AxonDemo123}"

# Extra `docker run -e KEY=val` overrides.
# Examples: OVERRIDES=(-e TRADING_SIMULATE=true)
#           OVERRIDES=(-e ENABLE_APPROVAL=false -e ENABLE_AGENT=false)
#           OVERRIDES=(-e TRADING_PAUSED=true)
# (OVERRIDES win over the env-file imports below; last -e wins in docker.)
OVERRIDES=()

# ---- Secrets + operational keys imported from host env files ----
# Files are read in order; later files win per key: backend/.env <
# backend/.env.signer < backend/.env.agent < backend/.env.approval.
# Only the allowlisted keys are passed through —
# DATABASE_URL, REDIS_URL, PORT, NODE_ENV, RUN_JOBS_IN_API, SIGNER_URL, etc.
# are NEVER imported (the container owns its postgres/redis/ports/topology).
# Values are never printed; only key names + source file are logged.
ENV_FILES=(backend/.env backend/.env.signer backend/.env.agent backend/.env.approval)
SECRET_KEYS=(
  JWT_SECRET APP_ENCRYPTION_KEY WALLET_ENCRYPTION_KEY SIGNER_SHARED_SECRET
  SIGNER_TIMEOUT_MS SIGNER_TX_WAIT_TIMEOUT_MS
  SIGNER_APPROVAL_PUBLIC_KEY SIGNER_APPROVAL_TOKEN_REQUIRED
  APPROVAL_SHARED_SECRET APPROVAL_ED25519_PRIVATE_KEY APPROVAL_TOKEN_TTL_SEC
  MUSE_API_KEY MUSE_BASE_URL MUSE_MODEL AGENT_DEMO_MODE AGENT_CREW_DEADLINE_MS
  MODEL_API_KEY MODEL_BASE_URL MODEL_NAME MODEL_FAST_NAME MODEL_TIMEOUT_MS
  MUSE_FAST_MODEL MUSE_TIMEOUT_MS
  MASTER_MNEMONIC
  LIFI_API_KEY LIFI_BASE_URL SYMBIOSIS_BASE_URL RELAY_BASE_URL
  SIGNER_ALLOWANCE_TOKENS SIGNER_ALLOWANCE_AMOUNT SIGNER_ALLOWANCES_ON_BOOT
  COINGECKO_API_KEY PYTH_HERMES_URL
  ETH_RPC_URL SEPOLIA_RPC_URL ARBITRUM_RPC_URL OPTIMISM_RPC_URL BASE_RPC_URL
  POLYGON_RPC_URL BSC_RPC_URL AVALANCHE_RPC_URL BITCOIN_API_URL SOLANA_RPC_URL
  SOLANA_DEVNET_RPC_URL
  TRON_FULL_HOST TRON_API_KEY
  ALCHEMY_WEBHOOK_ENABLED ALCHEMY_WEBHOOK_SIGNING_KEY
  HELIUS_WEBHOOK_ENABLED HELIUS_WEBHOOK_AUTH_HEADER
  MAIL_TRANSPORT SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM
)

# Print the value of KEY in FILE (last occurrence), or fail. Strips one layer
# of surrounding quotes. Never logs the value — callers must not echo it.
read_env_key() {
  local file="$1" key="$2" line val
  [ -f "$file" ] || return 1
  line="$(grep -E "^${key}=" "$file" | tail -n 1)" || return 1
  [ -n "$line" ] || return 1
  val="${line#*=}"
  val="${val%$'\r'}"
  if [[ "$val" == \"*\" && "$val" == *\" && ${#val} -ge 2 ]]; then
    val="${val:1:${#val}-2}"
  elif [[ "$val" == \'*\' && "$val" == *\' && ${#val} -ge 2 ]]; then
    val="${val:1:${#val}-2}"
  fi
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

# Warn when a key is set differently in two files (later file wins).
warn_if_differs() {
  local key="$1" file_a="$2" file_b="$3" va vb
  va="$(read_env_key "$file_a" "$key" 2>/dev/null)" || return 0
  vb="$(read_env_key "$file_b" "$key" 2>/dev/null)" || return 0
  if [ "$va" != "$vb" ]; then
    echo "WARNING: $key differs between $file_a and $file_b — using $file_b value."
  fi
}

collect_secret_args() {
  SECRETS_ARGS=()
  local key f val src count=0 names=()
  for key in "${SECRET_KEYS[@]}"; do
    val=""; src=""
    for f in "${ENV_FILES[@]}"; do
      if tmp="$(read_env_key "$f" "$key" 2>/dev/null)"; then
        val="$tmp"; src="$f"
      fi
    done
    if [ -n "$src" ]; then
      SECRETS_ARGS+=(-e "${key}=${val}")
      names+=("${key}(${src})")
      count=$((count + 1))
    fi
  done
  warn_if_differs SIGNER_SHARED_SECRET backend/.env backend/.env.signer
  warn_if_differs WALLET_ENCRYPTION_KEY backend/.env backend/.env.signer
  if [ "$count" -gt 0 ]; then
    echo "Imported $count keys from env files: ${names[*]}"
  else
    echo "No env-file keys found — container will generate its own secrets."
  fi
}

cmd="${1:-up}"

wait_ready() {
  echo "Waiting for readiness on :${PORT} (up to 5 min on first boot) ..."
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/ready" > /dev/null 2>&1 \
       && curl -fsS "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then
      echo "Single-port gateway is ready (SPA + /api proxy)."
      return 0
    fi
    sleep 5
  done
  echo "Timed out waiting for /ready. Check: ./docker-start.sh logs"
  return 1
}

print_demo_script() {
  cat <<'EOF'
AXON — the 60-second demo (say this while you click it)
────────────────────────────────────────────────────────
0:00  "Retail traders face pro desks alone — and bots move money
       with no oversight. AXON gives every trade a second mind."
       → Open http://localhost:8080 → Agent page.
0:10  "Watch the crew: scout pulls my balances and prices via tools,
       the strategist drafts a plan, the red team attacks it, and a
       deterministic verifier re-checks everything — outside the model."
       → Press ▶ Play the 60-second demo. Narrate the timeline.
0:35  "Every plan carries a receipt — which Meta model reasoned, with
       what effort, and how many tokens. Dry-run by default."
       → Point at the proposal card + model receipt. Approve (simulated).
0:45  "And it physically cannot steal: agents have read|trade scopes only —
       no withdraw scope exists in the schema. Dual-control approvals,
       full audit trail."
       → Flip the rail to LIVE, show portfolio + real ledger.
0:55  "Every trade gets a second mind."
────────────────────────────────────────────────────────
Backup lines (if asked):
- Models: Muse Spark 1.3 default; Wonder 1.0 for deep reasoning.
- Safety: dry-run default, no-withdraw scopes, deterministic verifier.
- Stack: ./docker-start.sh up → one container, one command.
EOF
}

case "$cmd" in
  up)
    docker build -t "$IMAGE" .
    docker volume create "$VOLUME" > /dev/null 2>&1 || true  # podman errors if it exists; docker is idempotent
    collect_secret_args
    if [ -n "$(docker ps -aq -f "name=^${NAME}$")" ]; then
      echo "Container $NAME exists — starting it with its ORIGINAL environment."
      echo "(To apply changed env files: './docker-start.sh down' then 'up'."
      echo " If you changed WALLET_ENCRYPTION_KEY or MASTER_MNEMONIC, use"
      echo " 'down -v' for a fresh boot — vault key + DB must stay in sync.)"
      docker start "$NAME" > /dev/null
    else
      echo "Creating container $NAME (single published port ${PORT}) ..."
      docker run -d --name "$NAME" \
        -p "${PORT}:80" \
        -v "${VOLUME}:/data" \
        "${SECRETS_ARGS[@]}" \
        "${OVERRIDES[@]}" \
        "$IMAGE" > /dev/null
    fi
    wait_ready
    echo
    echo "Everything behind one port:"
    echo "  Terminal:    http://localhost:${PORT}/"
    echo "  API health:  http://localhost:${PORT}/health"
    echo "  API ready:   http://localhost:${PORT}/ready"
    echo "  Swagger:     http://localhost:${PORT}/api/docs"
    echo "  CSRF token:  http://localhost:${PORT}/api/v1/csrf-token"
    echo
    echo "API :3000, signer :3100, approval :3200, agent :3220, postgres, redis"
    echo "all run INSIDE the container (nginx forwards /api/*, /health, /ready)."
    echo "Debug inside:  docker exec -it $NAME bash"
    echo "Supervisord:   docker exec -it $NAME supervisorctl -c /etc/supervisor/supervisord-docker.conf status"
    echo "First-boot mnemonic: docker exec $NAME cat /data/wallet-init-first-boot.log"
    echo
    echo "Useful next steps:"
    echo "  ./docker-start.sh demo-user   create $DEMO_EMAIL for the LIVE rail"
    echo "  ./docker-start.sh status      probe every endpoint"
    echo "  ./docker-start.sh demo        the 60-second talk track"
    ;;

  down)
    docker rm -f "$NAME" > /dev/null 2>&1 || echo "Container $NAME not found."
    if [ "${2:-}" = "-v" ]; then
      docker volume rm "$VOLUME" > /dev/null 2>&1 || echo "Volume $VOLUME not found."
      echo "Volume deleted — next 'up' boots completely fresh."
    else
      echo "Container removed. Volume $VOLUME kept (DB + secrets). Use 'down -v' to wipe."
    fi
    ;;

  restart)
    # stop/start (not `docker restart`): rootless podman holds pasta port
    # bindings briefly after stop, and an instant restart fails with
    # "Address already in use". The pause lets the ports release.
    docker stop -t 30 "$NAME" > /dev/null
    sleep 5
    docker start "$NAME" > /dev/null
    wait_ready
    ;;

  logs)
    docker logs -f --tail 200 "$NAME"
    ;;

  status)
    docker ps -a -f "name=^${NAME}$"
    echo
    echo "-- endpoint probes (single port ${PORT}) --"
    for ep in "/" "/health" "/ready" "/api/docs.json" "/api/v1/csrf-token"; do
      code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${PORT}${ep}" || echo "000")"
      printf "  :%s%s -> %s\n" "$PORT" "$ep" "$code"
    done
    ;;

  fresh)
    "$0" down -v
    "$0" up
    ;;

  demo-user)
    echo "Creating demo account $DEMO_EMAIL ..."
    code="$(curl -s -o /tmp/axon-demo-user.json -w "%{http_code}" --max-time 10 \
      -X POST "http://127.0.0.1:${PORT}/api/v1/auth/register" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\"}" || echo "000")"
    echo "HTTP $code"
    cat /tmp/axon-demo-user.json; echo
    if [ "$code" = "201" ] || [ "$code" = "200" ]; then
      echo "Login with: $DEMO_EMAIL / $DEMO_PASSWORD"
    else
      echo "(If the user already exists, just log in with the password above.)"
    fi
    ;;

  mnemonic)
    echo "The first-boot mnemonic was printed ONCE at boot (also saved 0600)."
    docker exec "$NAME" cat /data/wallet-init-first-boot.log 2>/dev/null \
      || echo "(container $NAME is not running — start it first.)"
    ;;

  demo)
    print_demo_script
    ;;

  *)
    echo "Usage: $0 [up|down|restart|logs|status|fresh|demo-user|mnemonic|demo]"
    exit 1
    ;;
esac
