/**
 * PURPOSE
 * -------
 * Tool registry and factory for Muse. Exports a map of available tools
 * and a safe executeTool entry point used by muse.orchestrator.
 *
 * KEY SECURITY & DESIGN CONSTRAINTS
 * ---------------------------------
 * - Muse never moves money. Even the "orders" tool is read-only.
 * - Dry-run is the default. Tools must respect scopes.
 * - Full audit trail: every invocation is recorded by the orchestrator.
 */

import type { ToolContext, ToolName, ToolResult } from '../types';
import { balancesTool } from './balances.tool';
import { chartTool } from './chart.tool';
import { pricesTool } from './prices.tool';
import { simulateTool } from './simulate.tool';
import { ordersTool } from './orders.tool';
import { ledgerTool } from './ledger.tool';
import { ForbiddenError, ValidationError } from '../../../utils/errors';

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>;

export const toolRegistry: Record<ToolName, ToolHandler> = {
  balances: balancesTool,
  prices: pricesTool,
  simulate: simulateTool,
  orders: ordersTool,
  ledger: ledgerTool,
  chart: chartTool,
};

const READ_TOOLS: ToolName[] = ['balances', 'prices', 'simulate', 'orders', 'ledger', 'chart'];
const TRADE_TOOLS: ToolName[] = ['simulate']; // simulate is still quote-only

export function assertToolScope(name: ToolName, ctx: ToolContext): void {
  const scopes = ctx.principal.scopes;
  if (READ_TOOLS.includes(name)) {
    if (!scopes.includes('read') && !scopes.includes('trade')) {
      throw new ForbiddenError(`Tool ${name} requires read or trade scope`);
    }
    return;
  }
  if (TRADE_TOOLS.includes(name) && !scopes.includes('trade') && !scopes.includes('read')) {
    throw new ForbiddenError(`Tool ${name} requires trade or read scope`);
  }
}

export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  toolCallId?: string
): Promise<ToolResult> {
  if (!(name in toolRegistry)) {
    throw new ValidationError(`Unknown tool: ${name}`);
  }
  const toolName = name as ToolName;
  assertToolScope(toolName, ctx);
  const result = await toolRegistry[toolName](params || {}, ctx);
  return {
    ...result,
    toolCallId: toolCallId || result.toolCallId || '',
    name: toolName,
  };
}

export const toolDefinitions = [
  {
    name: 'balances' as ToolName,
    description:
      'Get current available and locked balances for the user. Every row carries networkId + tokenId (tokenId null = native asset); copy those ids verbatim into prices/simulate calls, never bare symbols. Rows also carry symbol + network display names — narrate from those ("USDC on Solana"), never from raw ids.',
    parameters: {
      type: 'object',
      properties: {
        networkId: { type: 'string', description: 'Chain id, e.g. solana' },
        tokenId: { type: 'string', description: 'Registry token id or null for native' },
      },
    },
  },
  {
    name: 'prices' as ToolName,
    description:
      'Get mark prices. Name each asset with chain + asset identity: networkId with symbol (e.g. networkId solana + symbol USDC), or an exact tokenId (e.g. usdc-solana); networkId alone reads that chain\'s native + tokens. A bare symbol live on several chains (USDC, USDT, WETH, ...) ERRORS as ambiguous — pair it with networkId. Native aliases (SOL, ETH, BTC, ...) resolve to their native chain. Each mark carries price/source/updatedAt/ageMs/stale — stale=true only means older than ~3s (the settlement bar); for dry-run analysis, ageMs under a few minutes is fresh. Unknown assets yield explicit null-price entries.',
    parameters: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: 'Pair multi-chain symbols with networkId' },
        networkId: { type: 'string', description: 'Chain id that disambiguates symbols' },
        tokenId: { type: 'string', description: 'Exact registry id, e.g. usdc-solana' },
      },
    },
  },
  {
    name: 'simulate' as ToolName,
    description:
      'Simulate a swap (quote only). Never executes a live trade. Name EACH leg with networkId + tokenId exactly as shown in balances (e.g. fromNetworkId solana, fromTokenId usdc-solana). Native legs omit tokenId or pass null — never the string "null". A bare symbol (e.g. USDC) is resolved on that leg\'s networkId, unknown symbols error loudly. amount is human units (e.g. "2000"). Result carries the expected payout plus worst-case payout, fee, and slippage setting when the quote provides them.',
    parameters: {
      type: 'object',
      properties: {
        fromNetworkId: { type: 'string', description: 'Source chain id, e.g. solana' },
        toNetworkId: { type: 'string', description: 'Destination chain id' },
        fromTokenId: { type: 'string', description: 'Registry id (e.g. usdc-solana) or null for native' },
        toTokenId: { type: 'string', description: 'Registry id or null for native; never "null"' },
        amount: { type: 'string', description: 'Human units, e.g. "2000"' },
      },
      required: ['fromNetworkId', 'toNetworkId', 'amount'],
    },
  },
  {
    name: 'orders' as ToolName,
    description: 'List or get trade orders (read-only).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get'] },
        orderId: { type: 'string' },
        take: { type: 'number' },
      },
    },
  },
  {
    name: 'ledger' as ToolName,
    description: 'Recent ledger entries for the user (read-only).',
    parameters: {
      type: 'object',
      properties: {
        take: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'chart' as ToolName,
    description:
      '24h price history for one asset: change, range, volatility, trend, and recent closes. Name the asset with chain + asset identity: symbol with networkId, or an exact tokenId. A bare symbol live on several chains ERRORS as ambiguous; native aliases (SOL, ETH, BTC) resolve directly. Use for chart/momentum/trend questions instead of guessing from a single mark.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Pair multi-chain symbols with networkId' },
        networkId: { type: 'string', description: 'Chain id that disambiguates the symbol' },
        tokenId: { type: 'string', description: 'Exact registry id, e.g. usdc-solana' },
      },
    },
  },
];
