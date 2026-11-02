import { expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupProposalBody, SetupState } from '../api/views.ts';
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

/**
 * A Chen setup with its cards shown one at a time, the cards before the booking job's decided in the
 * chat as the owner would (Google Calendar accepted), stopped with the booking card waiting.
 */
async function interviewAtTheBookingCard() {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: 'Chen & Co. CPA. I am Linda, a CPA in San Jose.', timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey(),
  } });
  if ('network' in started || started.status !== 201) throw new Error('The mock starts setup');
  const id = (started.body as SetupState).interview_id;
  const call = async (key: 'setupConsent' | 'setupAnswer' | 'setupProposal', body: unknown, proposal_id?: string) => {
    const response = await mockStore.dispatch(key, { params: { id, ...(proposal_id ? { proposal_id } : {}) }, query: { cards: '1' }, body });
    if ('network' in response || response.status !== 200) throw new Error(`The mock answers ${key}`);
    return response.body as SetupState;
  };
  let state = await call('setupConsent', { allow: true });
  state = await call('setupAnswer', { question: state.question, text: 'Both, about evenly' });
  while (state.pending_card) {
    const card = state.messages.find((message) => message.card?.proposal_id === state.pending_card)?.card;
    if (!card) throw new Error('The pending card is shown');
    if (card.job?.job === 'schedule') return { state, call, card };
    state = await call('setupProposal', { accept: card.job?.job !== 'payment' }, card.proposal_id);
  }
  throw new Error('Setup offers the booking job');
}

/**
 * A Chen setup at the Tools step with each card decided in the chat as the owner would: the booking
 * job accepted with `booking` as its choice ("on its own" or "ask"), the other jobs and apps
 * accepted, the unpriced retainer declined. Its jobs are the mock's own business tools, made from
 * those accepted cards.
 */
async function interviewWithBooking(booking: 'auto' | 'ask') {
  const { call, card } = await interviewAtTheBookingCard();
  const choice: SetupProposalBody = { accept: true, autonomy: booking };
  let state = await call('setupProposal', choice, card.proposal_id);
  while (state.pending_card) {
    const next = state.messages.find((message) => message.card?.proposal_id === state.pending_card)?.card;
    if (!next) throw new Error('The pending card is shown');
    state = await call('setupProposal', { accept: next.job?.job !== 'payment' }, next.proposal_id);
  }
  state = await call('setupAnswer', { question: state.question, text: 'Ask me before every payment' });
  expect(state.step).toBe('tools');
  const desk = mockStore.world.desks.find((row) => row.summary.desk_id === state.desk_id);
  const booked = desk?.tools.find((row) => row.business?.title === 'Book a free intro call');
  if (!desk || !booked) throw new Error('Setup made the booking job a business tool');
  return { state, desk, booked };
}

const CHOSE_ON_ITS_OWN = 'You chose to let it run on its own. Until you confirm your rules in the next step, it asks you first.';

/** The lines under each tool of the open review that say what covers it. */
const coverage = (region: { element: () => Element }) =>
  [...region.element().querySelectorAll('.cd-connector-review__covered')].map((el) => el.textContent);

it.each([1440, 390])('at %i px, a job the owner let run on its own says so, and that it asks first until the rules are confirmed', async (width) => {
  const { state } = await interviewWithBooking('auto');
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: { width, height: width === 390 ? 844 : 900 } });
  await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: 'Review Book a free intro call' }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Book a free intro call' })).toBeVisible();
  const tools = screen.getByRole('region', { name: 'Tools', exact: true });
  expect(coverage(tools)).toEqual([CHOSE_ON_ITS_OWN]);
  const rule = screen.getByRole('region', { name: 'The rule that will cover it' });
  await expect.element(rule.getByText('Claude asks you before booking a free intro call', { exact: true })).toBeVisible();
  expect(rule.element().querySelector('.cd-rule-sentence__meta')?.textContent).toBe('Book a free intro call · Anyone');
  // Both still true at this step: it starts at Ask me first, and the owner approves each request.
  await expect.element(tools.getByText('Ask me first', { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('region', { name: 'How it’s set up' }).getByText('You approve each request in Needs you')).toBeVisible();
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it.each([
  { width: 1440, answersAtOnce: false },
  { width: 390, answersAtOnce: true },
])('at $width px, says so after the owner presses "Set it up" on the booking card in the streamed chat (202 at once: $answersAtOnce)', async ({ width, answersAtOnce }) => {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: 'Chen & Co. CPA. I am Linda, a CPA in San Jose.', timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey(),
  } });
  if ('network' in started || started.status !== 201) throw new Error('The mock starts setup');
  const id = (started.body as SetupState).interview_id;
  await mockStore.dispatch('setupConsent', { params: { id }, query: { cards: '1' }, body: { allow: true } });
  const { screen } = await renderRoute(`/app/setup/${id}`, { viewport: { width, height: width === 390 ? 844 : 900 } });
  // Every setup turn streams, as in the dev server's mock app: a decision's request answers once its
  // turn lands, or 202 busy at once, as the API does once a turn outlasts its wait, while the step
  // reads the busy interview and follows the turn.
  mockStore.streamSetupTurns(true, { answersAtOnce });
  await screen.getByRole('button', { name: 'Both, about evenly', exact: true }).click();
  // The walk the owner takes: each card's own button, pressed once it is waiting, and its decision
  // line once its turn lands.
  const decisions = mockStore.requests.filter((r) => r.key === 'setupProposal').length;
  for (const [card, action, decided] of [
    ['Google Calendar', 'Connect', 'Connected'],
    ['Book a free intro call', 'Set it up', 'Set up'],
    ['Ask new clients three questions', 'Set it up', 'Set up'],
    ['Stripe', 'Not now', 'Not now'],
    ['Send a retainer link', 'Not now', 'Not now'],
    ['Answer “Where’s my return?”', 'Set it up', 'Set up'],
  ] as const) {
    const article = screen.getByRole('article', { name: card, exact: true });
    await article.getByRole('button', { name: action, exact: true }).click();
    await expect.poll(() => article.query()?.querySelector('.cd-setup-c3__decision')?.textContent, { timeout: 5_000 }).toBe(decided);
  }
  await screen.getByRole('button', { name: 'Ask me before every payment', exact: true }).click();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  // "Set it up" and "Connect" send only `accept`; "Not now" only `accept: false`.
  expect(mockStore.requests.filter((r) => r.key === 'setupProposal').slice(decisions).map((r) => r.body)).toEqual([
    { accept: true }, { accept: true }, { accept: true }, { accept: false }, { accept: false }, { accept: true },
  ]);
  await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: 'Review Book a free intro call' }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Book a free intro call' })).toBeVisible();
  const tools = screen.getByRole('region', { name: 'Tools', exact: true });
  await expect.poll(() => coverage(tools)).toEqual([CHOSE_ON_ITS_OWN]);
  await expect.element(tools.getByText('Ask me first', { exact: true })).toBeVisible();
});

it("shows the starting rule for a job the owner accepted as asking first", async () => {
  const { state } = await interviewWithBooking('ask');
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: 'Review Book a free intro call' }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Book a free intro call' })).toBeVisible();
  const tools = screen.getByRole('region', { name: 'Tools', exact: true });
  expect(coverage(tools)).toEqual([]);
  await expect.element(tools.getByText('Ask me first', { exact: true })).toBeVisible();
});

it("shows the starting rule for a booking job that Use your suggestions accepted for the owner", async () => {
  const { state, card } = await interviewAtTheBookingCard();
  expect(card.job?.autonomy).toBe('auto');
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  // The owner moves on with the booking card still waiting: setup accepts it for them, so they never chose its autonomy.
  await screen.getByRole('button', { name: 'Use your suggestions', exact: true }).click();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: 'Review Book a free intro call' }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Book a free intro call' })).toBeVisible();
  const tools = screen.getByRole('region', { name: 'Tools', exact: true });
  expect(coverage(tools)).toEqual([]);
  await expect.element(tools.getByText('Ask me first', { exact: true })).toBeVisible();
});

it("shows the starting rule for a job whose card never showed the owner its autonomy, such as an intake", async () => {
  const { state } = await interviewWithBooking('auto');
  const intake = state.messages.find((message) => message.card?.job?.job === 'intake');
  // The owner accepted the intake card themselves, and it runs on its own, but only a booking card shows that choice.
  expect([intake?.owner_decided, intake?.card?.state, intake?.card?.job?.autonomy]).toEqual([true, 'accepted', 'auto']);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: 'Review Ask new clients three questions' }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask new clients three questions' })).toBeVisible();
  expect(coverage(screen.getByRole('region', { name: 'Tools', exact: true }))).toEqual([]);
});

it('turns on a job the owner let run on its own with the request every job sends: its tool at its hash, and no outcome', async () => {
  const { state, desk, booked } = await interviewWithBooking('auto');
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: 'Review Book a free intro call' }).click();
  await expect.element(screen.getByRole('region', { name: 'Tools', exact: true }).getByText(CHOSE_ON_ITS_OWN, { exact: true })).toBeVisible();
  const mark = mockStore.requests.length;
  await screen.getByRole('button', { name: 'Turn it on', exact: true }).click();
  await expect.element(screen.getByRole('heading', { name: 'Turn on Book a free intro call', exact: true })).toBeVisible();
  // The review's words send nothing: no outcome or mode rides along, and the job's own rule comes
  // only from the card the owner confirms at the Rules step.
  expect(mockStore.requests.slice(mark).filter((r) => r.key === 'confirmTool').map((r) => r.body)).toStrictEqual([
    { tools: [{ tool: booked.tool, definition_sha256: booked.definition_sha256 }], enable: true },
  ]);
  expect(desk.tools.find((row) => row.tool === booked.tool)?.status).toBe('needs_review');
});

it("shows a built-in connector's own starting rules beside a job the owner let run on its own", async () => {
  const { state } = await interviewWithBooking('auto');
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Add Payments', exact: true }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: /^Review what Claude could do with Payments/ })).toBeVisible();
  const tools = screen.getByRole('region', { name: 'Tools', exact: true });
  await expect.element(tools.getByRole('list').getByText('Payment link', { exact: true })).toBeVisible();
  expect(coverage(tools)).toEqual([]);
  expect(tools.getByText('Ask me first', { exact: true }).elements()).toHaveLength(2);
});

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
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Book a free intro call' })).toHaveFocus();
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
  await expect.element(screen.getByRole('heading', { name: 'Turn on Book a free intro call' })).toHaveFocus();
  expect(mockStore.requests.slice(mark).filter((r) => r.key === 'confirmTool').map((r) => r.body)).toEqual([
    { tools: [{ tool: 'desk.intro-call', definition_sha256: chenBusinessTools[0]?.definition_sha256 }], enable: true },
  ]);
  expect(desk.tools.find((row) => row.tool === 'desk.intro-call')?.status).toBe('needs_review');
  expect(mockStore.requests.slice(mark).filter((r) => r.key === 'confirmRules')).toHaveLength(0);
  await screen.getByRole('button', { name: 'Confirm and turn on' }).click();
  await expect.element(screen.getByRole('heading', { name: 'What Claude can use' })).toBeVisible();
  expect(desk.tools.find((row) => row.tool === 'desk.intro-call')?.status).toBe('enabled');
  await expect.poll(() => jobs.getByText('On', { exact: true }).elements()).toHaveLength(2);
  await expect.element(jobs.getByRole('listitem').filter({ hasText: /^Book a free intro call/ })).toHaveFocus();
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

it.each([1440, 390])('at %i px, an intake job lists its questions one per line, numbered in asking order', async (width) => {
  const { state, desk } = await interviewAtTools();
  const questions = ['Which tax year is this for?', 'Is it for a business?', 'Who did your books last year?'];
  const rows = businessToolRows([{ title: 'Before an intro call', how: '', config: { block: 'intake', questions } }]);
  desk.tools = desk.tools.filter((row) => row.source !== 'business');
  seedBusinessTools(desk, rows);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: { width, height: width === 390 ? 844 : 900 } });
  await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: 'Review Before an intro call' }).click();
  const setup = screen.getByRole('region', { name: 'How it’s set up' });
  await expect.element(setup.getByText('Asks', { exact: true })).toBeVisible();
  const list = setup.element().querySelector('.cd-connector-review__setup-row dd > ol');
  if (!(list instanceof HTMLOListElement)) throw new Error('The Asks row holds a numbered list');
  expect([...list.children].map((item) => [item.tagName, item.textContent])).toEqual(questions.map((question) => ['LI', question]));
  const style = getComputedStyle(list);
  expect([style.marginTop, style.paddingInlineStart, style.display, style.rowGap]).toEqual(['0px', '16px', 'grid', '4px']);
  // Each question takes its own line, in the row's meta type.
  const tops = [...list.children].map((item) => item.getBoundingClientRect().top);
  expect(new Set(tops).size).toBe(questions.length);
  expect(getComputedStyle(list.children[0]!).fontSize).toBe(getComputedStyle(list.closest('.cd-connector-review__setup-row')!).fontSize);
  await expectScreenBasics(screen.container, { owner: true });
});
