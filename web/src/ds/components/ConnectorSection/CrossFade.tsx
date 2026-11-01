import { useState, type AnimationEvent } from 'react';

import './CrossFade.css';

/** Whether the reader asked for reduced motion, or the browser can't say. */
function reducesMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The words two lines share at each end, and the words between that differ. */
interface ChangedWords {
  before: string;
  from: string;
  to: string;
  after: string;
}

/** `was` and `now` as the words they share at each end and the words between that changed. */
function changedWords(was: string, now: string): ChangedWords {
  const a = was.split(/(\s+)/);
  const b = now.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return {
    before: b.slice(0, start).join(''),
    from: a.slice(start, a.length - end).join(''),
    to: b.slice(start, b.length - end).join(''),
    after: b.slice(b.length - end).join(''),
  };
}

export interface CrossFadeProps {
  /** The words now. */
  text: string;
  /** A change to `text` cross-fades; off, it shows at once. */
  fade: boolean;
  /** Only the words that changed cross-fade ("7" in "Version 7 of your rules"); else the whole text. */
  byWord?: boolean;
}

/**
 * Text that cross-fades from what it said to what it says now, on motion-base, when it changes with
 * `fade` on: the old words fade out over the new ones as they fade in, stacked in one cell, and
 * only the new ones are read. Under reduced motion it shows the new words at once. Used inside the
 * design system where a confirmed change lands on Rules; not exported.
 */
export function CrossFade({ text, fade, byWord = false }: CrossFadeProps) {
  const [state, setState] = useState<{ now: string; was: string | null }>({ now: text, was: null });
  let shown = state;
  if (state.now !== text) {
    shown = { now: text, was: fade && !reducesMotion() ? state.now : null };
    setState(shown);
  }
  if (shown.was === null) return <>{text}</>;

  const { before, from, to, after } = byWord ? changedWords(shown.was, text) : { before: '', from: shown.was, to: text, after: '' };
  const faded = (event: AnimationEvent) => {
    if (event.target !== event.currentTarget) return;
    setState((now) => (now.was === null ? now : { now: now.now, was: null }));
  };
  return (
    <>
      {before}
      <span className="cd-cross-fade">
        <span className="cd-cross-fade__was" aria-hidden="true">
          {from}
        </span>
        <span className="cd-cross-fade__now" onAnimationEnd={faded}>
          {to}
        </span>
      </span>
      {after}
    </>
  );
}
