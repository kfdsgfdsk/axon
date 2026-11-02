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
    description: 'Get current available and locked balances for the user.',
    parameters: {
      type: 'object',
      properties: {
        networkId: { type: 'string' },
        tokenId: { type: 'string' },
      },
    },
  },
  {
    name: 'prices' as ToolName,
    description:
      'Get mark prices. Pass symbols (e.g. SOL, ETH) and/or tokenId for specific assets, or networkId alone for that chain\'s native + tokens. Each mark carries price/source/updatedAt/ageMs/stale — stale=true only means older than ~3s (the settlement bar); for dry-run analysis, ageMs under a few minutes is fresh. Unknown assets yield explicit null-price entries.',
    parameters: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' } },
        networkId: { type: 'string' },
        tokenId: { type: 'string' },
      },
    },
  },
  {
    name: 'simulate' as ToolName,
    description: 'Simulate a swap (quote only). Never executes a live trade.',
    parameters: {
      type: 'object',
      properties: {
        fromNetworkId: { type: 'string' },
        toNetworkId: { type: 'string' },
        fromTokenId: { type: 'string' },
        toTokenId: { type: 'string' },
        amount: { type: 'string' },
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
      '24h price history for one asset: change, range, volatility, trend, and recent closes. Pass symbol (e.g. SOL), networkId, or tokenId. Use for chart/momentum/trend questions instead of guessing from a single mark.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        networkId: { type: 'string' },
        tokenId: { type: 'string' },
      },
    },
  },
];
