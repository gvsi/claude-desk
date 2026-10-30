/**
 * The visitor's session for the agents page's two actions, a demo key and sending the built-in
 * agent, which the API ties to the visitor's chat with the Desk (its HttpOnly cookie). The page
 * opens it (`ensureSession`, which resumes the chat the cookie names) before its first call. A call
 * the API answers 401 found the session gone: a new one is opened and the call sent once more, and
 * a second 401 is the caller's to show as the chat having ended.
 */
import { useCallback, useRef } from 'react';

import { ApiError } from '../../api/http.ts';
import { ensureSession } from '../PublicChatProvider.tsx';

/** Sends `send` within the visitor's session, as described above. */
export type SessionCall = <T>(send: () => Promise<T>) => Promise<T>;

export interface AgentSession {
  call: SessionCall;
  /** Opens a new session now ("Start a new chat" after the chat ended). */
  reopen: () => Promise<void>;
}

export function useAgentSession(slug: string): AgentSession {
  const opened = useRef<Promise<unknown> | null>(null);

  const open = useCallback((): Promise<unknown> => {
    const opening = ensureSession(slug);
    opened.current = opening;
    // A session that didn't open is asked for again by the next call.
    opening.catch(() => {
      if (opened.current === opening) opened.current = null;
    });
    return opening;
  }, [slug]);

  const call = useCallback(
    async <T>(send: () => Promise<T>): Promise<T> => {
      await (opened.current ?? open());
      try {
        return await send();
      } catch (err) {
        if (!(err instanceof ApiError && err.kind === 'unauthorized')) throw err;
        await open();
        return send();
      }
    },
    [open],
  );

  const reopen = useCallback(async () => {
    await open();
  }, [open]);

  return { call, reopen };
}
