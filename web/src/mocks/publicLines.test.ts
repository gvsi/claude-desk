import { beforeEach, expect, it } from 'vitest';

import type { PublicLines, SetupState } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { SETUP_QUESTIONS } from './setup.ts';
import { mockStore } from './store.ts';

beforeEach(() => mockStore.reset('rivera'));

async function atRules() {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: START_EXAMPLES.en.examples[3]!.description,
    timezone: 'America/Los_Angeles', idempotency_key: 'public-lines',
  } });
  if ('network' in started) throw new Error('start failed');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: false } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text: 'Ask me first.' } });
  }
  await mockStore.dispatch('setupRules', { params });
  return params;
}

it('reads the seven public lines in order without moving the interview', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  expect(read.status).toBe(200);
  const lines = (read.body as PublicLines).lines;
  expect(lines.map((line) => line.key)).toEqual([
    'policy:about', 'policy:pricing', 'policy:intake', 'policy:after_hours',
    'policy:urgent', 'policy:service_area', 'policy:how_we_help',
  ]);
  expect(lines.at(-1)).toMatchObject({ editable: false });
  expect(lines.at(-1)?.text.split('\n')).toHaveLength(3);
  expect(await mockStore.dispatch('setup', { params })).toMatchObject({ body: { step: 'rules' } });
});

it('updates one editable line and refuses unsafe, read-only or invalid edits without changing it', async () => {
  const params = await atRules();
  const key = 'policy:after_hours';
  const text = 'Leave a message for Linda.';
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({
    status: 200, body: { lines: expect.arrayContaining([{ key, text, source: 'owner', editable: true }]) },
  });
  for (const refused of ['$20', '10%', '9am', '9:30', '9 to 6', 'guarantee', 'promise', 'always', 'never']) {
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: refused } })).toMatchObject({
      status: 422, body: { error: 'line_refused', key, reason: expect.any(String) },
    });
  }
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:how_we_help', text } })).toMatchObject({
    status: 422, body: { error: 'not_editable', key: 'policy:how_we_help' },
  });
  for (const invalid of ['', ' '.repeat(5), 'x'.repeat(501), null, 4]) {
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: invalid } })).toMatchObject({ status: 422 });
  }
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:unknown', text } })).toMatchObject({ status: 422 });
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: 'x'.repeat(500) } })).toMatchObject({ status: 200 });
  const read = await mockStore.dispatch('setupPublicLines', { params });
  expect(read).toMatchObject({ body: { lines: expect.arrayContaining([{ key, text: 'x'.repeat(500), source: 'owner', editable: true }]) } });
});

it('confirms all editable lines, rescans seeded answers and leaves the interview at rules', async () => {
  const params = await atRules();
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} });
  expect(confirmed).toMatchObject({ status: 200, body: { lines: expect.any(Array) } });
  expect(await mockStore.dispatch('setup', { params })).toMatchObject({ body: { step: 'rules' } });
  mockStore.reset('rivera');
  const started = await mockStore.dispatch('startSetup', { body: {
    description: 'We run Chen & Co. We always help.', timezone: 'UTC', idempotency_key: 'unsafe-seed',
  } });
  if ('network' in started) throw new Error('start failed');
  const unsafe = { id: (started.body as SetupState).interview_id };
  await mockStore.dispatch('setupConsent', { params: unsafe, body: { allow: false } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', { params: unsafe, body: { question: question.key, text: 'Ask first.' } });
  }
  await mockStore.dispatch('setupRules', { params: unsafe });
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params: unsafe, body: {} })).toMatchObject({
    status: 422, body: { error: 'line_refused', key: 'policy:about', reason: expect.any(String) },
  });
});

it('shows saved and confirmed lines in the public charter for their claims', async () => {
  const params = await atRules();
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup read failed');
  const { slug } = setup.body as SetupState;
  for (const [key, text] of [
    ['policy:about', 'We help local businesses.'],
    ['policy:pricing', 'Ask Linda for a quote.'],
  ]) {
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({ status: 200 });
  }
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} });
  if ('network' in confirmed) throw new Error('confirm failed');
  expect(confirmed.status).toBe(200);
  expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject({
    status: 200,
    body: {
      charter: (confirmed.body as PublicLines).lines.map(({ key, text }) => expect.objectContaining({
        fact_id: `charter:${key}`, title: text,
      })),
    },
  });
});

it('guards all three routes by owner, interview and stage, and isolates saved lines', async () => {
  const params = await atRules();
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:about', text: 'Changed.' } })).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({
    status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key: 'policy:about', text: 'Changed.' })]) },
  });
  const calls = [
    { key: 'setupPublicLines', body: undefined },
    { key: 'setupPublicLine', body: { key: 'policy:about', text: 'Changed.' } },
    { key: 'setupPublicLinesConfirm', body: {} },
  ] as const;
  for (const call of calls) {
    expect(await mockStore.dispatch(call.key, { params: { id: 'missing' }, body: call.body })).toMatchObject({ status: 404 });
  }
  await mockStore.dispatch('setupSafetyCheck', { params });
  for (const call of calls) expect(await mockStore.dispatch(call.key, { params, body: call.body })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  mockStore.reset('rivera', { signedIn: false });
  for (const call of calls) expect(await mockStore.dispatch(call.key, { params, body: call.body })).toMatchObject({ status: 401 });
  mockStore.reset('rivera');
  const fresh = await atRules();
  expect(await mockStore.dispatch('setupPublicLines', { params: fresh })).toMatchObject({
    status: 200, body: { lines: expect.not.arrayContaining([expect.objectContaining({ text: 'Changed.' })]) },
  });
});

it('refuses dollar amounts written as cents or with a sign', async () => {
  const params = await atRules();
  for (const text of ['From $.50', 'From $-20', 'From $+20']) {
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:pricing', text } })).toMatchObject({
      status: 422, body: { error: 'line_refused', key: 'policy:pricing' },
    });
  }
});
