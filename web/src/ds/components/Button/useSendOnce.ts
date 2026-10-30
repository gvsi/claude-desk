import { useEffect, useRef, useState } from 'react';

/** One press at a time, for buttons whose result the screen reports later. */
export interface SendOnce<K extends string> {
  /** The button whose press is in flight, until it is released; null when none is. */
  pressed: K | null;
  /** A press is in flight, or the screen says one is (`pending`): every button waits. */
  waiting: boolean;
  /** Calls `call` for a press of `key`, unless a press is already in flight. */
  send: (key: K, call: () => unknown) => void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}

/**
 * Sends a press once and waits for its result: until the screen's `pending` has come and gone, an
 * error is delivered (one appears, or another replaces it), or the promise the call returned
 * rejects. Clearing an error, as a screen does when a press starts, releases nothing, so the same
 * words after a cleared error release the buttons again. The press is noted before the screen
 * re-renders, so a second click in the same moment sends nothing.
 */
export function useSendOnce<K extends string>(pending: boolean, error?: string): SendOnce<K> {
  const [pressed, setPressed] = useState<{ key: K; press: number } | null>(null);
  const sent = useRef(false);
  const presses = useRef(0);
  const release = () => {
    sent.current = false;
    setPressed(null);
  };

  const sawPending = useRef(pending);
  useEffect(() => {
    const ended = sawPending.current && !pending;
    sawPending.current = pending;
    if (ended) release();
  }, [pending]);

  const shown = error !== undefined && error.trim() !== '' ? error : undefined;
  const delivered = useRef(shown);
  useEffect(() => {
    const before = delivered.current;
    delivered.current = shown;
    if (shown !== undefined && shown !== before) release();
  }, [shown]);

  const waiting = pending || pressed !== null;

  const send = (key: K, call: () => unknown) => {
    if (sent.current || waiting) return;
    sent.current = true;
    presses.current += 1;
    const press = presses.current;
    setPressed({ key, press });
    let result: unknown;
    try {
      result = call();
    } catch (thrown) {
      release();
      throw thrown;
    }
    if (isThenable(result)) {
      // A rejection releases only its own press.
      result.then(undefined, () => {
        if (presses.current !== press) return;
        sent.current = false;
        setPressed((current) => (current?.press === press ? null : current));
      });
    }
  };

  return { pressed: pressed?.key ?? null, waiting, send };
}
