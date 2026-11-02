import { expect, it } from 'vitest';

import { liveSetupDeskIds } from '../test/liveSetupDesk.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';
import { businessWords } from './businessWords.ts';

const QUESTIONS = 'Questions Claude couldn’t answer';

/** The rows' words, in order, by their class. */
function texts(list: Element, className: string): (string | null | undefined)[] {
  return [...list.querySelectorAll('li')].map((row) => row.querySelector(className)?.textContent);
}

// The mock's setup reads each description's business type from its words, as the API's model does.
it.each([
  { type: 'trade', description: 'An electrician in Fresno', title: 'Set for a trade business',
    alerts: ['Held requests, paused chats and emergencies', 'New leads, bookings and payments', 'Messages Claude answered on its own'],
    questions: ['Do you give free estimates?', 'Can you come out on a Sunday?', 'Do you take credit cards on site?'] },
  { type: 'office', description: 'Bright Smile Dental. A dentist in Oakland.', title: 'Set for a professional practice',
    alerts: ['Held requests and paused chats', 'New clients, appointments and payments', 'Messages Claude answered on its own'],
    questions: ['Do you work with clients in other states?', 'Can we meet in person instead of a call?', 'Do you take credit cards?'] },
  { type: 'landlord', description: 'Apartments in Sacramento', title: 'Set for a landlord',
    alerts: ['Held requests, paused chats and maintenance requests', 'New applicants, viewings and payments', 'Messages Claude answered on its own'],
    questions: ['Do you allow pets?', 'Is parking included?', 'Can I pay rent by card?'] },
  { type: 'other', description: 'A hair salon in Oakland', title: 'Set for your business',
    alerts: ['Held requests and paused chats', 'New leads, bookings and payments', 'Messages Claude answered on its own'],
    questions: ['Do you sell gift cards?', 'Is there parking nearby?', 'Do you take credit cards?'] },
])('a $type Desk shows its business type’s alerts and sample questions', async ({ description, title, alerts, questions }) => {
  const { deskId } = await liveSetupDeskIds(description);

  const alertsPage = await renderRoute(`/app/${deskId}/settings/alerts`, { pollScale: 100 });
  await expect.element(alertsPage.screen.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect.element(alertsPage.screen.getByText('From your business type', { exact: true })).toBeVisible();
  const list = alertsPage.screen.getByRole('list', { name: title, exact: true }).element();
  expect(texts(list, '.cd-alert-list__what')).toEqual(alerts);
  expect(alertsPage.screen.getByRole('heading', { name: 'Set for a plumber', exact: true }).query()).toBeNull();
  expectNoHorizontalScroll();

  const knowledge = await renderRoute(`/app/${deskId}/knowledge`, { pollScale: 100 });
  const asked = knowledge.screen.getByRole('region', { name: QUESTIONS, exact: true });
  await expect.element(asked).toBeVisible();
  expect(texts(asked.element(), '.cd-knowledge-list__title')).toEqual(questions);
  expect(texts(asked.element(), '.cd-knowledge-list__detail')).toEqual(['Asked 3 times this week', 'Asked twice this week', 'Asked once, on Friday']);
  expectNoHorizontalScroll();
});

it('the sample business keeps Turner’s words on every Desk, whatever its type says', () => {
  expect(businessWords({ business_name: 'Turner Plumbing', business_type: 'rivera' }).alertsTitle).toBe('Set for a plumber');
  expect(businessWords({ business_name: 'Turner Plumbing', business_type: 'other' }).alertsTitle).toBe('Set for a plumber');
  expect(businessWords({ business_name: 'Bright Smile Dental', business_type: 'office' }).alertsTitle).toBe('Set for a professional practice');
});
