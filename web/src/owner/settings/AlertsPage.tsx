import { useId } from 'react';

import { AlertList, SectionHeader, type AlertListItem } from '../../ds/index.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { RIVERA_SAMPLE_BUSINESS_NAME } from '../useDesks.ts';
import { VisionNote } from './VisionNote.tsx';

/** The alerts set for a plumber, from the business type, in the board's words. */
const PLUMBER_ALERTS: readonly AlertListItem[] = [
  { when: 'Right away', what: 'Held requests, paused chats and emergencies', how: 'Notifications' },
  { when: 'In your briefing', what: 'New leads, bookings and payments', how: 'Each morning at 7:00 am' },
  { when: 'Not at all', what: 'Messages Claude answered on its own' },
];

/** Any other business's: the same, with no emergencies, which a salon doesn't have (owner, 2026-11-02). */
const OTHER_ALERTS: readonly AlertListItem[] = PLUMBER_ALERTS.map((alert) =>
  alert.when === 'Right away' ? { ...alert, what: 'Held requests and paused chats' } : alert,
);

/**
 * Settings › Alerts, static and marked as vision: what reaches the owner when, and the alerts set
 * for the business type. In this prototype, alerts arrive in Notifications.
 */
export function AlertsPage() {
  const alertsId = useId();
  const { desk } = useOwnerDesk();
  const isSampleBusiness = desk.business_name === RIVERA_SAMPLE_BUSINESS_NAME;
  return (
    <>
      <VisionNote>In this prototype, alerts arrive in Notifications.</VisionNote>
      <p className="cd-type-body">Held requests and paused chats arrive in Notifications right away. Other alerts wait for your briefing.</p>
      <section aria-labelledby={alertsId} className="cd-settings__section">
        {isSampleBusiness ? (
          <SectionHeader id={alertsId} title="Set for a plumber" caption="From your business type" />
        ) : (
          <p id={alertsId} className="cd-section-header__caption cd-type-meta">From your business type</p>
        )}
        <AlertList label={isSampleBusiness ? 'Set for a plumber' : 'From your business type'} items={isSampleBusiness ? PLUMBER_ALERTS : OTHER_ALERTS} />
      </section>
    </>
  );
}
