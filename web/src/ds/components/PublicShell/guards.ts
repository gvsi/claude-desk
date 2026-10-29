/**
 * What the public page lets through from its props into styles and links. Each check passes only
 * the plain form and fails closed: anything else is the fallback, or no link.
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const TOKEN_COLOR = /^var\(--[a-z0-9-]+\)$/;

/**
 * A brand color as given when it is a plain `#rrggbb` or a token (`var(--token)`), else
 * `fallback`. Nothing else reaches the stylesheet, so a brand value can't load anything or reach
 * past its property.
 */
export function brandColor(value: string, fallback: string): string {
  const color = value.trim();
  return HEX_COLOR.test(color) || TOKEN_COLOR.test(color) ? color : fallback;
}

/** A path on this site: one leading slash, then no slash or backslash, and no whitespace anywhere. */
const SITE_PATH = /^\/(?![/\\])[^\s\\]*$/;

/** An about link's `href` when it is a path on this site, else null: no scheme, no other host. */
export function aboutLinkHref(href: string): string | null {
  return SITE_PATH.test(href) ? href : null;
}
