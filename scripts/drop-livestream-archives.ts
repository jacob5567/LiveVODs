/**
 * Removes the recordings of YouTube livestreams collected before they stopped
 * being programmed.
 *
 *   npx tsx scripts/drop-livestream-archives.ts [--apply]
 *
 * A stream archive is not a programme worth airing. They run for hours or days
 * — the longest here is a fortnight — so a row that draws one spends the rest
 * of the week on it, split into hundreds of parts, while everything else waits.
 * Ingest no longer creates them, but the ones already collected have to go.
 *
 * Run it once, after restarting the worker on the ingest change. Ordering
 * matters both ways: run it against the old worker and it will simply collect
 * them again, and leave it too long and it starts catching premieres, because
 * an aired premiere is stored exactly like an aired broadcast. Nothing
 * distinguishes them in the database — what separates them at ingest is that
 * the premiere was announced and so was already being followed. There are none
 * yet, which is what makes running this now safe.
 *
 * Uploads are untouched: they are the library.
 */
import { loadEnv } from '@/lib/env';

loadEnv();

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const { db } = await import('@/lib/db');
  const { channels, programs } = await import('@/drizzle/schema');
  const { and, eq, inArray } = await import('drizzle-orm');

  const archives = db
    .select({
      id: programs.id,
      title: programs.title,
      login: channels.login,
      startsAt: programs.startsAt,
      endsAt: programs.endsAt,
    })
    .from(programs)
    .innerJoin(channels, eq(channels.id, programs.channelId))
    .where(
      and(
        eq(channels.platform, 'youtube'),
        eq(programs.isUpload, false),
        // Anything still scheduled or live is left alone: a premiere yet to
        // air is exactly what this must not touch.
        inArray(programs.state, ['aired', 'missed']),
      ),
    )
    .all();

  if (archives.length === 0) {
    console.log('no livestream archives left to remove');
    return;
  }

  const hours = archives.reduce(
    (n, a) => n + (a.endsAt.getTime() - a.startsAt.getTime()) / 3_600_000,
    0,
  );

  console.log(
    `${archives.length} livestream archives, ${Math.round(hours).toLocaleString()} hours of ` +
      `programming${APPLY ? '' : '  [dry run — pass --apply to remove]'}`,
  );

  const longest = [...archives].sort(
    (a, b) => b.endsAt.getTime() - b.startsAt.getTime() - (a.endsAt.getTime() - a.startsAt.getTime()),
  );
  for (const a of longest.slice(0, 5)) {
    const h = (a.endsAt.getTime() - a.startsAt.getTime()) / 3_600_000;
    console.log(`  ${h.toFixed(1).padStart(7)}h  ${a.login.slice(0, 20).padEnd(20)} ${a.title.slice(0, 48)}`);
  }

  if (!APPLY) return;

  const ids = archives.map((a) => a.id);
  db.transaction((tx) => {
    for (let i = 0; i < ids.length; i += 500) {
      tx.delete(programs).where(inArray(programs.id, ids.slice(i, i + 500))).run();
    }
  });

  console.log(`\nremoved ${archives.length} archives`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
