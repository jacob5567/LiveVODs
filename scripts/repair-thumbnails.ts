/**
 * Repairs Twitch thumbnail URLs stored before the size substitution was fixed.
 *
 *   npx tsx scripts/repair-thumbnails.ts [--dry-run]
 *
 * Twitch VOD templates use %{width}x%{height}. Substituting the bare {width}
 * form first matched inside it and left a stray %, so rows were saved pointing
 * at thumb0-%440x%248.jpg, which 404s. The fix corrects new ingests; this
 * corrects the ones already written, which would otherwise only heal for the
 * handful of VODs still inside the sync's recent window.
 */
import { loadEnv } from '@/lib/env';

loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');

/** thumb0-%440x%248.jpg → thumb0-440x248.jpg */
export function repairSizedUrl(url: string): string {
  return url.replace(/%(\d+)x%(\d+)/g, '$1x$2');
}

async function main(): Promise<void> {
  const { db } = await import('@/lib/db');
  const { programs } = await import('@/drizzle/schema');
  const { eq, like } = await import('drizzle-orm');

  const broken = db
    .select({ id: programs.id, url: programs.thumbnailUrl })
    .from(programs)
    .where(like(programs.thumbnailUrl, '%x%%'))
    .all()
    .filter((r) => r.url && /%\d+x%\d+/.test(r.url));

  console.log(`${broken.length} rows with an unsubstituted size${DRY_RUN ? '  [dry run]' : ''}`);

  for (const row of broken.slice(0, 3)) {
    console.log(`  ${row.url}\n  → ${repairSizedUrl(row.url!)}\n`);
  }

  if (DRY_RUN || broken.length === 0) return;

  db.transaction((tx) => {
    for (const row of broken) {
      tx.update(programs)
        .set({ thumbnailUrl: repairSizedUrl(row.url!) })
        .where(eq(programs.id, row.id))
        .run();
    }
  });

  console.log(`repaired ${broken.length} rows`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
