import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../utils/errors';
import * as adminTrading from './trading.service';

const confirmFillSchema = z.object({
  txHash: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^\S+$/, 'txHash must not contain whitespace'),
  receivedAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'receivedAmount must be a positive decimal string'),
  reason: z.string().trim().max(500).optional(),
});

export async function overview(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await adminTrading.tradingOverview();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await adminTrading.listOrders({
      status: req.query.status as string | undefined,
      userId: req.query.userId as string | undefined,
      provider: req.query.provider as string | undefined,
      take: req.query.take ? parseInt(String(req.query.take), 10) : 50,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function confirmFill(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = confirmFillSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const data = await adminTrading.confirmFill({
      orderId: req.params.id,
      txHash: parsed.data.txHash,
      receivedAmount: parsed.data.receivedAmount,
      adminId: req.user!.id,
      reason: parsed.data.reason,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function forceFail(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await adminTrading.forceFailOrder({
      orderId: req.params.id,
      adminId: req.user!.id,
      reason: req.body.reason,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function forceClosePosition(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await adminTrading.forceClosePosition({
      positionId: req.params.id,
      adminId: req.user!.id,
      reason: req.body.reason,
      overridePriceUsd: req.body.overridePriceUsd,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function pause(req: Request, res: Response, next: NextFunction) {
  try {
    // Must await: Redis write is async; without await a fast response can race
    // the worker still seeing the old flag for the next monitor tick.
    await adminTrading.setTradingPaused(true, req.user!.id, req.body.reason);
    res.json({ success: true, data: { paused: true } });
  } catch (err) {
    next(err);
  }
}

export async function resume(req: Request, res: Response, next: NextFunction) {
  try {
    await adminTrading.setTradingPaused(false, req.user!.id, req.body.reason);
    res.json({ success: true, data: { paused: false } });
  } catch (err) {
    next(err);
  }
}

export async function routeStats(req: Request, res: Response, next: NextFunction) {
  try {
    const hours = req.query.hours ? parseInt(String(req.query.hours), 10) : 24;
    const data = await adminTrading.routeStats(hours);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function rebalanceHint(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await adminTrading.hotWalletRebalanceHint();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function clearCaches(req: Request, res: Response, next: NextFunction) {
  try {
    const data = adminTrading.clearCaches(req.user!.id);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
