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

/**
 * A title that opens with a link names no series.
 *
 * Streamers put their schedule or socials at the front of a title, and the
 * separator that follows makes the URL look exactly like a series name — one
 * lineup here produced a block called "http://speedgaming.org/schedule".
 */
const LINK = /^(?:https?:\/\/|www\.)/i;

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
 * Returns both forms: `stem` is flattened for comparison, so decoration and
 * case cannot split one series in two, and `display` keeps the creator's own
 * capitalisation because that is what gets shown above the row.
 *
 * Null when nothing survives that is long enough to mean anything — a one-off
 * video with no series in its name.
 */
function splitTitle(title: string): { stem: string; display: string } | null {
  let rest = title.normalize('NFKC').trim();

  // Strip the episode marker first: it may sit after the separator, and
  // removing it can leave the whole title as the stem.
  for (const marker of TRAILING_MARKERS) {
    rest = rest.replace(marker, '').trim();
  }

  const [head] = rest.split(SEPARATOR);
  const display = (head ?? rest).trim();
  if (LINK.test(display)) return null;

  const stem = display
    .toLowerCase()
    // Drop emoji, punctuation and decoration so "🔴 Elden Ring!" and
    // "Elden Ring" are the same series.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return stem.length >= MIN_STEM_LENGTH ? { stem, display } : null;
}

/** The comparable form of a title's series, or null if it names none. */
export function seriesStem(title: string): string | null {
  return splitTitle(title)?.stem ?? null;
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
  /** That playlist's name, which is what the guide shows above the run. */
  seriesTitle?: string | null;
}

/** What a programme belongs to, and what to call it. */
export interface Series {
  /** Groups programmes. Opaque — only equality is meaningful. */
  key: string;
  /**
   * What to show above the run, or null when the creator's own name is the
   * best answer and the caller already knows it.
   */
  label: string | null;
}

/**
 * Assigns every programme a series key.
 *
 * Title clustering is scoped to a channel: two creators opening titles the same
 * way are not one series, and a stem is only meaningful in the context of who
 * published it.
 */
export function assignSeries(programs: SeriesInput[]): Map<number, Series> {
  // Count stems per channel first — a stem earns series status only once
  // enough siblings share it.
  const stems = new Map<number, { stem: string; display: string } | null>();
  const population = new Map<string, number>();
  const naming = new Map<string, { programId: number; display: string }>();

  for (const program of programs) {
    const split = program.seriesId ? null : splitTitle(program.title);
    stems.set(program.programId, split);
    if (!split) continue;

    const key = `${program.channelId}:${split.stem}`;
    population.set(key, (population.get(key) ?? 0) + 1);

    // The lowest id names the series, so the label does not depend on the
    // order rows happened to come back in.
    const held = naming.get(key);
    if (!held || program.programId < held.programId) {
      naming.set(key, { programId: program.programId, display: split.display });
    }
  }

  const out = new Map<number, Series>();

  for (const program of programs) {
    if (program.seriesId) {
      out.set(program.programId, {
        key: `playlist:${program.seriesId}`,
        label: program.seriesTitle ?? null,
      });
      continue;
    }

    const split = stems.get(program.programId);
    const key = split ? `${program.channelId}:${split.stem}` : null;
    if (key && (population.get(key) ?? 0) >= MIN_CLUSTER) {
      out.set(program.programId, {
        key: `title:${key}`,
        label: naming.get(key)?.display ?? null,
      });
      continue;
    }

    // A Twitch broadcast is filed under the game it was streamed under, which
    // is the closest thing a stream has to a series.
    if (program.platform === 'twitch' && program.category) {
      out.set(program.programId, {
        key: `category:${program.channelId}:${program.category}`,
        label: program.category,
      });
      continue;
    }

    // The creator is the series. No label: the caller knows their name.
    out.set(program.programId, { key: `channel:${program.channelId}`, label: null });
  }

  return out;
}
