/**
 * The visitor's session for the agents page's calls, which the API ties to the visitor's chat with
 * the Desk (its HttpOnly cookie): the read of the Desk's tasks when the page opens, and the two
 * actions, a demo key and sending the built-in agent. The page makes one for all three, so they
 * share it: it opens (`ensureSession`, which resumes the chat the cookie names) before the first
 * call, however many calls are waiting for it, and a call the API answers 401 found it gone. Then
 * one new session opens, shared by every call that found the same one gone, and the call is sent
 * once more; a second 401 is the caller's to show as the chat having ended. A session that fails to
 * open is opened again by the next call. Two sessions opened at once would each set the cookie, and
 * a run read with the later one would answer 404 while its agent goes on.
 */
import { useCallback, useMemo, useRef } from 'react';

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
  /** The session being opened or last opened; null before the first and after one failed to open. */
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
      const used = opened.current ?? open();
      await used;
      try {
        return await send();
      } catch (err) {
        if (!(err instanceof ApiError && err.kind === 'unauthorized')) throw err;
        // Another call that found this session gone may already be opening the next one: share it.
        await (opened.current !== null && opened.current !== used ? opened.current : open());
        return send();
      }
    },
    [open],
  );

  const reopen = useCallback(async () => {
    await open();
  }, [open]);

  return useMemo(() => ({ call, reopen }), [call, reopen]);
}
