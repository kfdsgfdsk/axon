/**
 * Trade assets catalog contract.
 *
 * GET /api/v1/trade/assets is the backend-validated list the terminal may
 * chart client-side: active natives plus active tokens, each with the Binance
 * spot symbol for display streaming (null when none — stables included).
 */

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { trading: {} },
}));

jest.mock('../../src/services/blockchain/networks', () => ({
  __esModule: true,
  getActiveNetworks: jest.fn(() => [
    { id: 'ethereum', name: 'Ethereum', nativeCurrency: 'ETH', chainId: 1 },
    { id: 'solana', name: 'Solana', nativeCurrency: 'SOL' },
    { id: 'sepolia', name: 'Ethereum Sepolia', nativeCurrency: 'ETH', testnet: true, chainId: 11155111 },
  ]),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  warmTokenCache: jest.fn(async () => {}),
  getActiveTokens: jest.fn(async () => [
    { id: 'usdt-ethereum', symbol: 'USDT', name: 'Tether', networkId: 'ethereum', binanceSymbol: null, isStable: true, contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', logoUrl: null },
    { id: 'link-ethereum', symbol: 'LINK', name: 'Chainlink', networkId: 'ethereum', binanceSymbol: 'LINKUSDT', isStable: false, contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca', logoUrl: 'https://example.com/link.png' },
    { id: 'meme-ethereum', symbol: 'MEME', name: 'Memecoin', networkId: 'ethereum', binanceSymbol: null, isStable: false },
    { id: 'usdc-sepolia', symbol: 'USDC', name: 'USD Coin', networkId: 'sepolia', binanceSymbol: null, isStable: true, contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', logoUrl: null },
  ]),
}));

jest.mock('../../src/services/trading/price.service', () => ({
  __esModule: true,
  binanceSymbolFor: jest.fn((networkId: string, tokenId?: string | null, sym?: string | null) => {
    if (tokenId) return sym || null;
    return networkId === 'ethereum' ? 'ETHUSDT' : networkId === 'solana' ? 'SOLUSDT' : null;
  }),
  getUsdPrice: jest.fn(),
  getMidWithMeta: jest.fn(),
  getPriceBatch: jest.fn(),
}));

import { listAssets } from '../../src/modules/trading/trade.controller';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('listAssets', () => {
  test('returns natives plus active tokens with stream symbols', async () => {
    const req: any = { user: { id: 'u1' } };
    const res = mockRes();
    const next = jest.fn();
    await listAssets(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    const byAsset = new Map(data.map((d: any) => [d.asset, d]));

    expect(byAsset.get('ethereum')).toMatchObject({
      kind: 'native', networkId: 'ethereum', tokenId: null, symbol: 'ETH', binance: 'ETHUSDT', stable: false,
    });
    // Stable: $1 display, no stream symbol
    expect(byAsset.get('token:usdt-ethereum')).toMatchObject({
      kind: 'token', tokenId: 'usdt-ethereum', symbol: 'USDT', binance: null, stable: true,
    });
    // Mapped token keeps its registry symbol
    expect(byAsset.get('token:link-ethereum')).toMatchObject({ binance: 'LINKUSDT', stable: false });
    // Unmapped non-stable: explicit null, never a guessed symbol
    expect(byAsset.get('token:meme-ethereum')).toMatchObject({ binance: null, stable: false });
  });

  test('exposes contract, logo and chain id for client-side logo matching', async () => {
    const req: any = { user: { id: 'u1' } };
    const res = mockRes();
    await listAssets(req, res, jest.fn());
    const data = res.json.mock.calls[0][0].data;
    const byAsset = new Map(data.map((d: any) => [d.asset, d]));

    // Natives: no contract/logo, EVM chain id where defined
    expect(byAsset.get('ethereum')).toMatchObject({
      contractAddress: null, logoUrl: null, chainId: 1,
    });
    expect(byAsset.get('solana')).toMatchObject({
      contractAddress: null, logoUrl: null, chainId: null,
    });
    // Tokens: registry contract + admin logo pass through, chain from network
    expect(byAsset.get('token:link-ethereum')).toMatchObject({
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      logoUrl: 'https://example.com/link.png',
      chainId: 1,
    });
    // Missing registry fields normalize to null (never undefined)
    expect(byAsset.get('token:meme-ethereum')).toMatchObject({
      contractAddress: null, logoUrl: null, chainId: 1,
    });
  });

  test('hides testnet natives and their tokens by default', async () => {
    const req: any = { user: { id: 'u1' }, query: {} };
    const res = mockRes();
    await listAssets(req, res, jest.fn());
    const data = res.json.mock.calls[0][0].data;
    const ids = data.map((d: any) => d.asset);
    expect(ids).not.toContain('sepolia');
    expect(ids).not.toContain('token:usdc-sepolia');
    // Mainnet entries unaffected
    expect(ids).toContain('ethereum');
    expect(ids).toContain('token:usdt-ethereum');
  });

  test('includes testnets only with explicit opt-in', async () => {
    const req: any = { user: { id: 'u1' }, query: { includeTestnets: 'true' } };
    const res = mockRes();
    await listAssets(req, res, jest.fn());
    const data = res.json.mock.calls[0][0].data;
    const ids = data.map((d: any) => d.asset);
    expect(ids).toContain('sepolia');
    expect(ids).toContain('token:usdc-sepolia');
  });

  test('rejects unauthenticated callers', async () => {
    const req: any = {};
    const res = mockRes();
    const next = jest.fn();
    await listAssets(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
