'use client';

import { useEffect, useMemo, useState } from 'react';
import type { GuideSlot } from '@/lib/guide';
import {
  embedBlockedByProtocol,
  embedParents,
  embedTargetFor,
  embedUrl,
} from '@/lib/embed';
import styles from './PlayerPane.module.css';

/** A slot carries its own channel now, since a row pools several. */
export interface Selection {
  slot: GuideSlot;
  /**
   * How far into the programme the viewer tuned in, frozen at the moment they
   * did. Recomputing it as the clock ticks would make the player re-seek and
   * jump backwards under them.
   */
  startSeconds: number;
}

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const formatRange = (slot: GuideSlot) =>
  `${formatTime(slot.startsAt)} – ${slot.endsAtProvisional ? 'now' : formatTime(slot.endsAt)}`;

const formatOriginal = (slot: GuideSlot) =>
  `${slot.isUpload ? 'Published' : 'Aired'} ${new Date(slot.originalStartsAt).toLocaleDateString(
    [],
    { month: 'short', day: 'numeric', year: 'numeric' },
  )}`;

export function PlayerPane({
  selection,
  extraParents,
  onClose,
}: {
  selection: Selection;
  extraParents: string[];
  onClose: () => void;
}) {
  const { slot, startSeconds } = selection;

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
        platform: slot.platform,
        login: slot.channelLogin,
        platformRef: slot.platformRef,
        vodRef: slot.vodRef,
        state: slot.state,
      }),
    [slot.platform, slot.channelLogin, slot.platformRef, slot.vodRef, slot.state],
  );

  const src = useMemo(() => {
    if (!location) return null;
    return embedUrl(target, embedParents(location.hostname, extraParents), startSeconds);
  }, [target, location, extraParents, startSeconds]);

  const needsHttps =
    slot.platform === 'twitch' &&
    location !== null &&
    embedBlockedByProtocol(location.protocol, location.hostname);

  // A repeat of a past broadcast is not live, whatever the source programme says.
  const isLive = slot.state === 'live' && slot.isAppointment;

  return (
    <div className={styles.pane}>
      <div className={styles.stage}>
        {src && !needsHttps ? (
          <iframe
            key={src}
            src={src}
            title={slot.title}
            allowFullScreen
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          />
        ) : (
          <div className={styles.placeholder}>
            {target.kind === 'unavailable' ? (
              <>
                <strong>{target.reason}</strong>
                <span>Open it on {slot.platform} instead.</span>
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
              {slot.isAppointment ? slot.state.toUpperCase() : 'REPEAT'}
            </span>
          )}
        </div>

        <div className={styles.title}>{slot.title}</div>
        <div className={styles.channel}>
          {slot.channelName} · {slot.platform}
        </div>

        <div className={styles.meta}>
          {slot.category && (
            <>
              {slot.category}
              <br />
            </>
          )}
          {formatRange(slot)}
          {!slot.isAppointment && (
            <>
              <br />
              {formatOriginal(slot)}
            </>
          )}
          {startSeconds > 0 && (
            <>
              <br />
              {`Joined ${Math.round(startSeconds / 60)} min in`}
            </>
          )}
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
            href={slot.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open on {slot.platform} ↗
          </a>
          <button type="button" className={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
