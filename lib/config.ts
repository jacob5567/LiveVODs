/**
 * Additional domains allowed to host the Twitch embed.
 *
 * The browser's own hostname is always included automatically, so this is only
 * needed when the page is reachable under a name the browser does not report —
 * behind a reverse proxy, or embedded in another site.
 */
export function twitchEmbedParents(): string[] {
  return (process.env.TWITCH_EMBED_PARENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
