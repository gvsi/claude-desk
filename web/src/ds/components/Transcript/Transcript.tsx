import type { ReactNode } from 'react';

import './Transcript.css';

export interface TranscriptProps {
  /** The log's accessible name: "Conversation with Dana Whitfield". */
  label: string;
  /** The rows: messages, system lines, the writing state, and their margin receipts. */
  children: ReactNode;
}

/**
 * The conversation: a polite live log, so a screen reader announces each new reply, receipt and
 * system line as it arrives. It is an inline-size container named `cd-transcript`, so rows lay
 * out by the log's width, not the window's.
 */
export function Transcript({ label, children }: TranscriptProps) {
  return (
    <section className="cd-transcript" role="log" aria-live="polite" aria-label={label}>
      {children}
    </section>
  );
}
