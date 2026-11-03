import type { ReactNode, Ref } from 'react';

import './Transcript.css';

/**
 * Whose view the log is: `default`, the visitor's own chat and every other conversation, their words
 * on the right and Claude's on the left; `owner`, the owner's own conversation view, the sides
 * flipped, so the owner reads the Desk's side on the right.
 */
export type TranscriptVariant = 'default' | 'owner';

export interface TranscriptProps {
  /** The log's accessible name: "Conversation with Dana Whitfield". */
  label: string;
  /** The rows: messages, system lines, the writing state, and the receipts attached under messages. */
  children: ReactNode;
  /** When supplied, the log can receive restored focus after an action disappears. */
  logRef?: Ref<HTMLElement>;
  /** `owner` only in the owner app's conversation view (board REV-FLIP). */
  variant?: TranscriptVariant;
}

/**
 * The conversation: a polite live log, so a screen reader announces each new reply, receipt and
 * system line as it arrives. It is an inline-size container named `cd-transcript`, so rows lay
 * out by the log's width, not the window's.
 */
export function Transcript({ label, children, logRef, variant = 'default' }: TranscriptProps) {
  const className = variant === 'owner' ? 'cd-transcript cd-transcript--owner' : 'cd-transcript';
  return (
    <section ref={logRef} tabIndex={logRef ? -1 : undefined} className={className} role="log" aria-live="polite" aria-label={label}>
      {children}
    </section>
  );
}
