import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { request } from '../../api/http.ts';
import { DESKS_KEY } from '../useDesks.ts';

/** Mark only a committed transcript's cursor, once per visit and again for newer rows. A failed
 * write stays silent and is tried on the next open. Hidden tabs leave their markers alone. */
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
          void queryClient.invalidateQueries({ queryKey: ['conversations', deskId] });
          void queryClient.invalidateQueries({ queryKey: DESKS_KEY });
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
