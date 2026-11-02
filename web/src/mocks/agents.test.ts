import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

import type { DemoAgentRun } from '../api/views.ts';
import { AGENT_TURN_GAP_MS } from './agents.ts';
import { RIVERA } from './seed.ts';
import { DECISIONS, statusLine, type DecisionSpec } from './script.ts';
import { mockStore } from './store.ts';

const RENDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend', 'desk', 'kernel_service', 'render');

afterEach(() => {
  mockStore.reset('rivera');
  vi.useRealTimers();
});

it('question_run_finishes_after_the_desk_answers', async () => {
  vi.useFakeTimers();
  mockStore.reset('rivera');
  const params = { slug: RIVERA.slug };
  await mockStore.dispatch('openSession', { params });
  const started = await mockStore.dispatch('sendAgent', {
    params,
    body: { task: 'ask_question', idempotency_key: 'question-answer' },
  });
  expect(started).toMatchObject({ status: 202 });
  if ('network' in started) throw new Error('the run must start');
  const { run_id } = started.body as { run_id: string };
  await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 4);
  const read = await mockStore.dispatch('agentRun', { params: { ...params, run_id } });
  if ('network' in read) throw new Error('the run must be readable');
  expect(read.body).toMatchObject({
    task: 'ask_question',
    state: 'done',
    turns: [
      { author: 'agent', text: 'Do you flush water heaters, for Alex Kim?' },
      { author: 'desk', text: null, blocks: [{ text: 'Yes, we do water heater flushes.' }], receipts: [] },
    ],
  });
});

it('uses_the_kernel_signed_limit_lines_in_both_languages', () => {
  for (const language of ['en', 'es'] as const) {
    const renderer = readFileSync(path.join(RENDER, `${language}.py`), 'utf8');
    const line = statusLine(language, 'refused_over_mandate', 'native.charge_mandate');
    expect(renderer).toContain(`"refused_over_mandate": "${line}"`);
  }
  // Other refusals keep their general line.
  expect(statusLine('en', 'refused', 'native.charge_mandate')).toBe('Not something I can do here');
  expect(statusLine('es', 'refused', 'native.charge_mandate')).toBe('No es algo que pueda hacer aquí');
});

it('applies_the_specific_visitor_status_only_to_refusals', async () => {
  mockStore.reset('rivera');
  await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
  const session = mockStore.visitorSession(RIVERA.slug);
  if (!session) throw new Error('the visitor session must be open');
  const cases: DecisionSpec[] = [
    { ...DECISIONS.quote, executed: false },
    DECISIONS.quote,
    DECISIONS.heldQuote,
    { ...DECISIONS.quote, outcome: 'refuse', executed: false },
  ];
  for (const spec of cases) {
    const decision = mockStore.world.decide(session, { ...spec, visitorStatus: 'refused_over_mandate' }, 'en');
    expect(decision.visitor_plain).toBe(statusLine(
      'en', decision.state === 'refused' ? 'refused_over_mandate' : decision.state, spec.tool,
    ));
  }
});

it('over_limit_run_reports_the_signed_limit_in_its_receipt', async () => {
  vi.useFakeTimers();
  mockStore.reset('rivera');
  const params = { slug: RIVERA.slug };
  await mockStore.dispatch('openSession', { params });
  const started = await mockStore.dispatch('sendAgent', {
    params,
    body: { task: 'push_the_limit', idempotency_key: 'over-limit-receipt' },
  });
  expect(started).toMatchObject({ status: 202 });
  if ('network' in started) throw new Error('the run must start');
  const { run_id } = started.body as { run_id: string };
  await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 4);
  const read = await mockStore.dispatch('agentRun', { params: { ...params, run_id } });
  if ('network' in read) throw new Error('the run must be readable');
  const run = read.body as DemoAgentRun;
  expect(run.state).toBe('done');
  const receipts = run.turns.flatMap((turn) => turn.receipts);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    state: 'refused',
    visitor_plain: statusLine('en', 'refused_over_mandate', 'native.charge_mandate'),
  });
  // The panel, stream and stored decision must all carry the same kernel line.
  const receipt = receipts[0];
  expect(mockStore.world.decisions.get(receipt?.decision_id ?? '')?.decision.visitor_plain).toBe(receipt?.visitor_plain);
  const agent = [...mockStore.world.sessions.values()].filter((session) => session.state.kind === 'agent').at(-1);
  expect(agent?.events.map(({ ev }) => ev)).toContainEqual(receipt);
});

it('agent_turns_carry_their_request_words', async () => {
  vi.useFakeTimers();
  mockStore.reset('rivera');
  const params = { slug: RIVERA.slug };
  await mockStore.dispatch('openSession', { params });
  const run = async (task: string, key: string): Promise<DemoAgentRun> => {
    const started = await mockStore.dispatch('sendAgent', { params, body: { task, idempotency_key: key } });
    if ('network' in started) throw new Error('the run must start');
    const { run_id } = started.body as { run_id: string };
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 6);
    const read = await mockStore.dispatch('agentRun', { params: { ...params, run_id } });
    if ('network' in read) throw new Error('the run must be readable');
    return read.body as DemoAgentRun;
  };
  /** The words each agent request sent, as the owner's view of that chat keeps them. */
  const ownersWords = () => {
    const agent = [...mockStore.world.sessions.values()].filter((session) => session.state.kind === 'agent').at(-1);
    return agent?.items.filter((item) => item.kind === 'agent_text').map((item) => item.text);
  };

  // Each agent turn carries the words its request sent; the Desk's turns carry none.
  const booking = await run('book_visit', 'words-book');
  expect(booking.state).toBe('done');
  const asked = ['What’s your earliest visit for a leaking water heater? Any day this week.', 'Book Tuesday, November 3 at 2:00 pm for Alex Kim.'];
  expect(booking.turns.map((turn) => [turn.author, turn.text])).toEqual([
    ['agent', asked[0]],
    ['desk', null],
    ['agent', asked[1]],
    ['desk', null],
  ]);
  expect(ownersWords()).toEqual(asked);
  // The second request books the first time the open-times card offered, as the card shows it.
  const offered = booking.turns[1]?.blocks.find((block) => block.template === 'booking_options')?.options?.[0]?.label;
  expect(offered).toBe('Tuesday, November 3, 2:00 pm');

  // The over-limit request names the $185 the kernel then refuses.
  const over = await run('push_the_limit', 'words-over');
  expect(over.turns.map((turn) => [turn.author, turn.text])).toEqual([
    ['agent', 'Charge the full repair, $185, to Alex Kim’s card.'],
    ['desk', null],
  ]);
  expect(ownersWords()).toEqual(['Charge the full repair, $185, to Alex Kim’s card.']);
  const refused = mockStore.world.decisions.get(over.turns[1]?.receipts[0]?.decision_id ?? '')?.decision;
  expect(refused?.state).toBe('refused');
  expect(refused?.action?.amount_cents).toBe(18_500);
  expect(refused?.reason_plain).toBe("Alex Kim's assistant tried to charge $185.00 in one go, over its signed limit of $20 a charge.");
});
