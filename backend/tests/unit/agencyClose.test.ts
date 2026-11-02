/**
 * Regression tests for R4: agency close burns the asset escrow in the SAME tx
 * as the OPEN→CLOSING claim and runs the exit swap platform-sourced (no
 * unlock-before-swap window where the user could withdraw/reuse the asset).
 *
 * Rollback (re-credit escrow + reopen) is allowed ONLY when the exit leg
 * provably never broadcast: no order row, pre-broadcast FAILED, or FAILED
 * after a definitive on-chain revert. Anything else stays CLOSING for ops.
 */

jest.mock('../../src/lib/prisma', () => ({ __esModule: true, default: {} }));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getToken: jest.fn(),
}));

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  getUsdPrice: jest.fn(),
  getMidWithMeta: jest.fn(),
  getPriceBatch: jest.fn(),
  DEFAULT_STABLE_BY_NETWORK: {},
  isStableTokenId: jest.fn(),
}));

jest.mock('../../src/services/trading/priceHub.service', () => ({
  __esModule: true,
  getHubPrice: jest.fn(),
  readSharedMarks: jest.fn(),
}));

jest.mock('../../src/services/trading/triggerBand', () => ({
  __esModule: true,
  beginnerNeedsPriceCheck: jest.fn(),
}));

jest.mock('../../src/modules/trading/tradingPause', () => ({
  __esModule: true,
  isTradingPaused: jest.fn(),
}));

import { shouldRollbackAgencyClose } from '../../src/modules/trading/beginner.service';

test('no order row (threw before creation) → rollback is safe', () => {
  expect(shouldRollbackAgencyClose(null)).toBe(true);
});

test('FAILED pre-broadcast (no hash) → rollback is safe', () => {
  expect(
    shouldRollbackAgencyClose({
      status: 'FAILED',
      txHash: null,
      failureReason: 'swap build failed',
    })
  ).toBe(true);
});

test('FAILED after definitive on-chain revert → rollback is safe', () => {
  expect(
    shouldRollbackAgencyClose({
      status: 'FAILED',
      txHash: '0xabc',
      failureReason: 'on-chain revert (tx=0xabc)',
    })
  ).toBe(true);
});

test('EXECUTING with no hash yet → never rollback (may be in flight)', () => {
  expect(
    shouldRollbackAgencyClose({ status: 'EXECUTING', txHash: null, failureReason: null })
  ).toBe(false);
});

test('FAILED with a non-revert hash → never rollback (ops must verify)', () => {
  expect(
    shouldRollbackAgencyClose({
      status: 'FAILED',
      txHash: '0xabc',
      failureReason: 'something unexpected',
    })
  ).toBe(false);
});

test('COMPLETED → never rollback', () => {
  expect(
    shouldRollbackAgencyClose({ status: 'COMPLETED', txHash: '0xabc', failureReason: null })
  ).toBe(false);
});
