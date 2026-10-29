import type { ReactNode } from 'react';

import './Pill.css';

export interface PillProps {
  /** A short label, such as a visitor's level: "Public", "Verified", "Agent". A leading `StatusDot` lines up too. */
  children: ReactNode;
}

export function Pill({ children }: PillProps) {
  return <span className="cd-pill cd-type-pill">{children}</span>;
}
