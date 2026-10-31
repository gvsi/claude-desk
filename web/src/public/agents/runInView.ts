/**
 * Keeps a sent agent's run in view on the agents page. Pressing a task (`follow`) brings the run's
 * end into view, and while the run plays each step that arrives keeps it there, so the newest step
 * is on screen. A visitor who has scrolled away from the end is left where they are until they come
 * back to it or press a task again. The window scrolls smoothly, and at once when the visitor asks
 * for reduced motion.
 *
 * The page scrolls the document and has no composer. The run's end is an empty element the panel
 * puts after its card's body (`end`), under the newest step: the line saying the agent is at work,
 * "The agent finished.", a notice, or the tasks offered again under them. Its scroll margin is the
 * card's padding and border under it, so the card's foot is where the window stops.
 *
 * Whether the visitor is at the end comes from the window's scroll events, and is checked again
 * before each step, since a scroll made at once sends its event only with the next frame. A move
 * on the way to where the page is taking the window is the page's own; any other is the visitor's,
 * and so is a scroll of the page's that comes to rest short of where it was going. The visitor is
 * at the end while the end and the card's foot are on screen, give or take `AT_THE_END_PX`. This
 * hook only scrolls: it never moves the focus.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * How far past the window's edges the run's end may lie with the visitor still at it; and how much
 * of the run the page shows above its end.
 */
const AT_THE_END_PX = 48;

/** Where the browser sends no `scrollend`: how long after the last scroll the window counts as at rest. */
const REST_MS = 150;

/** How the page scrolls the window: smoothly, or at once when the visitor asks for reduced motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia(REDUCED_MOTION).matches ? 'instant' : 'smooth';
}

/** The run's end, in the document's coordinates: where its end element sits, and the card's foot under it. */
interface RunEnd {
  at: number;
  foot: number;
}

function runEndOf(end: HTMLElement): RunEnd {
  const at = end.getBoundingClientRect().top + window.scrollY;
  return { at, foot: at + (Number.parseFloat(getComputedStyle(end).scrollMarginBottom) || 0) };
}

/**
 * Whether the run's end is on screen with the window scrolled to `y`, give or take `slack`: some of
 * the run shows above its end, and the card's foot is in the window.
 */
function onScreen(end: RunEnd, y: number, slack: number): boolean {
  return end.at >= y + AT_THE_END_PX - slack && end.foot <= y + window.innerHeight + slack;
}

export interface RunInView {
  /** For an empty element after the run's card's body: the run's end. */
  end: RefObject<HTMLDivElement>;
  /** Call when the visitor presses a task: its run comes into view and is followed as it plays. */
  follow: () => void;
}

/** Keeps the run whose end carries `end` in view, from the first `follow` on. */
export function useRunInView(): RunInView {
  const end = useRef<HTMLDivElement>(null);
  /** A task was pressed, so the page follows a run. */
  const following = useRef(false);
  /** A task was just pressed: the next draw starts its run. */
  const pressed = useRef(false);
  /** The visitor is at the run's end, as far as the page knows. */
  const atTheEnd = useRef(true);
  /** Where the page is scrolling the window to, or null when it isn't. */
  const toward = useRef<number | null>(null);
  /** The window's scroll position when the page last looked. */
  const seenY = useRef(0);

  // Whether the visitor is at the run's end, with the window at `y`.
  const reassess = useCallback((y: number) => {
    const el = end.current;
    if (following.current && el) atTheEnd.current = onScreen(runEndOf(el), y, AT_THE_END_PX);
  }, []);

  // Notes where the window is, and whether the visitor moved it since the page last looked.
  const look = useCallback(() => {
    const y = window.scrollY;
    const from = seenY.current;
    seenY.current = y;
    if (y === from) return;
    const target = toward.current;
    if (target !== null) {
      if (Math.abs(y - target) <= 1) {
        toward.current = null;
        return;
      }
      const onTheWay = target > from ? y > from && y < target : y < from && y > target;
      if (onTheWay) return;
      toward.current = null;
    }
    reassess(y);
  }, [reassess]);

  // The window has come to rest. A scroll of the page's that stopped short of where it was going
  // was cut short, by the visitor or the browser: where it stopped decides whether they are still
  // at the run's end.
  const settle = useCallback(() => {
    const target = toward.current;
    if (target === null) return;
    toward.current = null;
    const y = window.scrollY;
    seenY.current = y;
    if (Math.abs(y - target) > 1) reassess(y);
  }, [reassess]);

  useEffect(() => {
    seenY.current = window.scrollY;
    // `scrollend` where the browser sends it; elsewhere, a short pause after the last scroll.
    const ends = 'onscrollend' in window;
    let pause: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      look();
      if (ends) return;
      clearTimeout(pause);
      pause = setTimeout(settle, REST_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    if (ends) window.addEventListener('scrollend', settle);
    return () => {
      clearTimeout(pause);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('scrollend', settle);
    };
  }, [look, settle]);

  // After every draw of the card: once a task is pressed, the run's end comes into view while the
  // visitor is at it.
  useLayoutEffect(() => {
    if (pressed.current) {
      // Wherever the visitor was, the run they just started is where the page takes them.
      pressed.current = false;
      following.current = true;
      atTheEnd.current = true;
      toward.current = null;
      seenY.current = window.scrollY;
    } else {
      look();
    }
    const el = end.current;
    if (!following.current || !atTheEnd.current || el === null) return;
    const runEnd = runEndOf(el);
    // Where the window is, or where the page is already taking it.
    const heading = toward.current ?? window.scrollY;
    if (onScreen(runEnd, heading, 1)) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const target = Math.max(0, Math.min(max, runEnd.foot - window.innerHeight));
    if (Math.abs(target - heading) <= 1) return;
    toward.current = target;
    window.scrollTo({ top: target, behavior: scrollBehavior() });
  });

  const follow = useCallback(() => {
    pressed.current = true;
  }, []);

  return { end, follow };
}
