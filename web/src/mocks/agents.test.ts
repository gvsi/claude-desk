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
