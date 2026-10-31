import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
   * from history.
   */
  live?: boolean;
}

/** The row's own landing: its message rising and each attached line landing. */
const LANDING: ReadonlySet<string> = new Set(['cd-transcript-row-rise', 'cd-transcript-row-land']);

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
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!arriving || row === null) return undefined;
    // Nothing can play it (reduced motion): spent at once, so motion coming back never plays it.
    if (!landing(row)) {
      setArriving(false);
      return undefined;
    }
    // Once the last line has landed (or motion stopped it), the row is like any other: a line
    // attached later shows at once, and nothing in it can land again. Its lines hold nothing at
    // their end, so letting the motion go changes nothing on screen.
    const settle = () => {
      if (!landing(row)) setArriving(false);
    };
    row.addEventListener('animationend', settle);
    row.addEventListener('animationcancel', settle);
    return () => {
      row.removeEventListener('animationend', settle);
      row.removeEventListener('animationcancel', settle);
    };
  }, [arriving]);
  // Nothing to attach (no receipts, an empty list, or only null and false) adds no block and no gap.
  const hasMargin = Children.toArray(margin).length > 0;
  return (
    <div ref={rowRef} className={arriving ? 'cd-transcript-row cd-transcript-row--live' : 'cd-transcript-row'}>
      <div className="cd-transcript-row__main">{children}</div>
      {hasMargin ? <div className="cd-transcript-row__margin">{margin}</div> : null}
    </div>
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
