import { expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { businessToolRows, chenBusinessTools, seedBusinessTools } from '../mocks/businessTools.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { BUSINESS_OWNER_LINES } from '../owner/connectors/businessWords.ts';
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
  // Finishing the run turns its accepted jobs into business tools; these tests start from the
  // signed board's fixture jobs instead.
  desk.tools = desk.tools.filter((row) => row.source !== 'business');
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
  await expect.element(screen.getByText(BUSINESS_OWNER_LINES.typed_booking, { exact: false })).toBeVisible();
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
    null, { ...intro, business: null }, { ...intro, business: { ...intro.business, title: null } },
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

it('lists only on and not-on jobs, excluding changed definitions, delisted jobs and turned-off jobs', async () => {
  const { state, desk } = await interviewAtTools();
  const intro = chenBusinessTools[0];
  if (!intro?.business) throw new Error('The fixture has an intro call definition');
  seedBusinessTools(desk, [
    {
      ...intro, tool: 'desk.changed-intro', review_reason: 'changed',
      pending_sha256: 'c'.repeat(64), pending_definition_text: 'Updated intro call definition.',
      business: { ...intro.business, title: 'Changed intro call' },
    },
    { ...intro, tool: 'desk.delisted-intro', review_reason: 'delisted', business: { ...intro.business, title: 'Delisted intro call' } },
    { ...intro, tool: 'desk.off-intro', status: 'disabled', review_reason: null, business: { ...intro.business, title: 'Turned-off intro call' } },
  ]);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
  await expect.element(jobs).toBeVisible();
  expect([...jobs.element().querySelectorAll('.cd-connector-summary__name')].map((el) => el.textContent)).toEqual([
    'Book a free intro call', 'New client intake',
  ]);
  await expect.element(jobs.getByRole('button', { name: 'Review Book a free intro call' })).toBeVisible();
  await expect.element(jobs.getByText('On', { exact: true })).toBeVisible();
  for (const title of ['Changed intro call', 'Delisted intro call', 'Turned-off intro call']) {
    expect(jobs.getByText(title, { exact: true }).elements()).toHaveLength(0);
    expect(jobs.getByRole('button', { name: `Review ${title}` }).elements()).toHaveLength(0);
  }
});

it('reviews all four blocks with owner lines through mock building and turn-on, including empty descriptions and zero-dollar payments', async () => {
  const { state, desk } = await interviewAtTools();
  const rows = businessToolRows([
    { title: 'Book a free intro call', how: '', config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 } },
    { title: 'Take a deposit', how: 'Sends a deposit link.', config: { block: 'purpose_payment', purpose: 'Consultation', amount_cents: 0 } },
    { title: 'Intake', how: '', config: { block: 'intake', questions: ['Which year?'] } },
    { title: 'Urgent request', how: '', config: { block: 'urgent', urgent_when: 'A deadline is today' } },
  ]);
  expect(rows).toHaveLength(4);
  desk.tools = desk.tools.filter((row) => row.source !== 'business');
  seedBusinessTools(desk, rows);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
  await expect.element(jobs).toBeVisible();
  await expect.element(jobs.getByText('Consultation, $0', { exact: true })).toBeVisible();
  for (const [index, row] of rows.entries()) {
    if (!row.business) throw new Error('The mock row carries its business definition');
    const title = row.business.title;
    await jobs.getByRole('button', { name: `Review ${title}` }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    const tools = screen.getByRole('region', { name: 'Tools', exact: true });
    await expect.element(tools.getByText(BUSINESS_OWNER_LINES[row.business.config.block], { exact: false })).toBeVisible();
    expect(tools.element().textContent).not.toContain(row.description_confirmed);
    expect(screen.getByText('A connected tool', { exact: true }).elements()).toHaveLength(0);
    if (row.business.config.block === 'purpose_payment') {
      await expect.element(screen.getByRole('region', { name: 'How it’s set up' }).getByText('$0', { exact: true })).toBeVisible();
    }
    const mark = mockStore.requests.length;
    await screen.getByRole('button', { name: 'Turn it on', exact: true }).click();
    await expect.element(screen.getByRole('heading', { name: `Turn on ${title}`, exact: true })).toBeVisible();
    expect(mockStore.requests.slice(mark).filter((request) => request.key === 'confirmTool').map((request) => request.body)).toEqual([
      { tools: [{ tool: row.tool, definition_sha256: row.definition_sha256 }], enable: true },
    ]);
    expect(desk.tools.find((tool) => tool.tool === row.tool)?.status).toBe('needs_review');
    await screen.getByRole('button', { name: 'Confirm and turn on', exact: true }).click();
    await expect.poll(() => jobs.getByText('On', { exact: true }).elements()).toHaveLength(index + 1);
    expect(desk.tools.find((tool) => tool.tool === row.tool)?.status).toBe('enabled');
  }
});

it('keeps an empty kernel-valid title accessible with the existing tool-name fallback', async () => {
  const { state, desk } = await interviewAtTools();
  const rows = businessToolRows([{ title: '', how: '', config: { block: 'typed_booking', appointment_type: '', minutes: 15 } }]);
  expect(rows).toHaveLength(1);
  desk.tools = desk.tools.filter((row) => row.source !== 'business');
  seedBusinessTools(desk, rows);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
  await expect.element(jobs).toBeVisible();
  expect(jobs.element().querySelector('.cd-connector-summary__name')?.textContent).toBe('A connected tool');
  await jobs.getByRole('button', { name: 'Review A connected tool' }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'A connected tool', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('region', { name: 'Tools', exact: true }).getByText(BUSINESS_OWNER_LINES.typed_booking, { exact: false })).toBeVisible();
  expect(screen.getByRole('region', { name: 'How it’s set up' }).getByText('Appointment', { exact: true }).elements()).toHaveLength(0);
  await expectScreenBasics(screen.container, { owner: true });
  await screen.getByRole('button', { name: 'Turn it on', exact: true }).click();
  await expect.element(screen.getByRole('heading', { name: 'Turn on A connected tool', exact: true })).toBeVisible();
});
