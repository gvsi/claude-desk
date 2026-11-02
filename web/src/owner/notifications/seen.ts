/**
 * Which notifications the owner has seen, kept in this browser: the entries the Notifications page
 * showed them last. Every other entry is unread, so a new copy's entries, which have ids of their
 * own, start unread. The API keeps no read state, so another browser starts with everything
 * unread. Storage can be missing or blocked; then what was seen is kept for this page's lifetime.
 */
import { useSyncExternalStore } from 'react';

import { readLocal, writeLocal } from '../../lib/storage.ts';

/** What was seen when storage couldn't keep it; null while storage keeps it. */
let kept: string | null = null;
const listeners = new Set<() => void>();

function stored(): string | null {
  return readLocal('notificationsSeen') ?? kept;
}

function parse(raw: string | null): ReadonlySet<string> {
  if (raw === null) return new Set();
  try {
    const ids: unknown = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of this browser that marks them seen counts here too.
  const onStorage = () => listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The ids seen, as a string so React compares it by value. */
function useSeenRaw(): string | null {
  return useSyncExternalStore(subscribe, stored);
}

/** The ids of the entries the owner has seen now, read once: what a page saw as it opened. */
export function seenIds(): ReadonlySet<string> {
  return parse(stored());
}

/** The ids of the entries the owner has seen, kept up as they change. */
export function useSeen(): ReadonlySet<string> {
  const raw = useSeenRaw();
  return parse(raw);
}

/** How many of `ids` the owner hasn't seen. */
export function useUnreadCount(ids: readonly string[]): number {
  const seen = useSeen();
  return ids.filter((id) => !seen.has(id)).length;
}

/**
 * Marks `ids`, every entry the page shows, as seen. They replace what was kept, so ids from an
 * earlier copy don't pile up.
 */
export function markSeen(ids: readonly string[]): void {
  const value = JSON.stringify([...new Set(ids)].sort());
  if (value === stored()) return;
  writeLocal('notificationsSeen', value);
  kept = readLocal('notificationsSeen') === value ? null : value;
  for (const listener of listeners) listener();
}

/** Forgets what was seen, in storage and in this page (for tests, which start from nothing seen). */
export function forgetSeen(): void {
  writeLocal('notificationsSeen', null);
  kept = null;
  for (const listener of listeners) listener();
}
