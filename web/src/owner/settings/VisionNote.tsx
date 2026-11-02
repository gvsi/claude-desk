import type { ReactNode } from 'react';

import { Pill } from '../../ds/index.ts';

/**
 * A section this prototype doesn't run: the Mock pill, then the explanation. Without `pill`, the
 * explanation alone: Knowledge's notes, whose plumbing demo says it is a mock once, beside its title.
 */
export function VisionNote({ children, pill = true }: { children: ReactNode; pill?: boolean }) {
  return (
    <div className="cd-settings__vision">
      {pill ? <Pill>Mock</Pill> : null}
      <p className="cd-settings__quiet cd-type-meta">{children}</p>
    </div>
  );
}
