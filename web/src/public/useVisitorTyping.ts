/**
 * The visitor typing in the public page's composer (plan 02b Task 1): the owner's view of the chat
 * shows a typing bubble, never the words.
 */
import { useCallback } from 'react';

import { request } from '../api/http.ts';
import { useTypingPings, type TypingPings } from '../lib/typing.ts';

/**
 * `visitorTyping` on the first keystroke in a composer with words in it, then at most once every
 * 2 s while typing goes on; nothing for an empty composer, and a send ends the run. The composer
 * takes input only while the chat's session is open. Presence only: every answer and failure is
 * dropped, since a lost ping means the owner sees no dots (a 401 is left to the send path, which
 * says the chat ended).
 */
export function useVisitorTyping(slug: string): TypingPings {
  const ping = useCallback(() => {
    request('visitorTyping', { params: { slug } }).catch(() => undefined);
  }, [slug]);
  return useTypingPings(ping);
}
