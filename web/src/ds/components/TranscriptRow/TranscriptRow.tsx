import { Children, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

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
  // Following a revealed message, each attached line's place among them, which its beat follows
  // (TranscriptRow.css), before it is drawn: a line attached while they follow gets its place too.
  useLayoutEffect(() => {
    if (!arriving || typeof follow !== 'number') return;
    rowRef.current
      ?.querySelectorAll<HTMLElement>(':scope > .cd-transcript-row__margin > *')
      .forEach((line, index) => line.style.setProperty('--cd-follow-line', String(index + 1)));
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
  // The beat the first attached line follows on, after the message's cards.
  const style = arriving && typeof follow === 'number' ? ({ '--cd-follow-next': follow } as CSSProperties) : undefined;
  return (
    <RowArrivalContext.Provider value={arrival}>
      <div ref={rowRef} className={className} style={style}>
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
