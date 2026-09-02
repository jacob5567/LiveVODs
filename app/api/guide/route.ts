import { NextResponse } from 'next/server';
import { loadGuide } from '@/lib/guide';

export const dynamic = 'force-dynamic';

/**
 * The guide window as JSON. The page renders its first paint on the server; this
 * is what the client refetches when the worker reports a change.
 */
export function GET() {
  return NextResponse.json(loadGuide(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
