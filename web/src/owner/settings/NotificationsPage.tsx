import { useId } from 'react';

import { AlertList, SectionHeader, type AlertListItem } from '../../ds/index.ts';
import { VisionNote } from './VisionNote.tsx';

/** The alerts set for a plumber, from the business type, in the board's words. */
const PLUMBER_ALERTS: readonly AlertListItem[] = [
  { when: 'Right away', what: 'Held requests, paused chats and emergencies', how: 'Demo inbox' },
  { when: 'In your briefing', what: 'New leads, bookings and payments', how: 'Each morning at 7:00 am' },
  { when: 'Not at all', what: 'Messages Claude answered on its own' },
];

/**
 * Settings › Notifications, static and marked as vision: what reaches the owner when, and the alerts
 * set for the business type. In this prototype, alerts reach the Demo inbox.
 */
export function NotificationsPage() {
  const alertsId = useId();
  return (
    <>
      <VisionNote>In this prototype, alerts reach your Demo inbox.</VisionNote>
      <p className="cd-type-body">Held requests and paused chats reach your Demo inbox right away. Other alerts wait for your briefing.</p>
      <section aria-labelledby={alertsId} className="cd-settings__section">
        <SectionHeader id={alertsId} title="Set for a plumber" caption="From your business type" />
        <AlertList label="Set for a plumber" items={PLUMBER_ALERTS} />
      </section>
    </>
  );
}
