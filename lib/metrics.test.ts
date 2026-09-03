// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { BASE_METRICS, readMetrics, sameMetrics } from './metrics';

function elementWith(vars: Record<string, string>): HTMLElement {
  const el = document.createElement('div');
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
  document.body.append(el);
  return el;
}

describe('readMetrics', () => {
  it('reads whichever breakpoint CSS has put in force', () => {
    const el = elementWith({
      '--ppm': '7.5',
      '--channel-col': '340px',
      '--row-h': '108px',
      '--ui-scale': '1.48',
    });

    expect(readMetrics(el)).toEqual({
      pxPerMinute: 7.5,
      channelColW: 340,
      rowH: 108,
      uiScale: 1.48,
    });
  });

  it('falls back to the base scale when a property is absent', () => {
    // Matters during the first render, before the stylesheet has applied.
    expect(readMetrics(elementWith({}))).toEqual(BASE_METRICS);
  });

  it('ignores a value it cannot parse rather than producing NaN', () => {
    // NaN here would put every bar at position NaN and blank the guide.
    const el = elementWith({ '--ppm': 'inherit', '--row-h': '' });
    const m = readMetrics(el);

    expect(m.pxPerMinute).toBe(BASE_METRICS.pxPerMinute);
    expect(m.rowH).toBe(BASE_METRICS.rowH);
  });
});

describe('sameMetrics', () => {
  it('treats an unchanged breakpoint as equal, so resizing does not re-render', () => {
    expect(sameMetrics(BASE_METRICS, { ...BASE_METRICS })).toBe(true);
  });

  it('notices a change of scale', () => {
    expect(sameMetrics(BASE_METRICS, { ...BASE_METRICS, pxPerMinute: 6 })).toBe(false);
  });
});
