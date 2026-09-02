import { NextResponse } from 'next/server';
import { loadGuide, loadGuideWindow } from '@/lib/guide';

export const dynamic = 'force-dynamic';

/**
 * The guide window as JSON. The page renders its first paint on the server;
 * this is what the client refetches when the live-update stream reports a
 * change.
 *
 * `from` and `to` are epoch milliseconds. The client passes back the window it
 * already has so an update does not shift the time axis under the viewer.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));

  const guide =
    Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from
      ? loadGuideWindow(new Date(from), new Date(to))
      : loadGuide();

  return NextResponse.json(guide, { headers: { 'Cache-Control': 'no-store' } });
}
