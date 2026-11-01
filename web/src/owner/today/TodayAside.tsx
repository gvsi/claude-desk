import { ThisWeek } from './ThisWeek.tsx';

export interface TodayAsideProps {
  deskId: string;
}

/**
 * Today's right column: the last 7 days. The public page is a new tab away from the greeting's
 * "Chat as a customer", and the Demo inbox is in the demo bar; nothing here opens a chat on Today.
 */
export function TodayAside({ deskId }: TodayAsideProps) {
  return (
    <div className="cd-today-aside">
      <ThisWeek deskId={deskId} />
    </div>
  );
}
