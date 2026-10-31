/**
 * Keeps a sent agent's run in view on the agents page. Pressing a task (`follow`) brings the run's
 * end into view, and while the run plays each step that arrives keeps it there, so the newest step
 * is on screen. A visitor who has scrolled away from the end is left where they are until they come
 * back to it or press a task again. The window scrolls smoothly, and at once when the visitor asks
 * for reduced motion.
 *
 * The page scrolls the document and has no composer, so the run's end is the "Send an agent"
 * card's foot, and the newest step is the card's last item: the line saying the agent is at work,
 * "The agent finished.", a notice, or the tasks offered again under them.
 *
 * Whether the visitor is at the end comes from the window's scroll events, and is checked again
 * before each step, since a scroll made at once sends its event only with the next frame. A move
 * on the way to where the page is taking the window is the page's own; any other is the visitor's,
 * and they are at the end while the newest item and the card's foot are on screen, give or take
 * `AT_THE_END_PX`. This hook only scrolls: it never moves the focus.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** How far past the window's edges the run's end may lie with the visitor still at it. */
const AT_THE_END_PX = 48;

/** How the page scrolls the window: smoothly, or at once when the visitor asks for reduced motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia(REDUCED_MOTION).matches ? 'instant' : 'smooth';
}

/** The run's end, in the document's coordinates: the top of the card's newest item, and the card's foot. */
interface RunEnd {
  top: number;
  foot: number;
}

function runEndOf(card: HTMLElement): RunEnd {
  // The card holds its title, its line and its body (`AgentsCardContent`): the newest item is the body's last.
  const newest = card.lastElementChild?.lastElementChild ?? card;
  const y = window.scrollY;
  return { top: newest.getBoundingClientRect().top + y, foot: card.getBoundingClientRect().bottom + y };
}

/** Whether `end` is on screen with the window scrolled to `at`, give or take `slack`. */
function onScreen(end: RunEnd, at: number, slack: number): boolean {
  return end.top >= at - slack && end.foot <= at + window.innerHeight + slack;
}

export interface RunInView {
  /** Call when the visitor presses a task: its run comes into view and is followed as it plays. */
  follow: () => void;
}

/** Keeps the run in the card whose title has the id `titleId` in view, from the first `follow` on. */
export function useRunInView(titleId: string): RunInView {
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

  // The run's card: its title's parent.
  const card = useCallback(() => document.getElementById(titleId)?.parentElement ?? null, [titleId]);

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
    const el = card();
    if (following.current && el) atTheEnd.current = onScreen(runEndOf(el), y, AT_THE_END_PX);
  }, [card]);

  useEffect(() => {
    seenY.current = window.scrollY;
    window.addEventListener('scroll', look, { passive: true });
    return () => window.removeEventListener('scroll', look);
  }, [look]);

  // After every draw of the card: once a task is pressed, the run's end comes into view while the
  // visitor is at it.
  useLayoutEffect(() => {
    if (pressed.current) {
      // Wherever the visitor was, the run they just started is where the page takes them.
      pressed.current = false;
      following.current = true;
      atTheEnd.current = true;
      seenY.current = window.scrollY;
    } else {
      look();
    }
    const el = card();
    if (!following.current || !atTheEnd.current || el === null) return;
    const end = runEndOf(el);
    // Where the window is, or where the page is already taking it.
    const heading = toward.current ?? window.scrollY;
    if (onScreen(end, heading, 1)) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const target = Math.max(0, Math.min(max, end.foot - window.innerHeight));
    if (Math.abs(target - heading) <= 1) return;
    toward.current = target;
    window.scrollTo({ top: target, behavior: scrollBehavior() });
  });

  const follow = useCallback(() => {
    pressed.current = true;
  }, []);

  return { follow };
}
