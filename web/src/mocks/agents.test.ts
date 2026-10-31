import { afterEach, expect, it, vi } from 'vitest';

import type { DemoAgentRun } from '../api/views.ts';
import { AGENT_TURN_GAP_MS } from './agents.ts';
import { RIVERA } from './seed.ts';
import { statusLine } from './script.ts';
import { mockStore } from './store.ts';

afterEach(() => {
  mockStore.reset('rivera');
  vi.useRealTimers();
});

it('uses_the_kernel_signed_limit_lines_in_both_languages', () => {
  // kernel_service/render/{en,es}.py STATUS['refused_over_mandate'], word for word.
  expect(statusLine('en', 'refused_over_mandate', 'native.charge_mandate')).toBe('Refused: over the signed limit for this agent');
  expect(statusLine('es', 'refused_over_mandate', 'native.charge_mandate')).toBe('Rechazado: supera el límite firmado para este agente');
  // Other refusals keep their general line.
  expect(statusLine('en', 'refused', 'native.charge_mandate')).toBe('Not something I can do here');
  expect(statusLine('es', 'refused', 'native.charge_mandate')).toBe('No es algo que pueda hacer aquí');
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
    visitor_plain: 'Refused: over the signed limit for this agent',
  });
  // The panel, stream and stored decision must all carry the same kernel line.
  const receipt = receipts[0];
  expect(mockStore.world.decisions.get(receipt?.decision_id ?? '')?.decision.visitor_plain).toBe(receipt?.visitor_plain);
  const agent = [...mockStore.world.sessions.values()].filter((session) => session.state.kind === 'agent').at(-1);
  expect(agent?.events.map(({ ev }) => ev)).toContainEqual(receipt);
});
