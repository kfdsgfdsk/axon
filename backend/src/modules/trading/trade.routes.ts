import { Router } from 'express';
import {
  quote,
  marketSwap,
  placeBracket,
  list,
  cancel,
  getEmergency,
  setEmergency,
  adminConfirmFill,
  openBeginner,
  closeBeginner,
  listBeginner,
  getBeginner,
  getPrices,
  getPriceHistory,
  streamPrices,
  watchPrices,
  listAssets,
} from './trade.controller';
import {
  authenticate,
  requireRole,
  requireAdmin2fa,
  requireAdmin2faEnrolled,
} from '../../middleware/auth.middleware';
import { csrfProtection } from '../../middleware/csrf.middleware';
import { idempotency } from '../../middleware/idempotency.middleware';
import { createRateLimiter } from '../../middleware/rateLimit.middleware';

const router = Router();

const tradeLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  prefix: 'rl:trade',
});

const priceLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  prefix: 'rl:price',
});

router.use(authenticate);

// ---------------------------------------------------------------------------
// Price hub — display only (never used as settlement input from client)
// ---------------------------------------------------------------------------
/**
 * @openapi
 * /api/v1/trade/prices:
 *   get:
 *     tags: [Prices]
 *     summary: Current mark prices from the server hub
 *     description: |
 *       Display only. Server never trusts client-supplied prices for settlement.
 *       Marks come from the in-memory price hub (Binance WS / REST / CoinGecko fallbacks).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: assets
 *         required: true
 *         schema:
 *           type: string
 *         description: Comma-separated asset keys (e.g. ethereum,solana,bitcoin)
 *         example: ethereum,solana
 *     responses:
 *       200:
 *         description: Hub marks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       asset: { type: string }
 *                       key: { type: string }
 *                       price: { type: number, nullable: true }
 *                       source: { type: string, nullable: true }
 *                       updatedAt: { type: number, nullable: true }
 *                       stale: { type: boolean }
 *                       ageMs: { type: number, nullable: true }
 *                 note:
 *                   type: string
 */
router.get('/prices', priceLimiter, getPrices);

/**
 * @openapi
 * /api/v1/trade/assets:
 *   get:
 *     tags: [Prices]
 *     summary: Backend-validated displayable asset catalog
 *     description: Fetched once per session by the terminal; only listed assets may be charted client-side. Testnet networks hidden unless includeTestnets=true.
 *     parameters:
 *       - in: query
 *         name: includeTestnets
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Asset catalog
 */
router.get('/assets', priceLimiter, listAssets);

/**
 * @openapi
 * /api/v1/trade/prices/{asset}/history:
 *   get:
 *     tags: [Prices]
 *     summary: Price history ring buffer for a simple line chart
 *     description: Display only. Points from the in-memory hub ring buffer.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: asset
 *         required: true
 *         schema: { type: string }
 *         example: ethereum
 *       - in: query
 *         name: minutes
 *         schema: { type: integer, default: 30, maximum: 120 }
 *     responses:
 *       200:
 *         description: History points
 */
router.get('/prices/:asset/history', priceLimiter, getPriceHistory);

/**
 * @openapi
 * /api/v1/trade/stream/prices:
 *   get:
 *     tags: [Prices]
 *     summary: SSE stream of hub price snapshots
 *     description: |
 *       Display only. Server-Sent Events (`text/event-stream`).
 *       Emits a JSON snapshot every ~1s.
 *       Example event: `data: {"t":1710000000000,"prices":[{"asset":"ethereum","price":3200.5,"stale":false,...}]}`
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: assets
 *         required: true
 *         schema: { type: string }
 *         example: ethereum,solana
 *     responses:
 *       200:
 *         description: SSE stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/stream/prices', priceLimiter, streamPrices);

/**
 * @openapi
 * /api/v1/trade/prices/watch:
 *   post:
 *     tags: [Prices]
 *     summary: Register assets the client is currently watching
 *     description: >
 *       Lightweight TTL registration so the Tier-2 background refresher keeps
 *       hub marks warm for charts/open views. Does not accept client prices.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assets]
 *             properties:
 *               assets:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["ethereum", "token:usdc-ethereum"]
 *               ttlMs:
 *                 type: integer
 *                 description: Optional TTL override (clamped)
 *     responses:
 *       200:
 *         description: Watch registered
 */
router.post('/prices/watch', priceLimiter, csrfProtection, watchPrices);

router.get('/orders', list);
router.get('/emergency', getEmergency);

// Beginner BUY/SELL — lock stable, win/lose in stable only
/**
 * @openapi
 * /api/v1/trade/positions:
 *   get:
 *     tags: [Beginner]
 *     summary: List beginner positions
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Position list
 *   post:
 *     tags: [Beginner]
 *     summary: Open beginner position (server mark only)
 *     description: |
 *       Entry price is taken exclusively from the server price hub.
 *       Client-supplied price fields are ignored.
 *       Optional Idempotency-Key header supported.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [side, assetNetworkId, marginStable]
 *             properties:
 *               side: { type: string, enum: [BUY, SELL], example: BUY }
 *               assetNetworkId: { type: string, example: ethereum }
 *               assetTokenId: { type: string, nullable: true, description: "Omit for native" }
 *               marginStable: { type: string, example: "100" }
 *               stableNetworkId: { type: string, example: ethereum }
 *               stableTokenId: { type: string, example: usdt-ethereum }
 *               leverage: { type: number, minimum: 1, maximum: 5, example: 1 }
 *               takeProfitPct: { type: number, example: 20 }
 *               stopLossPct: { type: number, example: 10 }
 *               expiresInHours: { type: number, example: 24 }
 *     responses:
 *       201:
 *         description: Position opened
 */
router.get('/positions', listBeginner);
router.get('/positions/:id', getBeginner);
router.post('/positions', tradeLimiter, csrfProtection, idempotency(), openBeginner);

/**
 * @openapi
 * /api/v1/trade/positions/{id}/close:
 *   post:
 *     tags: [Beginner]
 *     summary: Close a beginner position
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: X-CSRF-Token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Position closed
 */
router.post('/positions/:id/close', tradeLimiter, csrfProtection, closeBeginner);

/**
 * @openapi
 * /api/v1/trade/quote:
 *   post:
 *     tags: [Trading]
 *     summary: Get swap quote
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fromNetworkId, toNetworkId, amount]
 *             properties:
 *               fromNetworkId: { type: string, example: ethereum }
 *               fromTokenId: { type: string, nullable: true, example: usdt-ethereum }
 *               toNetworkId: { type: string, example: ethereum }
 *               toTokenId: { type: string, nullable: true, example: "" }
 *               amount: { type: string, example: "10" }
 *               slippagePct: { type: number, example: 1 }
 *     responses:
 *       200:
 *         description: Quote
 */
router.post('/quote', tradeLimiter, csrfProtection, quote);

/**
 * @openapi
 * /api/v1/trade/swap:
 *   post:
 *     tags: [Trading]
 *     summary: Execute market swap
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fromNetworkId, toNetworkId, amount]
 *             properties:
 *               fromNetworkId: { type: string, example: ethereum }
 *               fromTokenId: { type: string, nullable: true }
 *               toNetworkId: { type: string, example: ethereum }
 *               toTokenId: { type: string, nullable: true }
 *               amount: { type: string, example: "10" }
 *               slippagePct: { type: number, example: 1 }
 *               takeProfitPct: { type: number }
 *               stopLossPct: { type: number }
 *     responses:
 *       201:
 *         description: Order created
 */
router.post('/swap', tradeLimiter, csrfProtection, idempotency(), marketSwap);

/**
 * @openapi
 * /api/v1/trade/bracket:
 *   post:
 *     tags: [Trading]
 *     summary: Place TP/SL conditional bracket on balance
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [networkId, amount]
 *             properties:
 *               networkId: { type: string, example: ethereum }
 *               tokenId: { type: string, nullable: true }
 *               amount: { type: string, example: "1" }
 *               takeProfitPct: { type: number, example: 20 }
 *               stopLossPct: { type: number, example: 10 }
 *               triggerPriceUsd: { type: number }
 *               toTokenId: { type: string, nullable: true }
 *               expiresInHours: { type: number, example: 72 }
 *     responses:
 *       201:
 *         description: Bracket orders placed
 */
router.post('/bracket', tradeLimiter, csrfProtection, placeBracket);

/**
 * @openapi
 * /api/v1/trade/emergency:
 *   post:
 *     tags: [Trading]
 *     summary: Configure emergency protection
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled: { type: boolean, example: true }
 *               dropPct: { type: number, example: 15 }
 *               stableTokenByNetwork:
 *                 type: object
 *                 additionalProperties: { type: string }
 *                 example: { "ethereum": "usdc-ethereum" }
 *               watchTokenIds:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Updated
 */
router.post('/emergency', tradeLimiter, csrfProtection, setEmergency);

/**
 * @openapi
 * /api/v1/trade/orders/{id}/cancel:
 *   post:
 *     tags: [Trading]
 *     summary: Cancel an open order
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cancelled
 */
router.post('/orders/:id/cancel', tradeLimiter, csrfProtection, cancel);

/**
 * @openapi
 * /api/v1/trade/orders/{id}/confirm-fill:
 *   post:
 *     tags: [Admin]
 *     summary: Admin confirm order fill
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [txHash, receivedAmount]
 *             properties:
 *               txHash: { type: string }
 *               receivedAmount: { type: string, example: "9.95" }
 *     responses:
 *       200:
 *         description: Fill confirmed
 */
router.post(
  '/orders/:id/confirm-fill',
  requireRole('admin'),
  requireAdmin2faEnrolled,
  csrfProtection,
  requireAdmin2fa,
  adminConfirmFill
);

export default router;
