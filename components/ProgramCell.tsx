'use client';

import type { GuideSlot } from '@/lib/guide';
import { PX_PER_MINUTE, MINUTE_MS } from '@/lib/time';
import styles from './ProgramCell.module.css';

/** Below this a bar has no room for a title, so it shows nothing but its colour. */
const MIN_LABEL_PX = 54;

/** Horizontal padding inside a bar, kept in sync with .cell in the stylesheet. */
const CELL_PADDING_PX = 18;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const px = (ms: number) => (ms / MINUTE_MS) * PX_PER_MINUTE;

export function ProgramCell({
  slot,
  viewportStart,
  viewportEnd,
  selected = false,
}: {
  slot: GuideSlot;
  viewportStart: number;
  viewportEnd: number;
  selected?: boolean;
}) {
  // A programme that began before the window (or runs past it) is clipped to the
  // window rather than positioned off-screen — otherwise its label sits at a
  // negative offset and the bar renders blank.
  const startsBefore = slot.startsAt < viewportStart;
  const endsAfter = slot.endsAt > viewportEnd;

  const left = Math.max(0, px(slot.startsAt - viewportStart));
  const right = Math.min(px(viewportEnd - viewportStart), px(slot.endsAt - viewportStart));
  const width = Math.max(2, right - left);

  const isLive = slot.state === 'live' && slot.isAppointment;
  const isMissed = slot.state === 'missed';
  const roomForLabel = width >= MIN_LABEL_PX;

  const classes = [styles.cell, styles[slot.state]];
  if (isLive && slot.endsAtProvisional) classes.push(styles.ongoing);
  // Library content is playing at a time it never aired, so it reads quieter
  // than a real broadcast sitting at its own time.
  if (!slot.isAppointment) classes.push(styles.rerun);
  // Square off a clipped edge so it reads as continuing past the window.
  if (startsBefore) classes.push(styles.clippedStart);
  if (endsAfter) classes.push(styles.clippedEnd);
  if (selected) classes.push(styles.selected);

  // A row pools several creators, so the bar has to say whose programme it is —
  // the channel column no longer answers that.
  const meta = isMissed
    ? `${slot.channelName} · did not air`
    : [slot.channelName, slot.category].filter(Boolean).join(' · ');

  const tooltip = [
    slot.title,
    slot.channelName,
    slot.isAppointment
      ? `${formatTime(slot.startsAt)} – ${slot.endsAtProvisional ? 'now' : formatTime(slot.endsAt)}`
      : `${formatTime(slot.startsAt)} – ${formatTime(slot.endsAt)}  ·  ${
          slot.isUpload ? 'published' : 'aired'
        } ${formatDate(slot.originalStartsAt)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    /**
     * Presentation only. The row is the interactive element — you tune to a
     * channel, not to one listing in the grid — so a bar is a listing, not a
     * control, and must not take focus of its own.
     */
    <div
      className={classes.join(' ')}
      style={{ left, width: Math.max(width, 2) }}
      data-program={slot.programId}
      // Narrow bars have no visible label, so the tooltip carries the detail.
      title={tooltip}
      aria-hidden="true"
    >
      {roomForLabel && (
        /**
         * The bar's own geometry, handed to CSS so the label can slide right as
         * the bar scrolls off to the left and stay readable. See .label.
         */
        <span
          className={styles.label}
          style={
            {
              maxWidth: Math.max(0, width - CELL_PADDING_PX),
              '--bar-left': `${left}px`,
              '--bar-width': `${width}px`,
            } as React.CSSProperties
          }
        >
          {isLive && (
            <span className={styles.badge}>
              <span className={styles.dot} />
              LIVE
            </span>
          )}
          <span className={styles.title}>{slot.title}</span>
          <span className={styles.meta}>{meta}</span>
        </span>
      )}
    </div>
  );
}
