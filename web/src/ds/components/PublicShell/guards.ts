/**
 * What the public page lets through from its props into styles, links and the header's status
 * line. Each check passes only the plain form and fails closed: anything else is the fallback, no
 * link or no line.
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

/** What the header draws of the kernel's open status: its words and the dot's state. */
export interface OpenStatusLine {
  text: string;
  open: boolean;
}

/**
 * The header's open status when it is whole: words to show and a boolean for the dot, else null.
 * Only `text` and `open` are kept, and `text` exactly as the kernel wrote it. Anything else is no
 * line at all, never a dot without words or a dot that could disagree with them.
 */
export function openStatusLine(status: unknown): OpenStatusLine | null {
  if (typeof status !== 'object' || status === null) return null;
  const { text, open } = status as Record<string, unknown>;
  return typeof text === 'string' && text.trim() !== '' && typeof open === 'boolean' ? { text, open } : null;
}

/** A path on this site: one leading slash, then no slash or backslash, and no whitespace anywhere. */
const SITE_PATH = /^\/(?![/\\])[^\s\\]*$/;

/** An about link's `href` when it is a path on this site, else null: no scheme, no other host. */
export function aboutLinkHref(href: string): string | null {
  return SITE_PATH.test(href) ? href : null;
}
