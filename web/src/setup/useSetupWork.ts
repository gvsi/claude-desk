import { useCallback, useEffect, useRef, useState } from 'react';

import type { SetupState } from '../api/views.ts';
import { useLeavingSignal } from '../app/useLeavingSignal.ts';

/**
 * How long polling waits for setup's work before offering "Try again". It must outlast the API's
 * `TURN_ABANDONED_S` (130 s, in backend/desk/api/setup.py): by then a turn has landed, rolled back
 * or been recovered as abandoned, so the next read answers it. Consent answers 202 at once, so this
 * starts as the turn does; the 10 s past abandonment covers a few 2 s reads. Its test holds the two
 * together.
 */
export const SETUP_WORK_GIVE_UP_MS = 140_000;

/**
 * Polls only work still running on the questions step. `reread` updates the page's interview.
 * `progress` counts what the turn's stream has said so far: the whole wait starts again with each,
 * so a turn that is visibly writing never reads as given up.
 */
export function useSetupWork(state: SetupState, reread: () => Promise<SetupState | null>, progress = 0) {
  const working = state.step === 'questions' && state.busy === true;
  const [gaveUp, setGaveUp] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [visit, setVisit] = useState(0);
  const retryRead = useRef(false);
  // Like StartStep, stop as soon as the router moves, before a suspended destination draws.
  const leaving = useLeavingSignal(() => {
    // Back before unmount: this visit can read again, without reviving work from the old visit.
    retryRead.current = false;
    setRetrying(false);
    setVisit((now) => now + 1);
  });

  // The turn's stream said something more: it hasn't given up, and the wait starts again.
  useEffect(() => {
    setGaveUp(false);
  }, [progress]);

  useEffect(() => {
    if (!working) {
      setGaveUp(false);
      return;
    }
    const signal = leaving();
    if (gaveUp || signal.aborted) return;
    const controller = new AbortController();
    let reading = false;
    // Registered before the interval so the deadline wins over a tick at exactly the limit.
    const deadline = setTimeout(() => {
      if (controller.signal.aborted || signal.aborted) return;
      stop();
      setGaveUp(true);
    }, SETUP_WORK_GIVE_UP_MS);
    const timer = setInterval(() => {
      if (controller.signal.aborted || signal.aborted || reading) return;
      reading = true;
      void reread()
        .then((next) => {
          if (controller.signal.aborted) return;
          if (next !== null && (next.busy !== true || next.step !== 'questions')) stop();
        })
        .catch(() => {
          // A failed read waits for the next tick.
        })
        .finally(() => {
          reading = false;
        });
    }, 2000);
    function stop() {
      controller.abort();
      clearInterval(timer);
      clearTimeout(deadline);
    }
    signal.addEventListener('abort', stop);
    return () => {
      signal.removeEventListener('abort', stop);
      stop();
    };
  }, [state.interview_id, working, gaveUp, reread, visit, progress, leaving]);

  /** Read first: a failed read keeps the notice; a still-busy interview gets a fresh wait. */
  const retry = useCallback(async () => {
    const signal = leaving();
    if (!gaveUp || retryRead.current || signal.aborted) return;
    retryRead.current = true;
    setRetrying(true);
    try {
      const next = await reread();
      if (signal.aborted || next === null) return;
      setGaveUp(false);
    } catch {
      // The interview is still unknown: keep the notice and read again only on another press.
    } finally {
      if (!signal.aborted) {
        retryRead.current = false;
        setRetrying(false);
      }
    }
  }, [gaveUp, reread, leaving]);

  return { gaveUp, retrying, retry };
}
