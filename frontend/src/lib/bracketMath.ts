/* Pure $ math behind the bracket chart readout — spot proceeds and leveraged
 * margin outcomes. Framework-free so the standalone e2e math check can import
 * it without React. */

export interface BracketUsdInput {
  mark: number | null;
  amount: number;
  tpPct: number;
  slPct: number;
  /** Override position size in USD (leveraged positions: margin × leverage). */
  notionalUsd?: number;
  /** Margin behind a leveraged position — frames full TP/SL as margin outcomes. */
  collateralUsd?: number;
}

export interface BracketUsd {
  /** Position size behind the P&L: margin × leverage, else units × mark. */
  notional: number | null;
  /** Validated leveraged notional (drives the empty-chart size readout). */
  posNotional: number | null;
  winUsd: number | null;
  lossUsd: number | null;
  /** Full outcome at each leg: spot proceeds, or margin ± P&L when leveraged. */
  fullTpUsd: number | null;
  fullSlUsd: number | null;
  fullKind: 'proceeds' | 'margin' | null;
}

const NO_USD: BracketUsd = {
  notional: null,
  posNotional: null,
  winUsd: null,
  lossUsd: null,
  fullTpUsd: null,
  fullSlUsd: null,
  fullKind: null,
};

export function bracketUsd(input: BracketUsdInput): BracketUsd {
  const { mark, amount, tpPct, slPct, notionalUsd, collateralUsd } = input;
  const spotNotional =
    mark !== null && Number.isFinite(mark) && amount > 0 ? amount * mark : null;
  const posNotional =
    typeof notionalUsd === 'number' && Number.isFinite(notionalUsd) && notionalUsd > 0
      ? notionalUsd
      : null;
  const notional = posNotional ?? spotNotional;
  if (notional === null) return { ...NO_USD, posNotional };
  const winUsd = notional * (tpPct / 100);
  const lossUsd = notional * (slPct / 100);
  // Leveraged full outcome = what the margin becomes (margin ± P&L),
  // side-agnostic for longs and shorts; spot falls back to proceeds.
  const marginBase =
    typeof collateralUsd === 'number' &&
    Number.isFinite(collateralUsd) &&
    collateralUsd > 0 &&
    posNotional !== null
      ? collateralUsd
      : null;
  const fullBase = marginBase ?? notional;
  return {
    notional,
    posNotional,
    winUsd,
    lossUsd,
    fullTpUsd: fullBase + winUsd,
    fullSlUsd: fullBase - lossUsd,
    fullKind: marginBase !== null ? 'margin' : 'proceeds',
  };
}
