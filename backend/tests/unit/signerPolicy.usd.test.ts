/**
 * Regression tests for B5 signer policy fixes:
 *  S-C3  amountUsd resolved in-signer (tested via exemption + caps paths);
 *        spend recording takes the resolved value (see service wiring)
 *  S-H5  approval-token exemption only for signer-verified small withdrawals
 *  S-M10 Decimal cap comparisons (no float precision loss)
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    balance: { findFirst: jest.fn() },
    signerSpendEvent: { aggregate: jest.fn(async () => ({ _sum: { amountUsd: 0 } })) },
  },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    isProdLike: false,
    signerPolicy: {
      approvalTokenRequired: true,
      approvalPublicKey: '',
      approvalTokenMaxAgeSec: 300,
      approvalExemptBelowUsd: 50,
      perTxCaps: {},
      defaultPerTxNativeCap: '50',
      defaultPerTxTokenCap: '100000',
      hourlySpendCapUsd: 0,
      dailySpendCapUsd: 0,
      refuseAllowlistDisabledInProd: true,
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  evaluateSignerPolicy,
  amountExceedsCap,
  type PolicyContext,
} from '../../src/services/signer/policy';

const baseCtx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  kind: 'withdrawal',
  networkId: 'ethereum',
  tokenId: '',
  amount: '0.01',
  toAddress: '0x000000000000000000000000000000000000dEaD',
  entityId: 'w1',
  ...over,
});

describe('S-H5 approval exemption', () => {
  test('small signer-verified withdrawal is exempt without a token', async () => {
    const d = await evaluateSignerPolicy(baseCtx({ amountUsd: 10 }));
    expect(d).toEqual({ ok: true });
  });

  test('large withdrawal without a token is rejected', async () => {
    const d = await evaluateSignerPolicy(baseCtx({ amountUsd: 100 }));
    expect(d.ok).toBe(false);
    expect((d as any).reason).toBe('APPROVAL_TOKEN_MISSING');
  });

  test('swaps are never exempt', async () => {
    const d = await evaluateSignerPolicy({ ...baseCtx({ amountUsd: 10 }), kind: 'swap' });
    expect(d.ok).toBe(false);
    expect((d as any).reason).toBe('APPROVAL_TOKEN_MISSING');
  });

  test('exemption requires verified usd (unknown → token required)', async () => {
    const d = await evaluateSignerPolicy(baseCtx({ amountUsd: undefined }));
    expect(d.ok).toBe(false);
    expect((d as any).reason).toBe('APPROVAL_TOKEN_MISSING');
  });
});

describe('S-M10 Decimal cap math', () => {
  test('beyond-float amounts compare exactly', () => {
    // 2^53+1 vs 2^53+2: parseFloat rounds both to the same double
    expect(amountExceedsCap('9007199254740993', '9007199254740992')).toBe(true);
    expect(amountExceedsCap('9007199254740992', '9007199254740993')).toBe(false);
  });

  test('18-decimal dust compares exactly', () => {
    expect(amountExceedsCap('0.000000000000000001', '0.000000000000000002')).toBe(false);
    expect(amountExceedsCap('0.000000000000000002', '0.000000000000000001')).toBe(true);
  });

  test('garbage still fails closed', () => {
    expect(amountExceedsCap('nope', '2')).toBe(true);
    expect(amountExceedsCap('1', 'nope')).toBe(true);
  });
});
