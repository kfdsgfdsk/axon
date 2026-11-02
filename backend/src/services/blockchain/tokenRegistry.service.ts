/**
 * Token registry — DB-backed with short in-memory cache.
 *
 * Adding a new token (admin):
 *   POST /api/v1/admin/tokens
 *   { networkId, contractAddress, symbol?, name?, decimals? }
 *
 * For EVM, decimals/symbol/name are auto-fetched on-chain when omitted.
 * For Solana SPL, pass decimals (and ideally symbol/name) explicitly.
 */

import { ethers } from 'ethers';
import prisma from '../../lib/prisma';
import config from '../../config';
import { getNetwork } from './networks';
import { getEvmProvider } from './evmProvider';
import { AppError, ValidationError, NotFoundError } from '../../utils/errors';
import logger from '../../utils/logger';
import type { TokenStandard } from './tokens';

// Re-exported so existing `... from './tokenRegistry.service'` imports keep working.
// Single source of truth lives in ./tokens.ts (zero-dependency catalog module).
export type { TokenStandard } from './tokens';

export interface TokenInfo {
  id: string;
  symbol: string;
  name: string;
  networkId: string;
  contractAddress: string;
  decimals: number;
  standard: TokenStandard;
  isActive: boolean;
  /** Fee-on-transfer tokens must not use log amount for credit */
  isFeeOnTransfer: boolean;
  /** Admin-declared; never inferred from on-chain symbol() */
  isStable: boolean;
  registeredByAdminId?: string | null;
  minWithdraw?: string | null;
  maxWithdraw?: string | null;
  withdrawFee?: string | null;
  coingeckoId?: string | null;
  /** Binance spot symbol (e.g. "LINKUSDT") for the fast WS/REST price path. */
  binanceSymbol?: string | null;
  logoUrl?: string | null;
}

const ERC20_META_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
] as const;

/** Cache: tokenId -> TokenInfo | null (null = miss after negative lookup) */
let cacheById = new Map<string, TokenInfo>();
let cacheByNetwork = new Map<string, TokenInfo[]>();
/** Uppercase Binance symbol -> tokens priced by it (fast WS path fan-out). */
let cacheByBinance = new Map<string, TokenInfo[]>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

function invalidateCache(): void {
  cacheById = new Map();
  cacheByNetwork = new Map();
  cacheByBinance = new Map();
  cacheLoadedAt = 0;
}

function rowToInfo(row: {
  id: string;
  symbol: string;
  name: string;
  networkId: string;
  contractAddress: string;
  decimals: number;
  standard: string;
  isActive: boolean;
  isFeeOnTransfer?: boolean;
  isStable?: boolean;
  registeredByAdminId?: string | null;
  minWithdraw: { toString(): string } | null;
  maxWithdraw: { toString(): string } | null;
  withdrawFee: { toString(): string } | null;
  coingeckoId: string | null;
  binanceSymbol: string | null;
  logoUrl: string | null;
}): TokenInfo {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    networkId: row.networkId,
    contractAddress: row.contractAddress,
    decimals: row.decimals,
    standard: row.standard as TokenStandard,
    isActive: row.isActive,
    isFeeOnTransfer: !!row.isFeeOnTransfer,
    isStable: !!row.isStable,
    registeredByAdminId: row.registeredByAdminId ?? null,
    minWithdraw: row.minWithdraw?.toString() ?? null,
    maxWithdraw: row.maxWithdraw?.toString() ?? null,
    withdrawFee: row.withdrawFee?.toString() ?? null,
    coingeckoId: row.coingeckoId,
    binanceSymbol: row.binanceSymbol,
    logoUrl: row.logoUrl,
  };
}

async function ensureCache(): Promise<void> {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && cacheById.size > 0) return;

  const rows = await prisma.token.findMany({ where: { isActive: true } });
  const byId = new Map<string, TokenInfo>();
  const byNet = new Map<string, TokenInfo[]>();
  const byBin = new Map<string, TokenInfo[]>();

  for (const r of rows) {
    const info = rowToInfo(r);
    byId.set(info.id, info);
    const list = byNet.get(info.networkId) || [];
    list.push(info);
    byNet.set(info.networkId, list);
    if (info.binanceSymbol) {
      const sym = info.binanceSymbol.toUpperCase();
      const blist = byBin.get(sym) || [];
      blist.push(info);
      byBin.set(sym, blist);
    }
  }

  cacheById = byId;
  cacheByNetwork = byNet;
  cacheByBinance = byBin;
  cacheLoadedAt = Date.now();
}

/**
 * Best-effort cache warm for sync readers (getTokenSync/isStableTokenSync).
 * Call (awaited) on async paths that depend on a warm cache — e.g. watch
 * validation — so a freshly booted process behaves deterministically instead
 * of dropping every token:* key until unrelated traffic warms the cache.
 * Never throws: on DB failure the cache stays as-is (possibly cold).
 */
export async function warmTokenCache(): Promise<void> {
  try {
    await ensureCache();
  } catch (err: unknown) {
    logger.debug('Token cache warm failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getToken(tokenId: string): Promise<TokenInfo> {
  await ensureCache();
  const t = cacheById.get(tokenId);
  if (!t || !t.isActive) {
    // Fall through to DB in case cache is stale after admin add
    const row = await prisma.token.findUnique({ where: { id: tokenId } });
    if (!row || !row.isActive) {
      throw new ValidationError(`Token ${tokenId} is not supported or inactive`);
    }
    const info = rowToInfo(row);
    cacheById.set(info.id, info);
    return info;
  }
  return t;
}

/** Sync cache lookup (may be empty if cache not warmed). Used by isStableTokenId. */
export function getTokenSync(tokenId: string): TokenInfo | null {
  return cacheById.get(tokenId) || null;
}

/**
 * Active tokens priced by a Binance spot symbol (sync, for the WS tick path).
 * May be empty if the cache is not warmed — the feed warms it at connect and
 * refreshes it every 30 s, so staleness after admin changes is bounded.
 */
export function getTokensByBinanceSymbolSync(symbol: string): TokenInfo[] {
  return cacheByBinance.get(symbol.toUpperCase()) || [];
}

/**
 * Single source of truth for "is this tokenId a stablecoin".
 *
 * Admin-declared Token.isStable ONLY — there is deliberately NO
 * symbol-prefix guessing here or in any caller. Cold cache and unknown ids
 * report false (fail closed: unknown assets get real price discovery and
 * stale-mark enforcement instead of a $1 assumption).
 */
export function isStableTokenSync(tokenId: string | null | undefined): boolean {
  if (!tokenId) return false;
  const t = cacheById.get(tokenId);
  return t ? t.isStable === true : false;
}

export async function getActiveTokens(networkId?: string): Promise<TokenInfo[]> {
  await ensureCache();
  if (networkId) {
    return cacheByNetwork.get(networkId) || [];
  }
  return Array.from(cacheById.values());
}

export async function getTokensForNetwork(networkId: string): Promise<TokenInfo[]> {
  return getActiveTokens(networkId);
}

export async function findTokenByContract(
  networkId: string,
  contractAddress: string
): Promise<TokenInfo | undefined> {
  await ensureCache();
  const network = getNetwork(networkId);
  const normalized =
    network.type === 'evm' ? contractAddress.toLowerCase() : contractAddress;

  const list = cacheByNetwork.get(networkId) || [];
  return list.find((t) => t.contractAddress === normalized);
}

/** Build stable token id: symbol-network (lowercase, non-alnum stripped) */
export function buildTokenId(symbol: string, networkId: string): string {
  const sym = symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${sym}-${networkId}`;
}

function normalizeContract(networkId: string, address: string): string {
  const network = getNetwork(networkId);
  if (network.type === 'evm') {
    if (!ethers.isAddress(address)) {
      throw new ValidationError('Invalid EVM contract address');
    }
    return address.toLowerCase();
  }
  if (network.type === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      throw new ValidationError('Invalid Solana mint address');
    }
    return address;
  }
  throw new ValidationError(`Token standard not supported on network ${networkId}`);
}

function standardForNetwork(networkId: string): TokenStandard {
  const network = getNetwork(networkId);
  if (network.type === 'evm') return 'erc20';
  if (network.type === 'solana') return 'spl';
  if (network.type === 'tron') return 'trc20';
  throw new ValidationError(`Tokens not supported on ${networkId}`);
}

async function fetchEvmMetadata(
  networkId: string,
  contractAddress: string
): Promise<{ symbol: string; name: string; decimals: number }> {
  const provider = getEvmProvider(networkId);
  const contract = new ethers.Contract(contractAddress, ERC20_META_ABI, provider);

  let decimals: number;
  let symbol: string;
  let name: string;
  try {
    decimals = Number(await contract.decimals());
  } catch {
    throw new ValidationError('Could not read decimals() — is this an ERC-20?');
  }
  try {
    symbol = String(await contract.symbol());
  } catch {
    symbol = 'UNKNOWN';
  }
  try {
    name = String(await contract.name());
  } catch {
    name = symbol;
  }
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
    throw new ValidationError(`Invalid token decimals: ${decimals}`);
  }
  return { symbol, name, decimals };
}

export interface RegisterTokenInput {
  networkId: string;
  contractAddress: string;
  /** Required — admin-supplied; never taken solely from on-chain symbol() */
  symbol: string;
  name?: string;
  decimals?: number;
  /** Admin must declare stablecoins explicitly (priced ~$1). Default false. */
  isStable: boolean;
  /**
   * Fee-on-transfer / deflationary tokens. When true, deposit paths reject
   * (do not credit from log amount). Ops may dual-control credit after
   * verifying the real balance delta.
   */
  isFeeOnTransfer?: boolean;
  /** Admin performing registration (maker; activation needs a distinct checker). */
  registeredByAdminId?: string;
  /** 'spl' | 'spl2022' — auto-detected from mint owner when omitted on Solana */
  standard?: TokenStandard;
  minWithdraw?: string;
  maxWithdraw?: string;
  withdrawFee?: string;
  coingeckoId?: string;
  /**
   * Binance spot symbol (e.g. "LINKUSDT") for the fast WS/REST price path.
   * Omit for stables (synthetic $1) and tokens not listed on Binance spot.
   * Like coingeckoId, this is single-admin price-source metadata.
   */
  binanceSymbol?: string;
  logoUrl?: string;
  /**
   * Accepted for API compatibility but IGNORED (S-C2): new tokens are always
   * created inactive; activation requires propose + distinct-checker confirm.
   */
  isActive?: boolean;
}

/**
 * Normalize + validate an admin-supplied Binance spot symbol.
 * Uppercase alphanumerics, 2–20 chars. A wrong mapping misprices the token,
 * so the format is enforced here (service level, all callers covered).
 */
export function normalizeBinanceSymbol(input?: string): string | undefined {
  if (input === undefined || input === null || String(input).trim() === '') {
    return undefined;
  }
  const sym = String(input).trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(sym)) {
    throw new ValidationError(
      'binanceSymbol must be 2–20 uppercase alphanumerics (e.g. "LINKUSDT")'
    );
  }
  return sym;
}

/**
 * Register a token. Symbol and isStable are admin-supplied (not trusted from chain).
 * contractAddress is immutable after create. New tokens are always inactive;
 * activation requires proposeTokenActivation + confirmTokenActivation by a
 * distinct admin.
 */
export async function registerToken(input: RegisterTokenInput): Promise<TokenInfo> {
  const network = getNetwork(input.networkId);
  const contractAddress = normalizeContract(input.networkId, input.contractAddress);
  let standard = input.standard || standardForNetwork(input.networkId);
  if (network.type === 'solana' && input.standard === 'spl2022') {
    standard = 'spl2022';
  }

  const symbol = (input.symbol || '').trim();
  if (!symbol) {
    throw new ValidationError(
      'symbol is required (admin-supplied; do not rely on on-chain symbol())'
    );
  }
  if (typeof input.isStable !== 'boolean') {
    throw new ValidationError('isStable boolean is required (explicit admin declaration)');
  }
  const binanceSymbol = normalizeBinanceSymbol(input.binanceSymbol);

  let name = input.name?.trim();
  let decimals = input.decimals;

  if (standard === 'erc20') {
    // decimals/name may still be read from chain; symbol is NEVER taken from chain alone
    if (name === undefined || decimals === undefined) {
      const meta = await fetchEvmMetadata(input.networkId, contractAddress);
      name = name || meta.name;
      decimals = decimals ?? meta.decimals;
    }
  } else {
    if (decimals === undefined) {
      throw new ValidationError('decimals is required for non-EVM tokens');
    }
    name = name || symbol;
  }

  if (decimals! < 0 || decimals! > 36) {
    throw new ValidationError('decimals must be 0–36');
  }

  const id = buildTokenId(symbol, input.networkId);

  const existing = await prisma.token.findUnique({ where: { id } });
  if (existing) {
    // NEVER overwrite contractAddress — that would repoint ledger balances.
    if (
      existing.contractAddress.toLowerCase() !== contractAddress.toLowerCase() &&
      existing.contractAddress !== contractAddress
    ) {
      throw new ValidationError(
        `Token ${id} already bound to contract ${existing.contractAddress}; ` +
          `refusing to repoint to ${contractAddress}. Register under a new symbol/id if needed.`
      );
    }
    // Frozen once active (S-C2): decimals/isStable reprice live balances, so a
    // single admin must not flip them. Register a new token id for new params.
    if (
      existing.isActive &&
      (existing.decimals !== decimals || existing.isStable !== input.isStable)
    ) {
      throw new ValidationError(
        `Token ${id} is active: decimals/isStable are frozen. Register a new token id for new parameters.`
      );
    }
    const updated = await prisma.token.update({
      where: { id },
      data: {
        name: name!,
        decimals: decimals!,
        standard,
        isStable: input.isStable,
        isFeeOnTransfer:
          input.isFeeOnTransfer !== undefined
            ? !!input.isFeeOnTransfer
            : existing.isFeeOnTransfer,
        // isActive is not flipped on metadata update — use propose/confirm activation
        minWithdraw: input.minWithdraw ?? existing.minWithdraw,
        maxWithdraw: input.maxWithdraw ?? existing.maxWithdraw,
        withdrawFee: input.withdrawFee ?? existing.withdrawFee,
        coingeckoId: input.coingeckoId ?? existing.coingeckoId,
        binanceSymbol: binanceSymbol ?? existing.binanceSymbol,
        logoUrl: input.logoUrl ?? existing.logoUrl,
      },
    });
    invalidateCache();
    logger.info('Token metadata updated (contract unchanged)', {
      id,
      networkId: input.networkId,
    });
    await afterTokenSupportChanged(id);
    return rowToInfo(updated);
  }

  const byContract = await prisma.token.findUnique({
    where: {
      networkId_contractAddress: {
        networkId: input.networkId,
        contractAddress,
      },
    },
  });
  if (byContract) {
    throw new ValidationError(
      `Contract already registered as token ${byContract.id}`
    );
  }

  // Always inactive at registration (S-C2): activation requires a distinct
  // checker via proposeTokenActivation/confirmTokenActivation. Any client
  // isActive flag is ignored.
  const created = await prisma.token.create({
    data: {
      id,
      symbol,
      name: name!,
      networkId: input.networkId,
      contractAddress,
      decimals: decimals!,
      standard,
      isStable: input.isStable,
      isFeeOnTransfer: !!input.isFeeOnTransfer,
      isActive: false,
      registeredByAdminId: input.registeredByAdminId || null,
      minWithdraw: input.minWithdraw,
      maxWithdraw: input.maxWithdraw,
      withdrawFee: input.withdrawFee,
      coingeckoId: input.coingeckoId,
      binanceSymbol,
      logoUrl: input.logoUrl,
    },
  });

  invalidateCache();
  logger.info('Token registered (inactive — needs dual-control activation)', {
    id,
    networkId: input.networkId,
    contract: contractAddress,
    isStable: input.isStable,
    registeredByAdminId: input.registeredByAdminId,
  });
  await auditToken(input.registeredByAdminId || 'unknown', 'token.register', {
    id,
    networkId: input.networkId,
    contractAddress,
    symbol,
    isStable: input.isStable,
  });
  return rowToInfo(created);
}

async function auditToken(adminId: string, action: string, detail: object): Promise<void> {
  try {
    await prisma.adminAudit.create({ data: { action, adminId, detail: detail as object } });
  } catch (e: any) {
    logger.warn('AdminAudit write failed', { error: e?.message, action });
  }
}

export interface TokenActivationProposal {
  proposalId: string;
  status: 'PENDING';
}

/**
 * Propose activation (maker step of dual control, S-C2). The token stays
 * inactive until a DISTINCT admin confirms.
 */
export async function proposeTokenActivation(
  makerAdminId: string,
  tokenId: string
): Promise<TokenActivationProposal> {
  const row = await prisma.token.findUnique({ where: { id: tokenId } });
  if (!row) throw new NotFoundError('Token not found');
  if (row.isActive) throw new ValidationError('Token is already active');
  const pending = await prisma.tokenChangeProposal.findFirst({
    where: { tokenId, kind: 'activation', status: 'PENDING' },
  });
  if (pending) {
    if (pending.makerAdminId !== makerAdminId) {
      throw new ValidationError('Activation already proposed by another admin; use confirm');
    }
    return { proposalId: pending.id, status: 'PENDING' };
  }
  const created = await prisma.tokenChangeProposal.create({
    data: { tokenId, kind: 'activation', payload: {}, makerAdminId, status: 'PENDING' },
  });
  await auditToken(makerAdminId, 'token.activation.propose', {
    tokenId,
    networkId: row.networkId,
    contractAddress: row.contractAddress,
    symbol: row.symbol,
  });
  logger.info('Token activation proposed', { tokenId, makerAdminId });
  return { proposalId: created.id, status: 'PENDING' };
}

/**
 * Confirm activation (checker step — must differ from maker). Single-winner
 * claim so concurrent confirms cannot double-apply.
 */
export async function confirmTokenActivation(
  checkerAdminId: string,
  tokenId: string
): Promise<TokenInfo> {
  const pending = await prisma.tokenChangeProposal.findFirst({
    where: { tokenId, kind: 'activation', status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  if (!pending) {
    throw new ValidationError('No pending activation proposal — propose first');
  }
  if (pending.makerAdminId === checkerAdminId) {
    throw new ValidationError('Confirming admin must be distinct from proposing admin');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.tokenChangeProposal.updateMany({
      where: { id: pending.id, status: 'PENDING' },
      data: { status: 'APPLIED' },
    });
    if (claimed.count !== 1) throw new ValidationError('Proposal already resolved');
    const u = await tx.token.update({ where: { id: tokenId }, data: { isActive: true } });
    await tx.adminAudit.create({
      data: {
        action: 'token.activation.confirm',
        adminId: checkerAdminId,
        detail: { tokenId, proposedBy: pending.makerAdminId },
      },
    });
    return u;
  });
  invalidateCache();
  logger.info('Token activated (dual-control)', {
    tokenId,
    checkerAdminId,
    proposedBy: pending.makerAdminId,
  });
  await afterTokenSupportChanged(tokenId);
  return rowToInfo(updated);
}

/**
 * A token just became priced (activated) or its price metadata changed.
 * Warm the cache and auto-watch it so Tier-2 prices it immediately; the
 * Binance WS feed picks up binanceSymbol mappings on its 30 s refresh.
 * Best-effort — never fails the admin operation. Dynamic import avoids a
 * require cycle (watchedTokens.service imports this module).
 */
async function afterTokenSupportChanged(tokenId: string): Promise<void> {
  try {
    await warmTokenCache();
    const { watchAssets } = await import('../trading/watchedTokens.service');
    watchAssets([`token:${tokenId}`]);
  } catch (err: unknown) {
    logger.debug('Token support-changed hook failed (best-effort)', {
      tokenId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Deactivate immediately (safe direction — single admin). Cancels pendings.
 */
export async function deactivateToken(adminId: string, tokenId: string): Promise<TokenInfo> {
  const row = await prisma.token.findUnique({ where: { id: tokenId } });
  if (!row) throw new NotFoundError('Token not found');
  const updated = await prisma.$transaction(async (tx) => {
    await tx.tokenChangeProposal.updateMany({
      where: { tokenId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    const u = await tx.token.update({ where: { id: tokenId }, data: { isActive: false } });
    await tx.adminAudit.create({
      data: { action: 'token.deactivate', adminId, detail: { tokenId } },
    });
    return u;
  });
  invalidateCache();
  logger.info('Token deactivated', { tokenId, adminId });
  return rowToInfo(updated);
}

export interface TokenLimitsInput {
  minWithdraw?: string | null;
  maxWithdraw?: string | null;
  withdrawFee?: string | null;
  isFeeOnTransfer?: boolean;
}

function validateLimitsInput(limits: TokenLimitsInput): void {
  for (const k of ['minWithdraw', 'maxWithdraw', 'withdrawFee'] as const) {
    const v = limits[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) {
      throw new ValidationError(`${k} must be a positive decimal string`);
    }
  }
  if (
    limits.minWithdraw &&
    limits.maxWithdraw &&
    Number(limits.minWithdraw) > Number(limits.maxWithdraw)
  ) {
    throw new ValidationError('minWithdraw must not exceed maxWithdraw');
  }
}

/**
 * Propose limits/fee changes (maker step, S-C2). Applies only after a
 * distinct checker confirms.
 */
export async function proposeTokenLimits(
  makerAdminId: string,
  tokenId: string,
  limits: TokenLimitsInput
): Promise<TokenActivationProposal> {
  const row = await prisma.token.findUnique({ where: { id: tokenId } });
  if (!row) throw new NotFoundError('Token not found');
  validateLimitsInput(limits);
  const pending = await prisma.tokenChangeProposal.findFirst({
    where: { tokenId, kind: 'limits', status: 'PENDING' },
  });
  if (pending && pending.makerAdminId !== makerAdminId) {
    throw new ValidationError('Limits change already proposed by another admin; use confirm');
  }
  if (pending) {
    await prisma.tokenChangeProposal.update({
      where: { id: pending.id },
      data: { payload: limits as object },
    });
    return { proposalId: pending.id, status: 'PENDING' };
  }
  const created = await prisma.tokenChangeProposal.create({
    data: { tokenId, kind: 'limits', payload: limits as object, makerAdminId, status: 'PENDING' },
  });
  await auditToken(makerAdminId, 'token.limits.propose', { tokenId, limits });
  logger.info('Token limits change proposed', { tokenId, makerAdminId });
  return { proposalId: created.id, status: 'PENDING' };
}

/**
 * Confirm limits/fee changes (checker step — must differ from maker).
 */
export async function confirmTokenLimits(
  checkerAdminId: string,
  tokenId: string
): Promise<TokenInfo> {
  const pending = await prisma.tokenChangeProposal.findFirst({
    where: { tokenId, kind: 'limits', status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  if (!pending) {
    throw new ValidationError('No pending limits proposal — propose first');
  }
  if (pending.makerAdminId === checkerAdminId) {
    throw new ValidationError('Confirming admin must be distinct from proposing admin');
  }
  const limits = (pending.payload || {}) as TokenLimitsInput;
  validateLimitsInput(limits);
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.tokenChangeProposal.updateMany({
      where: { id: pending.id, status: 'PENDING' },
      data: { status: 'APPLIED' },
    });
    if (claimed.count !== 1) throw new ValidationError('Proposal already resolved');
    const u = await tx.token.update({
      where: { id: tokenId },
      data: {
        minWithdraw: limits.minWithdraw === undefined ? undefined : limits.minWithdraw,
        maxWithdraw: limits.maxWithdraw === undefined ? undefined : limits.maxWithdraw,
        withdrawFee: limits.withdrawFee === undefined ? undefined : limits.withdrawFee,
        isFeeOnTransfer:
          limits.isFeeOnTransfer === undefined ? undefined : !!limits.isFeeOnTransfer,
      },
    });
    await tx.adminAudit.create({
      data: {
        action: 'token.limits.confirm',
        adminId: checkerAdminId,
        detail: { tokenId, proposedBy: pending.makerAdminId, limits: { ...limits } },
      },
    });
    return u;
  });
  invalidateCache();
  logger.info('Token limits updated (dual-control)', {
    tokenId,
    checkerAdminId,
    proposedBy: pending.makerAdminId,
  });
  return rowToInfo(updated);
}

export async function listAllTokens(includeInactive = false): Promise<TokenInfo[]> {
  const rows = await prisma.token.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ networkId: 'asc' }, { symbol: 'asc' }],
  });
  return rows.map(rowToInfo);
}
