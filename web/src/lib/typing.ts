/**
 * Typing, both ways (plan 02b Task 1): presence, never words. While someone types, their side pings
 * the API at most every 2 s, and the other side shows it until the time the API gives, five
 * seconds on, or until their message takes its place. A signal whose time has passed shows nothing.
 * Shared by the owner's conversation and the visitor's chat; it formats nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How often a typing ping goes out while someone types, at most. */
export const TYPING_PING_EVERY = 2_000;

/** Someone typing, until a time the API gave (an ISO time). */
export interface TypingSignal {
  until: string;
}

/**
 * A function to call on every keystroke: it sends `ping` at most once every `TYPING_PING_EVERY`,
 * and ignores how it went, since a missed ping only means the dots don't show.
 */
export function useTypingPing(ping: () => Promise<unknown>): () => void {
  const last = useRef<number | null>(null);
  const latest = useRef(ping);
  useEffect(() => {
    latest.current = ping;
  }, [ping]);
  return useCallback(() => {
    const now = Date.now();
    if (last.current !== null && now - last.current < TYPING_PING_EVERY) return;
    last.current = now;
    latest.current().catch(() => undefined);
  }, []);
}

/**
 * Whether `signal` still shows: until its time, after which the screen renders again without it.
 * None, a time that can't be read, or one already past shows nothing.
 */
export function useStillTyping(signal: TypingSignal | null): boolean {
  const until = signal === null ? Number.NaN : Date.parse(signal.until);
  const [, setExpired] = useState(0);
  useEffect(() => {
    const left = until - Date.now();
    if (!(left > 0)) return undefined;
    const timer = setTimeout(() => setExpired((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [until]);
  return Number.isFinite(until) && until > Date.now();
}
