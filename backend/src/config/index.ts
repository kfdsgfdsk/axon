import path from 'path';
import dotenv from 'dotenv';

const root = path.resolve(__dirname, '../..');
const isSigner = process.env.SIGNER_PROCESS === '1';
const isAgentProcess = process.env.AGENT_PROCESS === '1';

// Signer process: load .env.signer FIRST (overrides), then optional shared .env
// Agent process: load .env.agent FIRST, then .env for non-custody config, and
//   strip every custody secret so the AI process can never sign or decrypt keys.
// API/worker: load only .env (must NOT contain WALLET_ENCRYPTION_KEY when SIGNER_URL is set)
if (isSigner) {
  dotenv.config({ path: path.join(root, '.env.signer') });
  dotenv.config({ path: path.join(root, '.env') }); // shared non-secret values (DB, RPCs) if you want
} else if (isAgentProcess) {
  dotenv.config({ path: path.join(root, '.env.agent') });
  dotenv.config({ path: path.join(root, '.env') });
} else {
  dotenv.config({ path: path.join(root, '.env') });
}
if (!isAgentProcess) {
  dotenv.config(); // cwd fallback last
}

// Hard isolation: the agent process must never hold key material or signer secrets.
const AGENT_FORBIDDEN_ENV = [
  'HD_MNEMONIC',
  'MNEMONIC',
  'WALLET_ENCRYPTION_KEY',
  'WALLET_VAULT_KEY',
  'SIGNER_SHARED_SECRET',
  'SIGNER_PRIVATE_KEY',
  'SIGNER_URL',
  'APPROVAL_SIGNER_SECRET',
];
if (isAgentProcess) {
  for (const name of AGENT_FORBIDDEN_ENV) {
    if (process.env[name]) {
      delete process.env[name];
    }
  }
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const ALLOWED_NODE_ENVS = new Set(['development', 'test', 'production', 'staging']);

function resolveNodeEnv(): string {
  const raw = (process.env.NODE_ENV || '').trim().toLowerCase();
  if (!raw) {
    // Fail closed: never silently default in non-explicit boots
    if (process.env.ALLOW_INSECURE_DEV_SECRETS === 'true') {
      return 'development';
    }
    console.error(
      'FATAL: NODE_ENV is unset or empty. Set NODE_ENV to one of: development|test|production|staging'
    );
    process.exit(1);
  }
  if (!ALLOWED_NODE_ENVS.has(raw)) {
    console.error(
      `FATAL: NODE_ENV="${process.env.NODE_ENV}" is not allowed. Use: development|test|production|staging`
    );
    process.exit(1);
  }
  return raw;
}

const nodeEnv = resolveNodeEnv();
const isProdLike = nodeEnv === 'production' || nodeEnv === 'staging';
const allowInsecureDev =
  nodeEnv === 'development' && process.env.ALLOW_INSECURE_DEV_SECRETS === 'true';

function secretEnv(name: string, minLen: number, insecureFallback?: string): string {
  const value = process.env[name];
  if (value && value.length >= minLen && value !== 'fallback_secret_change_me') {
    return value;
  }
  if (allowInsecureDev && insecureFallback) {
    console.warn(
      `WARNING: Using insecure fallback for ${name} because ALLOW_INSECURE_DEV_SECRETS=true`
    );
    return insecureFallback;
  }
  if (isProdLike || !allowInsecureDev) {
    console.error(
      `FATAL: ${name} is missing, too short (min ${minLen}), or is a known weak default. Refuse to start.`
    );
    process.exit(1);
  }
  // development without the flag still refuses weak secrets for JWT/custody
  console.error(
    `FATAL: ${name} required (min ${minLen} chars). For local weak secrets set NODE_ENV=development and ALLOW_INSECURE_DEV_SECRETS=true`
  );
  process.exit(1);
}

const config = {
  env: nodeEnv,
  /** production or staging — treat as prod-like for security fail-closed */
  isProdLike,
  port: parseInt(optionalEnv('PORT', '3000'), 10),

  jwt: {
    secret: secretEnv('JWT_SECRET', 32, 'dev_only_insecure_jwt_secret_change_me_32b'),
    expiresIn: optionalEnv('JWT_EXPIRES_IN', '15m'),
    refreshExpiresIn: optionalEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  bcryptSaltRounds: parseInt(optionalEnv('BCRYPT_SALT_ROUNDS', '12'), 10),
  redisUrl: process.env.REDIS_URL || '',
  databaseUrl: process.env.DATABASE_URL || '',

  wallet: {
    /**
     * 64-char hex = 32 bytes. Loaded optionally at config parse time.
     * Enforced only for the signer process (SIGNER_PROCESS=1) in prod/staging
     * when using the local-insecure vault provider.
     * API/workers must NOT set this when SIGNER_URL is configured (fail-closed).
     * Prefer VAULT_KMS_PROVIDER + envelope encryption in production.
     */
    encryptionKey: optionalEnv(
      'WALLET_ENCRYPTION_KEY',
      allowInsecureDev ? '0'.repeat(64) : ''
    ),
    /** Optional bootstrap only — prefer encrypted storage via wallet:init (signer/offline). */
    masterMnemonic: process.env.MASTER_MNEMONIC || '',
    /**
     * KMS/HSM provider for vault DEK: '' | 'aws' | 'vault'.
     * Production/staging requires a real provider unless ALLOW_INSECURE_LOCAL_VAULT=true.
     */
    kmsProvider: optionalEnv('VAULT_KMS_PROVIDER', ''),
    kmsKeyId: optionalEnv('VAULT_KMS_KEY_ID', ''),
    vaultAddr: optionalEnv('VAULT_ADDR', ''),
    vaultToken: optionalEnv('VAULT_TOKEN', ''),
    vaultTransitKey: optionalEnv('VAULT_TRANSIT_KEY', 'wallet-dek'),
    /**
     * Explicit opt-in for env-based AES-GCM vault key in production/staging.
     * Default false. Prefer KMS envelope encryption.
     */
    allowInsecureLocalVault:
      optionalEnv('ALLOW_INSECURE_LOCAL_VAULT', 'false') === 'true',
  },

  /**
   * Independent signer policy engine.
   * Caps, locked-balance checks, and ApprovalToken verification run inside
   * the signer process BEFORE any sign. Fail closed.
   */
  signerPolicy: {
    /** Feature flag: require short-lived ApprovalToken. Default ON in prod. */
    approvalTokenRequired:
      optionalEnv(
        'SIGNER_APPROVAL_TOKEN_REQUIRED',
        isProdLike ? 'true' : 'false'
      ) === 'true',
    /**
     * Ed25519 public key (base64 or hex) used to verify ApprovalTokens.
     * Private key lives only in the Approval Service / HSM.
     */
    approvalPublicKey: optionalEnv('SIGNER_APPROVAL_PUBLIC_KEY', ''),
    /** Max age of ApprovalToken in seconds. */
    approvalTokenMaxAgeSec: parseInt(
      optionalEnv('SIGNER_APPROVAL_TOKEN_MAX_AGE_SEC', '300'),
      10
    ),
    /**
     * Withdrawals at/under this signer-verified USD notional are exempt from
     * the ApprovalToken requirement (S-H5). The signer re-derives notional
     * from a fresh mark in-process — API status is never trusted. Defaults to
     * the API auto-approve threshold so both tiers agree. 0 = no exemption.
     */
    approvalExemptBelowUsd: parseFloat(
      optionalEnv(
        'SIGNER_APPROVAL_EXEMPT_BELOW_USD',
        optionalEnv('WITHDRAWAL_AUTO_APPROVE_THRESHOLD_USD', '50')
      )
    ),
    /**
     * Per-tx amount caps (JSON): networkId|tokenId → human max amount.
     * Example: {"ethereum":"10","usdt-ethereum":"50000"}
     */
    perTxCaps: parseJsonMap(process.env.SIGNER_PER_TX_CAPS),
    /** Default per-tx native cap (human) when not in map. */
    defaultPerTxNativeCap: optionalEnv('SIGNER_DEFAULT_PER_TX_NATIVE_CAP', '50'),
    /** Default per-tx token cap (human USD-ish). */
    defaultPerTxTokenCap: optionalEnv('SIGNER_DEFAULT_PER_TX_TOKEN_CAP', '100000'),
    /** Per-hour cumulative spend cap (USD approx). 0 = disabled. */
    hourlySpendCapUsd: parseFloat(
      optionalEnv('SIGNER_HOURLY_SPEND_CAP_USD', '500000')
    ),
    /** Per-day cumulative spend cap (USD approx). 0 = disabled. */
    dailySpendCapUsd: parseFloat(
      optionalEnv('SIGNER_DAILY_SPEND_CAP_USD', '2000000')
    ),
    /**
     * Hard-error if SIGNER_SWAP_ALLOWLIST_DISABLED is set in production.
     * Aggregator payloads are always treated as hostile.
     */
    refuseAllowlistDisabledInProd: true,
  },

  /**
   * Approval Service (separate process). Issues short-lived Ed25519 ApprovalTokens
   * after dual-control. API never holds the private key.
   */
  approval: {
    url: optionalEnv('APPROVAL_URL', 'http://127.0.0.1:3200'),
    sharedSecret: optionalEnv('APPROVAL_SHARED_SECRET', ''),
  },

  /**
   * App-level encryption (2FA TOTP secrets, etc.). Must be distinct from WALLET_ENCRYPTION_KEY.
   * Required on API/worker in production/staging; signer may omit it.
   */
  app: {
    encryptionKey: optionalEnv(
      'APP_ENCRYPTION_KEY',
      allowInsecureDev ? '1'.repeat(64) : ''
    ),
  },

  /**
   * Outbound mail transport for recovery/verification emails (S-M12).
   * Empty = stub (logs only in non-prod; DROPS in prod-like with loud errors).
   * Set MAIL_TRANSPORT (e.g. an SMTP/API DSN) and integrate a sender before
   * production — password resets and email verification depend on it.
   */
  mail: {
    transport: optionalEnv('MAIL_TRANSPORT', ''),
  },

  rpc: {
    ethereum: optionalEnv('ETH_RPC_URL', ''),
    sepolia: optionalEnv('SEPOLIA_RPC_URL', ''),
    arbitrum: optionalEnv('ARBITRUM_RPC_URL', ''),
    optimism: optionalEnv('OPTIMISM_RPC_URL', ''),
    base: optionalEnv('BASE_RPC_URL', ''),
    polygon: optionalEnv('POLYGON_RPC_URL', ''),
    bsc: optionalEnv('BSC_RPC_URL', ''),
    avalanche: optionalEnv('AVALANCHE_RPC_URL', ''),
    bitcoinApi: optionalEnv('BITCOIN_API_URL', 'https://mempool.space/api'),
    solana: optionalEnv('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    tronFullHost: optionalEnv('TRON_FULL_HOST', 'https://api.trongrid.io'),
    tronApiKey: optionalEnv('TRON_API_KEY', ''),
  },

  deposit: {
    // Faster default (15s) — scanner is now a safety-net; primary path is webhooks
    scanIntervalMs: parseInt(optionalEnv('DEPOSIT_SCAN_INTERVAL_MS', '15000'), 10),
    // Larger lookback so a lagging cursor can recover without permanent skips
    lookbackBlocks: parseInt(optionalEnv('DEPOSIT_LOOKBACK_BLOCKS', '500'), 10),
    scannerEnabled: optionalEnv('DEPOSIT_SCANNER_ENABLED', 'true') === 'true',
    /**
     * Provider webhooks (primary deposit detection).
     * Alchemy Notify (Address Activity) for EVM; Helius for Solana.
     * When enabled, the block-by-block scanner becomes a safety net only.
     */
    webhooks: {
      alchemy: {
        enabled: optionalEnv('ALCHEMY_WEBHOOK_ENABLED', 'false') === 'true',
        /** Signing key from Alchemy dashboard → Notify → signing key */
        signingKey: optionalEnv('ALCHEMY_WEBHOOK_SIGNING_KEY', ''),
      },
      helius: {
        enabled: optionalEnv('HELIUS_WEBHOOK_ENABLED', 'false') === 'true',
        /** Authorization header value you set when creating the Helius webhook */
        authHeader: optionalEnv('HELIUS_WEBHOOK_AUTH_HEADER', ''),
      },
    },
    /**
     * How many networks to scan at once. Keep this small on free-tier
     * Alchemy/QuickNode (2–4). 1 restores the old sequential behaviour.
     */
    scanConcurrency: Math.max(
      1,
      parseInt(optionalEnv('DEPOSIT_SCAN_CONCURRENCY', '3'), 10) || 1
    ),
    /**
     * How long a newly created deposit address stays active (watched).
     * After this window with no deposit the address is auto-expired and
     * scanning for that network stops (unless other active addresses remain).
     * Default 15 minutes — much cheaper on free RPC tiers than 24 h.
     * Accepts DEPOSIT_ADDRESS_TTL_MINUTES, falls back to old HOURS env for compat.
     */
    addressTtlMinutes: parseInt(
      optionalEnv('DEPOSIT_ADDRESS_TTL_MINUTES', optionalEnv('DEPOSIT_ADDRESS_TTL_HOURS', '15')),
      10
    ),
    /**
     * Sweep CREDITED deposit addresses → hot wallet so trading/withdrawals
     * can use user capital without a house bankroll.
     */
    sweeperEnabled: optionalEnv('DEPOSIT_SWEEPER_ENABLED', 'true') === 'true',
    sweepIntervalMs: parseInt(optionalEnv('DEPOSIT_SWEEP_INTERVAL_MS', '120000'), 10),
    /** Max deposit addresses processed per tick */
    sweepBatchSize: Math.max(
      1,
      parseInt(optionalEnv('DEPOSIT_SWEEP_BATCH_SIZE', '20'), 10) || 20
    ),
    /** Skip native balances below this human amount (per network decimals) */
    sweepMinNative: optionalEnv('DEPOSIT_SWEEP_MIN_NATIVE', '0.0001'),
    /** Skip token balances below this human amount */
    sweepMinToken: optionalEnv('DEPOSIT_SWEEP_MIN_TOKEN', '0.5'),
    /**
     * Max addresses per tick for EVM balance / Multicall3 polling.
     * Round-robins by lastCheckedAt so every watched address is visited.
     */
    balancePollBatchSize: Math.max(
      1,
      parseInt(optionalEnv('DEPOSIT_BALANCE_POLL_BATCH', '50'), 10) || 50
    ),
    /**
     * Prefer Multicall3 (0xcA11…) for native + ERC-20 balance reads on EVM.
     * Falls back to sequential eth_getBalance / balanceOf when multicall fails.
     */
    multicallEnabled: optionalEnv('DEPOSIT_MULTICALL_ENABLED', 'true') === 'true',
    /**
     * Soft-EXPIRED never-funded addresses remain in the scanner watch set for
     * this many days so late payments are still detected. 0 = until CANCELLED
     * (forever). Default 30.
     */
    expiredWatchDays: Math.max(
      0,
      parseInt(optionalEnv('DEPOSIT_EXPIRED_WATCH_DAYS', '30'), 10) || 0
    ),
    /**
     * Native balance-poll excess below this raw (atomic) amount is treated as
     * operational gas top-up: alert only, never auto-credit as a user deposit.
     * Default 0.002 ETH-style (2e15 wei) — override per deployment.
     */
    nativeGasTopUpMaxRaw: optionalEnv('DEPOSIT_NATIVE_GAS_TOPUP_MAX_RAW', '2000000000000000'),
    /**
     * When true, native balance-poll excess only creates CONFIRMING synthetics
     * (never auto-promotes to ledger credit). Real tx / webhook / ops required.
     * Default true (money-safe).
     */
    nativeSyntheticNeverAutoCredit:
      optionalEnv('DEPOSIT_NATIVE_SYNTHETIC_NEVER_AUTO_CREDIT', 'true') === 'true',
  },

  security: {
    /**
     * Comma-separated list of allowed Origins for CSRF / CORS in production.
     * Example: https://app.example.com,https://admin.example.com
     */
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },


  rango: {
    /** Test key from Rango docs — replace with private key in production */
    apiKey: optionalEnv('RANGO_API_KEY', 'c6381a79-2817-4602-83bf-6a641a409e32'),
    baseUrl: optionalEnv('RANGO_BASE_URL', 'https://public-api.rango.exchange'),
    defaultSlippage: parseFloat(optionalEnv('RANGO_DEFAULT_SLIPPAGE', '1.5')),
    /** Affiliate fee % (max 3) */
    referrerFee: optionalEnv('RANGO_REFERRER_FEE', '0.1'),
    referrerAddress: process.env.RANGO_REFERRER_ADDRESS || '',
  },

  trading: {
    /** Job interval for TP/SL + emergency checks (ms). Prefer 1000–5000 for active books. */
    monitorIntervalMs: parseInt(optionalEnv('TRADE_MONITOR_INTERVAL_MS', '5000'), 10),
    /**
     * Open orders / beginner positions / emergency rows loaded per page.
     * The monitor walks every page; this only bounds memory and IN-list size.
     */
    monitorBatchSize: Math.max(
      1,
      parseInt(optionalEnv('TRADE_MONITOR_BATCH_SIZE', '100'), 10) || 100
    ),
    /**
     * Percent band around TP/SL. 0 (default) evaluates every open position.
     * When > 0, positions whose fresh shared mark is farther than this from
     * every trigger — and not already through one — skip the price fetch.
     * Positions already through a trigger are always evaluated.
     */
    monitorNearBandPct: parseFloat(optionalEnv('TRADE_MONITOR_NEAR_BAND_PCT', '3')) || 0,
    /**
     * When near-band filter skips a position, defer its nextCheckAt by this many ms.
     * Default 15s — keeps far positions out of the hot scan at 10k–50k scale.
     * Production tip: 15_000–60_000 with TRADE_MONITOR_NEAR_BAND_PCT=2–5.
     */
    monitorFarDeferMs: parseInt(optionalEnv('TRADE_MONITOR_FAR_DEFER_MS', '15000'), 10),
    /** Max open conditional orders per user */
    maxOpenOrdersPerUser: parseInt(optionalEnv('TRADE_MAX_OPEN_ORDERS', '20'), 10),
    /** Max concurrent SSE price-stream connections per user (default 3) */
    maxSseConnectionsPerUser: parseInt(optionalEnv('TRADE_MAX_SSE_PER_USER', '3'), 10) || 3,
    /** Default emergency drop % */
    defaultEmergencyDropPct: optionalEnv('TRADE_EMERGENCY_DROP_PCT', '15'),
    /** Ledger-only fills (no on-chain broadcast) */
    simulate: optionalEnv('TRADING_SIMULATE', 'false') === 'true',
    /** Global kill switch — checked before open/execute */
    paused: optionalEnv('TRADING_PAUSED', 'false') === 'true',
    /**
     * Global floor for swap notional in USD (hot wallet pays gas — reject dust).
     * Effective min is max(this, estimatedGasCostUsd[network] * gasNotionalMultiplier).
     * Fail closed if mark missing when evaluating.
     */
    minSwapNotionalUsd: parseFloat(optionalEnv('TRADE_MIN_SWAP_NOTIONAL_USD', '25')),
    /**
     * Minimum protocol fee in USD collected on every swap (market + conditional).
     * Ensures the platform never pays more in gas than it earns in fees.
     * Effective fee = max(this, estimatedGas * gasMarginMultiplier, notional * swapFeeBps/10000).
     */
    minSwapFeeUsd: parseFloat(optionalEnv('TRADE_MIN_SWAP_FEE_USD', '2')),
    /**
     * Protocol fee in bps of fromAmount. Applied after minSwapFeeUsd floor.
     * Default 30 bps (0.3%). Set 0 to rely only on minSwapFeeUsd + gas floor.
     */
    swapFeeBps: parseInt(optionalEnv('TRADE_SWAP_FEE_BPS', '30'), 10),
    /**
     * Conservative estimated hot-wallet gas cost in USD per network for a typical swap/withdraw.
     * Used to reject economically negative operations. Override via TRADE_GAS_COST_USD_JSON.
     */
    estimatedGasCostUsdByNetwork: (() => {
      const defaults: Record<string, number> = {
        ethereum: 12,
        sepolia: 0.05, // testnet — negligible real cost
        arbitrum: 0.4,
        optimism: 0.4,
        base: 0.4,
        polygon: 0.25,
        bsc: 0.4,
        avalanche: 0.5,
      };
      const raw = process.env.TRADE_GAS_COST_USD_JSON;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, number>;
          return { ...defaults, ...parsed };
        } catch {
          /* keep defaults */
        }
      }
      return defaults;
    })(),
    /** Fallback gas estimate (USD) when network not in map */
    estimatedGasCostUsdDefault: parseFloat(
      optionalEnv('TRADE_GAS_COST_USD_DEFAULT', '5')
    ),
    /**
     * Multiplier on estimated gas for fee floor (fee >= gas * this).
     * >1 builds margin for gas spikes / failed txs / MEV.
     */
    gasMarginMultiplier: parseFloat(optionalEnv('TRADE_GAS_MARGIN_MULTIPLIER', '1.5')),
    /**
     * Min notional must be at least estimatedGas * this (so % fees can cover gas).
     */
    gasNotionalMultiplier: parseFloat(optionalEnv('TRADE_GAS_NOTIONAL_MULTIPLIER', '4')),
    /** In-memory / Redis price cache TTL */
    priceCacheTtlMs: parseInt(optionalEnv('TRADE_PRICE_CACHE_TTL_MS', '15000'), 10),
    /**
     * Reject open/close/TP/SL/conditional fire when mark older than this (ms).
     * Default 3s — marks are triggers only, not payout oracles; fail closed on stale.
     */
    maxStalePriceMs: parseInt(optionalEnv('TRADE_MAX_STALE_PRICE_MS', '3000'), 10),
    /** Per-source HTTP timeout for price fetches */
    priceFetchTimeoutMs: parseInt(optionalEnv('TRADE_PRICE_FETCH_TIMEOUT_MS', '2500'), 10),
    /**
     * Server-side hard cap on client slippage % (clamped; never trust client 50%).
     * Default 1.5. Exit paths may still use exitSlippagePct when preferFastExit.
     */
    maxSlippagePct: parseFloat(optionalEnv('TRADE_MAX_SLIPPAGE_PCT', '1.5')),
    /**
     * Optional min hold time (ms) before TP can fire on a beginner position / conditional.
     * 0 = disabled. Reduces instant flip-trigger abuse.
     */
    minHoldTimeMs: parseInt(optionalEnv('TRADE_MIN_HOLD_TIME_MS', '60000'), 10),
    /**
     * Trigger buffer in basis points applied to TP fire (more conservative).
     * Default 10 = require mark 10 bps through TP before firing. Not a ledger fill price.
     */
    triggerSpreadBps: parseFloat(optionalEnv('TRADE_TRIGGER_SPREAD_BPS', '10')) || 0,
    /**
     * When true, network price refresh must see two sources agreeing within
     * priceCrossCheckMaxBps (hub/cache single fresh hit still allowed).
     */
    priceRequireTwoSources: optionalEnv('TRADE_PRICE_REQUIRE_TWO_SOURCES', 'true') === 'true',
    /** Max deviation (bps) between two sources. Default 50 = 0.50%. */
    priceCrossCheckMaxBps: parseFloat(optionalEnv('TRADE_PRICE_CROSS_CHECK_MAX_BPS', '50')) || 50,
    /** Optional CoinGecko Pro key */
    coingeckoApiKey: process.env.COINGECKO_API_KEY || '',
    /** Pyth Hermes base URL (e.g. https://hermes.pyth.network) */
    pythHermesUrl: optionalEnv('PYTH_HERMES_URL', 'https://hermes.pyth.network'),
    /** Parallel quote timeout per router */
    quoteTimeoutMs: parseInt(optionalEnv('TRADE_QUOTE_TIMEOUT_MS', '4000'), 10),
    /** Comma order of preferred routers for same-chain (jupiter,zerox,rango) */
    routerOrder: optionalEnv('TRADE_ROUTER_ORDER', 'jupiter,zerox,rango')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    /** Circuit-breaker: consecutive failures before skip */
    routerCircuitFailures: parseInt(optionalEnv('TRADE_ROUTER_CIRCUIT_FAILURES', '5'), 10),
    /** Circuit-breaker open duration (ms) */
    routerCircuitOpenMs: parseInt(optionalEnv('TRADE_ROUTER_CIRCUIT_OPEN_MS', '60000'), 10),
    /** Optional 0x API key */
    zeroxApiKey: process.env.ZEROX_API_KEY || '',
    /**
     * Extra slippage % for stop-loss / emergency exits (fast fill preference).
     * Applied as max(defaultSlippage, exitSlippagePct) when executing conditional exits.
     * Still subject to operational judgment; not used as a ledger fill price.
     */
    exitSlippagePct: parseFloat(optionalEnv('TRADE_EXIT_SLIPPAGE_PCT', '2.5')),
    /**
     * Soft timeout (ms) for background executeSwapForOrder kicked from the monitor.
     * Monitor does not await the full chain wait — work continues in background.
     */
    executeBackgroundTimeoutMs: parseInt(
      optionalEnv('TRADE_EXECUTE_BG_TIMEOUT_MS', '180000'),
      10
    ),
    /**
     * Max concurrent executeSwapForOrder runs in one process (global).
     * Excess triggers are deferred (order stays TRIGGERED/EXECUTING for next tick).
     */
    maxConcurrentExecutes: Math.max(
      1,
      parseInt(optionalEnv('TRADE_MAX_CONCURRENT_EXECUTES', '8'), 10) || 8
    ),
    /**
     * Max concurrent executes per source chain within one process (nonce safety).
     * Cross-process nonce safety still requires a single signer or external lock.
     */
    maxConcurrentExecutesPerChain: Math.max(
      1,
      parseInt(optionalEnv('TRADE_MAX_CONCURRENT_EXECUTES_PER_CHAIN', '2'), 10) || 2
    ),

    // ---- Price hub ----
    /** Minutes of ring-buffer history kept per asset for line charts */
    priceHubHistoryMinutes: parseInt(optionalEnv('PRICE_HUB_HISTORY_MINUTES', '30'), 10),
    /** Max history points per asset (hard cap) */
    priceHubMaxPoints: parseInt(optionalEnv('PRICE_HUB_MAX_POINTS', '500'), 10),
    /**
     * Replicate latest marks through Redis when REDIS_URL is set.
     * Set PRICE_HUB_REDIS=false to force in-memory even if Redis is configured
     * (token blacklist still uses Redis).
     */
    priceHubRedisEnabled: optionalEnv('PRICE_HUB_REDIS', 'true') === 'true',
    /** TTL for a shared mark. Should exceed TRADE_MAX_STALE_PRICE_MS. */
    priceHubRedisTtlMs: parseInt(optionalEnv('PRICE_HUB_REDIS_TTL_MS', '180000'), 10),
    /**
     * Price-driven TP/SL trigger index (onMark from publishPrice).
     * When true, mark updates evaluate only relevant OPEN conditionals immediately.
     * Polling monitor remains as a safety net.
     */
    triggerIndexEnabled: optionalEnv('TRADE_TRIGGER_INDEX_ENABLED', 'true') === 'true',
    /**
     * Debounce rapid ticks per asset before running onMark evaluation (ms).
     * 0 = no debounce. 50–100 recommended under high tick rates.
     */
    triggerIndexDebounceMs: parseInt(optionalEnv('TRADE_TRIGGER_INDEX_DEBOUNCE_MS', '50'), 10),
    /** REST ticker poll interval for Tier-1 symbols */
    priceRestRefreshMs: parseInt(optionalEnv('PRICE_REST_REFRESH_MS', '1000'), 10),
    /**
     * Binance WebSocket is the PRIMARY price path (sub-second trade stream).
     * The REST refresher only fills gaps for symbols without a fresh WS mark.
     * Set PRICE_BINANCE_WS_ENABLED=false to run REST-only (degraded).
     */
    priceBinanceWsEnabled: optionalEnv('PRICE_BINANCE_WS_ENABLED', 'true') === 'true',
    /**
     * Comma-separated Binance symbols for Tier-1 hub (WS + REST).
     * Default covers majors + liquid alts. Expand carefully — combined stream
     * has practical limits; prefer PRICE_BINANCE_SYMBOL_MAP for extra mappings.
     */
    priceBeginnerSymbols: optionalEnv(
      'PRICE_BEGINNER_SYMBOLS',
      [
        'BTCUSDT',
        'ETHUSDT',
        'SOLUSDT',
        'BNBUSDT',
        'AVAXUSDT',
        'MATICUSDT',
        'POLUSDT',
        'TRXUSDT',
        'DOGEUSDT',
        'ADAUSDT',
        'XRPUSDT',
        'LINKUSDT',
        'DOTUSDT',
        'LTCUSDT',
        'ATOMUSDT',
        'NEARUSDT',
        'APTUSDT',
        'ARBUSDT',
        'OPUSDT',
        'SUIUSDT',
        'PEPEUSDT',
        'WIFUSDT',
        'RENDERUSDT',
        'INJUSDT',
        'TIAUSDT',
        'SEIUSDT',
        'JUPUSDT',
        'WLDUSDT',
        'FETUSDT',
        'FILUSDT',
        'AAVEUSDT',
        'UNIUSDT',
        'LDOUSDT',
      ].join(',')
    )
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),

    // ---- Tier-2 watched refresh ----
    /** Enable background refresh for watched / open-order tokens */
    priceTier2Enabled: optionalEnv('PRICE_TIER2_ENABLED', 'true') === 'true',
    /** Interval for Tier-2 batch refresh (ms). 5000–15000 recommended. */
    priceTier2RefreshMs: parseInt(optionalEnv('PRICE_TIER2_REFRESH_MS', '10000'), 10),
    /** Max assets per Tier-2 CoinGecko batch */
    priceTier2MaxBatch: parseInt(optionalEnv('PRICE_TIER2_MAX_BATCH', '80'), 10),
    /** TTL for frontend watch registrations (ms) */
    priceWatchTtlMs: parseInt(optionalEnv('PRICE_WATCH_TTL_MS', '120000'), 10),
    /** Soft cap on concurrent watched hub keys */
    priceWatchMaxKeys: parseInt(optionalEnv('PRICE_WATCH_MAX_KEYS', '200'), 10),
  },

  twofa: {
    issuer: optionalEnv('TWOFA_ISSUER', 'CryptoExchange'),
    emailOtpEnabled: optionalEnv('TWOFA_EMAIL_OTP_ENABLED', 'true') === 'true',
    smsOtpEnabled: optionalEnv('TWOFA_SMS_OTP_ENABLED', 'false') === 'true',
    smtp: process.env.SMTP_HOST
      ? {
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || '587', 10),
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
          from: process.env.SMTP_FROM || 'noreply@example.com',
        }
      : null,
  },

  withdrawal: {
    /**
     * Auto-approve below this USD notional (not native units).
     * Fail closed if mark price unavailable when evaluating.
     */
    autoApproveThresholdUsd: parseFloat(
      optionalEnv('WITHDRAWAL_AUTO_APPROVE_THRESHOLD_USD', '50')
    ),
    /** Legacy native-unit threshold — ignored; kept for env compat logging only */
    autoApproveThreshold: optionalEnv('WITHDRAWAL_AUTO_APPROVE_THRESHOLD', '0.5'),
    /** Per-user daily withdrawal cap in USD notional */
    dailyCapUsd: parseFloat(optionalEnv('WITHDRAWAL_DAILY_CAP_USD', '10000')),
    /** Per-user hourly auto-approve / withdrawal notional cap (USD) */
    hourlyCapUsd: parseFloat(optionalEnv('WITHDRAWAL_HOURLY_CAP_USD', '2000')),
    /**
     * Global hot-wallet outflow velocity caps (sum of APPROVED+PROCESSING+COMPLETED
     * notional USD across all users). Prevents drain via many small auto-approves.
     */
    globalHourlyOutflowUsd: parseFloat(
      optionalEnv('WITHDRAWAL_GLOBAL_HOURLY_OUTFLOW_USD', '50000')
    ),
    globalDailyOutflowUsd: parseFloat(
      optionalEnv('WITHDRAWAL_GLOBAL_DAILY_OUTFLOW_USD', '200000')
    ),
    /** Hours before a newly added whitelist address can receive withdrawals */
    addressCooldownHours: parseInt(
      optionalEnv('WITHDRAWAL_ADDRESS_COOLDOWN_HOURS', '24'),
      10
    ),
    /** If true, APPROVED withdrawals are broadcast immediately */
    autoProcess: optionalEnv('WITHDRAWAL_AUTO_PROCESS', 'true') === 'true',
    /**
     * USD-denominated defaults (converted to token units via mark price).
     * Native-unit defaults (0.001) were unsafe for USDT/WBTC.
     * Fee floor is also raised to cover estimated gas * margin so we never
     * process a withdrawal that costs the hot wallet more than the fee earned.
     */
    defaultFeeUsd: parseFloat(optionalEnv('WITHDRAWAL_DEFAULT_FEE_USD', '3')),
    defaultMinUsd: parseFloat(optionalEnv('WITHDRAWAL_DEFAULT_MIN_USD', '15')),
    /** Legacy native-unit fallbacks — only used if mark price unavailable (should not happen) */
    defaultFee: optionalEnv('WITHDRAWAL_DEFAULT_FEE', '0.001'),
    defaultMinAmount: optionalEnv('WITHDRAWAL_DEFAULT_MIN', '0.001'),
    defaultMaxAmount: optionalEnv('WITHDRAWAL_DEFAULT_MAX', '100'),
    /** Per-network overrides (JSON string or leave empty) */
    feeByNetwork: parseJsonMap(process.env.WITHDRAWAL_FEE_BY_NETWORK),
    minAmountByNetwork: parseJsonMap(process.env.WITHDRAWAL_MIN_BY_NETWORK),
    maxAmountByNetwork: parseJsonMap(process.env.WITHDRAWAL_MAX_BY_NETWORK),
    /**
     * When true (default), withdrawal fee is at least
     * estimatedGasCostUsd[network] * trading.gasMarginMultiplier.
     */
    enforceGasBackedFee: optionalEnv('WITHDRAWAL_ENFORCE_GAS_BACKED_FEE', 'true') === 'true',
    /** Circuit breaker: pause withdrawals when custody inventory reports insolvency */
    pauseOnInsolvency: optionalEnv('WITHDRAWAL_PAUSE_ON_INSOLVENCY', 'true') === 'true',
  },

  /**
   * Custody inventory (insolvency circuit breaker) + hot/cold separation.
   * Deposit addresses sweep → hot; excess above target is transferred to an
   * external cold multisig (Safe/MPC). Cold destinations are config/env only.
   */
  custody: {
    /**
     * Relative gap (liability - onChain) / liability above which a slice is
     * treated as insolvent for circuit-breaker purposes. Tunable to reduce
     * false positives from unswept deposits (on-chain includes deposit addresses).
     */
    insolvencyGapRatio: parseFloat(optionalEnv('CUSTODY_INSOLVENCY_GAP_RATIO', '0.05')),
    /** Absolute human-unit gap floor before flagging (avoids noise on dust) */
    insolvencyMinGap: parseFloat(optionalEnv('CUSTODY_INSOLVENCY_MIN_GAP', '0.01')),
    /** Consecutive insolvent reconcile ticks before pausing trading+withdrawals */
    insolvencyPauseAfterTicks: parseInt(
      optionalEnv('CUSTODY_INSOLVENCY_PAUSE_AFTER_TICKS', '2'),
      10
    ),
    /**
     * Max deposit addresses to sample per EVM network inventory scan.
     * 0 (default) = scan all, batched via multicall. Positive N = hard cap
     * (legacy behaviour for RPC-cost control). Env: CUSTODY_MAX_DEPOSIT_SAMPLE
     */
    maxDepositAddressesSample: parseInt(
      optionalEnv('CUSTODY_MAX_DEPOSIT_SAMPLE', '0'),
      10
    ),
    /**
     * When true (default), unsupported chain types (if any are ever added)
     * emit alert-only slices and never increment insolventCount / trip the
     * circuit breaker. Env: CUSTODY_ALERT_ONLY_UNSUPPORTED
     */
    alertOnlyUnsupportedChains:
      optionalEnv('CUSTODY_ALERT_ONLY_UNSUPPORTED', 'true') === 'true',
    /**
     * When true (default), true measured insolvency also pauses trading
     * (in addition to withdrawals). Set false to pause withdrawals only.
     * Env: CUSTODY_PAUSE_TRADING_ON_INSOLVENCY
     */
    pauseTradingOnInsolvency:
      optionalEnv('CUSTODY_PAUSE_TRADING_ON_INSOLVENCY', 'true') === 'true',

    // ── Hot / cold separation (H1) ─────────────────────────────────────────
    /** Target hot-wallet balance in USD equivalent (approx). Excess → cold. */
    hotTargetBalanceUsd: parseFloat(
      optionalEnv('HOT_TARGET_BALANCE_USD', '50000')
    ),
    /**
     * Per-asset hot target overrides (JSON map: tokenId|native:networkId → human amount).
     * Example: {"native:ethereum":"5","usdt-ethereum":"10000"}
     */
    hotTargetBalances: parseJsonMap(process.env.HOT_TARGET_BALANCE),
    /** Native gas reserve left on hot after cold sweep (human units). */
    hotMinReserve: optionalEnv('HOT_MIN_RESERVE', '0.05'),
    /** Master switch for excess→cold transfers. Default true in prod. */
    coldSweepEnabled:
      optionalEnv(
        'COLD_SWEEP_ENABLED',
        isProdLike ? 'true' : 'false'
      ) === 'true',
    /**
     * Per-network cold destination (Safe / MPC multisig). Immutable at runtime.
     * JSON map: networkId → address. Env: COLD_DESTINATION_JSON
     * Or per-network: COLD_DESTINATION_ETHEREUM=0x...
     */
    coldDestinations: (() => {
      const fromJson = parseJsonMap(process.env.COLD_DESTINATION_JSON);
      const out: Record<string, string> = { ...fromJson };
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('COLD_DESTINATION_') && k !== 'COLD_DESTINATION_JSON') {
          const net = k
            .replace('COLD_DESTINATION_', '')
            .toLowerCase()
            .replace(/_/g, '-');
          if (v && v.trim()) out[net] = v.trim();
        }
      }
      return out;
    })(),
  },

  /**
   * Background jobs. Default keeps today's single-process behaviour
   * (jobs inside the API). Production split: RUN_JOBS_IN_API=false and
   * run `npm run worker:start`. Do not run both or scans/monitors double.
   */
  jobs: {
    runJobsInApi: optionalEnv('RUN_JOBS_IN_API', 'true') === 'true',
    /**
     * Trade monitor historically ran as its own script (`job:trade-monitor`),
     * not inside server.ts. Default false preserves that. The worker always
     * runs it. Set true only when you want one process and are NOT also
     * running the worker or job:trade-monitor.
     */
    runTradeMonitorInApi: optionalEnv('RUN_TRADE_MONITOR_IN_API', 'false') === 'true',
  },

  /**
   * Isolated Signer Service configuration.
   * SECURITY: Prefer mode=isolated (default). Use legacy only during migration.
   * When signer.url is set, the API calls a separate process over localhost HTTP + HMAC.
   * When url is empty, isolated mode may fall back to in-process only if
   * SIGNER_ALLOW_INPROCESS=true (or non-prod). That collapses the key boundary.
   *
   * Process model:
   *   API/worker: SIGNER_URL=http://127.0.0.1:3100, SIGNER_SHARED_SECRET=..., NO WALLET_ENCRYPTION_KEY
   *   Signer:     SIGNER_PROCESS=1 (set by signer-entry), WALLET_ENCRYPTION_KEY=..., SIGNER_HOST=127.0.0.1
   */
  signer: {
    /** 'isolated' (default) | 'legacy' */
    mode: (optionalEnv('SIGNER_MODE', 'isolated').toLowerCase() === 'legacy'
      ? 'legacy'
      : 'isolated') as 'legacy' | 'isolated',
    /** e.g. http://127.0.0.1:3100 — empty = in-process (dev or SIGNER_ALLOW_INPROCESS) */
    url: optionalEnv('SIGNER_URL', ''),
    /** Shared secret for HMAC auth between API and remote signer */
    sharedSecret: optionalEnv('SIGNER_SHARED_SECRET', ''),
    /** Port when running signer as separate process */
    port: parseInt(optionalEnv('SIGNER_PORT', '3100'), 10),
    /** Bind address for signer HTTP server (keep localhost) */
    host: optionalEnv('SIGNER_HOST', '127.0.0.1'),
    /** Client timeout for remote signer calls (ms) */
    timeoutMs: parseInt(optionalEnv('SIGNER_TIMEOUT_MS', '120000'), 10),
    /**
     * Max time to await on-chain confirmation after sendTransaction / sendRawTransaction.
     * Hash is persisted before this wait; on timeout the order stays EXECUTING.
     * Keep below or near SIGNER_TIMEOUT_MS so remote clients are less likely to 504
     * while the signer is still waiting (hash is already durable either way).
     */
    txWaitTimeoutMs: parseInt(optionalEnv('SIGNER_TX_WAIT_TIMEOUT_MS', '90000'), 10),
  },

  /**
   * AI Agent / Muse layer
   * Muse never moves money. Dry-run is the default.
   */
  agent: {
    enabled: optionalEnv('AGENT_ENABLED', 'true') === 'true',
    /** Hard kill switch — all agent routes DENY when true */
    killSwitch: optionalEnv('AGENT_KILL_SWITCH', 'false') === 'true',
    /** Default dry-run for intelligent actions */
    dryRunDefault: optionalEnv('AGENT_DRY_RUN_DEFAULT', 'true') !== 'false',
    /** Ops flag: allow Policy Engine to issue ALLOW for live execution */
    allowLiveExecution: optionalEnv('AGENT_ALLOW_LIVE_EXECUTION', 'false') === 'true',
    modelApiKey:
      process.env.MODEL_API_KEY ||
      process.env.MUSE_API_KEY ||
      process.env.MODEL_API_KEY_MUSE ||
      '',
    modelBaseUrl: optionalEnv(
      'MODEL_BASE_URL',
      optionalEnv('MUSE_BASE_URL', 'https://api.meta.ai/v1')
    ),
    modelName: optionalEnv('MODEL_NAME', optionalEnv('MUSE_MODEL', 'muse-spark-1.3')),
    /** Optional role-based routing (fast tier for scout/simulator/explainer). */
    fastModel: optionalEnv('MODEL_FAST_NAME', optionalEnv('MUSE_FAST_MODEL', '')),
    strongModel: optionalEnv(
      'MODEL_STRONG_NAME',
      optionalEnv('MUSE_MODEL', optionalEnv('MODEL_NAME', 'muse-spark-1.3'))
    ),
    /**
     * Deep-reasoning model for strategist/judge/red-team on deep crew runs.
     * Recommended: muse-wonder-1.0 (Meta's most capable model). Empty = strongModel.
     */
    deepModel: optionalEnv('AGENT_DEEP_MODEL', ''),
    /**
     * Reasoning effort for deep runs (minimal|low|medium|high|xhigh|max).
     * Sent as top-level `reasoning_effort` on Chat Completions per
     * https://dev.meta.ai/docs/reasoning. Fast runs skip the param (lowest
     * latency); deep strategist/judge/red-team use this, other roles use low.
     */
    reasoningEffort: optionalEnv('AGENT_REASONING_EFFORT', 'high'),
    /**
     * Per-attempt model HTTP timeout (ms). Tune via MUSE_TIMEOUT_MS (or
     * MODEL_TIMEOUT_MS). Observed live: the provider sometimes hangs past 60s
     * or returns 200-with-empty-choices; the client aborts at this ceiling,
     * retries 3x with backoff, then degrades honestly to HOLD (never fake
     * output). The crew may pass a smaller per-call timeoutMs as its deadline
     * approaches. Raise for slow/strong models, lower for tighter SSE latency.
     */
    modelTimeoutMs: parseInt(
      optionalEnv('MODEL_TIMEOUT_MS', optionalEnv('MUSE_TIMEOUT_MS', '60000')),
      10
    ) || 60_000,
    /** auto = demo when no key, live when key present. true = always demo, false = require live. */
    demoMode: optionalEnv('AGENT_DEMO_MODE', 'auto'),
    /**
     * Structured output for strategist/judge via response_format json_schema
     * (https://dev.meta.ai/docs/structured-output), downgrading to
     * json_object and then plain JSON on HTTP 400. Default on: decoding is
     * constrained to the Proposal schema, so brittle repair parsing is a
     * fallback rather than the plan.
     */
    jsonMode: optionalEnv('AGENT_JSON_MODE', 'true') !== 'false',
    maxToolRounds: parseInt(optionalEnv('AGENT_MAX_TOOL_ROUNDS', '5'), 10) || 5,
    crewDeadlineMs: parseInt(optionalEnv('AGENT_CREW_DEADLINE_MS', '120000'), 10) || 120_000,
    maxActions: parseInt(optionalEnv('AGENT_MAX_ACTIONS', '10'), 10) || 10,
    // NOTE: approval service owns 3200 — the agent defaults to 3220 so both
    // start cleanly with stock env (F-A0).
    port: parseInt(optionalEnv('AGENT_PORT', '3220'), 10) || 3220,
    /** Set by the standalone agent entrypoint; used for isolation guards. */
    standalone: isAgentProcess,
    rateLimitWindowMs: parseInt(optionalEnv('AGENT_RATE_LIMIT_WINDOW_MS', '60000'), 10) || 60_000,
    rateLimitMax: parseInt(optionalEnv('AGENT_RATE_LIMIT_MAX', '30'), 10) || 30,
    maxNotionalUsd: parseFloat(optionalEnv('AGENT_MAX_NOTIONAL_USD', '10000')) || 10_000,
    maxSlippageBps: parseInt(optionalEnv('AGENT_MAX_SLIPPAGE_BPS', '100'), 10) || 100,
  },
};

function parseJsonMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

// Production/staging hard checks (also enforced earlier via secretEnv / resolveNodeEnv)
const isSignerProcess = process.env.SIGNER_PROCESS === '1';
const hasRemoteSigner = Boolean(config.signer.url && String(config.signer.url).trim());

if (isProdLike) {
  if (!config.databaseUrl) {
    console.error('FATAL: DATABASE_URL is required in production/staging');
    process.exit(1);
  }
  if (!isSignerProcess && config.security.allowedOrigins.length === 0) {
    console.error('FATAL: ALLOWED_ORIGINS must be set in production/staging for CSRF/CORS');
    process.exit(1);
  }
  if (config.signer.mode === 'isolated' && hasRemoteSigner) {
    if (!config.signer.sharedSecret || config.signer.sharedSecret.length < 32) {
      console.error(
        'FATAL: SIGNER_SHARED_SECRET (min 32 chars) required when SIGNER_URL is set in production/staging'
      );
      process.exit(1);
    }
  }

  // --- Wallet key process boundary ---
  // Signer process: KMS provider OR (ALLOW_INSECURE_LOCAL_VAULT + WALLET_ENCRYPTION_KEY).
  // API/worker with SIGNER_URL: MUST NOT have WALLET_ENCRYPTION_KEY (fail-closed misconfig).
  // API/worker without SIGNER_URL: only allowed with SIGNER_ALLOW_INPROCESS=true AND the key
  //   (collapses the boundary — not recommended).
  if (isSignerProcess) {
    const hasKms =
      Boolean(config.wallet.kmsProvider && config.wallet.kmsProvider.trim()) ||
      Boolean(process.env.VAULT_KMS_PROVIDER && process.env.VAULT_KMS_PROVIDER.trim());
    const allowInsecureLocal = config.wallet.allowInsecureLocalVault === true;
    if (!hasKms && !allowInsecureLocal) {
      console.error(
        'FATAL: Signer process in production/staging requires VAULT_KMS_PROVIDER (aws|vault) ' +
          'or explicit ALLOW_INSECURE_LOCAL_VAULT=true (not recommended).'
      );
      process.exit(1);
    }
    if (!hasKms && allowInsecureLocal) {
      if (!config.wallet.encryptionKey || config.wallet.encryptionKey.length !== 64) {
        console.error(
          'FATAL: ALLOW_INSECURE_LOCAL_VAULT=true requires WALLET_ENCRYPTION_KEY as 64-char hex'
        );
        process.exit(1);
      }
      console.warn(
        'WARNING: ALLOW_INSECURE_LOCAL_VAULT=true — vault key from env. Prefer KMS envelope encryption.'
      );
    }
  } else {
    if (hasRemoteSigner) {
      if (config.wallet.encryptionKey && config.wallet.encryptionKey.length > 0) {
        console.error(
          'FATAL: WALLET_ENCRYPTION_KEY must not be set on the API/worker when SIGNER_URL is configured. ' +
            'Only the signer process may hold the wallet vault key (process boundary).'
        );
        process.exit(1);
      }
    } else {
      // In-process fallback in prod collapses isolation
      if (process.env.SIGNER_ALLOW_INPROCESS !== 'true') {
        console.error(
          'FATAL: SIGNER_URL is required in production/staging (or set SIGNER_ALLOW_INPROCESS=true, which collapses the key boundary)'
        );
        process.exit(1);
      }
      if (!config.wallet.encryptionKey || config.wallet.encryptionKey.length !== 64) {
        console.error(
          'FATAL: In-process signer (SIGNER_ALLOW_INPROCESS) requires WALLET_ENCRYPTION_KEY as 64-char hex'
        );
        process.exit(1);
      }
      console.warn(
        'WARNING: SIGNER_ALLOW_INPROCESS=true — API/worker holds WALLET_ENCRYPTION_KEY. Prefer a remote signer.'
      );
    }

    // App encryption key required on API/worker (2FA, etc.)
    if (!config.app.encryptionKey || config.app.encryptionKey.length !== 64) {
      console.error(
        'FATAL: APP_ENCRYPTION_KEY must be a 64-char hex (32 bytes) on API/worker in production/staging ' +
          '(used for 2FA secrets; must be distinct from WALLET_ENCRYPTION_KEY)'
      );
      process.exit(1);
    }
    // L10: reusing the wallet key for 2FA/app secrets (or vice versa) breaks
    // the blast-radius separation between custody and app cryptography.
    if (
      config.wallet.encryptionKey &&
      config.wallet.encryptionKey === config.app.encryptionKey
    ) {
      console.error(
        'FATAL: WALLET_ENCRYPTION_KEY and APP_ENCRYPTION_KEY must be distinct in production/staging'
      );
      process.exit(1);
    }
    if (!config.mail.transport) {
      console.error(
        'WARNING: MAIL_TRANSPORT is unset — password resets and email verification emails will be DROPPED in production. ' +
          'Withdrawals require a verified email: set MAIL_TRANSPORT and integrate a sender (S-M12).'
      );
    }
  }
}

if (isProdLike && (config.trading.simulate || process.env.TRADING_SIMULATE === 'true')) {
  console.error(
    'FATAL: TRADING_SIMULATE=true is forbidden in production/staging (credits without on-chain tx)'
  );
  process.exit(1);
}


// Rango public test key must not be used in production/staging
const RANGO_PUBLIC_TEST_KEY = 'c6381a79-2817-4602-83bf-6a641a409e32';
if (isProdLike && config.rango.apiKey === RANGO_PUBLIC_TEST_KEY) {
  console.error(
    'FATAL: RANGO_API_KEY is still the public test key. Set a private Rango API key for production/staging.'
  );
  process.exit(1);
}

export default config;