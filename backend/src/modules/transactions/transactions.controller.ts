import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getUnifiedHistory } from './transactions.service';
import { getDemoBook, isDemoFlag, type DemoHistoryItem } from '../demo/demoBook';
import { UnauthorizedError, ValidationError } from '../../utils/errors';

export async function listHistory(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new UnauthorizedError();
    const schema = z.object({
      type: z.enum(['deposit', 'withdrawal', 'trade', 'beginner', 'all']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(200).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError('Invalid query');
    // Demo flag: seeded history (same envelope, keyset page over demo rows).
    if (isDemoFlag(req.query.demo)) {
      const data = await demoHistory(req.user.id, parsed.data.type, parsed.data.limit, parsed.data.cursor);
      return res.json({ success: true, data });
    }
    const data = await getUnifiedHistory({
      userId: req.user.id,
      type: parsed.data.type,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
}

/** Demo mirror of getUnifiedHistory: same filters, same envelope. */
async function demoHistory(
  userId: string, type?: string, limit?: number, cursor?: string,
): Promise<{ items: DemoHistoryItem[]; nextCursor: string | null; hasMore: boolean }> {
  const lim = Math.min(limit ?? 50, 100);
  const book = await getDemoBook(userId);
  let items = book.history;
  if (type && type !== 'all') items = items.filter((i) => i.type === type);
  if (cursor) {
    const idx = cursor.indexOf(':');
    const ms = Number(cursor.slice(0, idx));
    const id = cursor.slice(idx + 1);
    if (idx > 0 && Number.isFinite(ms) && id) {
      items = items.filter(
        (i) => i.createdAt.getTime() < ms || (i.createdAt.getTime() === ms && i.id < id),
      );
    }
  }
  const page = items.slice(0, lim);
  const hasMore = items.length > lim;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? `${last.createdAt.getTime()}:${last.id}` : null,
    hasMore,
  };
}
