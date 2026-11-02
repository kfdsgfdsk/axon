/**
 * Small concurrency / pagination helpers. No extra dependencies.
 */

/**
 * Run `fn` over items with at most `limit` in flight.
 * Preserves the "one failure does not cancel siblings" choice of the caller:
 * `fn` should catch its own errors if partial success is required.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await fn(items[index] as T, index);
      }
    })
  );
}

/**
 * Cursor-paginate rows that have a string `id`, ascending.
 * `fetchPage` must use the same page size and `orderBy: { id: 'asc' }`
 * with Prisma-style `cursor` + `skip: 1`.
 * Returns the number of rows visited.
 */
export async function paginateById<T extends { id: string }>(
  pageSize: number,
  fetchPage: (cursor: string | undefined) => Promise<T[]>,
  handle: (rows: T[]) => Promise<void>
): Promise<number> {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  let cursor: string | undefined;
  let total = 0;
  // Hard stop so a broken cursor cannot spin forever.
  for (let page = 0; page < 10_000; page++) {
    const rows = await fetchPage(cursor);
    if (rows.length === 0) break;
    total += rows.length;
    await handle(rows);
    if (rows.length < size) break;
    const lastId = rows[rows.length - 1]?.id;
    if (!lastId || lastId === cursor) break;
    cursor = lastId;
  }
  return total;
}
