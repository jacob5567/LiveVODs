/**
 * The program state machine.
 *
 * Live streaming hands us three incompatible shapes of data — scheduled slots
 * (start + end, may never happen), live streams (start, no end, still running),
 * and VODs (start + exact duration) — but a TV guide needs bars with two ends.
 * This module reconciles all three into a single timeline.
 *
 *                     live starts within ±SLOT_TOLERANCE
 *                     of a scheduled slot
 *    [scheduled] ──────────────────────────────────────► [live]
 *         │                                                 │
 *         │ slot passed, never aired                        │ went offline
 *         ▼                                                 ▼
 *     [missed]                                           [aired]
 *                                                           ▲
 *    live with no matching slot (the common Twitch case)     │
 *    ───────────────────────────────────────────────────────┤
 *                                                           │
 *    VOD appears later → exact duration backfilled ─────────┘
 *
 * Deliberately pure: no DB, no network, no clock. That is what makes every
 * branch above testable without credentials, and it is why `now` is a parameter.
 */
import type { ProgramState } from '@/drizzle/schema';
import { MIN_LIVE_BAR_MS, MISSED_GRACE_MS, SLOT_TOLERANCE_MS } from '@/lib/time';

/** A program as it currently exists in the database. */
export interface ProgramRecord {
  id: number;
  channelId: number;
  platformRef: string;
  title: string;
  category: string | null;
  startsAt: Date;
  endsAt: Date;
  endsAtProvisional: boolean;
  state: ProgramState;
  canonicalUrl: string;
  thumbnailUrl: string | null;
  vodRef: string | null;
}

export type NewProgram = Omit<ProgramRecord, 'id'>;
export type ProgramPatch = Partial<NewProgram>;

/** A slot the broadcaster has announced but has not yet aired. */
export interface ScheduledObservation {
  kind: 'scheduled';
  channelId: number;
  /** Twitch schedule segment id, or the YouTube video id of an upcoming stream. */
  platformRef: string;
  title: string;
  category: string | null;
  startsAt: Date;
  /** Twitch gives an end time; YouTube premieres do not, so null means "assume a default slot". */
  endsAt: Date | null;
  canonicalUrl: string;
  thumbnailUrl: string | null;
}

/** The channel is broadcasting right now. */
export interface LiveObservation {
  kind: 'live';
  channelId: number;
  /** Twitch stream id or YouTube video id — the identity of *this* broadcast. */
  platformRef: string;
  title: string;
  category: string | null;
  startedAt: Date;
  canonicalUrl: string;
  thumbnailUrl: string | null;
}

/**
 * The channel is confirmed not broadcasting. Emitted for every channel that was
 * polled but absent from the platform's live response — the reconciler must not
 * have to guess which channels were covered by a poll.
 */
export interface OfflineObservation {
  kind: 'offline';
  channelId: number;
}

/** A finished broadcast with a known duration. */
export interface VodObservation {
  kind: 'vod';
  channelId: number;
  /**
   * The originating broadcast id where the platform exposes it (Twitch VODs
   * carry `stream_id`), so this lands on the very row the live poll created.
   */
  platformRef: string;
  /** The playable video id. */
  vodRef: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  canonicalUrl: string;
  thumbnailUrl: string | null;
}

export type Observation =
  | ScheduledObservation
  | LiveObservation
  | OfflineObservation
  | VodObservation;

export type Write =
  | { op: 'insert'; row: NewProgram }
  | { op: 'update'; id: number; patch: ProgramPatch };

const DEFAULT_SLOT_MS = 2 * 60 * 60 * 1000;

interface WorkingRow {
  /** null for rows created during this pass. */
  id: number | null;
  original: ProgramRecord | null;
  current: NewProgram;
}

const keyOf = (channelId: number, platformRef: string) => `${channelId}:${platformRef}`;

/**
 * While a stream is running its end is unknown, so we peg it to now and re-peg
 * it on every poll. MIN_LIVE_BAR_MS keeps a just-started stream wide enough to
 * see and click on the grid.
 */
function provisionalEnd(startsAt: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), startsAt.getTime() + MIN_LIVE_BAR_MS));
}

export function reconcile(
  existing: ProgramRecord[],
  observations: Observation[],
  now: Date,
): Write[] {
  const working = new Map<string, WorkingRow>();
  const byChannel = new Map<number, WorkingRow[]>();
  // Insertion order is preserved for deterministic output, which keeps tests
  // and debug logs readable.
  const order: WorkingRow[] = [];

  const track = (row: WorkingRow) => {
    working.set(keyOf(row.current.channelId, row.current.platformRef), row);
    const list = byChannel.get(row.current.channelId);
    if (list) list.push(row);
    else byChannel.set(row.current.channelId, [row]);
    order.push(row);
  };

  for (const record of existing) {
    const { id, ...rest } = record;
    track({ id, original: record, current: { ...rest } });
  }

  const channelRows = (channelId: number) => byChannel.get(channelId) ?? [];

  for (const obs of observations) {
    switch (obs.kind) {
      case 'scheduled':
        applyScheduled(obs);
        break;
      case 'live':
        applyLive(obs);
        break;
      case 'offline':
        applyOffline(obs);
        break;
      case 'vod':
        applyVod(obs);
        break;
    }
  }

  sweepMissed();

  return collectWrites(order);

  function applyScheduled(obs: ScheduledObservation) {
    const endsAt = obs.endsAt ?? new Date(obs.startsAt.getTime() + DEFAULT_SLOT_MS);
    const existingRow = working.get(keyOf(obs.channelId, obs.platformRef));

    if (existingRow) {
      // Actual broadcast data always outranks the announced schedule. Once a slot
      // has aired we stop letting the schedule feed rewrite its times.
      if (existingRow.current.state !== 'scheduled') return;

      Object.assign(existingRow.current, {
        title: obs.title,
        category: obs.category,
        startsAt: obs.startsAt,
        endsAt,
        canonicalUrl: obs.canonicalUrl,
        thumbnailUrl: obs.thumbnailUrl,
      });
      return;
    }

    // A slot that already aired had its platformRef rebound from the segment id
    // to the stream id, so it no longer matches by key. Without this check the
    // next schedule sync would resurrect it as a duplicate scheduled row.
    const alreadyAired = channelRows(obs.channelId).some(
      (r) =>
        r.current.state !== 'scheduled' &&
        Math.abs(r.current.startsAt.getTime() - obs.startsAt.getTime()) <= SLOT_TOLERANCE_MS,
    );
    if (alreadyAired) return;

    track({
      id: null,
      original: null,
      current: {
        channelId: obs.channelId,
        platformRef: obs.platformRef,
        title: obs.title,
        category: obs.category,
        startsAt: obs.startsAt,
        endsAt,
        endsAtProvisional: false,
        state: 'scheduled',
        canonicalUrl: obs.canonicalUrl,
        thumbnailUrl: obs.thumbnailUrl,
        vodRef: null,
      },
    });
  }

  function applyLive(obs: LiveObservation) {
    const key = keyOf(obs.channelId, obs.platformRef);
    const existingRow = working.get(key);

    if (existingRow) {
      Object.assign(existingRow.current, {
        title: obs.title,
        category: obs.category,
        startsAt: obs.startedAt,
        endsAt: provisionalEnd(obs.startedAt, now),
        endsAtProvisional: true,
        state: 'live' satisfies ProgramState,
        thumbnailUrl: obs.thumbnailUrl,
      });
      return;
    }

    // Promote the closest scheduled slot this broadcast plausibly fulfils.
    let best: WorkingRow | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const row of channelRows(obs.channelId)) {
      if (row.current.state !== 'scheduled') continue;
      const delta = Math.abs(row.current.startsAt.getTime() - obs.startedAt.getTime());
      if (delta <= SLOT_TOLERANCE_MS && delta < bestDelta) {
        best = row;
        bestDelta = delta;
      }
    }

    if (best) {
      // Rebind identity from the schedule segment to the actual broadcast, so
      // the VOD (which references the stream id) later lands on this same row.
      working.delete(keyOf(best.current.channelId, best.current.platformRef));
      Object.assign(best.current, {
        platformRef: obs.platformRef,
        title: obs.title,
        category: obs.category,
        startsAt: obs.startedAt,
        endsAt: provisionalEnd(obs.startedAt, now),
        endsAtProvisional: true,
        state: 'live' satisfies ProgramState,
        canonicalUrl: obs.canonicalUrl,
        thumbnailUrl: obs.thumbnailUrl,
      });
      working.set(key, best);
      return;
    }

    // No matching slot: an unannounced stream. This is the normal case on Twitch
    // and is what keeps the grid populated for broadcasters who never post a
    // schedule — never drop it.
    track({
      id: null,
      original: null,
      current: {
        channelId: obs.channelId,
        platformRef: obs.platformRef,
        title: obs.title,
        category: obs.category,
        startsAt: obs.startedAt,
        endsAt: provisionalEnd(obs.startedAt, now),
        endsAtProvisional: true,
        state: 'live',
        canonicalUrl: obs.canonicalUrl,
        thumbnailUrl: obs.thumbnailUrl,
        vodRef: null,
      },
    });
  }

  function applyOffline(obs: OfflineObservation) {
    for (const row of channelRows(obs.channelId)) {
      if (row.current.state !== 'live') continue;
      // endsAt keeps the last provisional value, which the live path re-pegged to
      // `now` on every poll — the closest estimate we have of when it stopped.
      row.current.state = 'aired';
      row.current.endsAtProvisional = false;
    }
  }

  function applyVod(obs: VodObservation) {
    const existingRow = working.get(keyOf(obs.channelId, obs.platformRef));

    if (existingRow) {
      // Twitch publishes the VOD while the stream is still running, with a
      // duration that grows. Attach it for playback, but let the live path keep
      // owning the timeline until the broadcast actually ends.
      if (existingRow.current.state === 'live') {
        existingRow.current.vodRef = obs.vodRef;
        return;
      }

      Object.assign(existingRow.current, {
        startsAt: obs.startsAt,
        endsAt: obs.endsAt,
        endsAtProvisional: false,
        state: 'aired' satisfies ProgramState,
        vodRef: obs.vodRef,
        canonicalUrl: obs.canonicalUrl,
        thumbnailUrl: obs.thumbnailUrl ?? existingRow.current.thumbnailUrl,
      });
      return;
    }

    // Backfill: a broadcast that finished before this instance was watching.
    track({
      id: null,
      original: null,
      current: {
        channelId: obs.channelId,
        platformRef: obs.platformRef,
        title: obs.title,
        category: null,
        startsAt: obs.startsAt,
        endsAt: obs.endsAt,
        endsAtProvisional: false,
        state: 'aired',
        canonicalUrl: obs.canonicalUrl,
        thumbnailUrl: obs.thumbnailUrl,
        vodRef: obs.vodRef,
      },
    });
  }

  function sweepMissed() {
    const cutoff = now.getTime() - MISSED_GRACE_MS;
    for (const row of order) {
      if (row.current.state !== 'scheduled') continue;
      if (row.current.endsAt.getTime() < cutoff) row.current.state = 'missed';
    }
  }
}

function collectWrites(rows: WorkingRow[]): Write[] {
  const writes: Write[] = [];

  for (const row of rows) {
    if (row.original === null || row.id === null) {
      writes.push({ op: 'insert', row: row.current });
      continue;
    }

    const patch = diff(row.original, row.current);
    // An empty patch means this pass observed nothing new. Skipping it is what
    // makes re-delivering the same event a genuine no-op rather than a churn of
    // identical updates.
    if (patch !== null) writes.push({ op: 'update', id: row.id, patch });
  }

  return writes;
}

function diff(original: ProgramRecord, current: NewProgram): ProgramPatch | null {
  const patch: ProgramPatch = {};
  let changed = false;

  const set = <K extends keyof NewProgram>(key: K) => {
    const before = original[key];
    const after = current[key];
    const same =
      before instanceof Date && after instanceof Date
        ? before.getTime() === after.getTime()
        : before === after;
    if (!same) {
      patch[key] = after;
      changed = true;
    }
  };

  set('platformRef');
  set('title');
  set('category');
  set('startsAt');
  set('endsAt');
  set('endsAtProvisional');
  set('state');
  set('canonicalUrl');
  set('thumbnailUrl');
  set('vodRef');

  return changed ? patch : null;
}
