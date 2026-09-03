/**
 * The grid's scale, defined in CSS and read back where pixels are unavoidable.
 *
 * CSS owns these so the breakpoints can resize the guide without JavaScript,
 * and so the server can render one size-agnostic markup — it has no idea how
 * wide the viewport is, and guessing would mean a hydration mismatch.
 */
export interface GridMetrics {
  /** Pixels per minute of programming: how much of an evening fits on screen. */
  pxPerMinute: number;
  channelColW: number;
  rowH: number;
  /** Multiplier on type and other fixed sizes. */
  uiScale: number;
}

/**
 * Matches the bare .wrap block in GuideGrid.module.css. Used for the first
 * render on both sides of hydration, before the real values can be read.
 */
export const BASE_METRICS: GridMetrics = {
  pxPerMinute: 4,
  channelColW: 200,
  rowH: 64,
  uiScale: 1,
};

function num(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/** Reads whichever breakpoint is currently in force. */
export function readMetrics(el: Element): GridMetrics {
  const style = getComputedStyle(el);
  return {
    pxPerMinute: num(style, '--ppm', BASE_METRICS.pxPerMinute),
    channelColW: num(style, '--channel-col', BASE_METRICS.channelColW),
    rowH: num(style, '--row-h', BASE_METRICS.rowH),
    uiScale: num(style, '--ui-scale', BASE_METRICS.uiScale),
  };
}

export function sameMetrics(a: GridMetrics, b: GridMetrics): boolean {
  return (
    a.pxPerMinute === b.pxPerMinute &&
    a.channelColW === b.channelColW &&
    a.rowH === b.rowH &&
    a.uiScale === b.uiScale
  );
}
