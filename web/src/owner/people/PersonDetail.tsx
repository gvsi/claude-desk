/**
 * A person's page under Customers (N-Run2-People-Person): the way back to the list, their name, the
 * rules just for them, read only, with the way to change them on Rules, and under them the chats
 * they had once verified, each a link into it; beside them the contact on record as the API masked
 * it, where codes go and nowhere else. The page reads the same polled list as Customers, the
 * Desk's active rules, and the conversations and Needs you as Conversations polls them. Someone
 * the list doesn't hold is outside the copy: the not-found screen.
 */
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useNavigate, useParams } from 'react-router';

import type { RuleCard } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import type { ConversationSummary, PeopleOut } from '../../api/views.ts';
import { OutsideTheCopy } from '../../app/NotFound.tsx';
import { pollMs } from '../../app/poll.ts';
import { Breadcrumb, Card, ConversationListItem, LoadingLine, PageHeader, PersonRules, SectionHeader, type PersonRuleView } from '../../ds/index.ts';
import { conversationDay, formatCents, formatListTime, type ConversationDay } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { NO_BUSINESS_TOOLS, businessTools, type BusinessTools } from '../connectors/catalog.ts';
import { conversationsKey } from '../conversations/ConversationsPage.tsx';
import { conversationListStatus, conversationPath, whoLabel } from '../conversations/status.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { RouterLink, useOwnerDesk } from '../OwnerLayout.tsx';
import { ReadFailed } from '../ReadFailed.tsx';
import { rulesQuery } from '../rules/RuleDraftReview.tsx';
import { ruleWords, targetWords } from '../rules/ruleWords.ts';
import { firstName, useNeedsYou } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { PEOPLE_LABEL, peoplePath, usePeople } from './PeoplePage.tsx';

import './People.css';

const rulesPath = (deskId: string) => `/app/${encodeURIComponent(deskId)}/rules`;

/**
 * The active cards just for `personId`, in card order, as the person's page lists them: what each
 * is on, its reason, what it enforces in the rules' words, its outcome and an auto card's amount.
 */
export function personRules(cards: readonly RuleCard[], personId: string, people: PeopleOut, business: BusinessTools = NO_BUSINESS_TOOLS): PersonRuleView[] {
  return cards
    .filter((card) => card.who === 'person' && card.person_id === personId)
    .map((card) => {
      const limit = card.mode === 'auto' && card.max_amount_cents != null ? formatCents(card.max_amount_cents) : undefined;
      return {
        key: card.card_id,
        title: targetWords(card.applies_to, business),
        rule: { card_id: card.card_id, mode: card.mode, reason: card.reason },
        words: ruleWords(card, people),
        ...(limit === undefined ? {} : { limit }),
      };
    });
}

/** The rules just for this person, once the Desk's rules are read; a failed read says so with Try again. */
function TheirRules({ deskId, personId, name, people }: { deskId: string; personId: string; name: string; people: PeopleOut }) {
  const rules = useQuery({ ...rulesQuery(deskId), refetchInterval: pollMs('rules') });
  const failure = useReadFailure(rules);
  if (rules.data === undefined) {
    return failure === null ? <LoadingLine>Loading their rules</LoadingLine> : <ReadFailed failure={failure} />;
  }
  return (
    <>
      <ReadFailed failure={failure} />
      <PersonRules name={name} rules={personRules(rules.data.active.cards, personId, people, businessTools(rules.data.tools))} rulesHref={rulesPath(deskId)} linkComponent={RouterLink} />
    </>
  );
}

/** The words for a person with no chat they verified in: an unverified chat isn't theirs to list. */
export const NO_CONVERSATIONS = 'No verified conversations yet.';

/** One day's chats, under the day Conversations groups them by. */
export interface ConversationGroup {
  day: ConversationDay;
  items: ConversationSummary[];
}

/**
 * The chats `personId` had once verified (`person_id` theirs), newest first by their last
 * activity, in the day groups Conversations draws on the business's clock, so a row's time reads
 * as it does there.
 */
export function personConversations(items: readonly ConversationSummary[], personId: string, timezone: string, now: Date): ConversationGroup[] {
  const theirs = items
    .filter((s) => s.person_id != null && s.person_id === personId)
    .sort((a, b) => Date.parse(b.last_activity) - Date.parse(a.last_activity));
  const groups: ConversationGroup[] = [];
  for (const item of theirs) {
    const day = conversationDay(item.last_activity, timezone, now);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/**
 * The chats this person had once verified, as the Conversations list draws them, each a link into
 * it, from the same polled reads as that list: the conversations, and Needs you for a chat's open
 * handoff. Only a visitor's own chat has a person, never an agent's or the owner's preview, so a
 * row quotes the visitor's newest words. Until both first reads settle, the loading line; a failed
 * read says so with Try again.
 */
function TheirConversations({ deskId, personId }: { deskId: string; personId: string }) {
  const { business } = useOwnerDesk();
  const titleId = useId();
  const list = useQuery({
    queryKey: conversationsKey(deskId),
    queryFn: () => request('conversations', { params: { desk_id: deskId } }),
    refetchInterval: pollMs('list'),
  });
  const needsYou = useNeedsYou(deskId);
  const failure = useReadFailure(list);
  const needsFailure = useReadFailure(needsYou);
  // Needs you says which chats have a handoff open ("Wants you"), so its first read settles before
  // the rows draw, as on Conversations; a failed one leaves those rows their usual status.
  if (list.data === undefined || (needsYou.data === undefined && needsFailure === null)) {
    return failure === null ? <LoadingLine>Loading their conversations</LoadingLine> : <ReadFailed failure={failure} />;
  }
  const handoffs = new Set((needsYou.data ?? []).flatMap((item) => (item.handoff === null ? [] : [item.handoff.session_id])));
  const now = new Date();
  const groups = personConversations(list.data, personId, business.timezone, now);
  return (
    <>
      <ReadFailed failure={failure} />
      <section className="cd-person__conversations" aria-labelledby={titleId}>
        <SectionHeader id={titleId} title="Conversations" />
        {groups.length === 0 ? (
          <p className="cd-person__none cd-type-body">{NO_CONVERSATIONS}</p>
        ) : (
          groups.map((group) => (
            <div key={group.day} className="cd-person__day-group">
              <h3 className="cd-person__day cd-type-caption">{group.day}</h3>
              <ul className="cd-person__chats">
                {group.items.map((s) => (
                  <li key={s.session_id}>
                    <ConversationListItem
                      name={whoLabel(s)}
                      time={formatListTime(s.last_activity, business.timezone, now)}
                      status={conversationListStatus(s, s.outcome_counts.held ?? 0, handoffs.has(s.session_id), firstName(business.owner_display_name)) ?? undefined}
                      href={conversationPath(deskId, s.session_id)}
                      recorded={s.replayed === true}
                      quote={s.latest_visitor_text ?? undefined}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </>
  );
}

export function PersonDetail() {
  const { personId = '' } = useParams();
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const people = usePeople(deskId);
  const failure = useReadFailure(people);
  const person = people.data?.people.find((p) => p.person_id === personId);
  // The tab names them as the page's title does, and the page they are under until the list says who they are.
  useDocumentTitle(inApp(person?.display_name ?? PEOPLE_LABEL));

  if (people.data === undefined) {
    return <div className="cd-person">{failure === null ? <LoadingLine>Loading this customer</LoadingLine> : <ReadFailed failure={failure} />}</div>;
  }

  // Someone the copy's list doesn't hold: the not-found screen, never anyone else's page. Only a
  // read made since the page opened decides that, since a list read earlier may not have them yet;
  // until it lands, the page is loading, and if it fails, it says so with Try again.
  if (person === undefined) {
    const fresh = people.isFetchedAfterMount && !people.isFetching && failure === null;
    if (fresh) throw new OutsideTheCopy();
    return (
      <div className="cd-person">
        {failure !== null && !people.isFetching ? <ReadFailed failure={failure} /> : <LoadingLine>Loading this customer</LoadingLine>}
      </div>
    );
  }

  const name = person.display_name;
  return (
    <div className="cd-person" onClick={followInAppLinks(navigate)}>
      <ReadFailed failure={failure} />
      <Breadcrumb items={[{ label: PEOPLE_LABEL, href: peoplePath(deskId) }, { label: name }]} linkComponent={RouterLink} />
      <PageHeader title={<span data-copy="user">{name}</span>} />
      <div className="cd-person__columns">
        <div className="cd-person__main">
          <TheirRules deskId={deskId} personId={personId} name={name} people={people.data} />
          <TheirConversations deskId={deskId} personId={personId} />
        </div>
        <div className="cd-person__aside">
          <Card as="section" label="Contact on record">
            <h2 className="cd-person__card-title cd-type-section">Contact on record</h2>
            <p className="cd-person__contact cd-type-control">{person.masked_contact}</p>
            <p className="cd-person__codes cd-type-meta">Codes go only to this contact. A number typed in a chat never replaces it.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
