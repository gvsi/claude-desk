/**
 * Where the owner reaches their own public page. Every "Chat as a customer" and "Open your public
 * page" control opens it in a new tab: Today never opens a visitor's chat itself.
 */

/**
 * The public page as this Desk's owner sees it: `/d/{slug}?preview={deskId}`. The new tab asks the
 * API for the owner's preview of the Desk, and falls back to a visitor's chat when it can't have one.
 */
export function customerLink(slug: string, deskId: string): string {
  return `/d/${encodeURIComponent(slug)}?preview=${encodeURIComponent(deskId)}`;
}

/** The Desk's public link, the one to share: `{origin}/d/{slug}`. */
export function publicLink(slug: string): string {
  return `${window.location.origin}/d/${encodeURIComponent(slug)}`;
}
