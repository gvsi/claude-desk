import type { ReactNode } from 'react';

import { Pill } from '../../ds/index.ts';

/** A section this prototype doesn't run: the Mock pill, then the explanation. */
export function VisionNote({ children }: { children: ReactNode }) {
  return (
    <div className="cd-settings__vision">
      <Pill>Mock</Pill>
      <p className="cd-settings__quiet cd-type-meta">{children}</p>
    </div>
  );
}
