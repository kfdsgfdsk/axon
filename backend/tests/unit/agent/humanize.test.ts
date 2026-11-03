/**
 * Unit tests for the crew plain-English humanizer.
 * Must run without DB / token cache (fallback prettify path).
 */
import {
  describeAsset,
  displaySymbol,
  displayNetwork,
  humanizeText,
  labelBalanceRow,
  networkIdFromTokenId,
} from '../../../src/modules/agent/humanize';

describe('humanize', () => {
  test('networkIdFromTokenId handles single and double-dash chains', () => {
    expect(networkIdFromTokenId('usdc-solana')).toBe('solana');
    expect(networkIdFromTokenId('usdc-ethereum')).toBe('ethereum');
    expect(networkIdFromTokenId('x-solana-devnet')).toBe('solana-devnet');
    expect(networkIdFromTokenId('notachain')).toBeNull();
  });

  test('describeAsset renders token and native legs without raw ids', () => {
    expect(describeAsset('usdc-solana', 'solana')).toBe('USDC on Solana');
    expect(describeAsset('usdt-ethereum', 'ethereum')).toBe('USDT on Ethereum');
    expect(describeAsset(null, 'solana')).toBe('SOL on Solana');
    expect(describeAsset(null, 'arbitrum')).toBe('ETH on Arbitrum');
    expect(describeAsset(null, 'bitcoin')).toBe('BTC on Bitcoin');
  });

  test('humanizeText scrubs registry ids, keys, cites, enums, fields', () => {
    const out = humanizeText(
      'Swap fromTokenId usdc-ethereum to native:solana (token:usdc-solana) ' +
        'per tool:balances#1 as MARKET_SWAP with slippageBps 100 in dryRun; DRY_RUN ok.'
    );
    expect(out).not.toMatch(/usdc-ethereum|usdc-solana|native:|token:|tool:balances#1/);
    expect(out).not.toMatch(/MARKET_SWAP|slippageBps|dryRun|DRY_RUN/);
    expect(out).toMatch(/USDC on Ethereum/);
    expect(out).toMatch(/SOL on Solana/);
    expect(out).toMatch(/balance check/);
    expect(out).toMatch(/swap/);
  });

  test('humanizeText is idempotent and leaves plain prose alone', () => {
    const prose = 'Hold today; your 2,000 USDC on Solana stays put.';
    expect(humanizeText(prose)).toBe(prose);
    const once = humanizeText('from usdc-ethereum toTokenId usdc-solana');
    expect(humanizeText(once)).toBe(once);
  });

  test('humanizeText maps role ids, router codes, and policy jargon', () => {
    const out = humanizeText(
      'red_slippage: quote failed with NO_ROUTE; needs idempotency planning and the strategist agrees.'
    );
    expect(out).not.toMatch(/red_slippage|NO_ROUTE|idempotency|strategist/);
    expect(out).toMatch(/slippage check/);
    expect(out).toMatch(/no route available/);
    expect(out).toMatch(/replay protection/);
  });

  test('humanizeText keeps the ordinary word risk untouched', () => {
    expect(humanizeText('concentration risk is high')).toBe('concentration risk is high');
  });

  test('humanizeText turns tool-talk into plain words', () => {
    const out = humanizeText(
      'Per your orders tool and balances tool, the simulation quote per the simulation is ready.'
    );
    expect(out).not.toMatch(/orders tool|balances tool|simulation quote|per the simulation/);
    expect(out).toMatch(/orders list/);
    expect(out).toMatch(/dry-run quote/);
  });

  test('humanizeText turns route summaries into plain words', () => {
    expect(humanizeText('route is provider=jupiter with no warnings')).toBe(
      'route is via jupiter with no warnings'
    );
  });

  test('display labels give the model plain words without touching ledger keys', () => {
    expect(displaySymbol('usdc-solana', 'solana')).toBe('USDC');
    expect(displaySymbol(null, 'solana')).toBe('SOL');
    expect(displaySymbol(null, 'arbitrum')).toBe('ETH');
    expect(displayNetwork('solana')).toBe('Solana');
    const row = labelBalanceRow({
      networkId: 'solana',
      tokenId: 'usdc-solana',
      asset: 'usdc-solana',
      available: '10',
    });
    expect(row.asset).toBe('usdc-solana');
    expect(row.symbol).toBe('USDC');
    expect(row.network).toBe('Solana');
  });
});
