/**
 * Solana custody-inventory RPC batching.
 *
 * The inventory scan must NOT issue one getParsedTokenAccountsByOwner per
 * (owner × catalog mint) — that is O(tokens × addresses) RPC calls against
 * the public Solana endpoint and gets 429 rate-limited. Instead it fetches
 * ALL token accounts per owner with a single programId-filtered call and
 * attributes balances to catalog mints client-side. Native SOL is fetched
 * with one getMultipleAccountsInfo call (per-address getBalance only as fallback).
 */

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    rpc: {
      solana: 'https://fake-solana.local',
      bitcoinApi: '',
      tronFullHost: '',
      tronApiKey: '',
    },
    custody: {
      insolvencyGapRatio: 0.05,
      insolvencyMinGap: 0.01,
      maxDepositAddressesSample: 0,
    },
  },
}));

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: { balance: { groupBy: jest.fn() } },
}));

jest.mock('../../src/services/blockchain/evmProvider', () => ({
  __esModule: true,
  getEvmProvider: jest.fn(),
  getRpcUrl: jest.fn(() => ''),
}));

jest.mock('../../src/services/blockchain/tokenRegistry.service', () => ({
  __esModule: true,
  getTokensForNetwork: jest.fn(),
}));

jest.mock('../../src/services/blockchain/withdrawalBroadcaster.service', () => ({
  __esModule: true,
  getHotWalletAddress: jest.fn(),
}));

jest.mock('../../src/services/blockchain/depositAddress.service', () => ({
  __esModule: true,
  getWatchedAddresses: jest.fn(),
}));

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return { ...actual, Connection: jest.fn() };
});

import { Connection, PublicKey } from '@solana/web3.js';
import prisma from '../../src/lib/prisma';
import { getTokensForNetwork } from '../../src/services/blockchain/tokenRegistry.service';
import { getHotWalletAddress } from '../../src/services/blockchain/withdrawalBroadcaster.service';
import { getWatchedAddresses } from '../../src/services/blockchain/depositAddress.service';
import { compareLiabilityToOnChain } from '../../src/services/blockchain/custodyInventory.service';

const ConnectionMock = Connection as unknown as jest.Mock;

const HOT = '9WPKq9eg2HbXrfx87Vht9jW5wNuuouG7pPo1CqzUPdfR';
const DEP1 = '11111111111111111111111111111111';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const RENDER_MINT = 'rndrizKT3MK1iimdxRdWqcF7qNsi7ADvPxy366iFPu9'; // not in catalog → ignored dust

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const connectionMock = {
  getBalance: jest.fn(),
  getMultipleAccountsInfo: jest.fn(),
  getParsedTokenAccountsByOwner: jest.fn(),
};

function splRow(mint: string, amount: string) {
  return {
    account: {
      data: { parsed: { info: { mint, tokenAmount: { amount } } } },
    },
  };
}

function tokenRow(id: string, contractAddress: string, standard = 'spl') {
  return {
    id,
    symbol: id,
    name: id,
    networkId: 'solana',
    contractAddress,
    decimals: 6,
    standard,
    isActive: true,
    isFeeOnTransfer: false,
    isStable: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ConnectionMock.mockImplementation(() => connectionMock);

  (prisma.balance.groupBy as jest.Mock).mockResolvedValue([
    { networkId: 'solana', tokenId: '', _sum: { available: 1, locked: 0 } },
    {
      networkId: 'solana',
      tokenId: 'usdc-solana',
      _sum: { available: 7, locked: 3 },
    },
  ]);
  (getHotWalletAddress as jest.Mock).mockResolvedValue(HOT);
  (getWatchedAddresses as jest.Mock).mockResolvedValue([{ address: DEP1 }]);
  (getTokensForNetwork as jest.Mock).mockResolvedValue([
    tokenRow('usdc-solana', USDC_MINT),
    tokenRow('jup-solana', JUP_MINT),
    tokenRow('bogus-solana', 'not-a-valid-pubkey!!!'),
  ]);

  connectionMock.getMultipleAccountsInfo.mockResolvedValue([
    { lamports: 2_000_000_000 },
    { lamports: 500_000_000 },
  ]);
  connectionMock.getBalance.mockImplementation(async (pk: PublicKey) =>
    pk.toBase58() === HOT ? 2_000_000_000 : 500_000_000
  );
  connectionMock.getParsedTokenAccountsByOwner.mockImplementation(
    async (owner: PublicKey) => {
      if (owner.toBase58() === HOT) {
        return {
          value: [
            splRow(USDC_MINT, '6000000'),
            splRow(JUP_MINT, '100000000'),
            splRow(RENDER_MINT, '5'), // unknown mint → ignored
          ],
        };
      }
      return { value: [splRow(USDC_MINT, '4000000')] };
    }
  );
});

describe('solana inventory RPC batching', () => {
  test('fetches all SPL balances with one program-filtered call per owner', async () => {
    const report = await compareLiabilityToOnChain();

    // 2 owners → exactly 2 RPC calls however many catalog tokens exist.
    expect(
      connectionMock.getParsedTokenAccountsByOwner
    ).toHaveBeenCalledTimes(2);
    for (const call of connectionMock.getParsedTokenAccountsByOwner.mock.calls) {
      const filter = call[1] as Record<string, unknown>;
      // Program filter (all mints at once), never a per-mint filter.
      expect(filter).not.toHaveProperty('mint');
      expect(filter.programId).toBeInstanceOf(PublicKey);
      expect((filter.programId as PublicKey).toBase58()).toBe(TOKEN_PROGRAM);
    }

    const byId = new Map(report.slices.map((s) => [s.tokenId, s]));
    // 6 USDC (hot) + 4 USDC (deposit) = 10, covers liability 10.
    expect(byId.get('usdc-solana')).toMatchObject({
      networkId: 'solana',
      liability: '10',
      onChain: '10',
      insolvent: false,
      inventorySupported: true,
    });
    // Zero liability but positive balance → still reported, never insolvent.
    expect(byId.get('jup-solana')).toMatchObject({
      liability: '0',
      onChain: '100',
      insolvent: false,
      inventorySupported: true,
    });
    // Invalid mint → skipped, no slice, no RPC for it.
    expect(byId.has('bogus-solana')).toBe(false);
    expect(report.insolventCount).toBe(0);
  });

  test('fetches native SOL with one getMultipleAccountsInfo call', async () => {
    const report = await compareLiabilityToOnChain();

    expect(connectionMock.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    const arg = connectionMock.getMultipleAccountsInfo.mock.calls[0][0] as PublicKey[];
    expect(arg.map((p) => p.toBase58()).sort()).toEqual([DEP1, HOT].sort());
    expect(connectionMock.getBalance).not.toHaveBeenCalled();

    const native = report.slices.find(
      (s) => s.networkId === 'solana' && s.tokenId === ''
    );
    // 2 + 0.5 SOL covers liability 1.
    expect(native).toMatchObject({
      liability: '1',
      onChain: '2.5',
      insolvent: false,
      inventorySupported: true,
    });
  });

  test('falls back to per-address getBalance when getMultipleAccountsInfo fails', async () => {
    connectionMock.getMultipleAccountsInfo.mockRejectedValueOnce(
      new Error('node exploded')
    );

    const report = await compareLiabilityToOnChain();

    expect(connectionMock.getBalance).toHaveBeenCalledTimes(2);
    const native = report.slices.find(
      (s) => s.networkId === 'solana' && s.tokenId === ''
    );
    expect(native).toMatchObject({ onChain: '2.5', inventorySupported: true });
  });

  test('queries the Token-2022 program only when the catalog has spl2022 tokens', async () => {
    (getTokensForNetwork as jest.Mock).mockResolvedValue([
      tokenRow('usdc-solana', USDC_MINT),
      tokenRow('t22x-solana', USDC_MINT, 'spl2022'),
    ]);

    await compareLiabilityToOnChain();

    // 2 owners × 2 programs.
    expect(
      connectionMock.getParsedTokenAccountsByOwner
    ).toHaveBeenCalledTimes(4);
    const programs = connectionMock.getParsedTokenAccountsByOwner.mock.calls.map(
      (c) => ((c[1] as { programId: PublicKey }).programId.toBase58())
    );
    expect(programs).toContain(TOKEN_PROGRAM);
    expect(programs).toContain(TOKEN_2022_PROGRAM);
  });

  test('fails open (unmeasured, never insolvent) when SPL fetch fails', async () => {
    connectionMock.getParsedTokenAccountsByOwner.mockRejectedValue(
      new Error('429')
    );

    const report = await compareLiabilityToOnChain();

    const usdc = report.slices.find((s) => s.tokenId === 'usdc-solana');
    expect(usdc).toMatchObject({
      liability: '10',
      onChain: '0',
      insolvent: false,
      inventorySupported: false,
    });
    expect(report.insolventCount).toBe(0);
  });
});
