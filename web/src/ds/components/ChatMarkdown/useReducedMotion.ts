import { useSyncExternalStore } from 'react';

const REDUCE = '(prefers-reduced-motion: reduce)';

/** The reader's motion setting, or null where the browser can't say, as in a unit test's document. */
function setting(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE) : null;
}

function subscribe(onChange: () => void): () => void {
  const list = setting();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

/** Where the browser can't say, nothing moves, so nothing waits on motion. */
function reduced(): boolean {
  return setting()?.matches ?? true;
}

/** Whether the reader asked for less motion (`prefers-reduced-motion: reduce`), kept current. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reduced, reduced);
}
