import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { UNSAFE_DataRouterContext, useLocation } from 'react-router';

/** The signal a page gets before its own is in place: aborted, so nothing starts. */
const NOT_YET = AbortSignal.abort();

/**
 * The owner leaving this page, as a signal a page reads as it starts something (`leaving()`) and
 * checks after each wait, so a late answer does nothing once the owner has gone elsewhere.
 *
 * It is aborted the moment the router moves to another address, which is before React takes the
 * page away: the router draws a navigation in a transition, so the page it left stays on screen,
 * its effects still in place, until the next page has drawn. An effect's cleanup alone hears the
 * owner leave only then, and an answer landing meanwhile could still act, say by navigating the
 * owner back from where they went. It is aborted, too, when the page goes. Outside a data router,
 * only the page going aborts it.
 *
 * If the owner comes back (with Back, say) before the page has gone, a fresh signal takes over for
 * what the page starts from then on, and `onReturn` runs: whatever the page left, cut off, is its
 * own to settle again.
 */
export function useLeavingSignal(onReturn?: () => void): () => AbortSignal {
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const { pathname } = useLocation();
  const leaving = useRef<AbortController | null>(null);
  const returned = useRef(onReturn);
  useLayoutEffect(() => {
    returned.current = onReturn;
  });
  useEffect(() => {
    let controller = new AbortController();
    leaving.current = controller;
    const stop = router?.subscribe((state) => {
      if (state.location.pathname !== pathname) {
        controller.abort();
        return;
      }
      if (!controller.signal.aborted) return;
      controller = new AbortController();
      leaving.current = controller;
      returned.current?.();
    });
    return () => {
      stop?.();
      controller.abort();
    };
  }, [router, pathname]);
  return useCallback(() => leaving.current?.signal ?? NOT_YET, []);
}
