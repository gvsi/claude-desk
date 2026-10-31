import { useCallback, useEffect, useRef, useState } from 'react';

import type { SetupState } from '../api/views.ts';

/** Polls only work still running on the questions step. `reread` updates the page's interview. */
export function useSetupWork(state: SetupState, reread: () => Promise<SetupState | null>) {
  const working = state.step === 'questions' && state.busy === true;
  const [gaveUp, setGaveUp] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const leaving = useRef<AbortController | null>(null);
  const retryRead = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    leaving.current = controller;
    return () => controller.abort();
  }, [state.interview_id]);

  useEffect(() => {
    if (!working) {
      setGaveUp(false);
      return;
    }
    if (gaveUp) return;
    const controller = new AbortController();
    let reading = false;
    // Registered before the interval so the deadline wins over a tick at exactly 90 s.
    const deadline = setTimeout(() => {
      stop();
      setGaveUp(true);
    }, 90000);
    const timer = setInterval(() => {
      if (controller.signal.aborted || reading) return;
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
    return stop;
  }, [state.interview_id, working, gaveUp, reread]);

  /** Read first: a failed read keeps the notice; a still-busy interview gets a fresh 90 s. */
  const retry = useCallback(async () => {
    const signal = leaving.current?.signal;
    if (!gaveUp || retryRead.current || signal === undefined || signal.aborted) return;
    retryRead.current = true;
    setRetrying(true);
    try {
      const next = await reread();
      if (signal.aborted || next === null) return;
      setGaveUp(false);
    } catch {
      // The interview is still unknown: keep the notice and read again only on another press.
    } finally {
      retryRead.current = false;
      if (!signal.aborted) setRetrying(false);
    }
  }, [gaveUp, reread]);

  return { gaveUp, retrying, retry };
}
