/**
 * The owner typing in the "Write to them" composer of a chat she took over (plan 02b Task 1): the
 * visitor sees her initials, her name and three dots, never her words. Nothing goes in `ai` mode
 * (a whisper never reaches the visitor), in `paused`, or for an empty composer.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { ApiError, request } from '../../api/http.ts';
import type { OwnerTranscript } from '../../api/views.ts';
import { useTypingPings, type TypingPings } from '../../lib/typing.ts';
import { conversationKey } from './useTakeOver.ts';

/**
 * `ownerTyping {generation}` (the last read `state.generation`) on the first keystroke, then at
 * most once every 2 s while typing goes on; a send ends the run. A 409 (take over first, or a
 * changed generation) stops the pings for the chat as it was read and reads it again once, with
 * no line, since typing is presence, not a message. Any other failure is dropped.
 */
export function useOwnerTyping(sessionId: string): TypingPings {
  const queryClient = useQueryClient();
  // The generation a 409 turned back: no pings while the chat as read still has it.
  const refused = useRef<number | null>(null);
  const ping = useCallback(() => {
    const read = queryClient.getQueryData<OwnerTranscript>(conversationKey(sessionId));
    if (read?.state.mode !== 'owner') return;
    const { generation } = read.state;
    if (refused.current === generation) return;
    request('ownerTyping', { params: { session_id: sessionId }, body: { generation } }).catch((err: unknown) => {
      if (!(err instanceof ApiError && err.kind === 'conflict')) return;
      refused.current = generation;
      void queryClient.invalidateQueries({ queryKey: conversationKey(sessionId) });
    });
  }, [queryClient, sessionId]);
  return useTypingPings(ping);
}
