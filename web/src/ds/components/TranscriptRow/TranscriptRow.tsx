import { Children, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { RowArrivalContext, type RowArrival } from './arrival.ts';

import './TranscriptRow.css';

export interface TranscriptRowProps {
  /** The message: a `VisitorMessage`, `ClaudeMessage`, `PersonMessage`, `AgentMessage` or `Whisper`. */
  children: ReactNode;
  /** The message's `MarginReceipt`s and `MarginNote`s, in order, attached under it. */
  margin?: ReactNode;
  /**
   * The row arrived live, on a page already open: the message rises into place and what is
   * attached lands one by one, `motion-stagger` apart. Read once, when the row is first drawn:
   * changing it later neither starts nor stops the motion. The landing plays once; after it, or at
   * once when nothing can play it (reduced motion), the row is like any other. Never for a row read
   * from history. A message that reveals itself (`ClaudeMessage`'s `reveal`) comes in on its own
   * instead, and what is attached waits for its words, then follows its cards.
   */
  live?: boolean;
}

/**
 * The row's own arrival: its message rising and each attached line landing, or a revealed
 * message's cards and the lines that follow them.
 */
const LANDING: ReadonlySet<string> = new Set(['cd-transcript-row-rise', 'cd-transcript-row-land', 'cd-transcript-row-follow', 'cd-claude-message-follow']);

/**
 * How what is attached follows a message that reveals itself, as the message says (`RowArrival`):
 * it waits while the words come in, then follows from a beat; null when the message rises.
 */
type Follow = 'waiting' | number | null;

/** What brings a revealed message in: its words settling, its cards, and the lines that follow them. */
const COMING_IN: ReadonlySet<string> = new Set(['cd-md-settle', 'cd-md-settle-marker', 'cd-claude-message-follow', 'cd-transcript-row-follow']);

/** A time token's value in ms, as the page reads it, in ms or in s; 0 when it can't be read. */
function msOf(value: string): number {
  const time = Number.parseFloat(value);
  if (Number.isNaN(time)) return 0;
  return value.trim().endsWith('ms') ? time : time * 1000;
}

/** The page's animation clock now, in ms: the time a motion that starts now is counted from. */
function clockNow(): number {
  const time = document.timeline?.currentTime;
  return typeof time === 'number' ? time : performance.now();
}

/**
 * When everything coming in under `row` that is already playing or waiting for its beat will have
 * ended, on the page's animation clock, leaving out the lines in `unplaced`, which are yet to be
 * given theirs: one not yet started starts with the next frame, as one given its beat `now` does,
 * so it is counted from `now`.
 */
function comingInUntil(row: HTMLElement, now: number, unplaced: readonly Element[]): number {
  if (typeof row.getAnimations !== 'function') return now;
  return row
    .getAnimations({ subtree: true })
    .filter((animation) => {
      if (!(animation instanceof CSSAnimation) || !COMING_IN.has(animation.animationName) || animation.playState === 'finished') return false;
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return !unplaced.some((line) => target != null && line.contains(target));
    })
    .reduce((until, animation) => {
      const start = animation.startTime === null ? now : Number(animation.startTime);
      return Math.max(until, start + Number(animation.effect?.getComputedTiming().endTime ?? 0));
    }, now);
}

/** Whether anything in `row` is still landing: playing, or waiting for its beat. */
function landing(row: HTMLElement): boolean {
  if (typeof row.getAnimations !== 'function') return false;
  return row
    .getAnimations({ subtree: true })
    .some((animation) => animation instanceof CSSAnimation && LANDING.has(animation.animationName) && animation.playState !== 'finished');
}

/**
 * One row of a conversation: the message in the reading column, and its receipts attached under
 * it, at every width.
 */
export function TranscriptRow({ children, margin, live = false }: TranscriptRowProps) {
  // Whether the row is arriving: set when it is first drawn live, so a re-render never replays or
  // cuts the motion, and spent once its landing has played.
  const [arriving, setArriving] = useState(live);
  const arrivingRef = useRef(live);
  const rowRef = useRef<HTMLDivElement>(null);
  // A message that reveals itself says so before the first paint, and again once its words are
  // whole. The ref has it at once, for the layout effects of the same draw.
  const [follow, setFollow] = useState<Follow>(null);
  const followRef = useRef<Follow>(null);
  const arrival = useMemo<RowArrival>(() => {
    const set = (next: Follow) => {
      // Only a row drawn live hears it, and only while it is arriving.
      if (!arrivingRef.current) return;
      followRef.current = next;
      setFollow(next);
    };
    return { wait: () => set('waiting'), follow: (beat) => set(beat) };
  }, []);
  // Following a revealed message, when the row began to follow it, on the page's animation clock,
  // and the lines already given their beat.
  const sequence = useRef<{ from: number; placed: WeakSet<Element> } | null>(null);
  // Each attached line's beat (--cd-follow-delay, TranscriptRow.css), before it is drawn, one after
  // another: the first once the message's cards have come in (the beat it says, `motion-follow`
  // apart, from when its words were whole), and each line once everything before it has, so no two
  // parts of the reply ever come in together. A line attached while they follow (a newer status,
  // say) waits its turn the same way: after whatever is still coming in, or at once when nothing is.
  // A line already shown before its row arrived has no beat: it shows at once.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!arriving || typeof follow !== 'number' || row === null) return;
    const now = clockNow();
    sequence.current ??= { from: now, placed: new WeakSet() };
    const { from, placed } = sequence.current;
    const lines = [...row.querySelectorAll<HTMLElement>(':scope > .cd-transcript-row__margin > *')].filter(
      (line) => !placed.has(line) && !line.classList.contains('cd-margin-line--shown'),
    );
    if (lines.length === 0) return;
    const beat = msOf(getComputedStyle(row).getPropertyValue('--motion-follow'));
    let next = Math.max(from + follow * beat, comingInUntil(row, now, lines));
    for (const line of lines) {
      placed.add(line);
      line.style.setProperty('--cd-follow-delay', `${next - now}ms`);
      next += beat;
    }
  });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!arriving || row === null) return undefined;
    const spend = () => {
      arrivingRef.current = false;
      setArriving(false);
    };
    // A revealed message's words are coming in: what is attached waits for them, and the row is
    // arriving until it has followed them.
    if (followRef.current === 'waiting') return undefined;
    // Nothing can play it (reduced motion): spent at once, so motion coming back never plays it.
    if (!landing(row)) {
      spend();
      return undefined;
    }
    // Once the last line has landed (or motion stopped it), the row is like any other: a line
    // attached later shows at once, and nothing in it can land again. Its lines hold nothing at
    // their end, so letting the motion go changes nothing on screen.
    const settle = () => {
      if (followRef.current !== 'waiting' && !landing(row)) spend();
    };
    row.addEventListener('animationend', settle);
    row.addEventListener('animationcancel', settle);
    return () => {
      row.removeEventListener('animationend', settle);
      row.removeEventListener('animationcancel', settle);
    };
  }, [arriving, follow]);
  // Nothing to attach (no receipts, an empty list, or only null and false) adds no block and no gap.
  const hasMargin = Children.toArray(margin).length > 0;
  let className = 'cd-transcript-row';
  if (arriving) className += ' cd-transcript-row--live';
  if (arriving && follow === 'waiting') className += ' cd-transcript-row--waiting';
  if (arriving && typeof follow === 'number') className += ' cd-transcript-row--following';
  return (
    <RowArrivalContext.Provider value={arrival}>
      <div ref={rowRef} className={className}>
        <div className="cd-transcript-row__main">{children}</div>
        {hasMargin ? <div className="cd-transcript-row__margin">{margin}</div> : null}
      </div>
    </RowArrivalContext.Provider>
  );
}

export interface TranscriptHeaderProps {
  /** The first caption: "Today at 12:04, web chat from …", a display string from the screen. */
  left: ReactNode;
  /** The caption about the receipts, under the first: "Notes from the checks. Select one for the full trace." */
  right: ReactNode;
}

/** The captions over a conversation, first inside the `Transcript`, one under the other. */
export function TranscriptHeader({ left, right }: TranscriptHeaderProps) {
  return (
    <div className="cd-transcript-row cd-transcript-header">
      <p className="cd-transcript-row__main cd-transcript-header__caption cd-type-caption">{left}</p>
      <p className="cd-transcript-row__margin cd-transcript-header__caption cd-type-caption">{right}</p>
    </div>
  );
}
