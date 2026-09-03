'use client';

import { useEffect, useState } from 'react';
import type { GuideSlot } from '@/lib/guide';
import styles from './ProgramPreview.module.css';

const CARD_W = 296;
/**
 * Only used to decide whether the card fits above the bar. Deliberately the
 * tall case — thumbnail plus a three-line title — because guessing low flips it
 * upward into a space it does not fit and pushes it off the top of the screen.
 */
const CARD_H = 380;
const GAP = 10;
const EDGE = 8;

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const date = (ms: number) =>
  new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

function runtime(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function label(slot: GuideSlot): { text: string; live: boolean } {
  if (slot.state === 'missed') return { text: 'DID NOT AIR', live: false };
  // A marathon airs in blocks, and which block you are looking at matters more
  // than that it is a repeat.
  if (slot.partCount > 1) return { text: `PART ${slot.part} OF ${slot.partCount}`, live: false };
  if (!slot.isAppointment) return { text: slot.isUpload ? 'REPLAY' : 'REPEAT', live: false };
  if (slot.state === 'live') return { text: 'LIVE', live: true };
  return { text: 'UPCOMING', live: false };
}

/**
 * Detail for the programme under the pointer.
 *
 * Bars narrower than about a quarter-hour have no room for any text at all, so
 * without this a dense row is a strip of anonymous colour. It replaces the
 * browser's own tooltip, which arrived too slowly to be useful for scanning and
 * could not show the thumbnail the database already holds.
 */
export function ProgramPreview({ slot, anchor }: { slot: GuideSlot; anchor: DOMRect }) {
  /**
   * A thumbnail can still fail — a deleted VOD, an expired link — and a blank
   * 16:9 block is worse than no block, so the space collapses rather than
   * sitting empty. Reset per programme, since the card is reused as the
   * pointer moves rather than remounted (which would replay its animation on
   * every bar).
   */
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [slot.thumbnailUrl]);

  // Rendered off-screen for one frame would flash; instead the position is
  // computed immediately and only clamped against the viewport.
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Centred on the bar, then pulled back inside the viewport rather than
  // hanging off the edge — the rows at the far right of the guide are exactly
  // where the narrow bars tend to be.
  const left = Math.min(
    Math.max(EDGE, anchor.left + anchor.width / 2 - CARD_W / 2),
    viewport.w - CARD_W - EDGE,
  );

  // Above the bar by default; below when the row sits near the top of the screen.
  const above = anchor.top - GAP - CARD_H > EDGE;
  const top = above ? anchor.top - GAP : anchor.bottom + GAP;

  const { text, live } = label(slot);
  const provenance = slot.isAppointment
    ? null
    : `${slot.isUpload ? 'Published' : 'Aired'} ${date(slot.originalStartsAt)}`;

  return (
    <div
      className={styles.card}
      style={{ left, top, transform: above ? 'translateY(-100%)' : undefined }}
      role="presentation"
    >
      {slot.thumbnailUrl && !imageFailed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.thumb}
          src={slot.thumbnailUrl}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      )}

      <div className={styles.body}>
        <div className={styles.badges}>
          <span className={`${styles.badge} ${live ? styles.badgeLive : ''}`}>
            {live && <span className={styles.dot} />}
            {text}
          </span>
          <span className={styles.runtime}>{runtime(slot.endsAt - slot.startsAt)}</span>
        </div>

        <div className={styles.title}>{slot.title}</div>

        <div className={styles.channel}>
          {slot.channelName} <span>· {slot.platform}</span>
        </div>

        <div className={styles.meta}>
          {slot.category && (
            <>
              {slot.category}
              <br />
            </>
          )}
          {time(slot.startsAt)} – {slot.endsAtProvisional ? 'now' : time(slot.endsAt)}
          {provenance && (
            <>
              <br />
              {provenance}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
