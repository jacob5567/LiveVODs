import { describe, expect, it } from 'vitest';
import { MINUTE_MS, MISSED_GRACE_MS, SLOT_TOLERANCE_MS } from '@/lib/time';
import {
  reconcile,
  type LiveObservation,
  type Observation,
  type ProgramRecord,
  type ScheduledObservation,
  type VodObservation,
  type Write,
} from './reconcile';

const NOW = new Date('2026-09-01T20:00:00.000Z');
const CHANNEL = 1;

const at = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * MINUTE_MS);

function program(overrides: Partial<ProgramRecord> = {}): ProgramRecord {
  return {
    id: 100,
    channelId: CHANNEL,
    platformRef: 'segment-a',
    title: 'Scheduled Show',
    category: 'Just Chatting',
    startsAt: at(0),
    endsAt: at(120),
    endsAtProvisional: false,
    state: 'scheduled',
    canonicalUrl: 'https://twitch.tv/demo',
    thumbnailUrl: null,
    vodRef: null,
    isUpload: false,
    ...overrides,
  };
}

function scheduled(overrides: Partial<ScheduledObservation> = {}): ScheduledObservation {
  return {
    kind: 'scheduled',
    channelId: CHANNEL,
    platformRef: 'segment-a',
    title: 'Scheduled Show',
    category: 'Just Chatting',
    startsAt: at(0),
    endsAt: at(120),
    canonicalUrl: 'https://twitch.tv/demo',
    thumbnailUrl: null,
    ...overrides,
  };
}

function live(overrides: Partial<LiveObservation> = {}): LiveObservation {
  return {
    kind: 'live',
    channelId: CHANNEL,
    platformRef: 'stream-999',
    title: 'Actually Streaming',
    category: 'Software and Game Development',
    startedAt: at(0),
    canonicalUrl: 'https://twitch.tv/demo',
    thumbnailUrl: 'https://cdn/thumb.jpg',
    ...overrides,
  };
}

function vod(overrides: Partial<VodObservation> = {}): VodObservation {
  return {
    kind: 'vod',
    channelId: CHANNEL,
    platformRef: 'stream-999',
    vodRef: 'video-555',
    title: 'Actually Streaming',
    startsAt: at(0),
    endsAt: at(97),
    canonicalUrl: 'https://twitch.tv/videos/555',
    thumbnailUrl: null,
    ...overrides,
  };
}

const inserts = (writes: Write[]) =>
  writes.filter((w): w is Extract<Write, { op: 'insert' }> => w.op === 'insert');
const updates = (writes: Write[]) =>
  writes.filter((w): w is Extract<Write, { op: 'update' }> => w.op === 'update');

describe('scheduled slots', () => {
  it('inserts an announced slot that is not yet known', () => {
    const writes = reconcile([], [scheduled({ startsAt: at(60), endsAt: at(180) })], NOW);

    expect(inserts(writes)).toHaveLength(1);
    expect(inserts(writes)[0].row).toMatchObject({
      state: 'scheduled',
      platformRef: 'segment-a',
      endsAtProvisional: false,
    });
  });

  it('assumes a default slot length when the platform gives no end time', () => {
    // YouTube premieres carry scheduledStartTime but no duration.
    const writes = reconcile(
      [],
      [scheduled({ startsAt: at(60), endsAt: null, platformRef: 'yt-video-1' })],
      NOW,
    );

    const row = inserts(writes)[0].row;
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(2 * 60 * MINUTE_MS);
  });

  it('does not let a schedule refresh rewrite a slot that already aired', () => {
    const aired = program({ state: 'aired', startsAt: at(-100), endsAt: at(-10) });
    const writes = reconcile(
      [aired],
      [scheduled({ startsAt: at(-100), endsAt: at(20), title: 'Renamed By Schedule' })],
      NOW,
    );

    expect(writes).toHaveLength(0);
  });
});

describe('going live', () => {
  it('promotes a matching scheduled slot and rebinds it to the broadcast id', () => {
    const slot = program({ id: 7, startsAt: at(0) });
    // Streamer starts 12 minutes late — inside tolerance.
    const writes = reconcile([slot], [live({ startedAt: at(12) })], NOW);

    expect(inserts(writes)).toHaveLength(0);
    expect(updates(writes)).toHaveLength(1);

    const update = updates(writes)[0];
    expect(update.id).toBe(7);
    expect(update.patch).toMatchObject({
      state: 'live',
      // Identity moves from the schedule segment to the actual stream, so the
      // VOD can later find this row.
      platformRef: 'stream-999',
      endsAtProvisional: true,
    });
    expect(update.patch.startsAt).toEqual(at(12));
  });

  it('creates an ad-hoc program when the stream matches no slot', () => {
    // The common Twitch case: broadcaster keeps no schedule at all.
    const writes = reconcile([], [live({ startedAt: at(-30) })], NOW);

    expect(inserts(writes)).toHaveLength(1);
    expect(inserts(writes)[0].row).toMatchObject({
      state: 'live',
      platformRef: 'stream-999',
      endsAtProvisional: true,
    });
  });

  it('does not promote a slot that is outside the tolerance window', () => {
    const slot = program({ id: 7, startsAt: at(0) });
    const startedAt = new Date(at(0).getTime() + SLOT_TOLERANCE_MS + MINUTE_MS);

    const writes = reconcile([slot], [live({ startedAt })], NOW);

    // The far-off slot is untouched and the stream stands on its own.
    expect(inserts(writes)).toHaveLength(1);
    expect(inserts(writes)[0].row.state).toBe('live');
  });

  it('picks the closest slot when several are within tolerance', () => {
    const near = program({ id: 8, platformRef: 'segment-near', startsAt: at(10) });
    const far = program({ id: 9, platformRef: 'segment-far', startsAt: at(-25) });

    const writes = reconcile([near, far], [live({ startedAt: at(12) })], NOW);

    const promoted = updates(writes).filter((u) => u.patch.state === 'live');
    expect(promoted).toHaveLength(1);
    expect(promoted[0].id).toBe(8);
  });

  it('keeps extending the provisional end while the stream runs', () => {
    const running = program({
      id: 12,
      platformRef: 'stream-999',
      state: 'live',
      startsAt: at(-45),
      endsAt: at(-10),
      endsAtProvisional: true,
    });

    const writes = reconcile([running], [live({ startedAt: at(-45) })], NOW);

    expect(updates(writes)[0].patch.endsAt).toEqual(NOW);
  });

  it('gives a just-started stream a bar wide enough to be clickable', () => {
    const writes = reconcile([], [live({ startedAt: NOW })], NOW);

    const row = inserts(writes)[0].row;
    expect(row.endsAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('going offline', () => {
  it('finalises the provisional end when the broadcast stops', () => {
    const running = program({
      id: 12,
      platformRef: 'stream-999',
      state: 'live',
      startsAt: at(-90),
      endsAt: at(-1),
      endsAtProvisional: true,
    });

    const writes = reconcile([running], [{ kind: 'offline', channelId: CHANNEL }], NOW);

    expect(updates(writes)[0].patch).toEqual({
      state: 'aired',
      endsAtProvisional: false,
    });
  });

  it('leaves channels that were already idle alone', () => {
    const aired = program({ id: 3, state: 'aired', startsAt: at(-300), endsAt: at(-180) });
    const writes = reconcile([aired], [{ kind: 'offline', channelId: CHANNEL }], NOW);

    expect(writes).toHaveLength(0);
  });
});

describe('VOD backfill', () => {
  it('replaces the estimated end with the real duration once the VOD lands', () => {
    const aired = program({
      id: 20,
      platformRef: 'stream-999',
      state: 'aired',
      startsAt: at(0),
      endsAt: at(90), // estimated from the last poll before it went offline
      endsAtProvisional: false,
    });

    const writes = reconcile([aired], [vod({ endsAt: at(97) })], NOW);

    // Only the fields that actually moved appear in the patch — endsAtProvisional
    // was already false, so it is correctly absent.
    expect(updates(writes)[0].patch).toEqual({
      endsAt: at(97),
      vodRef: 'video-555',
      canonicalUrl: 'https://twitch.tv/videos/555',
    });
  });

  it('attaches the VOD without ending a stream that is still running', () => {
    // Twitch publishes the VOD as soon as the stream starts, with a growing
    // duration — it must not be read as the broadcast having finished.
    const running = program({
      id: 21,
      platformRef: 'stream-999',
      state: 'live',
      startsAt: at(-60),
      endsAt: NOW,
      endsAtProvisional: true,
    });

    const writes = reconcile([running], [vod({ endsAt: at(-2) })], NOW);

    expect(updates(writes)[0].patch).toEqual({ vodRef: 'video-555' });
  });

  it('backfills history that finished before this instance was watching', () => {
    const writes = reconcile([], [vod({ startsAt: at(-600), endsAt: at(-450) })], NOW);

    expect(inserts(writes)[0].row).toMatchObject({
      state: 'aired',
      vodRef: 'video-555',
      endsAtProvisional: false,
    });
  });
});

describe('missed slots', () => {
  it('writes off a slot whose window passed with no broadcast', () => {
    const stale = program({
      id: 30,
      startsAt: at(-300),
      endsAt: new Date(NOW.getTime() - MISSED_GRACE_MS - MINUTE_MS),
    });

    const writes = reconcile([stale], [], NOW);

    expect(updates(writes)[0].patch).toEqual({ state: 'missed' });
  });

  it('holds off during the grace period, since streamers run late', () => {
    const justEnded = program({
      id: 31,
      startsAt: at(-120),
      endsAt: new Date(NOW.getTime() - MISSED_GRACE_MS + MINUTE_MS),
    });

    expect(reconcile([justEnded], [], NOW)).toHaveLength(0);
  });

  it('does not write off a slot that went live', () => {
    const slot = program({ id: 32, startsAt: at(-200), endsAt: at(-100) });
    const writes = reconcile([slot], [live({ startedAt: at(-195) })], NOW);

    expect(updates(writes)[0].patch.state).toBe('live');
  });
});

describe('idempotency', () => {
  const cases: Array<[string, Observation[]]> = [
    ['a scheduled slot', [scheduled({ startsAt: at(60), endsAt: at(180) })]],
    ['a live stream', [live({ startedAt: at(-30) })]],
    ['a VOD', [vod({ startsAt: at(-600), endsAt: at(-450) })]],
  ];

  it.each(cases)('re-delivering %s produces no second row and no churn', (_label, observations) => {
    const first = reconcile([], observations, NOW);
    expect(inserts(first)).toHaveLength(1);

    // Simulate the insert landing, then the identical event arriving again —
    // which happens whenever poll and push both cover the same channel.
    const stored: ProgramRecord = { id: 500, ...inserts(first)[0].row };
    const second = reconcile([stored], observations, NOW);

    expect(second).toHaveLength(0);
  });

  it('does not resurrect a scheduled row after its slot has aired', () => {
    // The row was rebound to the stream id when it went live, so the schedule
    // feed's segment id no longer matches by key.
    const promoted = program({
      id: 40,
      platformRef: 'stream-999',
      state: 'aired',
      startsAt: at(5),
      endsAt: at(100),
    });

    const writes = reconcile([promoted], [scheduled({ startsAt: at(0), endsAt: at(120) })], NOW);

    expect(inserts(writes)).toHaveLength(0);
  });

  it('still announces a premiere when the channel has a recent upload nearby', () => {
    // Since the backfill landed, every channel carries hundreds of uploads. An
    // upload is library content that never aired, so it is not the aired form
    // of anything — but it used to count against the tolerance window and
    // silently swallow any premiere announced close to it.
    const upload = program({
      id: 41,
      platformRef: 'upload-abc',
      state: 'aired',
      isUpload: true,
      startsAt: at(-20),
      endsAt: at(5),
    });

    const premiere = scheduled({
      platformRef: 'premiere-xyz',
      startsAt: at(10),
      endsAt: at(25),
    });

    expect(inserts(reconcile([upload], [premiere], NOW))).toHaveLength(1);
  });

  it('handles a full lifecycle without duplicating the program', () => {
    let rows: ProgramRecord[] = [];
    let nextId = 1;

    const apply = (observations: Observation[], now: Date) => {
      for (const write of reconcile(rows, observations, now)) {
        if (write.op === 'insert') {
          rows.push({ id: nextId++, ...write.row });
        } else {
          rows = rows.map((r) => (r.id === write.id ? { ...r, ...write.patch } : r));
        }
      }
    };

    apply([scheduled({ startsAt: at(0), endsAt: at(120) })], at(-60));
    apply([live({ startedAt: at(5) })], at(10));
    apply([live({ startedAt: at(5) })], at(60));
    apply([{ kind: 'offline', channelId: CHANNEL }], at(95));
    apply([vod({ startsAt: at(5), endsAt: at(93) })], at(100));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'aired',
      platformRef: 'stream-999',
      vodRef: 'video-555',
      endsAtProvisional: false,
    });
    expect(rows[0].startsAt).toEqual(at(5));
    expect(rows[0].endsAt).toEqual(at(93));
  });
});

describe('multi-channel batches', () => {
  it('keeps channels independent within one pass', () => {
    const a = program({ id: 60, channelId: 1, platformRef: 'stream-a', state: 'live' });
    const b = program({ id: 61, channelId: 2, platformRef: 'stream-b', state: 'live' });

    const writes = reconcile(
      [a, b],
      [
        { kind: 'offline', channelId: 1 },
        live({ channelId: 2, platformRef: 'stream-b', startedAt: at(-20) }),
      ],
      NOW,
    );

    const byId = new Map(updates(writes).map((u) => [u.id, u.patch]));
    // Channel 1 ended; channel 2 must be untouched by that offline signal. Its
    // patch carries no `state` because it was already live and stayed live.
    expect(byId.get(60)).toMatchObject({ state: 'aired' });
    expect(byId.get(61)?.state).toBeUndefined();
    expect(byId.get(61)).toMatchObject({ endsAtProvisional: true });
  });
});
