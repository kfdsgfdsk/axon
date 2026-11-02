/**
 * PURPOSE
 * -------
 * Read-only access to the user's trade orders for Muse analysis.
 * Never creates or cancels orders from this tool.
 */

import { listOrders } from '../../trading/trade.service';
import prisma from '../../../lib/prisma';
import type { ToolContext, ToolResult } from '../types';
import { ordersToolParamsSchema } from '../schemas';
import { ForbiddenError } from '../../../utils/errors';

export async function ordersTool(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const started = Date.now();
  const parsed = ordersToolParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      toolCallId: '',
      name: 'orders',
      ok: false,
      error: parsed.error.message,
      durationMs: Date.now() - started,
    };
  }

  try {
    const { action, orderId, take } = parsed.data;
    // Demo flag: serve the seeded orders (same shapes as the ledger reads).
    if (ctx.demoBook) {
      if (action === 'get' && orderId) {
        const order = ctx.demoBook.orders.find((o) => o.id === orderId);
        if (!order) {
          return {
            toolCallId: '',
            name: 'orders',
            ok: false,
            error: 'Order not found',
            durationMs: Date.now() - started,
          };
        }
        return {
          toolCallId: '',
          name: 'orders',
          ok: true,
          data: order,
          durationMs: Date.now() - started,
          asOf: new Date().toISOString(),
        };
      }
      return {
        toolCallId: '',
        name: 'orders',
        ok: true,
        data: ctx.demoBook.orders.slice(0, Math.min(take ?? 50, 100)),
        durationMs: Date.now() - started,
        asOf: new Date().toISOString(),
      };
    }
    if (action === 'get' && orderId) {
      const order = await prisma.tradeOrder.findFirst({
        where: { id: orderId, userId: ctx.principal.userId },
      });
      if (!order) {
        return {
          toolCallId: '',
          name: 'orders',
          ok: false,
          error: 'Order not found',
          durationMs: Date.now() - started,
        };
      }
      return {
        toolCallId: '',
        name: 'orders',
        ok: true,
        data: order,
        durationMs: Date.now() - started,
        asOf: new Date().toISOString(),
      };
    }

    // list
    if (!ctx.principal.scopes.includes('read') && !ctx.principal.scopes.includes('trade')) {
      throw new ForbiddenError('orders tool requires read or trade scope');
    }
    const orders = await listOrders(ctx.principal.userId, take ?? 50);
    return {
      toolCallId: '',
      name: 'orders',
      ok: true,
      data: orders,
      durationMs: Date.now() - started,
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    return {
      toolCallId: '',
      name: 'orders',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
