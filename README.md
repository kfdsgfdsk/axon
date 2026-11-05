# AXON — the crypto exchange that thinks

AXON is a **custodial crypto exchange across 12 networks** (real wallets,
deposits, swaps, withdrawals) with an **AI trading desk powered by Meta Muse**
built on top: a crew of specialists that reads your book, prices rotations,
debates itself on the record, and cites every number to a tool observation.
Nothing moves without a human decision.

Built for the **Cerebral Hackathon — Meta AI track**.

If you read nothing else, read this: every AI run shows **what you asked**,
the **mode** the desk chose for it, the **crew** that debated it, and a
**receipt** of which models reasoned and what they spent. This README explains
each of those from first principles.

---

## Run it

### Prerequisites

- Docker (or podman with the `docker` alias). That's it — no Node, no Postgres,
  no Redis on your machine. Everything runs inside one container.

### 1. Boot everything

```bash
./docker-start.sh up
```

This builds the image, creates the `exchange-data` volume, and starts the whole
stack behind **one port**. First boot takes a few minutes (Postgres init,
schema push, token seed, wallet creation). Watch it with:

```bash
./docker-start.sh logs
```

### 2. Open the terminal

| What      | Where                            |
|-----------|----------------------------------|
| Terminal  | http://localhost:8080/           |
| API docs  | http://localhost:8080/api/docs   |
| Health    | http://localhost:8080/health     |
| Readiness | http://localhost:8080/ready      |

### 3. Create an account

Register in the UI, or create a ready-made account:

```bash
./docker-start.sh demo-user   # demo@axon.local / AxonDemo123
```

### 4. Give the desk its brain (Muse key)

The desk runs without a key (deterministic routing, degraded crews), but the
full Muse experience needs one:

```bash
cp backend/.env.agent.example backend/.env.agent
# put your Meta Model API key in MUSE_API_KEY, then:
./docker-start.sh down && ./docker-start.sh up
```

All other secrets (JWT, vault keys, service passwords) are **generated
automatically** at first boot — see [Secrets](#secrets--configuration).

### Useful commands

```bash
./docker-start.sh status     # container + endpoint probes
./docker-start.sh logs       # follow all logs
./docker-start.sh restart    # restart (DB + secrets kept)
./docker-start.sh down       # stop (volume kept)
./docker-start.sh down -v    # wipe volume: fresh DB, vault, secrets
./docker-start.sh fresh      # down -v + up (clean fresh boot)
./docker-start.sh demo       # the 60-second talk track
./docker-start.sh mnemonic   # show where the first-boot mnemonic lives
```

Change the port: `PORT=9000 ./docker-start.sh up`.

---

## Take the tour

1. **Agent page → "Watch a guided run."** A stables-rotation brief runs the full
   crew: scout pulls balances and prices via tools, the strategist drafts a
   plan, the simulator prices it, four red-teamers attack it, the judge rules.
2. **Type "make it smaller."** The run continues the same thread as a
   follow-up — Scout skipped, faster crew, `FOLLOW-UP` badge on the run.
3. **Open "Why this routing?"** on the run header. Every run shows the two axes
   that chose it: the mode (what the desk does) and the crew (how many debate).
4. **Point at the proposal + receipt.** Which Meta model reasoned, with what
   effort, how many tokens. Approve the dry-run (simulated, nothing executes).
5. **Try to break it:** run `I want to withdraw everything to my bank`. A
   deterministic gate refuses with zero roles, zero tools, zero tokens — no
   prompt involved, so no prompt can override it.

---

## Architecture

### System topology

One container, one published port, everything inside:

```
                    ┌──────────────────────────────────────────────┐
  browser ──:8080──▶│ nginx :80                                    │
                    │  / ──▶ terminal SPA (React)                  │
                    │  /api/*, /health, /ready ──▶ API :3000       │
                    │                                              │
                    │  API :3000 ──┬── signer :3100   (keys live   │
                    │              │    ONLY here)                 │
                    │              ├── approval :3200 (dual-       │
                    │              │    control tokens)            │
                    │              ├── agent :3220 (standalone    │
                    │              │    desk process)              │
                    │              ├── postgres :5432              │
                    │              └── redis :6379                 │
                    │  worker (BullMQ jobs: deposits, sweeps,     │
                    │         trade monitor, reconciliation)       │
                    │  all supervised by supervisord               │
                    └──────────────────────────────────────────────┘
                         ▲
                    /data volume: postgres, redis, secrets.env,
                                  wallet mnemonic (0600)
```

Only nginx's port 80 is published. The API, signer, approval, agent,
Postgres, and Redis are reachable **only inside the container**. Nginx is
SSE-safe (buffering off, 360s timeouts) because crew streams and price tickers
are long-lived event streams.

| Process  | Port (internal) | Job |
|----------|-----------------|-----|
| nginx    | 80 (published)  | Serves the SPA, proxies `/api/*` |
| api      | 3000            | REST + SSE streams, auth, trading, deposits, withdrawals, crew streaming |
| signer   | 3100            | Isolated key holder: vault decrypt, signing, broadcast |
| approval | 3200            | Dual-control service: short-lived Ed25519 approval tokens |
| agent    | 3220            | Standalone desk process (same crew the API streams) |
| worker   | —               | BullMQ jobs: deposit scan/sweep, trade monitor, ledger reconcile, price refresh |
| postgres | 5432            | 39 tables: users, wallets, ledger, trades, threads, transcripts |
| redis    | 6379            | Queues, price cache, token blacklist |

---

## The exchange

**12 networks:** Bitcoin, Ethereum, Sepolia, Arbitrum, Optimism, Base, Polygon,
BSC, Avalanche, Solana, Solana-devnet, Tron.

### Wallets and the signer boundary

Every user gets an HD-derived deposit address per network. The master seed is
encrypted in the `WalletVault` table — and the decryption key exists in **one
process only**: the signer. The API never holds key material; when it needs a
signature or a broadcast it calls the signer over localhost with a shared
secret, and the signer enforces its own policy (spend allowances, approval
tokens) before touching a key. If the API is compromised, there is nothing to
steal — the keys aren't there.

### Deposits

Per-network scanners (RPC polling plus provider webhooks) detect incoming
transfers to user addresses, credit them exactly once (duplicate detection
reports instead of double-crediting), reconcile them against the ledger, and a
sweeper consolidates funds to platform addresses. A reconciliation job keeps
verifying book-vs-chain forever.

### Swaps

Quotes route across six providers — LiFi, Kyber, Jupiter, SunSwap, Symbiosis,
Relay — picked per network pair, each behind a circuit breaker with readiness
checks. Before any plan reaches you, the simulator prices the exact path:
expected payout, worst-case payout, and fee. Real quotes, not estimates.

### Withdrawals and dual control

Withdrawals are the most guarded path in the system. A withdrawal needs two
independent grants collected by the approval service, which then issues a
short-lived Ed25519 approval token. The signer verifies that token before
broadcasting — no token, no transaction. The agent desk is cut out of this
path entirely (see [What the model cannot touch](#what-the-model-cannot-touch)).

### Idempotency and the ledger

Every money endpoint takes an idempotency key: submitting the same key twice
replays the first result instead of executing again — a retry can never
double-spend. Every movement is a double-entry ledger row, so the book is
always auditable.

---

## The AI desk (Meta Muse)

This is the part the demo video walks through. The desk answers one question
per run: *given what this user asked and what the book looks like, what should
we do — if anything?* The answer always comes with its reasoning attached.

### A run, end to end

1. You write a plain brief. There is no mode picker, no settings to learn.
2. A fast Muse classifier reads the brief and picks a **mode** (what the desk
   does). A deterministic layer with typo repair and fuzzy matching backs it,
   so routing never breaks when the model is unreachable.
3. A deterministic safety gate checks for money-out and instruction-override
   asks. Matches refuse instantly with zero roles, zero tools, zero tokens.
4. The policy engine evaluates the run: ALLOW, DRY_RUN, or DENY.
5. The **crew** debates: gatherers collect facts, a strategist plans, a
   simulator prices, red-teamers attack, a judge rules, an explainer briefs
   you. You watch it live over SSE.
6. Deterministic code verifies every proposed action against observed facts
   and drops what it can't prove. A repair loop rescues malformed model output
   or falls back to a safe hold.
7. You approve, veto, or re-attack. Execution — on live rails only — needs you
   to type `EXECUTE <proposal-id-tail>`, then re-verifies, enforces
   idempotency, and returns a fill receipt.
8. The run lands in an audit transcript: every role's model, tokens, and
   latency, plus every tool observation it cited.

### Axis 1 — modes (what the desk does)

The classifier routes each brief into exactly one of five modes. When several
fit, the precedence is fixed — attack beats verdict beats sweep beats plan
beats answer — so mixed asks always land somewhere sane.

| Mode | Job | Earns it |
|------|-----|----------|
| Quick take | Answer the question. Never builds a plan. | `What is my SOL balance?` |
| Morning brief | Sweep the book + markets, flag the one change. | `mornig brif pls` (typos fine) |
| Goal → plan | Turn a goal into the smallest safe steps. | `Grow stables 2% this month, no leverage` |
| Test a thesis | Verdict with evidence, plus what would change its mind. | `Is rotating 15% into SOL justified?` |
| Red-team | Attack a plan instead of building one. | `Red-team the rotation you proposed` |

Two details matter. First, plain balance and price questions are pinned to
Quick take *before* the model sees them: "balance" is two edits from
"rebalance", and without that guard every balance question would trigger a
ten-role debate. Second, the deterministic fallback repairs common
misspellings itself (`mornig` → `morning`, `swp` → `swap`, `thessis` →
`thesis`), so even with the model unreachable, messy English still routes by
intent.

### Axis 2 — crews (how many debate)

You hold a deep/fast toggle, but the server constrains it: Quick take always
forces fast, whatever the toggle says.

| Crew | Roles | Shape |
|------|-------|-------|
| Deep · 10 | scout, strategist, simulator, risk, 4 reds, judge, explainer | Full debate with red team. 9 on follow-ups. |
| Fast · 5 | scout, strategist, simulator, judge, explainer | No risk desk, no red round. 4 on follow-ups. |

Follow-ups skip Scout and refine the prior proposal instead of cold-starting —
same thread, parent run attached, visibly badged `FOLLOW-UP · SCOUT SKIPPED`.

### The ten roles, in run order

1. **Scout** — reads the live book through real tool calls and reports facts
   only: balances, prices, charts, orders. No opinions.
2. **Strategist** — turns the goal and Scout's facts into an ordered
   multi-step plan (or HOLD), as schema-validated JSON.
3. **Simulator** — prices every swap step with real quotes: expected payout,
   worst-case payout, fee.
4. **Risk desk** — checks the plan against hard gates (notional cap, slippage
   cap) and flags concentration and stale marks.
5. **Red · Slippage** — tries to kill the plan on price impact: thin books,
   spread, size versus depth.
6. **Red · Concentration** — tries to kill it on exposure: single-name and
   correlated bets.
7. **Red · Stale marks** — tries to kill it on trust: how fresh is each price
   the plan relies on?
8. **Red · Policy** — tries to kill any step outside limits and scope.
9. **Judge** — weighs the bull case against every red objection and writes the
   one surviving plan.
10. **Explainer** — briefs you in plain words: what it does, why, and what
    would invalidate it.

The red-team debates **sequentially**: each attacker sees the earlier attacks
and answers them by name, so the transcript reads as one debate, not four
monologues. (Sequential also avoids bursty parallel load against a flaky
provider.)

### Model routing: the right Muse per role

- **Tiers:** gathering roles (scout, simulator, risk, explainer) run on fast
  models; judgment roles (strategist, judge, reds) on stronger ones. An
  optional third tier (`AGENT_DEEP_MODEL`, e.g. `muse-wonder-1.0`) serves
  strategist/judge on deep runs. Defaults: `muse-spark-1.3`.
- **Reasoning:** deep runs give strategist/judge full reasoning effort. Reds
  deliberately stay on low effort — at high effort each one burns up to two
  minutes and the judge starves against the crew deadline. Fast runs skip the
  parameter entirely for lowest latency.
- **Budgets:** per-role output budgets carry reasoning headroom on top, so
  reasoning tokens can never consume the budget and return an empty answer.
- **Structure:** strategist and judge emit `json_schema`-validated proposals;
  prose roles are humanized for the tape while machines keep the raw JSON.

### Tools and cited evidence

Six real tools: `balances`, `prices`, `simulate`, `orders`, `ledger`, `chart`.
Every observation gets an id, and every quantitative claim in the debate cites
one — trace `tool:balances#2` from the tool result to the Judge's citation to
the proposal footnote. One id, three appearances: that is what cited reasoning
looks like. The terminal pins up to two chart tapes as first-class evidence
above the debate, so a two-asset question shows both charts side by side with
the argument that used them.

### What the model cannot touch

After the debate, the model steps aside:

- **Verification** — deterministic code re-checks every action against
  observed facts (holdings, amounts, price freshness) and drops what it can't
  prove.
- **Policy** — ALLOW opens the gate, DRY_RUN means simulate only, DENY locks
  it. The gate is code, not the model.
- **Repair** — malformed model output gets deterministic repair attempts, then
  a safe HOLD. The desk degrades; it never improvises past its cage.
- **Receipts** — every run records per-role model, tokens, and latency, plus
  the verification stamp and policy decision.
- **Keys** — the agent process has never held key material. That lives only
  in the signer, behind the approval service.

### Failure, handled two ways

- **No data:** ask about an asset with no price feed, and the desk says it
  doesn't have the number and holds. It will not invent a chart.
- **Attack:** ask it to move money out (`withdraw everything`, `send it to…`),
  override its instructions, or jailbreak it, and the deterministic fast-path
  refuses with zero roles, zero tools, zero tokens. No prompt is involved, so
  no prompt can override it.

### Memory and threads

Every run joins a thread; follow-ups refine instead of restarting. A desk
memory holds your risk tolerance, watched assets, and recent decisions — the
model reads it before every run, and only you can write it. Reload mid-run,
navigate away, or drop the stream: the page re-attaches from the server log
and the replay looks identical to watching live.

---

## The terminal (frontend)

React SPA: Overview, Markets, Trade, Deposits, Withdrawals, **Agent**,
Activity, Profile — plus a command palette and a persistent agent dock. The
Agent page is a three-column decision cockpit: live debate → proposal + risk →
oversight (memory, confidence ledger, policy gate, past decisions). Demo and
live rails share one session; demo runs read a seeded book and are always
forced to dry-run server-side, so the full crew is safe to run anywhere.

---

## Secrets & configuration

**You configure one thing: the Muse key.** Everything else is automatic.

On first boot the entrypoint generates every secret it needs with Node crypto
(`crypto.randomBytes`, hex) and persists them to `/data/secrets.env` (mode
0600, survives restarts via the volume):

| Secret | Purpose |
|--------|---------|
| `JWT_SECRET` | Session tokens |
| `APP_ENCRYPTION_KEY` | App-level encryption |
| `WALLET_ENCRYPTION_KEY` | Vault decryption (signer only) |
| `SIGNER_SHARED_SECRET` | API ↔ signer auth |
| `APPROVAL_SHARED_SECRET` | API ↔ approval auth |
| `APPROVAL_ED25519_PRIVATE_KEY` | Approval token signing |
| `POSTGRES_PASSWORD` | Database role password |

Precedence per key: explicit `docker run -e` → persisted `/data/secrets.env` →
freshly generated. `docker-start.sh` also imports allowlisted keys from
`backend/.env`, `.env.signer`, `.env.agent`, `.env.approval` (later files win;
topology keys like `DATABASE_URL` are never imported — the container owns its
internals). The first-boot wallet mnemonic is printed once and saved 0600 at
`/data/wallet-init-first-boot.log` — back it up, it can't be shown again.

Agent knobs live in `backend/.env.agent` (see
[`backend/.env.agent.example`](backend/.env.agent.example)): model names,
timeouts, demo mode, and the routing switch. After editing, `down` + `up` to
recreate the container with the new environment. Key references:

| Variable | Default | Meaning |
|----------|---------|---------|
| `MUSE_API_KEY` | (none — degraded without it) | Meta Model API key |
| `MUSE_BASE_URL` | `https://api.meta.ai/v1` | Model endpoint |
| `MUSE_MODEL` | `muse-spark-1.3` | Strong tier (judgment roles) |
| `MUSE_FAST_MODEL` | `muse-spark-1.3` | Fast tier (gathering roles, classifier) |
| `AGENT_DEEP_MODEL` | (empty = strong tier) | Deep tier, e.g. `muse-wonder-1.0` |
| `AGENT_REASONING_EFFORT` | `high` | Reasoning for strategist/judge on deep runs |
| `MUSE_TIMEOUT_MS` | `60000` | Per-attempt model HTTP timeout |
| `AGENT_CREW_DEADLINE_MS` | `120000` | Whole-crew wall-clock deadline |
| `AGENT_DEMO_MODE` | `auto` | `true` = seeded book, `false` = live data |
| `AGENT_CAPABILITY_AI` | `true` | `false` = deterministic routing only |

---

## Repo layout

```
├── Dockerfile                # all-in-one image (frontend + backend + infra)
├── docker-start.sh           # host helper: up/down/logs/demo/...
├── docker/
│   ├── entrypoint.sh         # first-boot init: secrets → postgres → schema → seed → vault → supervisord
│   ├── supervisord-base.conf # redis, signer, api, worker, nginx programs
│   └── nginx-allinone.conf   # single-port liaison (SPA + /api proxy, SSE-safe)
├── backend/
│   ├── src/
│   │   ├── modules/agent/    # the desk: capability.ts, crew/, tools/, policy, transcript, memory
│   │   ├── modules/{auth,trading,deposits,withdrawals,wallets,...}
│   │   ├── services/blockchain/  # 12 networks, HD wallets, vault, sweeps, detectors
│   │   ├── services/{signer,approval,trading}/  # isolated keys, dual control, routers
│   │   ├── jobs/             # BullMQ jobs (scanner, sweeper, monitor, reconcile)
│   │   └── *-entry.ts        # api / signer / approval / agent / worker entrypoints
│   ├── prisma/schema.prisma  # 39 models
│   ├── scripts/              # crew battery, fuzz, live scenarios, readiness checks
│   └── tests/                # jest: unit + integration
├── frontend/
│   ├── src/features/agent/   # cockpit, quant engine, run bus, re-attach
│   ├── src/features/{trade,markets,deposits,withdrawals,...}
│   └── e2e/                  # playwright verification scripts
└── README.md                 # you are here
```

---

## Tests & checks

```bash
# backend (run inside the container or with a local toolchain)
cd backend
npx jest tests/unit/agentQuant.test.ts   # quant engine incl. two-asset routing
npx jest tests/unit                      # unit suite
npx tsc --noEmit                         # typecheck

# frontend
cd frontend
npx tsc --noEmit && npm run build        # typecheck + production bundle

# live crew scenarios against a running stack
npm run crew:battery
```

---

## Stack

- **Backend:** Node 22, Express, Prisma + Postgres, BullMQ + Redis, ethers v6,
  solana/web3.js, bitcoinjs-lib, tronweb, zod, jobs under supervisord
- **Frontend:** React 18, Vite, React Router, pure-SVG charts, SSE streams
- **AI:** Meta Model API (`muse-spark-1.3` default, `muse-wonder-1.0` deep
  tier), `json_schema` structured output, per-role reasoning effort
- **Infra:** single Docker image — Postgres + Redis + 5 Node processes + nginx,
  one published port, one volume

## Notes

- No Muse key? The desk still runs: routing falls back to deterministic rules
  and the UI says so. Add the key for the full debate.
- `AGENT_DEMO_MODE=true` (or the Demo toggle in the UI) reads a seeded book —
  same real crew, always dry-run.
- Every run is replayable from its transcript: reload mid-run, navigate away,
  drop the stream — the page re-attaches from the server log.
