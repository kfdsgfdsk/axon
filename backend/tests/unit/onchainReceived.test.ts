/**
 * On-chain receive observation tests (EVM paths used by swap settlement credit).
 *
 * observeOnChainReceived is the ONLY source of truth for swap-fill amounts:
 *  - ERC-20: sum of Transfer logs to the recipient
 *  - native: balance delta across the inclusion block
 * Never trust quote amountOutMin for the credited amount.
 */

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { rpc: { solana: '' }, deposit: {}, trading: {}, withdrawal: {} },
}));

jest.mock('../../src/services/blockchain/networks', () => ({
  __esModule: true,
  getNetwork: jest.fn((networkId: string) => ({
    id: networkId,
    name: networkId,
    type: 'evm',
    addressFamily: 'evm',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/{index}",
    requiredConfirmations: 6,
    nativeCurrency: 'ETH',
    explorerUrl: '',
    isActive: true,
    decimals: 18,
    chainId: 11155111,
  })),
  NETWORKS: {},
  getActiveNetworks: jest.fn(() => []),
  getNetworksByFamily: jest.fn(() => []),
}));

const providerMock = {
  getTransactionReceipt: jest.fn(),
  getTransaction: jest.fn(),
  getBalance: jest.fn(),
  getBlockNumber: jest.fn(),
};

jest.mock('../../src/services/blockchain/evmProvider', () => ({
  __esModule: true,
  getEvmProvider: jest.fn(() => providerMock),
  resetEvmProvider: jest.fn(),
  getRpcUrl: jest.fn(() => 'http://localhost:8545'),
  getRpcHost: jest.fn(() => 'localhost:8545'),
  formatRpcError: jest.fn(() => 'rpc-error'),
  logRpcProbe: jest.fn(),
}));

jest.mock('../../src/services/blockchain/withdrawalBroadcaster.service', () => ({
  __esModule: true,
  getHotWalletAddress: jest.fn(async () => '0x000000000000000000000000000000000000dead'),
}));

import { ethers } from 'ethers';
import { observeOnChainReceived } from '../../src/services/trading/onchainReceived';
import { getEvmProvider } from '../../src/services/blockchain/evmProvider';
import { getHotWalletAddress } from '../../src/services/blockchain/withdrawalBroadcaster.service';
import logger from '../../src/utils/logger';

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';

function padAddr(a: string): string {
  return '0x' + a.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function erc20Receipt(logs: any[], status = 1) {
  return {
    status,
    blockNumber: 100,
    logs,
  };
}

describe('observeOnChainReceived (EVM)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getEvmProvider as jest.Mock).mockReturnValue(providerMock);
    (getHotWalletAddress as jest.Mock).mockResolvedValue(RECIPIENT);
  });

  it('returns null for cross-chain swaps (no destination settlement yet)', async () => {
    const result = await observeOnChainReceived({
      networkId: 'ethereum',
      tokenId: '',
      decimals: 18,
      contract: null,
      txHash: '0xabc',
      isCrossChain: true,
    });
    expect(result).toBeNull();
  });

  it('returns null when the EVM receipt failed', async () => {
    (providerMock.getTransactionReceipt as jest.Mock).mockResolvedValue(erc20Receipt([], 0));
    const result = await observeOnChainReceived({
      networkId: 'ethereum',
      tokenId: '',
      decimals: 18,
      contract: null,
      txHash: '0xabc',
    });
    expect(result).toBeNull();
  });

  it('sums ERC-20 Transfer logs to the recipient and credits the actual amount', async () => {
    (providerMock.getTransactionReceipt as jest.Mock).mockResolvedValue(
      erc20Receipt([
        {
          address: TOKEN,
          topics: [ethers.id('Transfer(address,address,uint256)'), padAddr(RECIPIENT), padAddr(RECIPIENT)],
          data: ethers.zeroPadValue(ethers.toBeHex(2_000_000n), 32),
        },
        {
          // Different recipient — must NOT be credited
          address: TOKEN,
          topics: [ethers.id('Transfer(address,address,uint256)'), padAddr(RECIPIENT), padAddr('0x3333333333333333333333333333333333333333')],
          data: ethers.zeroPadValue(ethers.toBeHex(1_000_000n), 32),
        },
      ])
    );

    const human = await observeOnChainReceived({
      networkId: 'ethereum',
      tokenId: 'usdt-ethereum',
      decimals: 6,
      contract: TOKEN,
      txHash: '0xabc',
      recipientAddress: RECIPIENT,
    });

    expect(human).toBe('2');
  });

  it('ignores Transfer logs sent to a different recipient', async () => {
    (providerMock.getTransactionReceipt as jest.Mock).mockResolvedValue(
      erc20Receipt([
        {
          address: TOKEN,
          topics: [ethers.id('Transfer(address,address,uint256)'), padAddr(RECIPIENT), padAddr('0x4444444444444444444444444444444444444444')],
          data: ethers.zeroPadValue(ethers.toBeHex(2_000_000n), 32),
        },
      ])
    );

    const human = await observeOnChainReceived({
      networkId: 'ethereum',
      tokenId: 'usdt-ethereum',
      decimals: 6,
      contract: TOKEN,
      txHash: '0xabc',
      recipientAddress: RECIPIENT,
    });

    expect(human).toBeNull();
  });

  it('uses native balance delta across the inclusion block', async () => {
    (providerMock.getTransactionReceipt as jest.Mock).mockResolvedValue({
      status: 1,
      blockNumber: 100,
      logs: [],
    });
    (providerMock.getBalance as jest.Mock).mockImplementation(async (addr: string, block?: number) => {
      // before block 99 → 1_000 ETH; at block 100 → 1_500 ETH
      if (block !== undefined && block >= 100) return 1_500n * 10n ** 18n;
      return 1_000n * 10n ** 18n;
    });

    const human = await observeOnChainReceived({
      networkId: 'ethereum',
      tokenId: '',
      decimals: 18,
      contract: null,
      txHash: '0xabc',
      recipientAddress: RECIPIENT,
    });

    expect(human).toBe('500');
  });

  it('returns null when native balance delta is not positive', async () => {
    (providerMock.getTransactionReceipt as jest.Mock).mockResolvedValue({
      status: 1,
      blockNumber: 100,
      logs: [],
    });
    (providerMock.getBalance as jest.Mock).mockResolvedValue(0n);

    const human = await observeOnChainReceived({
      networkId: 'ethereum',
      tokenId: '',
      decimals: 18,
      contract: null,
      txHash: '0xabc',
      recipientAddress: RECIPIENT,
    });

    expect(human).toBeNull();
  });
});
