/**
 * A person's page under Customers (N-Run2-People-Person): the way back to the list, their name, the
 * rules just for them, read only, with the way to change them on Rules, and beside them the contact
 * on record as the API masked it, where codes go and nowhere else. The page reads the same polled
 * list as Customers, and the Desk's active rules. Someone the list doesn't hold is outside the
 * copy: the not-found screen.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';

import type { RuleCard } from '../../api/contracts.ts';
import type { PeopleOut } from '../../api/views.ts';
import { OutsideTheCopy } from '../../app/NotFound.tsx';
import { pollMs } from '../../app/poll.ts';
import { Breadcrumb, Card, LoadingLine, PageHeader, PersonRules, type PersonRuleView, type RulesLinkProps } from '../../ds/index.ts';
import { formatCents } from '../../lib/format.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { rulesQuery } from '../rules/RuleDraftReview.tsx';
import { ruleWords, targetWords } from '../rules/ruleWords.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { PEOPLE_LABEL, ReadFailed, peoplePath, usePeople } from './PeoplePage.tsx';

import './People.css';

const rulesPath = (deskId: string) => `/app/${encodeURIComponent(deskId)}/rules`;

/** The breadcrumb's and the rules' links through the router, so the app stays loaded. */
function RouterLink({ href, children, ...rest }: RulesLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

/**
 * The active cards just for `personId`, in card order, as the person's page lists them: what each
 * is on, its reason, what it enforces in the rules' words, its outcome and an auto card's amount.
 */
export function personRules(cards: readonly RuleCard[], personId: string, people: PeopleOut): PersonRuleView[] {
  return cards
    .filter((card) => card.who === 'person' && card.person_id === personId)
    .map((card) => {
      const limit = card.mode === 'auto' && card.max_amount_cents != null ? formatCents(card.max_amount_cents) : undefined;
      return {
        key: card.card_id,
        title: targetWords(card.applies_to),
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
      <PersonRules name={name} rules={personRules(rules.data.active.cards, personId, people)} rulesHref={rulesPath(deskId)} linkComponent={RouterLink} />
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

  if (people.data === undefined) {
    return <div className="cd-person">{failure === null ? <LoadingLine>Loading this customer</LoadingLine> : <ReadFailed failure={failure} />}</div>;
  }

  // Someone the copy's list doesn't hold: the not-found screen, never anyone else's page.
  const person = people.data.people.find((p) => p.person_id === personId);
  if (person === undefined) throw new OutsideTheCopy();

  const name = person.display_name;
  return (
    <div className="cd-person" onClick={followInAppLinks(navigate)}>
      <ReadFailed failure={failure} />
      <Breadcrumb items={[{ label: PEOPLE_LABEL, href: peoplePath(deskId) }, { label: name }]} linkComponent={RouterLink} />
      <PageHeader title={<span data-copy="user">{name}</span>} />
      <div className="cd-person__columns">
        <div className="cd-person__main">
          <TheirRules deskId={deskId} personId={personId} name={name} people={people.data} />
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
