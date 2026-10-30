/**
 * Typing pings, both ways (plan 02b Task 1): presence, never words. The owner's
 * (`useOwnerTyping`) and the visitor's (`useVisitorTyping`) composers ping through this, each
 * with its own route and its own rules for when not to.
 */
import { useCallback, useRef, type FormEvent } from 'react';

import { typingPingMs } from '../app/poll.ts';

export interface TypingPings {
  /** The composer's input events, which bubble to the element around it. */
  onInput: (event: FormEvent<HTMLElement>) => void;
  /** The words were sent: the next keystroke starts a new run and pings at once. */
  sent: () => void;
}

/**
 * Calls `ping` on the first keystroke in a composer with words in it, then at most once every
 * `typingPingMs()` while typing goes on. An emptied composer pings nothing, and neither do words
 * the page put back in the box itself (only a person's keystrokes are trusted input events).
 */
export function useTypingPings(ping: () => void): TypingPings {
  const last = useRef<number | null>(null);
  const onInput = useCallback(
    (event: FormEvent<HTMLElement>) => {
      const box = event.target;
      if (!event.nativeEvent.isTrusted || !(box instanceof HTMLTextAreaElement) || box.value.trim() === '') return;
      const now = Date.now();
      if (last.current !== null && now - last.current < typingPingMs()) return;
      last.current = now;
      ping();
    },
    [ping],
  );
  const sent = useCallback(() => {
    last.current = null;
  }, []);
  return { onInput, sent };
}
