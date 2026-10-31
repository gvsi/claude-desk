/**
 * Where the owner reaches their own public page. Every "Chat as a customer" and "Open your public
 * page" control opens it in a new tab: Today never opens a visitor's chat itself.
 */
/**
 * The public page as this Desk's owner sees it: `/d/{slug}?preview={deskId}`. The new tab asks the
 * API for the owner's preview of the Desk, and falls back to a visitor's chat when it can't have one.
 * With `tryToken`, the token of "Try to break it"'s hand-off in this browser (`handOffBreakItIdea`),
 * `&try={token}` too: the page types the handed-off idea into its chat box once, for the owner to
 * send, and takes the token out of the address.
 */
export function customerLink(slug: string, deskId: string, tryToken?: string): string {
  const link = `/d/${encodeURIComponent(slug)}?preview=${encodeURIComponent(deskId)}`;
  return tryToken === undefined ? link : `${link}&try=${encodeURIComponent(tryToken)}`;
}

/** The Desk's public link, the one to share: `{origin}/d/{slug}`. */
export function publicLink(slug: string): string {
  return `${window.location.origin}/d/${encodeURIComponent(slug)}`;
}
