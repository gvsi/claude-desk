import type { ReactNode } from 'react';

import './StatusDot.css';

/** `handled` (allowed, done), `held` (needs you), `refused` (blocked) or `info` (a hollow dot). */
export type StatusTone = 'handled' | 'held' | 'refused' | 'info';

export interface StatusDotProps {
  tone: StatusTone;
}

/** A 6 px dot in the tone's status color. Always `aria-hidden`: the words beside it say the same. */
export function StatusDot({ tone }: StatusDotProps) {
  return <span className={`cd-status-dot cd-status-dot--${tone}`} aria-hidden="true" />;
}

export interface StatusLabelProps {
  tone: StatusTone;
  /** The words that say what the dot shows: "Handled", "Needs you", "Blocked". */
  children: ReactNode;
}

/** A status dot beside its words, in the surrounding type. */
export function StatusLabel({ tone, children }: StatusLabelProps) {
  return (
    <span className="cd-status-label">
      <StatusDot tone={tone} />
      <span>{children}</span>
    </span>
  );
}
