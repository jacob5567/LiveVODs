/**
 * Fills the database with a plausible lineup and a few hours of programming so
 * the guide can be developed and demoed with no API credentials at all.
 *
 * Safe to re-run: it clears the demo rows first.
 *
 *   npm run db:migrate && npx tsx scripts/seed-demo.ts
 *
 * Once real channels are synced these fixtures only clutter the guide, so:
 *
 *   npx tsx scripts/seed-demo.ts --clear
 *
 * removes them and adds nothing back.
 */
import { eq, like } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, programs, type ProgramState } from '@/drizzle/schema';
import { HOUR_MS, MINUTE_MS } from '@/lib/time';

const CLEAR_ONLY = process.argv.includes('--clear');

const now = Date.now();
const at = (offsetMinutes: number) => new Date(now + offsetMinutes * MINUTE_MS);

type DemoChannel = {
  platform: 'twitch' | 'youtube';
  login: string;
  displayName: string;
  programs: Array<{
    title: string;
    category: string | null;
    startMin: number;
    durationMin: number;
    state: ProgramState;
  }>;
};

const lineup: DemoChannel[] = [
  {
    platform: 'twitch',
    login: 'theprimeagen',
    displayName: 'ThePrimeagen',
    programs: [
      { title: 'Reading Rust So You Do Not Have To', category: 'Software and Game Development', startMin: -220, durationMin: 115, state: 'aired' },
      { title: 'Vim Motions Until It Hurts', category: 'Software and Game Development', startMin: -35, durationMin: 0, state: 'live' },
      { title: 'Late Night Refactor', category: 'Software and Game Development', startMin: 180, durationMin: 120, state: 'scheduled' },
    ],
  },
  {
    platform: 'twitch',
    login: 'tsoding',
    displayName: 'Tsoding',
    programs: [
      { title: 'Writing a Compiler in C from Scratch', category: 'Software and Game Development', startMin: -95, durationMin: 0, state: 'live' },
      { title: 'Porth Episode 42', category: 'Software and Game Development', startMin: 240, durationMin: 180, state: 'scheduled' },
    ],
  },
  {
    platform: 'twitch',
    login: 'piratesoftware',
    displayName: 'PirateSoftware',
    programs: [
      { title: 'Heartbound Development', category: 'Game Development', startMin: -300, durationMin: 200, state: 'aired' },
      { title: 'Game Dev Q&A', category: 'Just Chatting', startMin: 60, durationMin: 90, state: 'scheduled' },
    ],
  },
  {
    platform: 'twitch',
    login: 'cohhcarnage',
    displayName: 'CohhCarnage',
    programs: [
      // A slot that came and went with no broadcast — the "missed" case.
      { title: 'Morning Playthrough', category: 'Baldur’s Gate 3', startMin: -280, durationMin: 120, state: 'missed' },
      { title: 'Cohhilition Community Night', category: 'Just Chatting', startMin: 30, durationMin: 240, state: 'scheduled' },
    ],
  },
  {
    platform: 'twitch',
    login: 'northernlion',
    displayName: 'Northernlion',
    programs: [
      { title: 'The Binding of Isaac: Repentance', category: 'The Binding of Isaac', startMin: -150, durationMin: 145, state: 'aired' },
      { title: 'Roguelike Roulette', category: 'Variety', startMin: 15, durationMin: 120, state: 'scheduled' },
    ],
  },
  {
    platform: 'youtube',
    login: '@LinusTechTips',
    displayName: 'Linus Tech Tips',
    programs: [
      { title: 'WAN Show', category: 'Science & Technology', startMin: 120, durationMin: 180, state: 'scheduled' },
    ],
  },
  {
    platform: 'youtube',
    login: '@Fireship',
    displayName: 'Fireship',
    programs: [
      { title: 'Code Report Live', category: 'Science & Technology', startMin: -20, durationMin: 0, state: 'live' },
    ],
  },
  {
    platform: 'youtube',
    login: '@ThePrimeTimeagen',
    displayName: 'ThePrimeTime',
    programs: [
      { title: 'Reacting to Hacker News', category: 'Science & Technology', startMin: -400, durationMin: 165, state: 'aired' },
    ],
  },
];

function canonicalUrl(c: DemoChannel): string {
  return c.platform === 'twitch'
    ? `https://twitch.tv/${c.login}`
    : `https://youtube.com/${c.login}`;
}

let channelCount = 0;
let programCount = 0;

if (CLEAR_ONLY) {
  // Programs go with them via ON DELETE CASCADE.
  const removed = db
    .delete(channels)
    .where(like(channels.platformChannelId, 'demo-%'))
    .run();

  console.log(`removed ${removed.changes} demo channel(s) and their programs`);
  process.exit(0);
}

db.transaction((tx) => {
  for (const [i, c] of lineup.entries()) {
    const platformChannelId = `demo-${c.platform}-${i}`;

    tx.delete(channels)
      .where(eq(channels.platformChannelId, platformChannelId))
      .run();

    const [row] = tx
      .insert(channels)
      .values({
        platform: c.platform,
        platformChannelId,
        login: c.login,
        displayName: c.displayName,
        avatarUrl: null,
        enabled: true,
      })
      .returning({ id: channels.id })
      .all();

    channelCount += 1;

    for (const [j, p] of c.programs.entries()) {
      const startsAt = at(p.startMin);
      // A live program's end is provisional: it is "now" plus a little, and gets
      // finalised when the stream actually goes offline.
      const isLive = p.state === 'live';
      const endsAt = isLive
        ? new Date(Math.max(now, startsAt.getTime() + 15 * MINUTE_MS))
        : at(p.startMin + p.durationMin);

      tx.insert(programs)
        .values({
          channelId: row.id,
          platformRef: `${platformChannelId}-p${j}`,
          title: p.title,
          category: p.category,
          startsAt,
          endsAt,
          endsAtProvisional: isLive,
          state: p.state,
          canonicalUrl: canonicalUrl(c),
          thumbnailUrl: null,
          vodRef: p.state === 'aired' ? `demo-vod-${i}-${j}` : null,
          updatedAt: new Date(now),
        })
        .run();

      programCount += 1;
    }
  }
});

console.log(
  `seeded ${channelCount} channels and ${programCount} programs ` +
    `spanning ${new Date(now - 7 * HOUR_MS).toISOString()} → ${new Date(now + 7 * HOUR_MS).toISOString()}`,
);
