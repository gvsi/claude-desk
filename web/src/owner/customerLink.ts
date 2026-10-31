/**
 * Where the owner reaches their own public page. Every "Chat as a customer" and "Open your public
 * page" control opens it in a new tab: Today never opens a visitor's chat itself.
 */
import type { BreakItIdea } from '../lib/breakItIdeas.ts';

/**
 * The public page as this Desk's owner sees it: `/d/{slug}?preview={deskId}`. The new tab asks the
 * API for the owner's preview of the Desk, and falls back to a visitor's chat when it can't have one.
 * With `tryKey`, the key of one of "Try to break it"'s fixed ideas, `&try={key}` too: the page types
 * that idea into its chat box once, for the owner to send, and takes the key out of the address.
 */
export function customerLink(slug: string, deskId: string, tryKey?: BreakItIdea['key']): string {
  const link = `/d/${encodeURIComponent(slug)}?preview=${encodeURIComponent(deskId)}`;
  return tryKey === undefined ? link : `${link}&try=${encodeURIComponent(tryKey)}`;
}

/** The Desk's public link, the one to share: `{origin}/d/{slug}`. */
export function publicLink(slug: string): string {
  return `${window.location.origin}/d/${encodeURIComponent(slug)}`;
}
