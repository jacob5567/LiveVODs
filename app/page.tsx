import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, programs } from '@/drizzle/schema';

// The guide is time-sensitive; never serve it from the static cache.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const rows = await db
    .select({
      displayName: channels.displayName,
      platform: channels.platform,
      title: programs.title,
      state: programs.state,
      startsAt: programs.startsAt,
      endsAt: programs.endsAt,
    })
    .from(programs)
    .innerJoin(channels, eq(programs.channelId, channels.id))
    .orderBy(asc(channels.displayName), asc(programs.startsAt));

  return (
    <main style={{ padding: '2rem', maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>LiveVODs</h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
        {rows.length} programs across {new Set(rows.map((r) => r.displayName)).size} channels. The
        guide grid lands in milestone 4.
      </p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {rows.map((r, i) => (
          <li
            key={i}
            style={{
              padding: '0.5rem 0.75rem',
              marginBottom: 4,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderLeft: `3px solid var(--${r.state})`,
              borderRadius: 6,
              display: 'flex',
              gap: '0.75rem',
              alignItems: 'baseline',
            }}
          >
            <code style={{ color: 'var(--text-dim)', minWidth: 72 }}>{r.state}</code>
            <strong style={{ minWidth: 150 }}>{r.displayName}</strong>
            <span>{r.title}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
