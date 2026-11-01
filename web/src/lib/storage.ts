/**
 * The app's only use of localStorage: whether "Things to try" is hidden, the last Desk the owner
 * opened, "Try to break it"'s hand-off from Today to the public page in a new tab (one record,
 * read once, `breakItIdeas.ts`), whether this browser has had an owner's demo copy, so a
 * session that ends is said to have ended after a reload too (`providers.tsx`), and the chat each
 * payment link the public chat showed came from, so the paid checkout can link back to it (one
 * record of token digests and paths, `payChats.ts`). Nothing else is stored in the browser.
 * Storage can be missing or blocked (a private window, blocked site data), so neither function
 * ever throws.
 */
const KEYS = {
  thingsToTryHidden: 'claude-desk.things-to-try-hidden',
  lastDesk: 'claude-desk.last-desk',
  breakItHandoff: 'claude-desk.break-it-handoff',
  hadOwnerCopy: 'claude-desk.had-owner-copy',
  payChats: 'claude-desk.pay-chats',
} as const;

export type LocalKey = keyof typeof KEYS;

/** The stored value, or null when there is none or storage can't be read. */
export function readLocal(key: LocalKey): string | null {
  try {
    return window.localStorage.getItem(KEYS[key]);
  } catch {
    return null;
  }
}

/** Stores `value` (null removes it); does nothing when storage can't be written. */
export function writeLocal(key: LocalKey, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(KEYS[key]);
    else window.localStorage.setItem(KEYS[key], value);
  } catch {
    // Storage is a convenience: without it the app starts from its defaults.
  }
}
