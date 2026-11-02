/**
 * Seed Token table from TOKEN_SEED catalog.
 * Usage: npm run tokens:seed  (npx ts-node src/scripts/seedTokens.ts)
 *
 * POLICY — insert-only (decided with product; locked by
 * tests/unit/tokenSeedPolicy.test.ts):
 *  - Rows that already exist are NEVER modified. Re-seeding cannot clobber
 *    admin edits (symbol/name/decimals/contractAddress/flags/isActive).
 *    Change existing rows via the admin token API, not by re-seeding.
 *  - A catalog row whose contract is already registered under a different id
 *    is skipped (contracts are immutable once bound; repointing would rebind
 *    ledger balances).
 *  - Only genuinely new rows are created (active, with catalog metadata).
 *
 * Reads are batched (one findMany for the whole catalog); only missing rows
 * are written, so a steady-state re-seed is a single read query.
 */
import { PrismaClient } from '@prisma/client';
import { TOKEN_SEED } from '../services/blockchain/tokens';
import { buildTokenId } from '../services/blockchain/tokenRegistry.service';
import {
  decideSeedRow,
  normalizeSeedContract,
} from '../services/blockchain/tokenSeedPolicy';

const prisma = new PrismaClient();

async function main() {
  let created = 0;
  let skipped = 0;

  // One read for the whole catalog (previously 1–2 queries per token).
  const rows = await prisma.token.findMany({
    select: { id: true, networkId: true, contractAddress: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byContract = new Map(
    rows.map((r) => [`${r.networkId}::${r.contractAddress}`, r.id])
  );

  for (const t of TOKEN_SEED) {
    const id = buildTokenId(t.symbol, t.networkId);
    const contractAddress = normalizeSeedContract(t);
    const takenBy = byContract.get(`${t.networkId}::${contractAddress}`);

    const decision = decideSeedRow({
      seed: t,
      id,
      existing: byId.get(id) ?? null,
      contractTakenById: takenBy && takenBy !== id ? takenBy : null,
    });

    if (decision.action === 'skip') {
      if (decision.reason === 'contract-taken') {
        console.log(`skip ${id}: contract already as ${decision.takenById}`);
      }
      skipped++;
      continue;
    }

    await prisma.token.create({ data: decision.data });
    // Keep the in-memory indexes fresh so a catalog that lists one contract
    // twice behaves exactly like the old per-row lookups (second row skips).
    byId.set(id, { id, networkId: t.networkId, contractAddress });
    byContract.set(`${t.networkId}::${contractAddress}`, id);
    created++;
  }

  // One-time backfill for the binanceSymbol column (added after launch).
  // Only fills rows whose value is still NULL — never overwrites an
  // admin-set mapping. Insert-only policy for every other field is unchanged.
  let backfilled = 0;
  for (const t of TOKEN_SEED) {
    if (!t.binanceSymbol) continue;
    const id = buildTokenId(t.symbol, t.networkId);
    const r = await prisma.token.updateMany({
      where: { id, binanceSymbol: null },
      data: { binanceSymbol: t.binanceSymbol },
    });
    backfilled += r.count;
  }

  console.log(
    `Token seed complete: ${created} created, ${skipped} already seeded (left untouched), total catalog ${TOKEN_SEED.length}`
  );
  console.log(
    `Token binanceSymbol backfill: ${backfilled} rows updated (NULL only)`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
