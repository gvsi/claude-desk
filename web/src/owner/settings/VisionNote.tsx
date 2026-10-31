import type { ReactNode } from 'react';

import { Pill } from '../../ds/index.ts';

/** The note at the top of a Settings section this prototype doesn't run: the Vision pill, then its line. */
export function VisionNote({ children }: { children: ReactNode }) {
  return (
    <div className="cd-settings__vision">
      <Pill>Vision</Pill>
      <p className="cd-settings__quiet cd-type-meta">{children}</p>
    </div>
  );
}
