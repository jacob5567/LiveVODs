'use client';

import { useEffect, useMemo, useState } from 'react';
import type { GuideChannel, GuideProgram } from '@/lib/guide';
import {
  embedBlockedByProtocol,
  embedParents,
  embedTargetFor,
  embedUrl,
} from '@/lib/embed';
import styles from './PlayerPane.module.css';

export interface Selection {
  program: GuideProgram;
  channel: GuideChannel;
}

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const formatRange = (program: GuideProgram) =>
  `${formatTime(program.startsAt)} – ${
    program.endsAtProvisional ? 'now' : formatTime(program.endsAt)
  }`;

export function PlayerPane({
  selection,
  extraParents,
  onClose,
}: {
  selection: Selection;
  extraParents: string[];
  onClose: () => void;
}) {
  const { program, channel } = selection;

  // The embed needs the browser's own hostname, which only exists client-side.
  // Until it resolves the pane renders its chrome without an iframe.
  const [location, setLocation] = useState<{ hostname: string; protocol: string } | null>(null);

  useEffect(() => {
    setLocation({ hostname: window.location.hostname, protocol: window.location.protocol });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const target = useMemo(
    () =>
      embedTargetFor({
        platform: channel.platform,
        login: channel.login,
        platformRef: program.platformRef,
        vodRef: program.vodRef,
        state: program.state,
      }),
    [channel.platform, channel.login, program.platformRef, program.vodRef, program.state],
  );

  const src = useMemo(() => {
    if (!location) return null;
    return embedUrl(target, embedParents(location.hostname, extraParents));
  }, [target, location, extraParents]);

  const needsHttps =
    channel.platform === 'twitch' &&
    location !== null &&
    embedBlockedByProtocol(location.protocol, location.hostname);

  const isLive = program.state === 'live';

  return (
    <div className={styles.pane}>
      <div className={styles.stage}>
        {src && !needsHttps ? (
          <iframe
            key={src}
            src={src}
            title={program.title}
            allowFullScreen
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          />
        ) : (
          <div className={styles.placeholder}>
            {target.kind === 'unavailable' ? (
              <>
                <strong>{target.reason}</strong>
                <span>Open it on {channel.platform} instead.</span>
              </>
            ) : (
              <span>Loading player…</span>
            )}
          </div>
        )}
      </div>

      <div className={styles.side}>
        <div className={styles.row}>
          {isLive ? (
            <span className={styles.badge}>
              <span className={styles.dot} />
              LIVE
            </span>
          ) : (
            <span className={`${styles.badge} ${styles.badgeMuted}`}>
              {program.state.toUpperCase()}
            </span>
          )}
        </div>

        <div className={styles.title}>{program.title}</div>
        <div className={styles.channel}>
          {channel.displayName} · {channel.platform}
        </div>

        <div className={styles.meta}>
          {program.category && (
            <>
              {program.category}
              <br />
            </>
          )}
          {formatRange(program)}
        </div>

        {needsHttps && (
          <div className={styles.warn}>
            Twitch embeds require HTTPS on any host other than <code>localhost</code>. This page is
            served over <code>{location?.protocol.replace(':', '')}</code> from{' '}
            <code>{location?.hostname}</code>, so the player is blocked. Use a TLS-terminating proxy
            or browse via localhost.
          </div>
        )}

        <div className={styles.actions}>
          <a
            className={styles.button}
            href={program.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open on {channel.platform} ↗
          </a>
          <button type="button" className={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
