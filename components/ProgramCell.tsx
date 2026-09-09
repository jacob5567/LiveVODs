"use client";

import { avatarAtIconSize } from "@/lib/avatar";
import type { GuideSlot } from "@/lib/guide";
import { MINUTE_MS } from "@/lib/time";
import type { GridMetrics } from "@/lib/metrics";
import styles from "./ProgramCell.module.css";

/**
 * Below this a bar has no room for a title. Scaled with the interface, since
 * the type inside it scales too.
 */
const MIN_LABEL_PX = 54;

/**
 * Below this a bar cannot even carry the creator's picture, and shows nothing
 * but its colour.
 *
 * Between the two it shows the picture alone. Nearly a third of bars fall in
 * that band at the base scale, and they are wide enough for four or five
 * letters of a title — which tells you nothing — but easily wide enough for a
 * face you recognise.
 */
const MIN_ICON_PX = 22;

/** Horizontal padding inside a bar, kept in sync with .cell in the stylesheet. */
const CELL_PADDING_PX = 18;

/** "Adam Savage's Tested" → "AS". Two letters is all a narrow bar can hold. */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const letters =
    words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

export function ProgramCell({
  slot,
  viewportStart,
  viewportEnd,
  metrics,
  selected = false,
}: {
  slot: GuideSlot;
  viewportStart: number;
  viewportEnd: number;
  metrics: GridMetrics;
  selected?: boolean;
}) {
  const px = (ms: number) => (ms / MINUTE_MS) * metrics.pxPerMinute;
  // A programme that began before the window (or runs past it) is clipped to the
  // window rather than positioned off-screen — otherwise its label sits at a
  // negative offset and the bar renders blank.
  const startsBefore = slot.startsAt < viewportStart;
  const endsAfter = slot.endsAt > viewportEnd;

  const left = Math.max(0, px(slot.startsAt - viewportStart));
  const right = Math.min(
    px(viewportEnd - viewportStart),
    px(slot.endsAt - viewportStart),
  );
  const width = Math.max(2, right - left);

  const isLive = slot.state === "live" && slot.isAppointment;
  const roomForLabel = width >= MIN_LABEL_PX * metrics.uiScale;
  const roomForIcon = !roomForLabel && width >= MIN_ICON_PX * metrics.uiScale;

  const classes = [styles.cell, styles[slot.state]];
  if (isLive && slot.endsAtProvisional) classes.push(styles.ongoing);
  // Library content is playing at a time it never aired, so it reads quieter
  // than a real broadcast sitting at its own time.
  if (!slot.isAppointment) classes.push(styles.rerun);
  // Square off a clipped edge so it reads as continuing past the window.
  if (startsBefore) classes.push(styles.clippedStart);
  if (endsAfter) classes.push(styles.clippedEnd);
  if (selected) classes.push(styles.selected);
  // At this width the bar is almost entirely padding, and the picture it exists
  // to show would be clipped to a sliver. Give the icon the room instead.
  if (roomForIcon) classes.push(styles.iconOnly);

  /**
   * A row pools several creators, so the bar has to say whose programme it is —
   * the channel column no longer answers that.
   *
   * There is no `missed` case here: the guide draws appointments from live and
   * scheduled rows and fill from aired ones, so a missed slot never reaches the
   * grid. It leaves a gap that library content takes, which is the better
   * outcome — a "did not air" bar would just be dead air with a label.
   */
  const meta = [
    slot.channelName,
    // A marathon airs across several blocks, so a bar has to say which.
    slot.partCount > 1 ? `Part ${slot.part} of ${slot.partCount}` : null,
    slot.category,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    /**
     * Presentation only. The row is the interactive element — you tune to a
     * channel, not to one listing in the grid — so a bar is a listing, not a
     * control, and must not take focus of its own.
     */
    <div
      className={classes.join(" ")}
      style={{ left, width: Math.max(width, 2) }}
      data-program={slot.programId}
      // The grid delegates hover from the rows container, so a bar only has to
      // name itself.
      data-slot={slot.key}
      aria-hidden="true"
    >
      {roomForIcon &&
        (slot.channelAvatarUrl ? (
          /**
           * Deliberately not `loading="lazy"`. A window holds a few hundred of
           * these drawn from only about forty-five distinct channels, so the
           * browser fetches each one once and serves the rest from cache — and
           * asked for at icon size they are a couple of kilobytes each. Lazy
           * loading saves nothing against that and costs the thing the tier
           * exists for: a bar that scrolls into view holding nothing, because
           * it sits inside a horizontally scrolled lane where the deferred
           * fetch is the least reliable.
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.avatar}
            src={avatarAtIconSize(slot.channelAvatarUrl)}
            alt=""
            decoding="async"
          />
        ) : (
          // No picture stored — the creator's initials still say whose it is.
          <span className={styles.initials}>
            {initialsOf(slot.channelName)}
          </span>
        ))}

      {roomForLabel && (
        /**
         * The bar's own geometry, handed to CSS so the label can slide right as
         * the bar scrolls off to the left and stay readable. See .label.
         */
        <span
          className={styles.label}
          style={
            {
              maxWidth: Math.max(0, width - CELL_PADDING_PX * metrics.uiScale),
              "--bar-left": `${left}px`,
              "--bar-width": `${width}px`,
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
