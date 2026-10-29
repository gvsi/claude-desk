import type { ReactNode } from 'react';

import './TranscriptRow.css';

export interface TranscriptRowProps {
  /** The message: a `VisitorMessage`, `ClaudeMessage`, `PersonMessage`, `AgentMessage` or `Whisper`. */
  children: ReactNode;
  /** The margin column: the message's `MarginReceipt`s and `MarginNote`s, in order. */
  margin?: ReactNode;
  /**
   * What the margin lines up with: `reply` (the default) a serif reply's first line, `bubble` the
   * first line inside a bubble, `top` the top of the row (a message with a caption above it).
   */
  align?: 'reply' | 'bubble' | 'top';
}

/**
 * One row of a conversation: the message in the reading column and its receipts in the margin
 * beside it. In a transcript under 884 px wide the margin stacks under the message, full width.
 */
export function TranscriptRow({ children, margin, align = 'reply' }: TranscriptRowProps) {
  const hasMargin = margin !== undefined && margin !== null && margin !== false;
  return (
    <div className={`cd-transcript-row cd-transcript-row--${align}`}>
      <div className="cd-transcript-row__main">{children}</div>
      {hasMargin ? <div className="cd-transcript-row__margin">{margin}</div> : null}
    </div>
  );
}

export interface TranscriptHeaderProps {
  /** Over the reading column: "Today at 12:04, web chat from …", a display string from the screen. */
  left: ReactNode;
  /** Over the margin: "Notes from the checks. Select one for the full trace." */
  right: ReactNode;
}

/** The captions over a conversation's two columns, first inside the `Transcript`. */
export function TranscriptHeader({ left, right }: TranscriptHeaderProps) {
  return (
    <div className="cd-transcript-row cd-transcript-row--top cd-transcript-header">
      <p className="cd-transcript-row__main cd-transcript-header__caption cd-type-caption">{left}</p>
      <p className="cd-transcript-row__margin cd-transcript-header__caption cd-type-caption">{right}</p>
    </div>
  );
}
