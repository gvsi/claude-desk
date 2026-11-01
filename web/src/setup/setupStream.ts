/**
 * A running setup turn as the questions step shows it, from its event stream: the reads' labels as
 * each read ends, then Claude's reply as it is written. None of it is the interview: the saved turn
 * replaces it once the interview is read again (on `done`) or the request still out answers with it.
 * `useSetupStream` follows the stream for the step; `stepSetupStream` says what each event changes.
 */
import { useEffect, useRef, useState } from 'react';

import { canFollowSetup, openSetupEvents, type SetupRead, type SetupStreamEvent } from '../api/setupEvents.ts';
import type { SetupState } from '../api/views.ts';

/** What a running turn shows so far: the finished reads' labels, in order, and the reply's words. */
export interface Growing {
  /** One label per read, in the order the reads ended: the saved `tool_label` message's words. */
  labels: readonly { read: SetupRead; text: string }[];
  /** Claude's reply so far; empty before its first word and after a reset. */
  text: string;
}

export const NOTHING_YET: Growing = { labels: [], text: '' };

/**
 * What follows an event:
 * - `read_on`: the stream goes on.
 * - `refetch`: the turn ended; read the interview, which holds it (or says it failed).
 * - `refetch_idle`: no turn was running and no request is out; read the interview, and if it is
 *   still busy, read it every so often from there (the turn runs where this stream can't see it).
 * - `wait`: the turn ended while its request is still out; that request's answer holds it.
 * - `reopen`: no turn runs yet while its request is out (the stream reached the API first); look again.
 * - `fall_back`: the stream failed; read the interview every so often, as before streaming.
 */
export type StreamNext = 'read_on' | 'refetch' | 'refetch_idle' | 'wait' | 'reopen' | 'fall_back';

/** What `event` changes in `now`, and what follows, while a request of the turn's is out or not. */
export function stepSetupStream(now: Growing, event: SetupStreamEvent | { type: 'failed' }, inFlight: boolean): { growing: Growing; next: StreamNext } {
  switch (event.type) {
    case 'delta':
      return { growing: { labels: now.labels, text: event.text }, next: 'read_on' };
    case 'reset':
      return { growing: { labels: now.labels, text: '' }, next: 'read_on' };
    case 'reading':
      // A read in progress shows as Claude writing, as the setup boards draw it.
      return { growing: now, next: 'read_on' };
    case 'label': {
      // Keyed by what was read: the reads run at once and end in any order, each shown once.
      const label = { read: event.read, text: event.text };
      const known = now.labels.some(({ read }) => read === event.read);
      const labels = known ? now.labels.map((shown) => (shown.read === event.read ? label : shown)) : [...now.labels, label];
      return { growing: { labels, text: now.text }, next: 'read_on' };
    }
    case 'done':
      if (event.run === null) return { growing: now, next: inFlight ? 'reopen' : 'refetch_idle' };
      return { growing: now, next: inFlight ? 'wait' : 'refetch' };
    case 'error':
      return { growing: NOTHING_YET, next: inFlight ? 'wait' : 'refetch' };
    case 'failed':
      return { growing: NOTHING_YET, next: 'fall_back' };
  }
}

/** How long before the stream is opened again, and how many times in a row, before reading the interview instead. */
export const REOPEN_MS = 400;
export const REOPENS_MAX = 5;

export interface SetupStream {
  /** What the running turn shows so far, or null while there is nothing to show. */
  growing: Growing | null;
  /** The stream couldn't follow this turn: the step reads the interview every so often instead. */
  fellBack: boolean;
}

/**
 * Follows interview `id`'s running turn while `watching`: from the moment its request goes out
 * (`inFlight`) until the interview is no longer busy. One stream at most, closed when watching
 * ends, on a new interview and on unmount. When it can't follow the turn (no `EventSource`, a
 * stream that fails, or no turn running while the interview reads busy), it stops and the step's
 * own reads of the interview (`useSetupWork`) carry on alone.
 */
export function useSetupStream(id: string, watching: boolean, inFlight: boolean, reread: () => Promise<SetupState | null>): SetupStream {
  const [growing, setGrowing] = useState<Growing>(NOTHING_YET);
  const [fellBack, setFellBack] = useState(false);
  /** Bumped to open the stream again. */
  const [attempt, setAttempt] = useState(0);
  const growingRef = useRef<Growing>(NOTHING_YET);
  const inFlightRef = useRef(inFlight);
  inFlightRef.current = inFlight;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  const rereadRef = useRef(reread);
  rereadRef.current = reread;
  const reopens = useRef(0);
  /** The turn ended while its request was out: once it answers, look again if still busy. */
  const waiting = useRef(false);

  const show = (next: Growing) => {
    growingRef.current = next;
    setGrowing(next);
  };

  // A new watch starts from nothing.
  useEffect(() => {
    if (watching) return;
    growingRef.current = NOTHING_YET;
    setGrowing(NOTHING_YET);
    setFellBack(false);
    reopens.current = 0;
    waiting.current = false;
  }, [watching, id]);

  useEffect(() => {
    if (!watching || fellBack) return undefined;
    if (!canFollowSetup()) {
      setFellBack(true);
      return undefined;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (delay: number) => {
      if (!live || !watchingRef.current) return;
      if (reopens.current >= REOPENS_MAX) {
        setFellBack(true);
        return;
      }
      reopens.current += 1;
      timer = setTimeout(() => {
        if (live && watchingRef.current) setAttempt((n) => n + 1);
      }, delay);
    };
    const close = openSetupEvents(id, {
      event(ev) {
        if (!live) return;
        const step = stepSetupStream(growingRef.current, ev, inFlightRef.current);
        if (step.growing !== growingRef.current) show(step.growing);
        if (ev.type === 'delta' || ev.type === 'label') reopens.current = 0;
        if (step.next === 'read_on') return;
        close();
        if (step.next === 'wait') {
          waiting.current = true;
        } else if (step.next === 'reopen') {
          again(REOPEN_MS);
        } else if (step.next === 'refetch' || step.next === 'refetch_idle') {
          const idle = step.next === 'refetch_idle';
          void rereadRef.current().finally(() => {
            // The saved turn is the interview's now, even while it still reads busy for a moment
            // as the API unlocks it: its words never show twice.
            if (live) show(NOTHING_YET);
            // Still busy with no turn this stream can see: the step's own reads carry on alone.
            if (idle) {
              if (live && watchingRef.current) setFellBack(true);
            } else {
              again(REOPEN_MS);
            }
          });
        }
      },
      failed() {
        if (!live) return;
        show(NOTHING_YET);
        setFellBack(true);
      },
    });
    return () => {
      live = false;
      clearTimeout(timer);
      close();
    };
  }, [id, watching, fellBack, attempt]);

  // The request that was out has answered while the interview still reads busy: look again.
  useEffect(() => {
    if (inFlight || !watching || !waiting.current) return;
    waiting.current = false;
    setAttempt((n) => n + 1);
  }, [inFlight, watching]);

  const shown = watching && (growing.labels.length > 0 || growing.text.trim() !== '') ? growing : null;
  return { growing: shown, fellBack: watching && fellBack };
}
