import { NextResponse } from 'next/server';
import { loadGuideWindow, parseGuideWindow } from '@/lib/guide';

export const dynamic = 'force-dynamic';

/**
 * The guide window as JSON. The page renders its first paint on the server;
 * this is what the client refetches when the live-update stream reports a
 * change.
 *
 * `from` and `to` are epoch milliseconds. The client passes back the window it
 * already has so an update does not shift the time axis under the viewer. The
 * span is bounded — see parseGuideWindow.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requested = parseGuideWindow(params.get('from'), params.get('to'));

  if (!requested.ok) {
    return NextResponse.json({ error: requested.reason }, { status: 400 });
  }

  const guide = loadGuideWindow(new Date(requested.from), new Date(requested.to));
  return NextResponse.json(guide, { headers: { 'Cache-Control': 'no-store' } });
}
