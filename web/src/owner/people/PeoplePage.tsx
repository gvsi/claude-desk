/**
 * People, which the owner's sidebar calls Customers: those on record, each with the contact on
 * record as the API masked it and a link to their page, then the leads, newest first, each replayed
 * one tagged Recorded (N-History-People, N-Run2-People-*). The list is polled.
 */
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useNavigate } from 'react-router';

import type { PeopleOut } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import { Button, EmptyState, LeadRow, PageHeader, PersonRow, RecordedHistoryLink, SectionHeader, SkeletonScreen } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { customerLink } from '../customerLink.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { ReadFailed } from '../ReadFailed.tsx';
import { peopleQuery } from '../rules/RuleDraftReview.tsx';
import { entriesPath } from '../today/SinceLastNight.tsx';
import { useReadFailure } from '../useReadFailure.ts';
import { PEOPLE_SUBTITLE } from './copy.ts';
import { PeopleSkeleton } from './PeopleSkeleton.tsx';

import './People.css';

/** The Desk's people label, the one the sidebar shows: the page's title. The concept and route stay People. */
export const PEOPLE_LABEL = 'Customers';

/** The business's people and leads, polled as the owner's lists are. */
export function usePeople(deskId: string) {
  return useQuery({ ...peopleQuery(deskId), refetchInterval: pollMs('list') });
}

/** The People list under the Desk. */
export function peoplePath(deskId: string): string {
  return `/app/${encodeURIComponent(deskId)}/people`;
}

/** A person's page under the Desk. */
export function personPath(deskId: string, personId: string): string {
  return `${peoplePath(deskId)}/${encodeURIComponent(personId)}`;
}

type Person = PeopleOut['people'][number];
type Lead = PeopleOut['leads'][number];

const byName = (a: Person, b: Person) => a.display_name.localeCompare(b.display_name);
const newestFirst = (a: Lead, b: Lead) => Date.parse(b.created_at) - Date.parse(a.created_at);

const counted = (n: number, one: string, many: string) => ({ n, label: `${n} ${n === 1 ? one : many}` });

export function PeoplePage() {
  const { business, desk } = useOwnerDesk();
  useDocumentTitle(inApp(PEOPLE_LABEL));
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const people = usePeople(deskId);
  const failure = useReadFailure(people, { pausedRoute: 'people' });
  const contactsId = useId();
  const leadsId = useId();

  // The list's first read is out: no people and no failure yet.
  const loading = people.data === undefined && failure === null;
  let body = null;
  if (people.data === undefined) {
    // Nothing read: the skeleton while the read is out, then the failure alone.
  } else if (people.data.people.length === 0 && people.data.leads.length === 0) {
    body = (
      <div className="cd-people__below">
        <EmptyState
          title="No customers yet"
          body="When someone shares their details or verifies, they show up here."
          action={
            <Button variant="secondary" href={customerLink(desk.slug, deskId)} external>
              Open your public page
            </Button>
          }
        />
      </div>
    );
  } else {
    const contacts = [...people.data.people].sort(byName);
    const leads = [...people.data.leads].sort(newestFirst);
    const now = new Date();
    body = (
      <>
        {contacts.length === 0 ? null : (
          <section className="cd-people__section" aria-labelledby={contactsId}>
            <div className="cd-people__head">
              <SectionHeader id={contactsId} title="Contacts on record" count={counted(contacts.length, 'contact on record', 'contacts on record')} />
            </div>
            <ul role="list" className="cd-people__rows" aria-labelledby={contactsId}>
              {contacts.map((person) => (
                <li key={person.person_id}>
                  <PersonRow name={person.display_name} contact={person.masked_contact} href={personPath(deskId, person.person_id)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {leads.length === 0 ? null : (
          <section className="cd-people__section" aria-labelledby={leadsId}>
            <div className="cd-people__head">
              <SectionHeader id={leadsId} title="Leads" count={counted(leads.length, 'lead', 'leads')} />
              {leads.some((lead) => lead.replayed === true) ? (
                <p className="cd-people__caption cd-type-caption">
                  <RecordedHistoryLink href={entriesPath(deskId)} />
                </p>
              ) : null}
            </div>
            <ul role="list" className="cd-people__rows" aria-labelledby={leadsId}>
              {leads.map((lead) => (
                <li key={lead.lead_id}>
                  {/* A lead may have left no note (or, though the kernel never writes one, no name): nothing is drawn for it. */}
                  <LeadRow
                    name={lead.display_name ?? ''}
                    time={formatWhen(lead.created_at, business.timezone, now)}
                    note={lead.note ?? ''}
                    recorded={lead.replayed === true}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <div className="cd-people" onClick={followInAppLinks(navigate)}>
      <PageHeader title={PEOPLE_LABEL} subtitle={PEOPLE_SUBTITLE} />
      {/* Under the real header, everything the people read draws: its failure, the sections or the empty state. */}
      <SkeletonScreen loading={loading} status="Loading your customers" skeleton={<PeopleSkeleton withHeader={false} />} className="cd-people__region">
        <ReadFailed failure={failure} />
        {body}
      </SkeletonScreen>
    </div>
  );
}
