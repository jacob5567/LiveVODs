'use client';

import type { GuideProgram } from '@/lib/guide';
import { PX_PER_MINUTE, MINUTE_MS } from '@/lib/time';
import styles from './ProgramCell.module.css';

/** Below this a bar has no room for a title, so it shows nothing but its colour. */
const MIN_LABEL_PX = 54;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const px = (ms: number) => (ms / MINUTE_MS) * PX_PER_MINUTE;

export function ProgramCell({
  program,
  viewportStart,
  viewportEnd,
  selected = false,
  onSelect,
}: {
  program: GuideProgram;
  viewportStart: number;
  viewportEnd: number;
  selected?: boolean;
  onSelect: (program: GuideProgram) => void;
}) {
  // A program that began before the window (or runs past it) is clipped to the
  // window rather than positioned off-screen — otherwise its label sits at a
  // negative offset and the bar renders blank.
  const startsBefore = program.startsAt < viewportStart;
  const endsAfter = program.endsAt > viewportEnd;

  const left = Math.max(0, px(program.startsAt - viewportStart));
  const right = Math.min(px(viewportEnd - viewportStart), px(program.endsAt - viewportStart));
  const width = Math.max(2, right - left);

  const isLive = program.state === 'live';
  const isMissed = program.state === 'missed';
  const roomForLabel = width >= MIN_LABEL_PX;

  const classes = [styles.cell, styles[program.state]];
  if (isLive && program.endsAtProvisional) classes.push(styles.ongoing);
  // Square off a clipped edge so it reads as continuing past the window.
  if (startsBefore) classes.push(styles.clippedStart);
  if (endsAfter) classes.push(styles.clippedEnd);
  if (selected) classes.push(styles.selected);

  const meta = isMissed
    ? 'did not air'
    : [program.category, `${formatTime(program.startsAt)}`].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      className={classes.join(' ')}
      style={{ left, width: Math.max(width, 2) }}
      // Narrow bars have no visible label, so the tooltip carries the detail.
      title={`${program.title}${program.category ? ` — ${program.category}` : ''}\n${formatTime(
        program.startsAt,
      )} – ${program.endsAtProvisional ? 'now' : formatTime(program.endsAt)}`}
      disabled={isMissed}
      onClick={() => onSelect(program)}
    >
      {roomForLabel && (
        <>
          {isLive && (
            <span className={styles.badge}>
              <span className={styles.dot} />
              LIVE
            </span>
          )}
          <span className={styles.title}>{program.title}</span>
          <span className={styles.meta}>{meta}</span>
        </>
      )}
    </button>
  );
}
