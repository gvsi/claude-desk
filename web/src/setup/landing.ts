/**
 * Setup's results landing one by one, as the safety check's tricks and the real situations do:
 * which read of them lands, how many of its rows have begun to land, and when they are done.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

/** The owner came to the step and nothing was there yet: no read is drawn still. A read's time is never below 0. */
const NO_READ = -1;

/** The rows' own landing: the keyframes of a SafetyCheckRow or SituationRow drawn `live`, and of its dot. */
const LANDING: ReadonlySet<string> = new Set(['cd-safety-check-row-land', 'cd-safety-check-row-dot', 'cd-situation-row-land', 'cd-situation-row-dot']);

/**
 * Whether anything in `list` is still landing: playing, or waiting for its beat. Other motion in the
 * rows doesn't count, and where the browser can't say what is moving, nothing is landing.
 */
function landing(list: HTMLElement): boolean {
  if (typeof list.getAnimations !== 'function') return false;
  return list
    .getAnimations({ subtree: true })
    .some((animation) => animation instanceof CSSAnimation && LANDING.has(animation.animationName) && animation.playState !== 'finished');
}

/** The place in `list` of the item `target` sits in, from 0, or -1. */
function itemIndex(list: HTMLElement, target: EventTarget | null): number {
  let item = target instanceof Element ? target : null;
  while (item !== null && item.parentElement !== list) item = item.parentElement;
  return item === null ? -1 : Array.prototype.indexOf.call(list.children, item);
}

/** A query's read of the results: its data, and when it was read. */
export interface ResultsRead {
  data: unknown;
  dataUpdatedAt: number;
}

export interface Landing {
  /** The rows are landing now: draw them `live`. False once they have landed, and for rows drawn still. */
  live: boolean;
  /** How many rows have begun to land, in order: every row when none is landing. */
  landed: number;
}

/** The read landing now, how many of its rows have begun to land, and whether it is done. */
interface Progress {
  read: number;
  landed: number;
  done: boolean;
}

/**
 * The rows of a step's results (`rows` of them, in `list`), landing when they arrive while the step
 * is open.
 *
 * Which read lands: one that arrives while the step is open. The results a step opened with are
 * drawn at once: a read already there when it opened, and the first read of a step setup opened at
 * (a reload, or setup resumed from Today), which the owner didn't just ask for. When the owner came
 * to the step on this page (`cameLive`), its first read lands; every later read (Run again, Try
 * again, the check run again after Back) lands too, since each is a check that just ran.
 *
 * How the rows land is the rows' own (`live` on SafetyCheckRow and SituationRow); this follows what
 * actually plays, so whatever follows `landed` never runs ahead of the rows. The first row lands at
 * once, with no delay, so `landed` starts at 1. When nothing can play the landing (reduced motion),
 * every row has landed at once.
 *
 * Key `list` by the read (`dataUpdatedAt`), so each read's rows are drawn anew; its children are
 * the rows' items.
 */
export function useLanding(list: RefObject<HTMLElement | null>, read: ResultsRead, cameLive: boolean, rows: number): Landing {
  const has = read.data !== undefined;
  // The read drawn still: the one the step opened with once it is known (null until a step setup
  // opened at has read its first), or NO_READ when the owner came to the step with nothing there.
  const [still, setStill] = useState<number | null>(() => (has ? read.dataUpdatedAt : cameLive ? NO_READ : null));
  if (still === null && has) setStill(read.dataUpdatedAt);
  const arriving = has && still !== null && read.dataUpdatedAt !== still && rows > 0 ? read.dataUpdatedAt : null;

  const [progress, setProgress] = useState<Progress | null>(null);
  let now = progress;
  if (arriving !== null && progress?.read !== arriving) {
    // A new read to land: from its first row, which lands at once.
    now = { read: arriving, landed: 1, done: false };
    setProgress(now);
  }
  const live = arriving !== null && now !== null && now.read === arriving && !now.done;

  useLayoutEffect(() => {
    const el = list.current;
    if (!live || el === null || arriving === null) return undefined;
    const update = (next: (current: Progress) => Progress) =>
      setProgress((current) => (current === null || current.read !== arriving ? current : next(current)));
    // Once the last row has landed (or motion stopped it), the rows are drawn still: nothing
    // replays them, and they hold nothing at their end, so letting the motion go changes nothing.
    const settle = () => {
      if (!landing(el)) update((current) => (current.done ? current : { ...current, landed: rows, done: true }));
    };
    // Nothing can play it (reduced motion), or the browser can't say: every row has landed, at once.
    if (!landing(el)) {
      settle();
      return undefined;
    }
    const start = (event: AnimationEvent) => {
      if (!LANDING.has(event.animationName)) return;
      const index = itemIndex(el, event.target);
      if (index >= 0) update((current) => (index < current.landed ? current : { ...current, landed: index + 1 }));
    };
    el.addEventListener('animationstart', start);
    el.addEventListener('animationend', settle);
    el.addEventListener('animationcancel', settle);
    return () => {
      el.removeEventListener('animationstart', start);
      el.removeEventListener('animationend', settle);
      el.removeEventListener('animationcancel', settle);
    };
  }, [list, live, arriving, rows]);

  return { live, landed: live && now !== null ? now.landed : rows };
}
