#!/usr/bin/env node
/**
 * Bracket $ math verification (standalone, no stack needed).
 *
 * Asserts bracketUsd() — the helper behind the bracket chart readout:
 * full TP/SL outcomes for spot brackets (proceeds) and leveraged positions
 * (margin outcomes), plus the invalid-input fallbacks.
 *
 * Run: node frontend/e2e/bracket-math.verify.mjs
 */
import { bracketUsd } from '../src/lib/bracketMath.ts';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const near = (a, b) =>
  (a === null && b === null) ||
  (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

function expect(name, got, want) {
  const keys = Object.keys(want);
  const bad = keys.filter((k) =>
    typeof want[k] === 'number' || want[k] === null ? !near(got[k], want[k]) : got[k] !== want[k]
  );
  check(name, bad.length === 0, bad.length ? `off: ${bad.map((k) => `${k}=${got[k]} want ${want[k]}`).join(', ')}` : '');
}

// 1. Spot bracket: 20 units @ $200 mark, TP +6% / SL −3% → full proceeds.
expect('spot full proceeds', bracketUsd({ mark: 200, amount: 20, tpPct: 6, slPct: 3 }), {
  notional: 4000, posNotional: null, winUsd: 240, lossUsd: 120,
  fullTpUsd: 4240, fullSlUsd: 3880, fullKind: 'proceeds',
});

// 2. Leveraged position: $500 margin × 3x, TP +6% / SL −3% → margin outcomes.
expect('leveraged margin outcomes', bracketUsd({
  mark: 220, amount: 0, tpPct: 6, slPct: 3, notionalUsd: 1500, collateralUsd: 500,
}), {
  notional: 1500, posNotional: 1500, winUsd: 90, lossUsd: 45,
  fullTpUsd: 590, fullSlUsd: 455, fullKind: 'margin',
});

// 3. Leveraged without margin framing falls back to notional proceeds.
expect('leveraged no-margin fallback', bracketUsd({
  mark: 220, amount: 0, tpPct: 10, slPct: 5, notionalUsd: 1000,
}), {
  notional: 1000, posNotional: 1000, winUsd: 100, lossUsd: 50,
  fullTpUsd: 1100, fullSlUsd: 950, fullKind: 'proceeds',
});

// 4. Zero size hides all $ math.
expect('zero size hides math', bracketUsd({ mark: 200, amount: 0, tpPct: 6, slPct: 3 }), {
  notional: null, posNotional: null, winUsd: null, lossUsd: null,
  fullTpUsd: null, fullSlUsd: null, fullKind: null,
});

// 5. Invalid notional (bad margin/leverage input) hides all $ math.
expect('invalid notional hides math', bracketUsd({
  mark: 200, amount: 0, tpPct: 6, slPct: 3, notionalUsd: 0, collateralUsd: 500,
}), {
  notional: null, posNotional: null, winUsd: null, lossUsd: null,
  fullTpUsd: null, fullSlUsd: null, fullKind: null,
});

// 6. No mark (chart empty) hides $ math even with units typed.
expect('no mark hides math', bracketUsd({ mark: null, amount: 20, tpPct: 6, slPct: 3 }), {
  notional: null, posNotional: null, winUsd: null, lossUsd: null,
  fullTpUsd: null, fullSlUsd: null, fullKind: null,
});

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('bracket math OK');
