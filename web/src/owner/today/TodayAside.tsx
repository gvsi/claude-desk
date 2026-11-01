import type { ReactNode } from 'react';

import { ThisWeek } from './ThisWeek.tsx';

export interface TodayAsideProps {
  deskId: string;
  /** First: Today's Demo inbox, whose button opens it in a sheet at the right. */
  inbox?: ReactNode;
}

/**
 * Today's right column: the Demo inbox and the last 7 days. The public page is a new tab away from
 * the greeting's "Chat as a customer"; nothing here opens a chat on Today.
 */
export function TodayAside({ deskId, inbox }: TodayAsideProps) {
  return (
    <div className="cd-today-aside">
      {inbox}
      <ThisWeek deskId={deskId} />
    </div>
  );
}
