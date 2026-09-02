import { guideRevision } from '@/lib/guide';

export const dynamic = 'force-dynamic';

/** How often to check whether the worker has written anything. */
const WATCH_INTERVAL_MS = 5_000;

/** Proxies commonly close an idle stream after 60s; stay under that. */
const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events telling the guide when to refetch.
 *
 * The worker writes in a separate process, so there is no in-process signal to
 * subscribe to. Rather than adding a message broker for a single-instance
 * self-hosted app, this watches a cheap revision token and emits only when it
 * actually changes — so an idle guide costs one indexed query every few
 * seconds and sends nothing.
 *
 * Only the token is sent, not the data: the client refetches /api/guide with
 * the window it already has, which keeps this endpoint trivial and the time
 * axis stable.
 */
export function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let lastRevision: string | null = null;
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client vanished between the abort signal and this write.
          stop();
        }
      };

      const check = () => {
        const revision = guideRevision();
        if (revision === lastRevision) return;
        lastRevision = revision;
        send(`event: guide\ndata: ${revision}\n\n`);
      };

      const watch = setInterval(check, WATCH_INTERVAL_MS);
      // A comment line is a valid no-op event; it keeps intermediaries from
      // treating the connection as idle and closing it.
      const heartbeat = setInterval(() => send(': keepalive\n\n'), HEARTBEAT_MS);

      function stop() {
        if (closed) return;
        closed = true;
        clearInterval(watch);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }

      request.signal.addEventListener('abort', stop);

      // Establish the baseline immediately so the first real change is detected
      // rather than the client being told to refetch what it just rendered.
      check();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which defeats SSE entirely.
      'X-Accel-Buffering': 'no',
    },
  });
}
