#!/usr/bin/env -S npx ts-node --transpile-only --compiler-options {"module":"commonjs"}
/**
 * Swap readiness matrix: proves every route family quotes live, and reports
 * hot-wallet funding per chain (execution needs funded wallets — quotes do not).
 *
 *   npm run routes:check -- [--skip-routes] [--skip-funding]
 *     [--btc ADDR] [--evm ADDR] [--sol ADDR] [--trx ADDR] [--rpc URL]
 *
 * Without address flags it tries in-process hot-wallet derivation (works
 * where the vault/signer is reachable, e.g. inside the container); pass
 * flags to check arbitrary addresses (e.g. from the admin hot-wallet view).
 * Exit 0 only if every route quotes; EMPTY funding is reported, not fatal.
 */
import dotenv from 'dotenv';
import path from 'path';

// Ops script: needs RPC URLs that live in .env.signer (Tron, EVM).
dotenv.config({ path: path.join(__dirname, '..', '.env.signer') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { bestQuote } from '../src/services/trading/routers';

const BTC = 'bc1q67mqxvlkyz7gltmcqa3rlygnrx9j9zvuaq46hk';
const ETH = '0x8f3cf7ad4aa0d9c3ef2b5e6a7d8c9b0a1f2e3d41';
const SOL = '22gL8ia7EVNHLub9XdXPm2Wk5hh1aXNxvwVaRbFaNzV4';
const TRX = 'TK32ZQaoPVG7CN9FeivaZeCVawPM6BfbHc';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDT_TRX = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface Cell {
  name: string;
  from: string; fromC: string | null; fromDec: number;
  to: string; toC: string | null; toDec: number;
  amount: string; fromAddr: string; toAddr: string;
}

const MATRIX: Cell[] = [
  { name: 'BTC -> USDC(base) [priority]', from: 'bitcoin', fromC: null, fromDec: 8, to: 'base', toC: USDC_BASE, toDec: 6, amount: '100000', fromAddr: BTC, toAddr: ETH },
  { name: 'BTC -> USDT(eth)', from: 'bitcoin', fromC: null, fromDec: 8, to: 'ethereum', toC: USDT_ETH, toDec: 6, amount: '100000', fromAddr: BTC, toAddr: ETH },
  { name: 'BTC -> SOL', from: 'bitcoin', fromC: null, fromDec: 8, to: 'solana', toC: null, toDec: 9, amount: '100000', fromAddr: BTC, toAddr: SOL },
  { name: 'BTC -> ETH', from: 'bitcoin', fromC: null, fromDec: 8, to: 'ethereum', toC: null, toDec: 18, amount: '100000', fromAddr: BTC, toAddr: ETH },
  { name: 'USDC(base) -> BTC', from: 'base', fromC: USDC_BASE, fromDec: 6, to: 'bitcoin', toC: null, toDec: 8, amount: '50000000', fromAddr: ETH, toAddr: BTC },
  { name: 'ETH -> BTC', from: 'ethereum', fromC: null, fromDec: 18, to: 'bitcoin', toC: null, toDec: 8, amount: '50000000000000000', fromAddr: ETH, toAddr: BTC },
  { name: 'USDC(eth) -> USDC(base)', from: 'ethereum', fromC: USDC_ETH, fromDec: 6, to: 'base', toC: USDC_BASE, toDec: 6, amount: '50000000', fromAddr: ETH, toAddr: ETH },
  { name: 'ETH -> SOL', from: 'ethereum', fromC: null, fromDec: 18, to: 'solana', toC: null, toDec: 9, amount: '50000000000000000', fromAddr: ETH, toAddr: SOL },
  { name: 'SOL -> ETH', from: 'solana', fromC: null, fromDec: 9, to: 'ethereum', toC: null, toDec: 18, amount: '500000000', fromAddr: SOL, toAddr: ETH },
  { name: 'SOL -> USDC(sol)', from: 'solana', fromC: null, fromDec: 9, to: 'solana', toC: USDC_SOL, toDec: 6, amount: '500000000', fromAddr: SOL, toAddr: SOL },
  { name: 'TRX -> BTC', from: 'tron', fromC: null, fromDec: 6, to: 'bitcoin', toC: null, toDec: 8, amount: '100000000', fromAddr: TRX, toAddr: BTC },
  { name: 'TRX -> USDT(trx)', from: 'tron', fromC: null, fromDec: 6, to: 'tron', toC: USDT_TRX, toDec: 6, amount: '100000000', fromAddr: TRX, toAddr: TRX },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function checkRoutes(): Promise<boolean> {
  console.log('--- routes (live quotes, no funds needed) ---');
  let ok = true;
  for (const c of MATRIX) {
    try {
      const q = await bestQuote({
        fromNetworkId: c.from, toNetworkId: c.to,
        fromContract: c.fromC, toContract: c.toC,
        fromSymbol: '?', toSymbol: '?',
        amountAtomic: c.amount, fromDecimals: c.fromDec, toDecimals: c.toDec,
        slippagePct: 1, fromAddress: c.fromAddr, toAddress: c.toAddr,
      });
      console.log(`OK   ${c.name}  [${q.provider}] out=${q.amountOutAtomic} min=${q.amountOutMinAtomic ?? '-'}`);
    } catch (err: any) {
      ok = false;
      console.log(`FAIL ${c.name}  ${String(err?.message || err).slice(0, 160)}`);
    }
  }
  return ok;
}

async function tryDerive(networkId: string): Promise<string | undefined> {
  try {
    const { getHotWalletAddress } = await import(
      '../src/services/blockchain/withdrawalBroadcaster.service'
    );
    return await getHotWalletAddress(networkId);
  } catch {
    return undefined;
  }
}

async function btcFunding(addr: string): Promise<string> {
  const [info, utxos] = await Promise.all([
    fetch(`https://mempool.space/api/address/${addr}`).then((r) => r.json() as any),
    fetch(`https://mempool.space/api/address/${addr}/utxo`).then((r) => r.json() as any),
  ]);
  const s = info?.chain_stats || {};
  const bal = (s.funded_txo_sum || 0) - (s.spent_txo_sum || 0);
  return `${(bal / 1e8).toFixed(8)} BTC, ${Array.isArray(utxos) ? utxos.length : '?'} UTXOs`;
}

async function evmFunding(addr: string, rpc: string): Promise<string> {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }),
  }).then((x) => x.json() as any);
  const wei = BigInt(r?.result || '0');
  return `${(Number(wei) / 1e18).toFixed(6)} ETH`;
}

async function solFunding(addr: string): Promise<string> {
  const r = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [addr] }),
  }).then((x) => x.json() as any);
  const lamports = Number(r?.result?.value || 0);
  return `${(lamports / 1e9).toFixed(6)} SOL`;
}

async function trxFunding(addr: string): Promise<string> {
  const r = await fetch(`https://api.trongrid.io/v1/accounts/${addr}`).then(
    (x) => x.json() as any
  );
  const sun = Number(r?.data?.[0]?.balance || 0);
  return `${(sun / 1e6).toFixed(2)} TRX`;
}

async function checkFunding(): Promise<void> {
  console.log('--- hot-wallet funding (execution needs this) ---');
  const addrs: Record<string, string | undefined> = {
    bitcoin: arg('--btc') || (await tryDerive('bitcoin')),
    ethereum: arg('--evm') || (await tryDerive('ethereum')),
    solana: arg('--sol') || (await tryDerive('solana')),
    tron: arg('--trx') || (await tryDerive('tron')),
  };
  const rpc = arg('--rpc') || process.env.ETH_RPC_URL || '';
  const checks: Record<string, (a: string) => Promise<string>> = {
    bitcoin: btcFunding,
    ethereum: (a) => evmFunding(a, rpc),
    solana: solFunding,
    tron: trxFunding,
  };
  for (const [net, addr] of Object.entries(addrs)) {
    if (!addr) {
      console.log(`??   ${net}: no address (vault unreachable here — pass --${net === 'ethereum' ? 'evm' : net.slice(0, 3)} ADDR)`);
      continue;
    }
    try {
      if (net === 'ethereum' && !rpc) throw new Error('no EVM RPC (set ETH_RPC_URL or --rpc URL)');
      const bal = await checks[net](addr);
      const empty = /^(0\.0+|0) (BTC|ETH|SOL|TRX)/.test(bal);
      console.log(`${empty ? 'EMPTY' : 'FUNDED'} ${net}: ${addr} -> ${bal}`);
    } catch (err: any) {
      console.log(`ERR  ${net}: ${addr} (${String(err?.message || err).slice(0, 120)})`);
    }
  }
  console.log('starter suggestion: fund >= 0.005 BTC / 0.2 ETH / 2 SOL / 1000 TRX to operate');
}

async function main(): Promise<void> {
  const skipRoutes = process.argv.includes('--skip-routes');
  const skipFunding = process.argv.includes('--skip-funding');
  let routesOk = true;
  if (!skipRoutes) routesOk = await checkRoutes();
  if (!skipFunding) await checkFunding();
  if (!routesOk) process.exit(1);
}

main().catch((e) => {
  console.error('readiness check crashed:', e?.message || e);
  process.exit(2);
});
