import { useEffect, useMemo, useRef, useState } from 'react';

import { wordEnds } from './wordEnds.ts';

/** The reveal's pace: about 50 tokens a second. */
const CHARACTERS_PER_SECOND = 200;

/** The longest a reveal takes: a longer reply goes faster, so none takes more than this. */
const LONGEST_REVEAL_MS = 3000;

/** The last cut at or before `position`, and never less than the first. */
function cutAt(ends: readonly number[], position: number): number {
  return ends.findLast((end) => end <= position) ?? ends[0] ?? 0;
}

/**
 * How much of `text` to show, as a length cut after a whole word (`wordEnds`). While `growing`,
 * that is all of it but an unfinished last word. With `revealing`, the cut starts after the first
 * word and moves on each frame, at about 200 characters a second, or faster for a reply that would
 * take longer than about 3 s, until it reaches the end. `paceLength` sets that pace by a longer
 * whole, when `text` is one of several blocks of a reply revealed one after another. The text is
 * already whole: the reveal only shows more of it, in order.
 */
export function useReveal(text: string, growing: boolean, revealing: boolean, paceLength?: number): { shown: number; whole: boolean } {
  const ends = useMemo(() => wordEnds(text, growing), [text, growing]);
  const last = ends.at(-1) ?? 0;
  const [revealed, setRevealed] = useState(() => (revealing ? (ends[0] ?? 0) : last));
  const revealedRef = useRef(revealed);
  /** When the first frame of the reveal was drawn: the reveal's clock, kept if the text grows. */
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!revealing || revealedRef.current >= last) return undefined;
    let frame = 0;
    const step = (now: number) => {
      startRef.current ??= now;
      const perSecond = Math.max(CHARACTERS_PER_SECOND, ((paceLength ?? last) * 1000) / LONGEST_REVEAL_MS);
      const next = cutAt(ends, ((now - startRef.current) * perSecond) / 1000);
      if (next > revealedRef.current) {
        revealedRef.current = next;
        setRevealed(next);
      }
      if (next < last) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [revealing, ends, last, paceLength]);

  if (!revealing) return { shown: last, whole: true };
  const shown = cutAt(ends, revealed);
  return { shown, whole: shown >= last };
}
