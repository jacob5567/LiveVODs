/**
 * Asking a platform's CDN for the size the guide actually draws.
 *
 * Both platforms store one avatar URL per channel, sized for a profile page —
 * YouTube hands back 240px, Twitch 300px. The guide draws them at sixteen. A
 * bar carrying a 240px file to fill sixteen pixels costs sixteen kilobytes to
 * say one thing: whose programme this is.
 *
 * Both CDNs encode the size in the URL, so the smaller file is free to ask for:
 *
 *   YouTube  …=s240-c-k-c0x00ffffff-no-rj   →  …=s88-c-k-c0x00ffffff-no-rj
 *   Twitch   …-profile_image-300x300.png    →  …-profile_image-70x70.png
 *
 * Each offers a fixed ladder rather than arbitrary sizes, so this snaps to the
 * smallest rung that still covers a retina bar rather than requesting the exact
 * pixel count. Anything unrecognised is returned untouched — a URL that does
 * not match one of these shapes is some other host's, and rewriting it blindly
 * would turn a working avatar into a broken one.
 */

/** YouTube's `=s<N>-…` size token, which opens the option list. */
const YOUTUBE_SIZE = /=s\d+-/;

/** Twitch's `-profile_image-<N>x<N>.<ext>` tail. */
const TWITCH_SIZE = /-profile_image-\d+x\d+\.(\w+)$/;

/**
 * The smallest rung each CDN offers that still covers the guide's 16px bar
 * icon on a 2× display, with room for the 32px row header if it returns.
 */
const YOUTUBE_RUNG = 88;
const TWITCH_RUNG = 70;

/** The same avatar, asked for at guide size rather than profile-page size. */
export function avatarAtIconSize(url: string): string {
  if (YOUTUBE_SIZE.test(url))
    return url.replace(YOUTUBE_SIZE, `=s${YOUTUBE_RUNG}-`);
  if (TWITCH_SIZE.test(url)) {
    return url.replace(
      TWITCH_SIZE,
      `-profile_image-${TWITCH_RUNG}x${TWITCH_RUNG}.$1`,
    );
  }
  return url;
}
