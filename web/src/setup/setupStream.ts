/**
 * A running setup turn as the questions step shows it, from its event stream: the reads' labels as
 * each read ends, then Claude's reply as it is written. None of it is the interview: the saved turn
 * replaces it once the interview is read again (on `done`) or the request still out answers with it.
 * `useSetupStream` follows the stream for the step; `stepSetupStream` says what each event changes.
 */
import { useEffect, useRef, useState } from 'react';

import { canFollowSetup, openSetupEvents, type SetupRead, type SetupStreamEvent } from '../api/setupEvents.ts';
import type { SetupState } from '../api/views.ts';
import { settledWords } from '../lib/GrowingReply.tsx';

/** What a running turn shows so far: its reads and their labels, and the reply's words. */
export interface Growing {
  /**
   * One row per read, in the order the reads started; `text` is its label once it ends, in the saved
   * `tool_label` message's words, and null while it runs. The saved turn read back corrects any
   * difference (several failed searches stream a label each, and the interview keeps one).
   */
  labels: readonly { read: SetupRead; text: string | null }[];
  /** Claude's reply so far; empty before its first word and after a reset. */
  text: string;
  /** `done` came: the reply is whole, its last word included, until the saved turn takes its place. */
  final: boolean;
  /** The stream reconnected and replays the turn so far: the first read it replays starts the rows again. */
  replaying?: true;
}

export const NOTHING_YET: Growing = { labels: [], text: '', final: false };

/** The labels of the reads that have ended, in the order the reads started. */
export function shownLabels(growing: Growing): string[] {
  return growing.labels.flatMap(({ text }) => (text === null ? [] : [text]));
}

/** Whether `growing` has words to show: any once it is whole, else a word something follows. */
export function hasWords(growing: Growing): boolean {
  return growing.final ? growing.text.trim() !== '' : settledWords(growing.text) !== '';
}

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
export function stepSetupStream(
  now: Growing,
  event: SetupStreamEvent | { type: 'failed' } | { type: 'reconnected' },
  inFlight: boolean,
): { growing: Growing; next: StreamNext } {
  const replaying = now.replaying ? { replaying: true as const } : {};
  // A replayed read starts the rows again, so each read shows once after a reconnect.
  const rows = now.replaying ? [] : now.labels;
  switch (event.type) {
    case 'delta':
      return { growing: { labels: now.labels, text: event.text, final: false, ...replaying }, next: 'read_on' };
    case 'reset':
      return { growing: { labels: now.labels, text: '', final: false, ...replaying }, next: 'read_on' };
    case 'reconnected':
      return { growing: { ...now, replaying: true }, next: 'read_on' };
    case 'reading':
      // A read in progress shows as Claude writing, as the setup boards draw it: a row with no label yet.
      return { growing: { labels: [...rows, { read: event.read, text: null }], text: now.text, final: now.final }, next: 'read_on' };
    case 'label': {
      // The reads run at once and end in any order: a label ends the first read of its kind still
      // running, in its place, or, from a read this stream never heard start, follows the rest.
      const at = rows.findIndex(({ read, text }) => read === event.read && text === null);
      const label = { read: event.read, text: event.text };
      const labels = at === -1 ? [...rows, label] : rows.map((row, index) => (index === at ? label : row));
      return { growing: { labels, text: now.text, final: now.final }, next: 'read_on' };
    }
    case 'done':
      if (event.run === null) return { growing: now, next: inFlight ? 'reopen' : 'refetch_idle' };
      return { growing: { ...now, final: true }, next: inFlight ? 'wait' : 'refetch' };
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
  /** How many reads and pieces of the reply the stream has brought: it grows while the turn writes. */
  progress: number;
}

/**
 * Follows interview `id`'s running turn while `watching`: from the moment its request goes out
 * (`inFlight`) until the interview is no longer busy. One stream at most, closed when watching
 * ends, on a new interview and on unmount. When it can't follow the turn (no `EventSource`, a
 * stream that fails, or no turn running while the interview reads busy), it stops and the step's
 * own reads of the interview (`useSetupWork`) carry on alone. Once the turn is done, its words give
 * way to the saved turn in the very render the interview holds it: when `saved`, the number of
 * messages the page has, moves on from where it was at `done`, or when watching ends.
 */
export function useSetupStream(id: string, watching: boolean, inFlight: boolean, reread: () => Promise<SetupState | null>, saved: number): SetupStream {
  const [growing, setGrowing] = useState<Growing>(NOTHING_YET);
  const [fellBack, setFellBack] = useState(false);
  /** Bumped to open the stream again. */
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState(0);
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
  const savedRef = useRef(saved);
  savedRef.current = saved;
  /** How many messages the page had when the turn said `done`, until its saved turn shows. */
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const superseded = doneAt !== null && saved !== doneAt;

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
    setDoneAt(null);
    reopens.current = 0;
    waiting.current = false;
  }, [watching, id]);

  // The saved turn shows: its words have gone already in that render, and now from here too.
  useEffect(() => {
    if (!superseded) return;
    growingRef.current = NOTHING_YET;
    setGrowing(NOTHING_YET);
    setDoneAt(null);
  }, [superseded]);

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
        if (ev.type === 'delta' || ev.type === 'reset' || ev.type === 'reading' || ev.type === 'label') setProgress((n) => n + 1);
        if (step.next === 'read_on') return;
        close();
        if (ev.type === 'done' && ev.run !== null) setDoneAt(savedRef.current);
        if (step.next === 'wait') {
          waiting.current = true;
        } else if (step.next === 'reopen') {
          again(REOPEN_MS);
        } else if (step.next === 'refetch' || step.next === 'refetch_idle') {
          const idle = step.next === 'refetch_idle';
          void rereadRef.current().finally(() => {
            // Still busy with no turn this stream can see: the step's own reads carry on alone.
            if (idle) {
              if (live && watchingRef.current) setFellBack(true);
            } else {
              again(REOPEN_MS);
            }
          });
        }
      },
      reconnected() {
        if (!live) return;
        show(stepSetupStream(growingRef.current, { type: 'reconnected' }, inFlightRef.current).growing);
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

  const shown = watching && !superseded && (shownLabels(growing).length > 0 || growing.text.trim() !== '') ? growing : null;
  return { growing: shown, fellBack: watching && fellBack, progress };
}
