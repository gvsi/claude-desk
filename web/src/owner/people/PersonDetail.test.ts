/** A person's rules name listed business tools while keeping the existing fallback words. */
import { expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import type { PeopleOut } from '../../api/views.ts';
import { chenBusinessTools } from '../../mocks/businessTools.ts';
import { businessTools } from '../connectors/catalog.ts';
import { personRules } from './PersonDetail.tsx';

it('names a business target on a person rule', () => {
  const people: PeopleOut = { people: [], leads: [] };
  const card: RuleCard = { card_id: 'intro', applies_to: 'desk.intro-call', who: 'person', person_id: 'new-client', mode: 'auto', reason: 'Intro calls run on their own.' };
  expect(personRules([card], 'new-client', people, businessTools(chenBusinessTools))[0]?.title).toBe('Book a free intro call');
  expect(personRules([card], 'new-client', people)[0]?.title).toBe('A connected tool');
  expect(personRules([{ ...card, applies_to: 'desk.unknown' }], 'new-client', people, businessTools(chenBusinessTools))[0]?.title).toBe('A connected tool');
  expect(personRules([card], 'someone-else', people, businessTools(chenBusinessTools))).toEqual([]);
});
