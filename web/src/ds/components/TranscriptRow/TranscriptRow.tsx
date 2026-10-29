import type { ReactNode } from 'react';

import './TranscriptRow.css';

export interface TranscriptRowProps {
  /** The message: a `VisitorMessage`, `ClaudeMessage`, `PersonMessage`, `AgentMessage` or `Whisper`. */
  children: ReactNode;
  /** The message's `MarginReceipt`s and `MarginNote`s, in order, attached under it. */
  margin?: ReactNode;
}

/**
 * One row of a conversation: the message in the reading column, and its receipts attached under
 * it, at every width.
 */
export function TranscriptRow({ children, margin }: TranscriptRowProps) {
  const hasMargin = margin !== undefined && margin !== null && margin !== false;
  return (
    <div className="cd-transcript-row">
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
