/**
 * Proposal display rendering must speak plain English: no registry ids,
 * no action enums, no field names. Machine fields stay exact.
 */
import { renderProposalText, roleDisplaySummary } from '../../../src/modules/agent/proposal';
import type { Proposal } from '../../../src/modules/agent/types';

function proposal(): Proposal {
  return {
    id: 'p1',
    capability: 'strategy',
    summary: 'Swap USDT on Ethereum for SOL on Solana as a dry run.',
    actions: [
      {
        type: 'MARKET_SWAP',
        fromNetworkId: 'ethereum',
        toNetworkId: 'solana',
        fromTokenId: 'usdt-ethereum',
        toTokenId: null,
        amount: '1069',
        rationale: 'Illustrative 25% of USDT on Ethereum balance.',
        estimatedNotionalUsd: 1069,
      },
      { type: 'HOLD', rationale: 'Fallback while the quote is unverified.' },
    ],
    risks: ['Quote failed with NO_ROUTE for usdt-ethereum.'],
    assumptions: ['Dry run only.'],
    createdAt: new Date().toISOString(),
  };
}

describe('proposal display', () => {
  test('renderProposalText narrates legs in plain words', () => {
    const text = renderProposalText(proposal());
    expect(text).not.toMatch(/MARKET_SWAP|HOLD|usdt-ethereum|fromTokenId/);
    expect(text).not.toMatch(/NO_ROUTE/);
    expect(text).toMatch(/Swap 1,069 USDT on Ethereum → SOL on Solana/);
    expect(text).toMatch(/no route available/);
    expect(text).toMatch(/\(\~\$1,069\)/);
  });

  test('roleDisplaySummary strips the JSON blob and humanizes the head', () => {
    const p = proposal();
    const content = `Reasoning mentions usdc-solana and tool:balances#1.\n${JSON.stringify({
      summary: p.summary,
      actions: p.actions,
      risks: p.risks,
      assumptions: p.assumptions,
    })}`;
    const text = roleDisplaySummary(content, p);
    expect(text).not.toMatch(/usdc-solana|tool:balances#1/);
    expect(text).toMatch(/USDC on Solana/);
    expect(text).toMatch(/balance check/);
  });
});
