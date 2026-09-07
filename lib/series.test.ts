import { describe, expect, it } from 'vitest';
import { assignSeries, seriesStem, type SeriesInput } from './series';

const program = (overrides: Partial<SeriesInput> = {}): SeriesInput => ({
  programId: 1,
  channelId: 10,
  title: 'Some Video',
  category: null,
  platform: 'youtube',
  seriesId: null,
  ...overrides,
});

/** Several programmes on one channel sharing a title shape. */
const run = (titles: string[], channelId = 10) =>
  titles.map((title, i) => program({ programId: i + 1, channelId, title }));

describe('reading a series out of a title', () => {
  it('takes the part before the episode marker', () => {
    expect(seriesStem('Alton Brown Cooks Food | Episode 40: Syrup Sanctuary')).toBe(
      'alton brown cooks food',
    );
    expect(seriesStem("Let's Review Your Games — Ep. 060")).toBe('let s review your games');
  });

  it('reads the same series through different episode markers', () => {
    const forms = [
      'The Long Dark Winter - Part 4',
      'The Long Dark Winter (Part 12)',
      'The Long Dark Winter #7',
      'The Long Dark Winter',
    ];
    expect(new Set(forms.map(seriesStem)).size).toBe(1);
  });

  it('ignores decoration, so a live badge does not split a series', () => {
    expect(seriesStem('🔴 Terraria Playthrough — Part 2')).toBe(seriesStem('Terraria Playthrough'));
  });

  it('gives nothing back for a title with no usable stem', () => {
    // Too short to mean anything: a stem this generic would swallow a channel.
    expect(seriesStem('Ep 4')).toBeNull();
    expect(seriesStem('#12')).toBeNull();
  });

  it('reads no series out of a title that opens with a link', () => {
    // Streamers put their schedule at the front, and the separator after it
    // makes the URL look exactly like a series name.
    expect(seriesStem('http://speedgaming.org/schedule ~~ Race night')).toBeNull();
    expect(seriesStem('www.example.com — Episode 4')).toBeNull();
  });

  it('does not split a hyphenated word', () => {
    // The separator needs space around it, or "Sci-Fi" becomes "Sci".
    expect(seriesStem('Sci-Fi Retrospective Number One')).toBe('sci fi retrospective number one');
  });
});

describe('assigning a series to every programme', () => {
  it('groups a run of episodes that share a title', () => {
    const keys = assignSeries(
      run(['Deep Dive Diaries - Part 1', 'Deep Dive Diaries - Part 2', 'Deep Dive Diaries - Part 3']),
    );

    expect(new Set([...keys.values()].map((v) => v.key)).size).toBe(1);
    expect([...keys.values()][0].key).toContain('title:10:deep dive diaries');
  });

  it('will not call two videos a series', () => {
    // A pair sharing an opening is usually coincidence, not a series.
    const keys = assignSeries(run(['Deep Dive Diaries - Part 1', 'Deep Dive Diaries - Part 2']));

    expect([...keys.values()].every((v) => v.key === 'channel:10')).toBe(true);
  });

  it('keeps two channels apart even when they title alike', () => {
    const keys = assignSeries([
      ...run(['Weekly Roundup Show - 1', 'Weekly Roundup Show - 2', 'Weekly Roundup Show - 3'], 10),
      ...run(['Weekly Roundup Show - 1', 'Weekly Roundup Show - 2', 'Weekly Roundup Show - 3'], 20).map(
        (p, i) => ({ ...p, programId: 100 + i }),
      ),
    ]);

    expect(new Set([...keys.values()].map((v) => v.key)).size).toBe(2);
  });

  it('prefers a playlist the creator declared over anything guessed', () => {
    const keys = assignSeries([
      program({ programId: 1, title: 'Deep Dive Diaries - Part 1', seriesId: 'PL123' }),
      program({ programId: 2, title: 'Deep Dive Diaries - Part 2' }),
      program({ programId: 3, title: 'Deep Dive Diaries - Part 3' }),
    ]);

    expect(keys.get(1)!.key).toBe('playlist:PL123');
    // And the declared one is not counted towards the guessed cluster.
    expect(keys.get(2)!.key).toBe('channel:10');
  });

  it('files a Twitch broadcast under the game it was streamed under', () => {
    const keys = assignSeries([
      program({ programId: 1, platform: 'twitch', category: 'Melee', title: 'friday night' }),
    ]);

    expect(keys.get(1)!.key).toBe('category:10:Melee');
  });

  it('falls back to the channel, so a row still airs a stretch of one creator', () => {
    expect(assignSeries([program({ title: 'A One Off Video Nobody Repeats' })]).get(1)!.key).toBe(
      'channel:10',
    );
  });

  it('gives every programme a key', () => {
    const keys = assignSeries(run(['One', 'Two', 'Three', 'Four']));
    expect(keys.size).toBe(4);
    expect([...keys.values()].every((v) => Boolean(v.key))).toBe(true);
  });
});
