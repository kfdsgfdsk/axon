jest.mock('../../../src/services/blockchain/tokenRegistry.service', () => ({
  // Only usdc-ethereum counts as stable; everything else (including
  // stable-looking prefixes like pyusd-/busd-) reports non-stable.
  isStableTokenSync: jest.fn(
    (id: string | null | undefined) => id === 'usdc-ethereum'
  ),
}));

import { verifyProposal } from '../../../src/modules/agent/crew/verifyProposal';
import { isStableTokenSync } from '../../../src/services/blockchain/tokenRegistry.service';
import type {
  PolicyDecision,
  PortfolioContext,
  Proposal,
  ProposalAction,
} from '../../../src/modules/agent/types';

const isStableMock = isStableTokenSync as unknown as jest.Mock;

const policy: PolicyDecision = {
  kind: 'ALLOW',
  reasons: [],
  constraints: { maxNotionalUsd: 1000 },
};

const portfolio: PortfolioContext = {
  userId: 'u1',
  balances: [
    {
      networkId: 'ethereum',
      tokenId: null,
      asset: 'ETH',
      available: '2',
      locked: '0',
      updatedAt: new Date().toISOString(),
      markUsd: 3000,
      markStale: false,
      valueUsd: 6000,
      weightPct: 60,
    },
    {
      networkId: 'ethereum',
      tokenId: 'usdc-ethereum',
      asset: 'USDC',
      available: '500',
      locked: '0',
      updatedAt: new Date().toISOString(),
      markUsd: 1,
      markStale: false,
      valueUsd: 500,
      weightPct: 5,
    },
  ],
  totalUsd: 6500,
  staleMarks: 0,
  asOf: new Date().toISOString(),
};

const observations = [
  { id: 'tool:balances#1', tool: 'balances', ok: true, data: {} },
  { id: 'tool:prices#2', tool: 'prices', ok: true, data: {} },
];

function proposal(actions: ProposalAction[]): Proposal {
  return {
    id: 'p1',
    capability: 'plan',
    summary: 'test',
    actions,
    risks: [],
    assumptions: [],
    createdAt: new Date().toISOString(),
  };
}

function swap(overrides: Partial<ProposalAction> = {}): ProposalAction {
  return {
    type: 'MARKET_SWAP',
    fromNetworkId: 'ethereum',
    toNetworkId: 'ethereum',
    fromTokenId: 'usdc-ethereum',
    toTokenId: null,
    amount: '100',
    estimatedNotionalUsd: 100,
    rationale: 'starter allocation',
    evidence: ['tool:balances#1'],
    ...overrides,
  };
}

describe('deterministic proposal verification', () => {
  test('keeps a fully supported action', () => {
    const result = verifyProposal({
      proposal: proposal([swap()]),
      portfolio,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.droppedActions).toBe(0);
    expect(result.proposal.actions[0].type).toBe('MARKET_SWAP');
    expect(result.proposal.verification?.ok).toBe(true);
  });

  test('drops an action that exceeds available funds and inserts HOLD', () => {
    const result = verifyProposal({
      proposal: proposal([swap({ amount: '999' })]),
      portfolio,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.droppedActions).toBe(1);
    expect(result.problems.join(' ')).toMatch(/exceeds available/);
    expect(result.proposal.actions).toHaveLength(1);
    expect(result.proposal.actions[0].type).toBe('HOLD');
  });

  test('drops sizing a non-stable asset from a stale mark', () => {
    const stale: PortfolioContext = {
      ...portfolio,
      balances: portfolio.balances.map((b) =>
        b.tokenId === null ? { ...b, markStale: true } : b
      ),
      staleMarks: 1,
    };
    const result = verifyProposal({
      proposal: proposal([
        swap({
          fromTokenId: null,
          toTokenId: 'usdc-ethereum',
          amount: '1',
          estimatedNotionalUsd: 3000,
        }),
      ]),
      portfolio: stale,
      observations,
      policy,
      maxNotionalUsd: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/stale/);
    expect(result.proposal.actions[0].type).toBe('HOLD');
  });

  test('allows selling a stablecoin without a fresh mark', () => {
    const stale: PortfolioContext = {
      ...portfolio,
      balances: portfolio.balances.map((b) =>
        b.tokenId === 'usdc-ethereum' ? { ...b, markStale: true } : b
      ),
      staleMarks: 1,
    };
    const result = verifyProposal({
      proposal: proposal([swap()]),
      portfolio: stale,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.problems.join(' ')).not.toMatch(/stale/);
    expect(result.proposal.actions[0].type).toBe('MARKET_SWAP');
  });

  test('drops an action with an unknown evidence id', () => {
    const result = verifyProposal({
      proposal: proposal([swap({ evidence: ['tool:invented#99'] })]),
      portfolio,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/unknown evidence/);
  });

  test('drops an action above the notional cap', () => {
    const result = verifyProposal({
      proposal: proposal([swap({ amount: '100', estimatedNotionalUsd: 5000 })]),
      portfolio,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/exceeds cap/);
  });

  test('drops an action whose source asset is not held', () => {
    const result = verifyProposal({
      proposal: proposal([
        swap({ fromTokenId: 'wbtc-ethereum', amount: '0.1', estimatedNotionalUsd: 100 }),
      ]),
      portfolio,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/is not held/);
  });

  test('stable-looking prefixes are NOT trusted without registry isStable', () => {
    // pyusd-/busd- look like stables but the registry says nothing about
    // them here: selling from a stale mark must be refused (fail closed).
    const withPyusd: PortfolioContext = {
      ...portfolio,
      balances: [
        ...portfolio.balances,
        {
          networkId: 'ethereum',
          tokenId: 'pyusd-ethereum',
          asset: 'PYUSD',
          available: '500',
          locked: '0',
          updatedAt: new Date().toISOString(),
          markUsd: 1,
          markStale: true,
          valueUsd: 500,
          weightPct: 5,
        },
      ],
    };
    const result = verifyProposal({
      proposal: proposal([
        swap({ fromTokenId: 'pyusd-ethereum', amount: '100', estimatedNotionalUsd: 100 }),
      ]),
      portfolio: withPyusd,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/stale/);
    expect(result.proposal.actions[0].type).toBe('HOLD');
  });

  test('registry isStable=false overrides a stable-looking symbol', () => {
    // Even usdc-ethereum needs a fresh mark when the registry does not
    // declare it stable — the symbol alone decides nothing.
    isStableMock.mockReturnValueOnce(false);
    const stale: PortfolioContext = {
      ...portfolio,
      balances: portfolio.balances.map((b) =>
        b.tokenId === 'usdc-ethereum' ? { ...b, markStale: true } : b
      ),
      staleMarks: 1,
    };
    const result = verifyProposal({
      proposal: proposal([swap()]),
      portfolio: stale,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/stale/);
  });

  test('always keeps HOLD', () => {
    const result = verifyProposal({
      proposal: proposal([{ type: 'HOLD', rationale: 'safe' }]),
      portfolio,
      observations,
      policy,
      maxNotionalUsd: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.proposal.actions[0].type).toBe('HOLD');
  });
});
