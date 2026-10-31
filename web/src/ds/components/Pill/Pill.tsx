import type { ReactNode } from 'react';

import './Pill.css';

export interface PillProps {
  /** A short label, such as a visitor's level: "Public", "Verified", "Agent". A leading `StatusDot` lines up too. */
  children: ReactNode;
  /**
   * The lockup's "Preview" badge, and nothing else: the word, written in sentence case, drawn in small,
   * slightly spaced capitals (`.cd-type-badge-caps`). The copy check allows capitals on this badge alone,
   * and only for "Preview".
   */
  caps?: boolean;
}

export function Pill({ children, caps = false }: PillProps) {
  return caps ? (
    <span className="cd-pill cd-type-badge-caps" data-ds="preview-badge">
      {children}
    </span>
  ) : (
    <span className="cd-pill cd-type-pill">{children}</span>
  );
}
