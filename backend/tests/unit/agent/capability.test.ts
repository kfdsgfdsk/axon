/**
 * Desk-mode inference: the crew derives its depth from the user's words.
 * Locks the routing for the asks the desk actually sees, plus precedence
 * (attack-a-plan > test-a-thesis > brief-me > do-something > answer-me).
 */
import { inferCapability, isQuickInquiry } from '../../../src/modules/agent/capability';

describe('inferCapability', () => {
  test.each([
    ['Red-team the rotation you just proposed.'],
    ['Attack this plan from the slippage angle'],
    ['Critique the proposal above'],
    ['What could kill this plan?'],
    ['What is wrong with my trade idea?'],
    ['Review my plan before I approve it'],
  ])('attack-a-plan → critique (%s)', (message) => {
    expect(inferCapability(message)).toBe('critique');
  });

  test.each([
    ['Is rotating 15% of ETH into SOL justified this week?'],
    ['Should I arm the crash shield today?'],
    ['Test my thesis: SOL outperforms ETH into month end'],
    ['Is rotating into SOL a good idea right now?'],
    ['Give me a verdict and what would change your mind'],
  ])('test-an-idea → strategy (%s)', (message) => {
    expect(inferCapability(message)).toBe('strategy');
  });

  test.each([
    ['Give me the morning read, focus on stables.'],
    ['Review my portfolio and flag one change'],
    ['Brief me on the desk'],
    ['Sweep the book and flag one change'],
    ['How is my portfolio positioned?'],
  ])('desk snapshot → copilot (%s)', (message) => {
    expect(inferCapability(message)).toBe('copilot');
  });

  test.each([
    ['Grow my stables by 2% this month without leverage. Dry run only.'],
    ['Draft a $2,000 momentum rotation into SOL, dry run only'],
    ['What would I get if I swapped 500 USDC on Solana for SOL right now?'],
    ['Quote me $500 SOL → USDC on Solana with slippage and fees'],
    ['Convert 100 USDC into SOL on Solana'],
    ['I want to buy 1 SOL with USDC'],
  ])('concrete goal / sized ask → plan (%s)', (message) => {
    expect(inferCapability(message)).toBe('plan');
  });

  test.each([
    ['What is the bias on SOL right now?'],
    ['Break down SOL: trend, momentum, key levels'],
    ['Just give me a quick read on BTC, nothing else'],
    ['What does funding rate mean?'],
    ['Why not ETH instead?'],
    ['Make it smaller — halve the size'],
    ['I want to withdraw everything to my bank'],
  ])('plain question → reactive (%s)', (message) => {
    expect(inferCapability(message)).toBe('reactive');
  });

  test('rules fallback understands intent despite typos (AI unavailable)', () => {
    // Double typos the fixed correction list cannot enumerate.
    expect(inferCapability('mornin breif pls')).toBe('copilot');
    expect(inferCapability('how is my protofolio doing')).toBe('copilot');
    expect(inferCapability('rotat my stables into sol')).toBe('plan');
    expect(inferCapability('attak my plan from the size angle')).toBe('critique');
    expect(inferCapability('thessi on SOL: outperform into month end?')).toBe('strategy');
    expect(inferCapability('mornign read, focus stables')).toBe('copilot');
  });

  test('fuzzy routing does not overtrigger on plain questions', () => {
    expect(inferCapability('What is the bias on SOL right now?')).toBe('reactive');
    expect(inferCapability('What does funding rate mean?')).toBe('reactive');
    expect(inferCapability('Why not ETH instead?')).toBe('reactive');
  });

  test('attack beats thesis beats brief beats plan wording', () => {
    // "rotation" alone is plan language, but the red-team verb wins.
    expect(inferCapability('Red-team my rotation thesis')).toBe('critique');
    // "justified" (thesis) wins over the sized "%" (plan language).
    expect(inferCapability('Is a 15% rotation justified?')).toBe('strategy');
    // A brief ask with a goal verb still sweeps first.
    expect(inferCapability('Morning brief: should I grow stables?')).toBe('copilot');
  });
});

describe('isQuickInquiry', () => {
  test.each([
    "What's my current SOL balance?",
    "What's my SOL balance?",
    'How much ETH do I have?',
    'What is SOL worth right now?',
  ])('balance/price question qualifies (%s)', (message) => {
    expect(isQuickInquiry(message)).toBe(true);
  });

  test.each([
    'Rebalance my portfolio', // "balance" substring, but an action
    'Should I rotate some SOL into USDC?', // thesis verdict, not a lookup
    'Swap 500 USDC to SOL', // sized action
    'How is my portfolio doing?', // desk sweep, not a lookup
    'Attack my plan to grow stables', // red-team pass
    'Withdraw everything to my bank', // safety fast-path, not a lookup
  ])('action/sweep/attack asks never qualify (%s)', (message) => {
    expect(isQuickInquiry(message)).toBe(false);
  });
});
