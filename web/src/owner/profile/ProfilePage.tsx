import { useId } from 'react';

import { DetailList, NAV_LABELS, PageHeader, SectionHeader, type DetailItem } from '../../ds/index.ts';
import { hoursParts } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { HeaderColourCard } from '../settings/HeaderColourCard.tsx';

import '../settings/Settings.css';
import './Profile.css';

/**
 * A Desk's hours window in the signed board's words, "Weekdays 8:00 am to 6:00 pm". No board draws
 * an all-day window, so one reads as Rules writes it, with the comma: "Every day, all day".
 */
function hoursWords({ days, times, allDay }: ReturnType<typeof hoursParts>): string {
  return allDay ? `${days}, ${times}` : `${days} ${times}`;
}

/**
 * An IANA time zone as the owner reads it: its generic name and its city, "Pacific Time (Los
 * Angeles)" for America/Los_Angeles; the generic name alone when it already names the city, and
 * the zone as it came when the browser can't name it.
 */
function timeZoneWords(zone: string): string {
  const city = zone.split('/').at(-1)?.replaceAll('_', ' ') ?? zone;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    if (name === undefined || name === '') return zone;
    return name.includes(city) ? name : `${name} (${city})`;
  } catch {
    return zone;
  }
}

/** The business details and public header customers see. */
export function ProfilePage() {
  useDocumentTitle(inApp(NAV_LABELS.profile));
  const { business, desk } = useOwnerDesk();
  const businessId = useId();
  const details: DetailItem[] = [
    { label: 'Business', value: business.name },
    { label: 'This Desk', value: desk.name },
    { label: 'Customers see you as', value: business.owner_display_name },
    { label: 'Time zone', value: timeZoneWords(business.timezone) },
  ];
  // In the signed board's words: "Weekdays 8:00 am to 6:00 pm, Saturdays 9:00 am to 1:00 pm".
  const hours = desk.hours.map((window) => hoursWords(hoursParts(window)));
  if (hours.length > 0) details.push({ label: 'Hours', value: hours.join(', ') });

  return (
    <>
      <PageHeader title={NAV_LABELS.profile} subtitle="How customers see your business." />
      <div className="cd-profile">
        <section aria-labelledby={businessId} className="cd-settings__section">
          <SectionHeader id={businessId} title="Your business" />
          <DetailList items={details} />
        </section>
        <HeaderColourCard key={desk.desk_id} business={business} desk={desk} />
      </div>
    </>
  );
}
