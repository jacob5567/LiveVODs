/**
 * Deciding what makes two programmes belong together.
 *
 * The scheduler airs a series in a run rather than scattering it, but it takes
 * no view on what a series *is* — it only reads a key. This module produces
 * that key, from the best evidence available for each programme:
 *
 *   1. a playlist the creator put it in — declared by the creator, so nothing
 *      else comes close;
 *   2. a title it shares with several siblings on the same channel — free, and
 *      it catches the series creators never made a playlist for;
 *   3. the Twitch category it was streamed under — three hours of one game;
 *   4. failing all that, the channel itself, so a row still airs a stretch of
 *      one creator rather than dealing them out one at a time.
 *
 * Pure: no database, no network. Everything here is a function of the rows the
 * caller already loaded, which is what keeps it testable and cheap enough to
 * run on every request.
 */
import type { Platform } from '@/drizzle/schema';

/**
 * How many programmes must share a title shape before it counts as a series.
 *
 * Two videos sharing a prefix is usually a coincidence — a creator opening two
 * titles the same way. Three is a pattern.
 */
const MIN_CLUSTER = 3;

/**
 * Shortest usable title stem. Below this a prefix carries no meaning: "the",
 * "my", "ep" would collapse half a channel into one series.
 */
const MIN_STEM_LENGTH = 10;

/**
 * Separators a creator uses to put the series first and the episode second:
 * "Brawl Minus - Episode 4", "The Rundown — Wednesday", "Elden Ring | Part 12".
 *
 * All require surrounding space, so hyphenated words and times survive intact.
 */
const SEPARATOR = /\s+[|—–~]+\s+|\s+-\s+|:\s+/;

/** Trailing episode markers, which vary but always sit at the end. */
const TRAILING_MARKERS: RegExp[] = [
  // (Part 2), [Episode 11], (pt. 3)
  /[([][^)\]]*\b(?:part|pt|ep|episode|no|vol|volume)\b[^)\]]*[)\]]\s*$/i,
  // - Part 2, | Episode 11, # 4
  /[\s\-|#:]*\b(?:part|pt|ep|episode|vol|volume)\b\.?\s*\d+\s*$/i,
  // trailing bare numbering: "#14", "(2024)"
  /[\s\-|]*#\s*\d+\s*$/,
  /\(\s*\d{4}\s*\)\s*$/,
];

/**
 * The part of a title that names the series rather than the episode.
 *
 * Returns null when nothing survives that is long enough to mean anything —
 * a one-off video with no series in its name.
 */
export function seriesStem(title: string): string | null {
  let stem = title.normalize('NFKC').trim();

  // Strip the episode marker first: it may sit after the separator, and
  // removing it can leave the whole title as the stem.
  for (const marker of TRAILING_MARKERS) {
    stem = stem.replace(marker, '').trim();
  }

  const [head] = stem.split(SEPARATOR);
  const candidate = (head ?? stem).trim();

  const normalised = candidate
    .toLowerCase()
    // Drop emoji, punctuation and decoration so "🔴 Elden Ring!" and
    // "Elden Ring" are the same series.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalised.length >= MIN_STEM_LENGTH ? normalised : null;
}

/** One programme, as much of it as deciding its series requires. */
export interface SeriesInput {
  programId: number;
  channelId: number;
  title: string;
  category: string | null;
  platform: Platform;
  /** Playlist the creator filed it under, where that has been collected. */
  seriesId: string | null;
}

/**
 * Assigns every programme a series key.
 *
 * Title clustering is scoped to a channel: two creators opening titles the same
 * way are not one series, and a stem is only meaningful in the context of who
 * published it.
 */
export function assignSeries(programs: SeriesInput[]): Map<number, string> {
  // Count stems per channel first — a stem earns series status only once
  // enough siblings share it.
  const stems = new Map<number, string | null>();
  const population = new Map<string, number>();

  for (const program of programs) {
    const stem = program.seriesId ? null : seriesStem(program.title);
    stems.set(program.programId, stem);
    if (stem) {
      const key = `${program.channelId}:${stem}`;
      population.set(key, (population.get(key) ?? 0) + 1);
    }
  }

  const out = new Map<number, string>();

  for (const program of programs) {
    if (program.seriesId) {
      out.set(program.programId, `playlist:${program.seriesId}`);
      continue;
    }

    const stem = stems.get(program.programId);
    if (stem && (population.get(`${program.channelId}:${stem}`) ?? 0) >= MIN_CLUSTER) {
      out.set(program.programId, `title:${program.channelId}:${stem}`);
      continue;
    }

    // A Twitch broadcast is filed under the game it was streamed under, which
    // is the closest thing a stream has to a series.
    if (program.platform === 'twitch' && program.category) {
      out.set(program.programId, `category:${program.channelId}:${program.category}`);
      continue;
    }

    out.set(program.programId, `channel:${program.channelId}`);
  }

  return out;
}
