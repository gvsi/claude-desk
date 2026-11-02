/** A person's rules name listed business tools while keeping the existing fallback words; their page lists only their own chats. */
import { expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import type { ConversationSummary, PeopleOut } from '../../api/views.ts';
import { chenBusinessTools } from '../../mocks/businessTools.ts';
import { businessTools } from '../connectors/catalog.ts';
import { personConversations, personRules } from './PersonDetail.tsx';

it('names a business target on a person rule', () => {
  const people: PeopleOut = { people: [], leads: [] };
  const card: RuleCard = { card_id: 'intro', applies_to: 'desk.intro-call', who: 'person', person_id: 'new-client', mode: 'auto', reason: 'Intro calls run on their own.' };
  expect(personRules([card], 'new-client', people, businessTools(chenBusinessTools))[0]?.title).toBe('Book a free intro call');
  expect(personRules([card], 'new-client', people)[0]?.title).toBe('A connected tool');
  expect(personRules([{ ...card, applies_to: 'desk.unknown' }], 'new-client', people, businessTools(chenBusinessTools))[0]?.title).toBe('A connected tool');
  expect(personRules([card], 'someone-else', people, businessTools(chenBusinessTools))).toEqual([]);
});

/** A conversation summary as the API sends it, with the fields the person's page reads. */
function chat(sessionId: string, lastActivity: string, personId: string | null): ConversationSummary {
  return {
    session_id: sessionId,
    kind: 'visitor',
    display_name: personId === null ? null : 'Dana Whitfield',
    verified: personId !== null,
    person_id: personId,
    mode: 'ai',
    last_activity: lastActivity,
    outcome_counts: {},
    owner_preview: false,
    latest_visitor_text: 'Hi',
  };
}

it("lists only a person's own verified chats, newest first, in Conversations' day groups", () => {
  // Friday, October 30, 12:30 pm in Los Angeles.
  const now = new Date('2026-10-30T19:30:00Z');
  const items = [
    chat('ses-old', '2026-10-12T17:00:00Z', 'dana'),
    chat('ses-today', '2026-10-30T18:00:00Z', 'dana'),
    chat('ses-bob', '2026-10-30T19:00:00Z', 'bob'),
    chat('ses-unverified', '2026-10-30T19:10:00Z', null),
    chat('ses-yesterday', '2026-10-29T20:00:00Z', 'dana'),
    chat('ses-older', '2026-10-20T17:00:00Z', 'dana'),
  ];
  const groups = personConversations(items, 'dana', 'America/Los_Angeles', now);
  expect(groups.map((g) => [g.day, g.items.map((s) => s.session_id)])).toEqual([
    ['Today', ['ses-today']],
    ['Yesterday', ['ses-yesterday']],
    ['Earlier', ['ses-older', 'ses-old']],
  ]);
  expect(personConversations(items, 'someone-else', 'America/Los_Angeles', now)).toEqual([]);
  // A summary without the field, from before the API sent it, is no one's.
  const { person_id: _, ...unnamed } = chat('ses-unnamed', '2026-10-30T18:00:00Z', null);
  expect(personConversations([unnamed], '', 'America/Los_Angeles', now)).toEqual([]);
});
