import { expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { chenBusinessTools, seedBusinessTools } from '../mocks/businessTools.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { SETUP_COPY } from './copy.ts';

async function interviewAtTools() {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: 'Chen & Co. CPA. I am Linda, a CPA in San Jose.', timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey(),
  } });
  if ('network' in started || started.status !== 201) throw new Error('The mock starts setup');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text: question.key === 'money_limit' ? '$500 is fine.' : 'Yes, that works.' } });
  }
  const desk = mockStore.world.desks.find((row) => row.summary.desk_id === state.desk_id);
  if (!desk) throw new Error('Setup has a Desk');
  seedBusinessTools(desk);
  // The signed Chen setup lists its two jobs and Verification, with Stripe still to connect.
  desk.summary.business_name = 'Chen & Co. CPA';
  desk.tools = desk.tools.filter((row) => row.source === 'business' || row.tool === 'native.start_verification');
  return { state, desk };
}

it.each([1440, 1512, 390])('at %i px, reviews and turns on exactly one job at its listed hash only after confirming its rules draft', async (width) => {
  const { state, desk } = await interviewAtTools();
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: { width, height: width === 390 ? 844 : 900 } });
  const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
  await expect.element(jobs).toBeVisible();
  expect([...jobs.element().querySelectorAll('.cd-connector-summary__name')].map((el) => el.textContent)).toEqual(['Book a free intro call', 'New client intake']);
  await expect.element(jobs.getByText('Free intro call, 20 minutes, in your opening hours')).toBeVisible();
  await expect.element(jobs.getByText('3 questions before a booking')).toBeVisible();
  await expect.element(jobs.getByText('On', { exact: true })).toBeVisible();
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
  await page.screenshot({ path: `../../.vitest/attachments/task-2/tools-${width}.png` });
  const review = jobs.getByRole('button', { name: 'Review Book a free intro call' });
  (screen.getByRole('link', { name: 'Save and exit' }).element() as HTMLElement).focus();
  await userEvent.tab();
  await expect.element(review).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Book a free intro call' })).toBeVisible();
  await expect.element(screen.getByRole('region', { name: 'How it’s set up' }).getByText('You approve each request in Needs you')).toBeVisible();
  await expect.element(screen.getByText('Offers open times and books a free intro call, 20 minutes.', { exact: false })).toBeVisible();
  expect(screen.getByText(/A built-in connector/).elements()).toHaveLength(0);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
  await page.screenshot({ path: `../../.vitest/attachments/task-2/review-${width}.png` });
  const mark = mockStore.requests.length;
  const turnOn = screen.getByRole('button', { name: 'Turn it on', exact: true });
  await userEvent.tab();
  await expect.element(turnOn).toHaveFocus();
  await userEvent.tab();
  await expect.element(screen.getByRole('button', { name: 'Cancel', exact: true })).toHaveFocus();
  await userEvent.tab({ shift: true });
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('heading', { name: 'Turn on Book a free intro call' })).toBeVisible();
  expect(mockStore.requests.slice(mark).filter((r) => r.key === 'confirmTool').map((r) => r.body)).toEqual([
    { tools: [{ tool: 'desk.intro-call', definition_sha256: chenBusinessTools[0]?.definition_sha256 }], enable: true },
  ]);
  expect(desk.tools.find((row) => row.tool === 'desk.intro-call')?.status).toBe('needs_review');
  expect(mockStore.requests.slice(mark).filter((r) => r.key === 'confirmRules')).toHaveLength(0);
  await screen.getByRole('button', { name: 'Confirm and turn on' }).click();
  await expect.element(screen.getByRole('heading', { name: 'What Claude can use' })).toBeVisible();
  expect(desk.tools.find((row) => row.tool === 'desk.intro-call')?.status).toBe('enabled');
  await expect.poll(() => jobs.getByText('On', { exact: true }).elements()).toHaveLength(2);
  expect(jobs.getByRole('button').elements()).toHaveLength(0);
});

it('omits unknown and malformed business rows and keeps the Tools step usable', async () => {
  const { state } = await interviewAtTools();
  const intro = chenBusinessTools[0];
  if (!intro) throw new Error('The fixture has an intro call');
  mockStore.inject({ route: 'setupTools', status: 200, body: { tools: [
    null, { ...intro, business: null }, { ...intro, business: { ...intro.business, title: ' ' } },
    { ...intro, business: { ...intro.business, config: { block: 'unknown' } } },
    { ...intro, effects: [null] }, { ...intro, definition_sha256: null }, { ...intro, status: 'disabled' },
    { ...intro, tool: { toString: 'not a function' } },
  ], connectable: [] } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await expect.element(screen.getByText(SETUP_COPY.tools.empty, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('heading', { name: 'What Claude can use' })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Your Desk’s jobs' }).elements()).toHaveLength(0);
  expect(screen.container.querySelector('.cd-app-error')).toBeNull();
});
