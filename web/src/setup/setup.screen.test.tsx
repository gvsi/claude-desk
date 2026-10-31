/**
 * Setup in a real browser against the mock API: from the business's description to its live link.
 * The questions, the tools and their review, the rules with the payment limit in its signed words,
 * real situations, the safety check, the confirm with Answering still off, the owner's preview and
 * going live. Nothing turns on, goes live or reads "On" before its confirming request succeeds.
 */
import { describe, expect, it } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { RouteKey } from '../api/routes.ts';
import type { SetupState } from '../api/views.ts';
import { MEMORY_LABEL, SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import type { DeskRecord } from '../mocks/world.ts';
import { renderRoute } from '../test/renderRoute.tsx';

const DESCRIPTION =
  "Rivera Plumbing. I'm Maria, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters for homes and small shops. Weekdays mostly, emergencies on Saturday mornings.";

/** The requests a route got, by key, from the `from`th request on. */
const requests = (key: RouteKey, from = 0) => mockStore.requests.slice(from).filter((r) => r.key === key);

/** A new interview in the mock, made the way the start page makes one; with consent given unless `consent` is false. */
async function startInterview(consent: boolean | null = true): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: { description: DESCRIPTION, timezone: 'America/Los_Angeles' } });
  if ('network' in started || started.status !== 200) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  if (consent !== null) await mockStore.dispatch('setupConsent', { params: { id: state.interview_id }, body: { allow: consent } });
  return state;
}

/** An interview whose questions are all answered, at the tools step; the money limit answered as $500. */
async function interviewAtTools(): Promise<SetupState> {
  const state = await startInterview();
  const id = state.interview_id;
  for (const question of SETUP_QUESTIONS) {
    const text = question.key === 'money_limit' ? '$500 is fine. Anything bigger, ask me.' : 'Yes, that works.';
    await mockStore.dispatch('setupAnswer', { params: { id }, body: { text } });
  }
  return state;
}

/** The mock's Desk for an interview. */
function deskOf(state: SetupState): DeskRecord {
  const desk = mockStore.world.desk(state.desk_id);
  if (!desk) throw new Error('the mock made the setup Desk');
  return desk;
}

/** Each tool's status in the mock, by name. */
const statuses = (state: SetupState, tools: readonly string[]) => tools.map((tool) => deskOf(state).tools.find((t) => t.tool === tool)?.status);

/** A row of the tools list, by its connector's name. */
const connectorRow = (screen: RenderResult, name: string) => screen.getByRole('listitem').filter({ hasText: new RegExp(`^${name}`) });

const FAILED_LINE = "I couldn't answer just now. Your answer is still here; try again.";

/** Whether `el` is set in Claude's serif. */
const inSerif = (el: Element) => /Source Serif 4/.test(getComputedStyle(el).fontFamily);

describe('setup', () => {
  it('start_then_consent_then_questions', async () => {
    const { screen, router } = await renderRoute('/app/setup');
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Tell me about your business' })).toBeVisible();
    await screen.getByRole('textbox', { name: 'Your business' }).fill(DESCRIPTION);
    await screen.getByRole('button', { name: 'Start' }).click();

    // The description and the browser's own time zone, once.
    await expect.element(screen.getByRole('button', { name: 'Yes, use it' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: "No, I'll type it" })).toBeVisible();
    expect(requests('startSetup').map((r) => r.body)).toEqual([{ description: DESCRIPTION, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }]);
    const state = [...mockStore.world.desks].reverse()[0];
    expect(state?.summary.answering).toBe(false);
    expect(router.state.location.pathname).toMatch(/^\/app\/setup\/setup-\d+$/);
    // The business's name in the bar once it is known, and Claude's question in its serif.
    await expect.element(screen.getByText('Rivera Plumbing', { exact: true }).first()).toBeVisible();
    const consent = screen.getByText(/^Thanks, Maria\. Before I ask anything/);
    await expect.element(consent).toBeVisible();
    expect(inSerif(consent.element())).toBe(true);
    await expect.element(screen.getByText("About seven. Answer in your own words; I'll turn them into rules you can check.", { exact: true })).toBeVisible();

    await screen.getByRole('button', { name: 'Yes, use it' }).click();
    const first = SETUP_QUESTIONS[0]?.text ?? '';
    await expect.element(screen.getByText(first, { exact: true })).toBeVisible();
    expect(requests('setupConsent').map((r) => r.body)).toEqual([{ allow: true }]);
    await expect.element(screen.getByText(MEMORY_LABEL, { exact: true })).toBeVisible();
    expect(inSerif(screen.getByText(first, { exact: true }).element())).toBe(true);
    await expect.element(screen.getByText('Question 1 of 7', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Yes, use it' }).elements()).toHaveLength(0);
    // The answer the owner gave shows as theirs.
    await expect.element(screen.getByText('Yes, use it', { exact: true })).toBeVisible();
    const setup = (await mockStore.dispatch('setup', { params: { id: router.state.location.pathname.split('/').at(-1) ?? '' } })) as { body: SetupState };
    expect(setup.body.consent).toBe(true);
  });

  it('answer_failure_keeps_the_answer', async () => {
    const { interview_id: id } = await startInterview();
    const { screen } = await renderRoute(`/app/setup/${id}`);
    const box = screen.getByRole('textbox', { name: 'Your answer' });
    const answer = 'Leaks, drains and water heaters, around Oakland.';
    await box.fill(answer);
    mockStore.inject({ route: 'setupAnswer', status: 429 });
    await screen.getByRole('button', { name: 'Send' }).click();

    // The line says so, the words are back where the owner wrote them, and nothing moved on.
    await expect.element(screen.getByText(FAILED_LINE, { exact: true })).toBeVisible();
    await expect.element(box).toHaveValue(answer);
    await expect.element(screen.getByText('Question 1 of 7', { exact: true })).toBeVisible();

    await screen.getByRole('button', { name: 'Try again' }).click();
    await expect.element(screen.getByText(`Got it. ${SETUP_QUESTIONS[1]?.text ?? ''}`, { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Question 2 of 7', { exact: true })).toBeVisible();
    await expect.element(box).toHaveValue('');
    expect(screen.getByText(FAILED_LINE, { exact: true }).elements()).toHaveLength(0);
    expect(requests('setupAnswer').map((r) => r.body)).toEqual([{ text: answer }, { text: answer }]);

    // An answer whose reply was lost, which the API took: the interview is read again, and the
    // answer isn't called failed or asked for again.
    const reads = requests('setup').length;
    mockStore.inject({ route: 'setupAnswer', status: 'network', afterCommit: true });
    await box.fill('Weekdays 8 to 6.');
    await screen.getByRole('button', { name: 'Send' }).click();
    await expect.element(screen.getByText(`Got it. ${SETUP_QUESTIONS[2]?.text ?? ''}`, { exact: true })).toBeVisible();
    expect(requests('setup').length).toBeGreaterThan(reads);
    expect(screen.getByText(FAILED_LINE, { exact: true }).elements()).toHaveLength(0);
    await expect.element(box).toHaveValue('');
  });

  it('tool_turns_on_only_after_its_change_is_confirmed', async () => {
    const state = await interviewAtTools();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
    const mark = mockStore.requests.length;

    // Stripe, the mock payments server, with its Mock badge; connecting it lists its two tools, neither on.
    const stripe = connectorRow(screen, 'Stripe');
    await expect.element(stripe.getByText('Mock', { exact: true })).toBeVisible();
    await screen.getByRole('button', { name: /^(Connect|Add) Stripe$/ }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: /^Review what Claude could do with Stripe/ })).toBeVisible();
    expect(requests('setupConnect', mark).map((r) => r.body)).toEqual([{ server: 'mock_payments' }]);
    const tools = ['payments.list_charges', 'payments.create_refund'];
    expect(statuses(state, tools)).toEqual(['needs_review', 'needs_review']);
    const review = screen.getByRole('region', { name: 'Tools' });
    await expect.element(review.getByText('See charges', { exact: true })).toBeVisible();
    await expect.element(review.getByText('Refund', { exact: true })).toBeVisible();
    expect(review.getByText('Ask me first', { exact: true }).elements()).toHaveLength(2);

    // Connected is not on: back on the list, Stripe doesn't read "On", and opening it again connects nothing more.
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(connectorRow(screen, 'Stripe')).toBeVisible();
    expect(connectorRow(screen, 'Stripe').getByText('On', { exact: true }).elements()).toHaveLength(0);
    await screen.getByRole('button', { name: /^(Connect|Add) Stripe$/ }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: /^Review what Claude could do with Stripe/ })).toBeVisible();
    expect(requests('setupConnect', mark)).toHaveLength(1);

    // One confirm for the connector's tools, each at the hash it was listed at; nothing is on yet.
    await screen.getByRole('button', { name: 'Turn it on' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Turn on Stripe' })).toBeVisible();
    const hashes = tools.map((tool) => deskOf(state).tools.find((t) => t.tool === tool)?.definition_sha256);
    expect(requests('confirmTool', mark).map((r) => r.body)).toEqual([
      { tools: tools.map((tool, i) => ({ tool, definition_sha256: hashes[i] })), enable: true },
    ]);
    expect(statuses(state, tools)).toEqual(['needs_review', 'needs_review']);
    expect(requests('confirmRules', mark)).toHaveLength(0);
    const drafted = [...deskOf(state).drafts.keys()].at(-1);

    // Only the confirmed change turns them on, and the list, read again, says so.
    await screen.getByRole('button', { name: 'Confirm and turn on' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
    expect(requests('confirmRules', mark).map((r) => r.body)).toEqual([{ version: drafted }]);
    expect(statuses(state, tools)).toEqual(['enabled', 'enabled']);
    await expect.element(connectorRow(screen, 'Stripe').getByText('On', { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: /^(Connect|Add) Stripe$/ }).elements()).toHaveLength(0);
    expect(requests('confirmTool', mark)).toHaveLength(1);
  });

  it('built_in_connector_turns_on_only_after_its_change_is_confirmed', async () => {
    const state = await interviewAtTools();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
    const mark = mockStore.requests.length;
    const tools = ['native.payment_link', 'native.charge_mandate'];
    expect(statuses(state, tools)).toEqual(['needs_review', 'needs_review']);

    // A built-in connector has nothing to connect: its review opens at once.
    await screen.getByRole('button', { name: /^(Add|Connect) Payments$/ }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: /^Review what Claude could do with Payments/ })).toBeVisible();
    const review = screen.getByRole('region', { name: 'Tools' });
    await expect.element(review.getByText('Payment link', { exact: true })).toBeVisible();
    await expect.element(review.getByText('Charge within a signed limit', { exact: true })).toBeVisible();
    expect(review.getByText('Ask me first', { exact: true }).elements()).toHaveLength(2);

    // Opening its review turns nothing on: back on the list, Payments doesn't read "On".
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(connectorRow(screen, 'Payments')).toBeVisible();
    expect(connectorRow(screen, 'Payments').getByText('On', { exact: true }).elements()).toHaveLength(0);
    await screen.getByRole('button', { name: /^(Add|Connect) Payments$/ }).click();

    await screen.getByRole('button', { name: 'Turn it on' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Turn on Payments' })).toBeVisible();
    const hashes = tools.map((tool) => deskOf(state).tools.find((t) => t.tool === tool)?.definition_sha256);
    expect(requests('confirmTool', mark).map((r) => r.body)).toEqual([
      { tools: tools.map((tool, i) => ({ tool, definition_sha256: hashes[i] })), enable: true },
    ]);
    expect(requests('setupConnect', mark)).toHaveLength(0);
    expect(statuses(state, tools)).toEqual(['needs_review', 'needs_review']);
    expect(requests('confirmRules', mark)).toHaveLength(0);

    await screen.getByRole('button', { name: 'Confirm and turn on' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
    expect(requests('confirmRules', mark)).toHaveLength(1);
    expect(statuses(state, tools)).toEqual(['enabled', 'enabled']);
    await expect.element(connectorRow(screen, 'Payments').getByText('On', { exact: true })).toBeVisible();
  });
});
