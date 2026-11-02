/**
 * The owner's notifications: what Claude would have sent the owner by text or email (the kernel's
 * alert for each held request, the copy's codes and ledger checkpoints), the copy's Demo inbox
 * read whole. The owner's frame reads them as it first draws, with the Desks, and again when the
 * owner comes back to the tab or the network, so the sidebar's count of unread ones keeps up; the
 * Notifications page also reads them every few seconds while it is open.
 */
import { useQuery } from '@tanstack/react-query';

import { FRESH_MS, ownerInboxQuery } from '../useDesks.ts';
import { useUnreadCount } from './seen.ts';

/**
 * The read of the notifications: as the frame first draws, and on a return to the tab or the
 * network once the last read is no longer fresh. With `onPage`, the Notifications page's own: a
 * return reads however fresh the last read is, so the page shows what is there now.
 */
export function useNotifications({ onPage = false }: { onPage?: boolean } = {}) {
  return useQuery({
    ...ownerInboxQuery(),
    staleTime: FRESH_MS,
    // A failed read is read again from the page's "Try again", or on a return, not each time the frame draws again.
    retryOnMount: false,
    ...(onPage ? { refetchOnWindowFocus: 'always' as const, refetchOnReconnect: 'always' as const } : {}),
  });
}

/** How many notifications the owner hasn't seen, as the frame last read them: 0 until a read works. */
export function useUnreadNotifications(): number {
  const { data } = useNotifications();
  return useUnreadCount((data ?? []).map((entry) => entry.entry_id));
}
