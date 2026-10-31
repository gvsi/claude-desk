/**
 * Plays a figure once: the first time it is at least a third in view, its root is marked played, and its
 * stylesheet animates it from that mark. Until then it is marked ready, which hides the parts the animation
 * brings in. Both marks only take effect on screen with motion (`reader.css` keys them inside
 * `@media screen and (prefers-reduced-motion: no-preference)`), so the figure is complete by default.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import type { FigureName } from '../documents.ts';

/** How much of a figure is in view when it plays. */
const IN_VIEW = 0.33;

export type Play = 'ready' | 'played';

/**
 * The figures that have played in this page load, by name. A figure draws afresh when the reader opens the other
 * document and comes back; once played, it stays complete until the page reloads.
 */
const played = new Set<FigureName>();

/** Whether the reader asked for reduced motion, or the browser can't say. */
function reducedMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A ref for the figure's root, and the mark it sets as `data-play={play ?? undefined}`: `ready` until it is in
 * view, then `played`, and null for a figure that has already played in this page load.
 */
export function usePlayOnce<T extends Element>(name: FigureName): [ref: RefObject<T>, play: Play | null] {
  const ref = useRef<T>(null);
  const [play, setPlay] = useState<Play | null>(null);

  // A layout effect, so the figure is marked ready before its first paint and never shows complete, then hides.
  useLayoutEffect(() => {
    const figure = ref.current;
    if (!figure || played.has(name)) return;
    // With no way to tell when it comes into view, or for a reader who asked for less motion (or a browser that
    // can't say), the figure stays as drawn: complete.
    if (typeof window.IntersectionObserver !== 'function' || reducedMotion()) return;
    setPlay('ready');
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.intersectionRatio >= IN_VIEW)) return;
        observer.disconnect();
        played.add(name);
        setPlay('played');
      },
      { threshold: IN_VIEW },
    );
    observer.observe(figure);
    return () => observer.disconnect();
  }, [name]);

  return [ref, play];
}

/**
 * For tests only: forgets which figures have played, so the next one plays as in a fresh page load. Browser tests
 * share modules within a file, so each file whose figures play calls this after every test.
 */
export function forgetPlayedFigures(): void {
  played.clear();
}
