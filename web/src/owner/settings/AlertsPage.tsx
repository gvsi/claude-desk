import { useId } from 'react';

import { AlertList, SectionHeader, type AlertListItem } from '../../ds/index.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { businessWords, type BusinessWords } from '../businessWords.ts';
import { VisionNote } from './VisionNote.tsx';

/** The alerts set for a business, from its type: what reaches the owner right away, what waits for the briefing, and what never does. */
function alertsFor(words: BusinessWords): readonly AlertListItem[] {
  return [
    { when: 'Right away', what: words.rightAway, how: 'Notifications' },
    { when: 'In your briefing', what: words.inBriefing, how: 'Each morning at 7:00 am' },
    { when: 'Not at all', what: 'Messages Claude answered on its own' },
  ];
}

/**
 * Settings › Alerts, static and marked as vision: what reaches the owner when, and the alerts set
 * for the business type. In this prototype, alerts arrive in Notifications.
 */
export function AlertsPage() {
  const alertsId = useId();
  const { desk } = useOwnerDesk();
  const words = businessWords(desk);
  return (
    <>
      <VisionNote>In this prototype, alerts arrive in Notifications.</VisionNote>
      <p className="cd-type-body">Held requests and paused chats arrive in Notifications right away. Other alerts wait for your briefing.</p>
      <section aria-labelledby={alertsId} className="cd-settings__section">
        <SectionHeader id={alertsId} title={words.alertsTitle} caption="From your business type" />
        <AlertList label={words.alertsTitle} items={alertsFor(words)} />
      </section>
    </>
  );
}
