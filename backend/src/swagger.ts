/**
 * OpenAPI / Swagger setup for the exchange API.
 * UI:  GET /api/docs
 * Spec: GET /api/docs.json
 */

import swaggerJsdoc from 'swagger-jsdoc';
import config from './config';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Crypto Exchange API',
      version: '1.0.0',
      description: `
Custodial exchange API: deposits, withdrawals, swaps, beginner price-game positions, and mark prices.

## Auth
Most routes require \`Authorization: Bearer <accessToken>\`.
Mutating routes also require the CSRF header \`X-CSRF-Token\` (obtain via \`GET /api/v1/csrf-token\`).

## Prices
Price endpoints are **display only**. The server never trusts client-supplied prices for open/close/TP/SL settlement.
Marks come from the in-memory price hub (Binance WS / REST refresher / CoinGecko / Pyth fallbacks).
      `.trim(),
    },
    servers: [
      {
        // Relative: "try it out" works through the single-port nginx proxy
        // and against a directly exposed API alike.
        url: '/',
        description: 'Same origin',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
            message: { type: 'string' },
            code: { type: 'string' },
          },
        },
        TokenPair: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
            expiresIn: { type: 'string', example: '15m' },
          },
        },
        Requires2FA: {
          type: 'object',
          properties: {
            requires2fa: { type: 'boolean', example: true },
            preAuthToken: { type: 'string' },
            expiresIn: { type: 'integer', example: 300 },
            methods: { type: 'array', items: { type: 'string' }, example: ['totp', 'backup'] },
          },
        },
        HubPrice: {
          type: 'object',
          properties: {
            asset: { type: 'string', example: 'ethereum' },
            key: { type: 'string', example: 'native:ethereum' },
            price: { type: 'number', nullable: true, example: 3200.5 },
            source: {
              type: 'string',
              nullable: true,
              example: 'binance-ws',
              description: 'binance-ws | rest-refresh | binance | coingecko | pyth | synthetic',
            },
            updatedAt: { type: 'number', nullable: true, description: 'Epoch ms' },
            stale: { type: 'boolean' },
            ageMs: { type: 'number', nullable: true },
          },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Login / register / tokens' },
      { name: '2FA', description: 'TOTP, email/SMS OTP, backup codes, trusted devices' },
      { name: 'Users', description: 'Profile, password, sessions, whitelist' },
      { name: 'Transactions', description: 'Unified ledger history' },
      { name: 'Wallets', description: 'Deposit addresses' },
      { name: 'Deposits', description: 'Deposit status' },
      { name: 'Withdrawals', description: 'Withdrawals and balances' },
      { name: 'Prices', description: 'Mark hub display APIs (UI only)' },
      { name: 'Trading', description: 'Quotes, swaps, conditional brackets' },
      { name: 'Beginner', description: 'Stable-margin BUY/SELL positions' },
      { name: 'Balances', description: 'User ledger balances (available / locked)' },
      { name: 'Webhooks', description: 'Provider deposit webhooks (Alchemy, Helius) — server-to-server' },
      { name: 'Admin', description: 'Admin trading, deposits, withdrawals, custody' },
      { name: 'Health', description: 'Liveness and readiness' },
    ],
  },
  apis: [
    './src/modules/**/*.routes.ts',
    './src/modules/**/*.controller.ts',
    './src/app.ts',
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
