import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { request } from '../../api/http.ts';
import type { ConversationSummary } from '../../api/views.ts';
import { DESKS_KEY } from '../useDesks.ts';

const listKey = (deskId: string) => ['conversations', deskId] as const;
/** The Desk's unread count as the conversation list last showed it: held apart from the Desks read, which the frame
 * keeps and checks for fresh reads of its own, so following the list never reads the Desks again or looks like it. */
const unreadKey = (deskId: string) => ['unreadConversations', deskId] as const;

/**
 * Carry the cached conversation list's unread rows to the sidebar's count, with nothing read again, stamped with the
 * time the list was read (`at`, or the list's own read time): a later Desks read then wins over it, and a later list
 * read wins back, even when the number is the same.
 */
export function syncUnreadCount(queryClient: QueryClient, deskId: string, at?: number): void {
  const list = queryClient.getQueryState<ConversationSummary[]>(listKey(deskId));
  if (list?.data === undefined) return;
  const count = list.data.filter((row) => row.unread).length;
  const updatedAt = at ?? list.dataUpdatedAt;
  const held = queryClient.getQueryState<number>(unreadKey(deskId));
  if (held?.data === count && held.dataUpdatedAt >= updatedAt) return;
  queryClient.setQueryData(unreadKey(deskId), count, { updatedAt });
}

/** The sidebar's unread count for the Desk: the conversation list's, when it was seen after the Desks read gave
 * `fromDesks`, else the Desks read's own. */
export function useUnreadConversations(deskId: string, fromDesks: number): number {
  const queryClient = useQueryClient();
  const followed = useQuery({ queryKey: unreadKey(deskId), queryFn: () => fromDesks, enabled: false, staleTime: Infinity });
  const desksAt = queryClient.getQueryState(DESKS_KEY)?.dataUpdatedAt ?? 0;
  return followed.data !== undefined && followed.dataUpdatedAt >= desksAt ? followed.data : fromDesks;
}

/** Mark only a committed transcript's cursor, once per visit and again for newer rows. A failed
 * write stays silent and is tried on the next open. Hidden tabs leave their markers alone. Once marked, the
 * cached list shows the conversation read and the sidebar's count follows it, with no read sent again. */
export function useConversationRead(deskId: string, sessionId: string, through: number | undefined): void {
  const queryClient = useQueryClient();
  const attempted = useRef(-1);
  useEffect(() => {
    if (through === undefined) return;
    let frame: number | undefined;
    const schedule = () => {
      if (document.visibilityState !== 'visible' || through <= attempted.current || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (document.visibilityState !== 'visible' || through <= attempted.current) return;
        attempted.current = through;
        void request('markConversationRead', { params: { session_id: sessionId }, body: { through } }).then(() => {
          queryClient.setQueryData<ConversationSummary[]>(listKey(deskId), (rows) => rows?.map((row) => (
            row.session_id === sessionId && row.unread ? { ...row, unread: false } : row)));
          syncUnreadCount(queryClient, deskId, Date.now());
        }).catch(() => { /* Read markers never interrupt the conversation. */ });
      });
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [deskId, sessionId, through, queryClient]);
}
