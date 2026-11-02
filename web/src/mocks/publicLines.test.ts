import { beforeEach, expect, it } from 'vitest';

import type { PublicDesk } from '../api/contracts.ts';
import type { SetupPublicLines, QuestionKey, SetupState } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { SETUP_QUESTIONS } from './setup.ts';
import { mockStore, MockStore } from './store.ts';
import { publicLineRefused } from './publicLineScan.ts';
import { holdPublicLineOnSeed, storePublicLines, storePublicState } from './publicLineStore.ts';
import { cardChrome } from '../ds/components/ReplyCard/chrome.ts';

beforeEach(() => mockStore.reset('rivera'));

it('validates price deletion query bounds before reading the interview', async () => {
  const params = await atRules();
  const before = await mockStore.dispatch('setupPublicLines', { params });
  const queries = [
    { title: '', unit_cents: '25000' },
    { title: '   ', unit_cents: '25000' },
    { title: 'a'.repeat(81), unit_cents: '25000' },
    { title: 'Tax return review', unit_cents: '-1' },
    { title: 'Tax return review', unit_cents: '2000000' },
  ];
  for (const query of queries) {
    for (const id of [params.id, 'missing']) {
      expect(await mockStore.dispatch('removePublicPrice', { params: { id, item_id: 'tax-return-review' }, query })).toMatchObject({ status: 422, body: { error: 'invalid' } });
    }
    expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(before);
  }
  expect(await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'tax-return-review' }, query: { title: 'a'.repeat(80), unit_cents: '1000000' } })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(before);
});

it('checks price deletion query and current item before rejecting owner prices', async () => {
  const params = await atRules();
  expect(await confirmShown(params)).toMatchObject({ status: 200 });
  const before = await mockStore.dispatch('setupPublicLines', { params });
  const cases: { item_id: string; query: Record<string, string>; status: number; error: string }[] = [
    { item_id: 'missing', query: {}, status: 422, error: 'invalid' },
    { item_id: 'missing', query: { title: 'Tax return review', unit_cents: '25000' }, status: 409, error: 'conflict' },
    { item_id: 'tax-return-review', query: { title: 'Old title', unit_cents: '25000' }, status: 409, error: 'conflict' },
    { item_id: 'tax-return-review', query: { title: 'Tax return review', unit_cents: '1' }, status: 409, error: 'conflict' },
    { item_id: 'tax-return-review', query: { title: 'Tax return review', unit_cents: '25000' }, status: 422, error: 'not_suggested' },
  ];
  for (const { item_id, query, status, error } of cases) {
    expect(await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id }, query })).toMatchObject({ status, body: { error } });
    expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(before);
  }
});

it('refuses unknown and read-only DELETE keys with the API errors', async () => {
  const params = await atRules();
  const before = await mockStore.dispatch('setupPublicLines', { params });
  expect(await mockStore.dispatch('removePublicLine', { params: { ...params, key: 'policy:unknown' } })).toMatchObject({ status: 422, body: { error: 'invalid' } });
  expect(await mockStore.dispatch('removePublicLine', { params: { ...params, key: 'policy:how_we_help' } })).toMatchObject({ status: 422, body: { error: 'not_editable', key: 'policy:how_we_help' } });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(before);
});

it('serializes hours with seconds on public-lines reads and writes', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  expect(read).toMatchObject({ status: 200, body: { hours: { windows: [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '18:00:00' },
  ] } } });
  if ('network' in read) throw new Error('read failed');
  storePublicState(mockStore.world, params.id, { ...(read.body as SetupPublicLines), hours: {
    source: 'suggested', windows: [{ days: ['sat'], start: '09:30', end: '12:00' }],
  } });
  const current = await mockStore.dispatch('setupPublicLines', { params });
  const saved = await mockStore.dispatch('setupPublicLine', { params, body: { key: 'contact', text: 'office@example.com' } });
  const removed = await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'tax-return-review' }, query: { title: 'Tax return review', unit_cents: '25000' } });
  const confirmed = await confirmShown(params);
  for (const response of [current, saved, removed, confirmed]) {
    expect(response).toMatchObject({ status: 200, body: { hours: { windows: [
      { days: ['sat'], start: '09:30:00', end: '12:00:00' },
    ] } } });
  }
});

it('confirms displayed structured keys with the current revision', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const before = read.body as SetupPublicLines;
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {
    keys: [...before.lines.filter((line) => !line.held).map((line) => line.key), 'hours', 'prices'], revision: before.revision,
  } });
  expect(confirmed).toMatchObject({ status: 200, body: { hours: { source: 'owner' }, prices: { source: 'owner' } } });
  if ('network' in confirmed) throw new Error('confirm failed');
  expect((confirmed.body as SetupPublicLines).revision).not.toBe(before.revision);
});

it('changes revision on every suggestion removal and refuses the prior confirm without mutation', async () => {
  const params = await atRules();
  for (const key of ['hours', 'contact', 'prices'] as const) {
    const read = await mockStore.dispatch('setupPublicLines', { params });
    if ('network' in read) throw new Error('read failed');
    const before = read.body as SetupPublicLines;
    const removed = key === 'prices'
      ? await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: before.prices!.items[0]!.item_id }, query: {
        title: before.prices!.items[0]!.title, unit_cents: String(before.prices!.items[0]!.unit_cents),
      } })
      : await mockStore.dispatch('removePublicLine', { params: { ...params, key } });
    expect(removed).toMatchObject({ status: 200 });
    if ('network' in removed) throw new Error('remove failed');
    expect((removed.body as SetupPublicLines).revision).not.toBe(before.revision);
    const latest = await mockStore.dispatch('setupPublicLines', { params });
    expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {
      keys: [...before.lines.map((line) => line.key), ...(before.hours ? ['hours'] : []), ...(before.prices ? ['prices'] : [])], revision: before.revision,
    } })).toMatchObject(key === 'prices'
      ? { status: 409, body: { error: 'conflict' } }
      : { status: 422, body: { error: 'invalid' } });
    expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(latest);
  }
});

it('guards recomputed duplicate-title ids against stale displayed prices', async () => {
  const params = await atRules();
  const response = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in response) throw new Error('read failed');
  const data = response.body as SetupPublicLines;
  storePublicState(mockStore.world, params.id, { ...data, prices: { source: 'suggested', items: [
    { item_id: 'review', title: 'Review', unit_cents: 25000 },
    { item_id: 'review-2', title: 'Review', unit_cents: 60000 },
    { item_id: 'review-3', title: 'Review', unit_cents: 15000 },
  ] } });
  expect(await mockStore.dispatch('removePublicPrice', {
    params: { ...params, item_id: 'review' }, query: { title: 'Review', unit_cents: '25000' },
  })).toMatchObject({ status: 200, body: { prices: { items: [
    { item_id: 'review', title: 'Review', unit_cents: 60000 },
    { item_id: 'review-2', title: 'Review', unit_cents: 15000 },
  ] } } });
  const remaining = await mockStore.dispatch('setupPublicLines', { params });
  // The old second id now names $150, so the original $600 guard must refuse it.
  expect(await mockStore.dispatch('removePublicPrice', {
    params: { ...params, item_id: 'review-2' }, query: { title: 'Review', unit_cents: '60000' },
  })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(remaining);
  expect(await mockStore.dispatch('removePublicPrice', {
    params: { ...params, item_id: 'review' }, query: { title: 'Review', unit_cents: '60000' },
  })).toMatchObject({ status: 200, body: { prices: { items: [
    { item_id: 'review', title: 'Review', unit_cents: 15000 },
  ] } } });
  expect(await mockStore.dispatch('removePublicPrice', {
    params: { ...params, item_id: 'review' }, query: { title: 'Review', unit_cents: '15000' },
  })).toMatchObject({ status: 200, body: { prices: null } });
});

it('requires both displayed price query values and refuses any mismatch without mutation', async () => {
  const params = await atRules();
  const response = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in response) throw new Error('read failed');
  const data = response.body as SetupPublicLines;
  storePublicState(mockStore.world, params.id, { ...data, prices: { source: 'suggested', items: [
    { item_id: 'review', title: 'Review & café / intro?', unit_cents: 0 },
  ] } });
  const before = await mockStore.dispatch('setupPublicLines', { params });
  const priceParams = { ...params, item_id: 'review-cafe-intro' };
  const invalidQueries: Record<string, string>[] = [{}, { title: 'Review & café / intro?' }, { unit_cents: '0' }, { title: 'Review & café / intro?', unit_cents: '' }, { title: 'Review & café / intro?', unit_cents: 'invalid' }];
  for (const query of invalidQueries) {
    expect(await mockStore.dispatch('removePublicPrice', { params: priceParams, query })).toMatchObject({ status: 422, body: { error: 'invalid' } });
    expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(before);
  }
  for (const query of [{ title: 'Review', unit_cents: '0' }, { title: 'Review & café / intro?', unit_cents: '1' }]) {
    expect(await mockStore.dispatch('removePublicPrice', { params: priceParams, query })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(before);
  }
  expect(await mockStore.dispatch('removePublicPrice', { params: priceParams, query: { title: 'Review & café / intro?', unit_cents: '0' } })).toMatchObject({ status: 200, body: { prices: null } });
});

it('removes one suggested price, recomputes duplicate ids and clears the last price', async () => {
  const params = await atRules();
  const response = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in response) throw new Error('read failed');
  const data = response.body as SetupPublicLines;
  expect(data.prices!.items.map((item) => item.item_id)).toEqual(['tax-return-review', 'business-tax-return', 'monthly-bookkeeping']);
  const removed = await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'business-tax-return' }, query: { title: 'Business tax return', unit_cents: '60000' } });
  expect(removed).toMatchObject({ status: 200, body: { lines: data.lines, hours: data.hours, prices: { source: 'suggested', items: [
    data.prices!.items[0], data.prices!.items[2],
  ] } } });
  expect(await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'business-tax-return' }, query: { title: 'Business tax return', unit_cents: '60000' } })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  // IDs are recomputed from the remaining titles, including duplicate suffixes.
  storePublicState(mockStore.world, params.id, { ...data, prices: { source: 'suggested', items: [
    { item_id: 'cafe-review', title: 'Café review!', unit_cents: 25000 },
    { item_id: 'cafe-review-2', title: 'Café review!', unit_cents: 60000 },
    { item_id: 'cafe-review-3', title: 'Café review!', unit_cents: 15000 },
  ] } });
  const first = await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'cafe-review' }, query: { title: 'Café review!', unit_cents: '25000' } });
  expect(first).toMatchObject({ status: 200, body: { prices: { source: 'suggested', items: [
    { item_id: 'cafe-review', title: 'Café review!', unit_cents: 60000 },
    { item_id: 'cafe-review-2', title: 'Café review!', unit_cents: 15000 },
  ] } } });
  expect(await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'cafe-review' }, query: { title: 'Café review!', unit_cents: '25000' } })).toMatchObject({ status: 409 });
  expect(await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'cafe-review' }, query: { title: 'Café review!', unit_cents: '60000' } })).toMatchObject({ status: 200, body: { prices: { items: [
    { item_id: 'cafe-review', title: 'Café review!', unit_cents: 15000 },
  ] } } });
  expect(await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'cafe-review' }, query: { title: 'Café review!', unit_cents: '15000' } })).toMatchObject({ status: 200, body: { prices: null } });
});

it('refuses per-price removal for owner prices, wrong stages and another owner', async () => {
  const params = await atRules();
  const priceParams = { ...params, item_id: 'tax-return-review' };
  expect(await confirmShown(params)).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('removePublicPrice', { params: priceParams, query: { title: 'Tax return review', unit_cents: '25000' } })).toMatchObject({ status: 422, body: { error: 'not_suggested', key: 'prices' } });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({ body: { prices: { source: 'owner', items: expect.arrayContaining([expect.objectContaining({ item_id: priceParams.item_id })]) } } });
  await mockStore.dispatch('setupSafetyCheck', { params });
  expect(await mockStore.dispatch('removePublicPrice', { params: priceParams, query: { title: 'Tax return review', unit_cents: '25000' } })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  expect(await mockStore.dispatch('removePublicPrice', { params: { id: 'missing', item_id: priceParams.item_id }, query: { title: 'Tax return review', unit_cents: '25000' } })).toMatchObject({ status: 404 });
  mockStore.reset('rivera', { signedIn: false });
  expect(await mockStore.dispatch('removePublicPrice', { params: priceParams, query: { title: 'Tax return review', unit_cents: '25000' } })).toMatchObject({ status: 401 });
  const store = new MockStore({ cookies: 'real' });
  const owner = async () => {
    const copy = await store.dispatch('copies', { body: { passcode: 'demo' } });
    if ('network' in copy) throw new Error('copy failed');
    const value = /^desk_owner=([^;]+)/.exec(copy.setCookie?.find((line) => line.startsWith('desk_owner=')) ?? '')?.[1];
    if (!value) throw new Error('owner cookie missing');
    return { desk_owner: value };
  };
  const first = await owner();
  const second = await owner();
  const started = await store.dispatch('startSetup', { cookies: first, body: { description: START_EXAMPLES.en.examples[3]!.description, timezone: 'UTC', idempotency_key: 'price-ownership' } });
  if ('network' in started) throw new Error('start failed');
  expect(await store.dispatch('removePublicPrice', { cookies: first, params: { id: (started.body as SetupState).interview_id, item_id: 'tax-return-review' }, query: { title: 'Tax return review', unit_cents: '25000' } })).toMatchObject({ status: 409 });
  expect(await store.dispatch('removePublicPrice', { cookies: second, params: { id: (started.body as SetupState).interview_id, item_id: 'tax-return-review' }, query: { title: 'Tax return review', unit_cents: '25000' } })).toMatchObject({ status: 404 });
});

it('removes only suggested items and never publishes a removed item', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.map((line) =>
    line.key === 'policy:after_hours' ? { ...line, source: 'suggested' } : line,
  ));
  for (const key of ['contact', 'hours', 'prices', 'policy:after_hours']) {
    const removed = await mockStore.dispatch('removePublicLine', { params: { ...params, key } });
    expect(removed).toMatchObject({ status: 200 });
    if ('network' in removed) throw new Error('remove failed');
    const data = removed.body as SetupPublicLines;
    if (key === 'hours' || key === 'prices') expect(data[key]).toBeNull();
    else expect(data.lines.some((line) => line.key === key)).toBe(false);
    expect(await mockStore.dispatch('removePublicLine', { params: { ...params, key } })).toMatchObject({ status: 422, body: { error: 'not_suggested', key } });
  }
  expect(await mockStore.dispatch('removePublicLine', { params: { ...params, key: 'policy:about' } })).toMatchObject({ status: 422, body: { error: 'not_suggested', key: 'policy:about' } });
  expect(await confirmShown(params)).toMatchObject({ status: 200, body: { hours: null, prices: null } });
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup failed');
  const published = await mockStore.dispatch('publicDesk', { params: { slug: (setup.body as SetupState).slug } });
  expect(JSON.stringify(published)).not.toMatch(/linda@chenandco.com|Tax return review|charter:hours|charter:policy:after_hours/);
  await mockStore.dispatch('setupSafetyCheck', { params });
  expect(await mockStore.dispatch('removePublicLine', { params: { ...params, key: 'contact' } })).toMatchObject({ status: 409 });
  expect(await mockStore.dispatch('removePublicLine', { params: { id: 'missing', key: 'contact' } })).toMatchObject({ status: 404 });
  mockStore.reset('rivera', { signedIn: false });
  expect(await mockStore.dispatch('removePublicLine', { params: { ...params, key: 'contact' } })).toMatchObject({ status: 401 });
});

it('publishes suggestions only after an edit or confirmation, including structured hours and prices', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const data = read.body as SetupPublicLines;
  storePublicLines(mockStore.world, params.id, data.lines.map((line) =>
    line.key === 'policy:service_area' ? { ...line, source: 'suggested' } : line,
  ));
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup failed');
  const publicParams = { slug: (setup.body as SetupState).slug };
  const publicRead = async () => {
    const response = await mockStore.dispatch('publicDesk', { params: publicParams });
    if ('network' in response) throw new Error('public read failed');
    return response.body as { charter: { fact_id: string; title: string }[] };
  };
  for (const key of ['contact', 'hours', 'prices', 'policy:service_area']) {
    expect((await publicRead()).charter.some((card) => card.fact_id === `charter:${key}`)).toBe(false);
  }
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'contact', text: 'linda@chenandco.com' } })).toMatchObject({ status: 200 });
  expect((await publicRead()).charter).toContainEqual(expect.objectContaining({ fact_id: 'charter:contact', title: 'linda@chenandco.com' }));
  expect((await publicRead()).charter.some((card) => card.fact_id === 'charter:hours')).toBe(false);
  const confirmed = await confirmShown(params);
  expect(confirmed).toMatchObject({ status: 200, body: { hours: { source: 'owner' }, prices: { source: 'owner' } } });
  if ('network' in confirmed) throw new Error('confirm failed');
  expect((confirmed.body as SetupPublicLines).lines.every((line) => line.source === 'owner')).toBe(true);
  expect(JSON.stringify(await publicRead())).not.toMatch(/Tax return review|Business tax return|Monthly bookkeeping|charter:prices/);
  expect((await publicRead()).charter.map((card) => card.fact_id)).toEqual(expect.arrayContaining([
    'charter:contact', 'charter:hours', 'charter:policy:service_area',
  ]));
});

async function atRules(answers: Partial<Record<QuestionKey, string>> = {}, description = START_EXAMPLES.en.examples[3]!.description) {
  const started = await mockStore.dispatch('startSetup', { body: {
    description,
    timezone: 'America/Los_Angeles', idempotency_key: 'public-lines',
  } });
  if ('network' in started) throw new Error('start failed');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: false } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text: answers[question.key] ?? 'Ask me first.' } });
  }
  // An owner who typed their own contact is offered a test client first: not now.
  const read = await mockStore.dispatch('setup', { params });
  if (!('network' in read) && (read.body as SetupState).question === 'test_client') {
    await mockStore.dispatch('setupAnswer', { params, body: { question: 'test_client', text: 'Not now' } });
  }
  await mockStore.dispatch('setupRules', { params });
  return params;
}


/** Existing scan/publication cases explicitly approve the current listed lines, never hidden fields. */
async function confirmListed(params: { id: string }) {
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read || read.status !== 200) throw new Error('public lines unavailable');
  const state = read.body as SetupPublicLines;
  return mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: state.lines.map((line) => line.key), revision: state.revision } });
}

/** The screen's full selection includes only rendered structured suggestions. */
async function confirmShown(params: { id: string }) {
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read || read.status !== 200) throw new Error('public lines unavailable');
  const state = read.body as SetupPublicLines;
  return mockStore.dispatch('setupPublicLinesConfirm', { params, body: {
    keys: [...state.lines.filter((line) => !line.held).map((line) => line.key),
      ...(state.hours?.source === 'suggested' && state.hours.windows.length ? ['hours'] : []),
      ...(state.prices?.source === 'suggested' && state.prices.items.length ? ['prices'] : [])], revision: state.revision,
  } });
}

it('holds the signed CPA Contact until confirmation and projects its Contact label', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const lines = (read.body as SetupPublicLines).lines;
  expect(lines[1]).toEqual({ key: 'contact', text: '(408) 555-0199, linda@chenandco.com', source: 'suggested', editable: true, held: false });
  storePublicLines(mockStore.world, params.id, lines.map((line) => ({ ...line, source: 'suggested' })));
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup failed');
  const publicParams = { slug: (setup.body as SetupState).slug };
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({ status: 200, body: { charter: [] } });
  expect(await confirmListed(params)).toMatchObject({ status: 200 });
  const published = await mockStore.dispatch('publicDesk', { params: publicParams });
  if ('network' in published) throw new Error('public read failed');
  const contact = (published.body as PublicDesk).charter.find((card) => card.fact_id === 'charter:contact')!;
  expect(contact).toMatchObject({ template: 'contact', title: '(408) 555-0199, linda@chenandco.com' });
  expect(cardChrome(contact.template!, 'en', contact.fact_id)?.label).toBe('Contact');
});

it('keeps held owner words private, refuses their confirmation and clears the hold only on accepted PUT', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const key = 'policy:intake';
  const text = 'The owner’s stored pricing words.';
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.map((line) =>
    line.key === key ? { ...line, text, source: 'owner', held: true } : { ...line, source: 'suggested' },
  ));
  const held = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in held) throw new Error('read failed');
  const state = held.body as SetupPublicLines;
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup failed');
  const publicParams = { slug: (setup.body as SetupState).slug };
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({ status: 200, body: { charter: [] } });
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: [key], revision: state.revision } })).toMatchObject({
    status: 422, body: { error: 'line_refused', key },
  });
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: 'Always charge $250.' } })).toMatchObject({ status: 422 });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(held);
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {
    keys: state.lines.filter((line) => line.key !== key).map((line) => line.key), revision: state.revision,
  } });
  expect(confirmed).toMatchObject({ status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text, held: true })]) } });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({ status: 200, body: {
    charter: expect.not.arrayContaining([expect.objectContaining({ fact_id: `charter:${key}` })]),
  } });
  const saved = await mockStore.dispatch('setupPublicLine', { params, body: { key, text: 'Ask Linda for a quote.' } });
  expect(saved).toMatchObject({ status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text: 'Ask Linda for a quote.', held: false, source: 'owner' })]) } });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({ status: 200, body: {
    charter: expect.arrayContaining([expect.objectContaining({ fact_id: `charter:${key}`, title: 'Ask Linda for a quote.' })]),
  } });
});

it('seeds requested held keys per interview with owner words and defaults other holds to false', async () => {
  const params = await atRules();
  const key = 'policy:intake';
  const text = 'Always charge $250.';
  holdPublicLineOnSeed(mockStore.world, params.id, key, text);
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const state = read.body as SetupPublicLines;
  expect(state.lines.find((line) => line.key === key)).toEqual({ key, text, source: 'owner', editable: true, held: true });
  expect(state.lines.filter((line) => line.key !== key).every((line) => line.held === false)).toBe(true);
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {
    keys: ['policy:about'], revision: state.revision,
  } })).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'contact', text: 'office@example.com' } })).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({ status: 200, body: {
    lines: expect.arrayContaining([expect.objectContaining({ key, text, held: true })]),
  } });
  mockStore.reset('rivera');
  const other = await atRules();
  const otherRead = await mockStore.dispatch('setupPublicLines', { params: other });
  if ('network' in otherRead) throw new Error('read failed');
  expect((otherRead.body as SetupPublicLines).lines.every((line) => line.held === false)).toBe(true);
});

it('seeds exactly the CPA suggestions alongside owner lines without moving the interview', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  expect(read.status).toBe(200);
  const lines = (read.body as SetupPublicLines).lines;
  expect(lines.map((line) => line.key)).toEqual([
    'policy:about', 'contact', 'policy:intake', 'policy:after_hours',
    'policy:urgent', 'policy:service_area', 'policy:how_we_help',
  ]);
  expect(lines.at(-1)).toMatchObject({ editable: false });
  expect(lines.at(-1)?.text.split('\n')).toHaveLength(3);
  expect(read.body).toMatchObject({
    lines: expect.arrayContaining([
      { key: 'contact', text: '(408) 555-0199, linda@chenandco.com', source: 'suggested', editable: true, held: false },
      expect.objectContaining({ key: 'policy:about', source: 'owner' }),
    ]),
    hours: { source: 'suggested', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '18:00:00' }] },
    prices: { source: 'suggested', items: [
      { item_id: 'tax-return-review', title: 'Tax return review', unit_cents: 25000 },
      { item_id: 'business-tax-return', title: 'Business tax return', unit_cents: 60000 },
      { item_id: 'monthly-bookkeeping', title: 'Monthly bookkeeping', unit_cents: 15000 },
    ] },
  });
  expect(await mockStore.dispatch('setup', { params })).toMatchObject({ body: { step: 'rules' } });
});

it('seeds the signed CPA starter lines and keeps limit answers out of every line', async () => {
  const limits = {
    quote_limit: 'Always ask me first.',
    discounts: 'Never offer discounts.',
    documents_and_payments: 'Documents require verification and payments always ask me.',
    money_limit: '$500 is the money limit.',
  };
  const params = await atRules({
    ...limits,
    what_you_do: 'Tax returns and bookkeeping for individuals and small businesses in San Jose.',
    hours_and_area: 'Monday to Friday, 9 to 6. Customers can book those times on their own.',
    contact_and_after_hours: 'Email Linda. After hours, take a message.',
  });
  const board = [
    ['about', 'Chen & Co. CPA is a two-person CPA firm in San Jose. We do tax returns and bookkeeping.'],
    ['intake', 'Before a consult, the Desk asks whether it’s for you, your business or both, which tax years or months need work, and whether you use bookkeeping software.'],
    ['after_hours', 'Outside business hours, the Desk takes a message and Linda replies the next business day.'],
    ['urgent', 'A notice from the IRS or the state with a deadline this week is urgent: the Desk tells Linda right away.'],
    ['service_area', 'Clients in San Jose and the South Bay, in person or online.'],
    ['how_we_help', 'New clients book a short introductory call.\nBefore their call, new clients answer three short questions.\nClients get a secure link to pay a retainer before work starts.'],
  ];
  const expected = { lines: board.map(([key, text]) => ({ key: `policy:${key}`, text, source: 'owner', editable: key !== 'how_we_help' })) };
  expected.lines.splice(1, 0, { key: 'contact', text: '(408) 555-0199, linda@chenandco.com', source: 'suggested', editable: true });
  const read = await mockStore.dispatch('setupPublicLines', { params });
  expect(read).toMatchObject({ status: 200, body: expected });
  if ('network' in read) throw new Error('read failed');
  for (const answer of Object.values(limits)) {
    for (const line of (read.body as SetupPublicLines).lines) expect(line.text).not.toContain(answer);
  }
  expect(await confirmListed(params)).toMatchObject({
    status: 200, body: { lines: expected.lines.map((line) => ({ ...line, source: 'owner' })) },
  });
});

it('seeds other businesses only from their About and customer-facing after-hours clauses', async () => {
  const limits = {
    quote_limit: 'Always ask me first for quotes.',
    discounts: 'Never offer discounts.',
    documents_and_payments: 'Documents require verification and payments always ask me.',
    money_limit: '$500 is the money limit.',
  };
  const knownAbout = { key: 'policy:about', text: 'We help local businesses.', source: 'owner', editable: true };
  for (const [contact, afterHours] of [
    ['Email me at lee@example.com; After hours, take a message.', null],
    ['Email me at lee@example.com; After hours, you can leave a message.', 'After hours, you can leave a message.'],
    ['After hours, you can take a message for me.', null],
    ['After hours, you can handle any requests.', null],
    ['After hours, you can leave a message for me.', null],
    ['After hours, you can email us.', 'After hours, you can email us.'],
    ['Call me. Outside business hours, take a message.', null],
    ['Call me. Outside business hours, we reply the next business day.', 'Outside business hours, we reply the next business day.'],
    ['After hours, we should take a message.', null],
    ['After hours, we want you to take a message.', null],
    ['Email me at lee@example.com.', null],
  ] as const) {
    mockStore.reset('rivera');
    const params = await atRules({
      ...limits,
      what_you_do: 'Tax returns and bookkeeping for individuals and small businesses.',
      hours_and_area: 'Monday to Friday, 9 to 6. Customers can book those times on their own.',
      contact_and_after_hours: contact,
    }, 'Lakeview Accounts. I’m Lee. We help local businesses.');
    const read = await mockStore.dispatch('setupPublicLines', { params });
    expect(read).toMatchObject({ status: 200, body: { lines: [knownAbout, ...(afterHours ? [
      { key: 'policy:after_hours', text: afterHours, source: 'owner', editable: true },
    ] : [])] } });
    if ('network' in read) throw new Error('read failed');
    for (const answer of Object.values(limits)) {
      for (const line of (read.body as SetupPublicLines).lines) expect(line.text).not.toContain(answer);
    }
    expect(await confirmListed(params)).toMatchObject({ status: 200 });
  }
});

it('updates one editable line and refuses unsafe, read-only or invalid edits without changing it', async () => {
  const params = await atRules();
  const key = 'policy:after_hours';
  const text = 'Leave a message for Linda.';
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({
    status: 200, body: { lines: expect.arrayContaining([{ key, text, source: 'owner', editable: true, held: false }]) },
  });
  for (const refused of ['$20', '10%', '9am', '9:30', '9 to 6', 'guarantee', 'promise', 'always', 'never']) {
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: refused } })).toMatchObject({
      status: 422, body: { error: 'line_refused', key, reason: ['mock_scan'] },
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
  expect(read).toMatchObject({ body: { lines: expect.arrayContaining([{ key, text: 'x'.repeat(500), source: 'owner', editable: true, held: false }]) } });
});

it('confirms all lines, rescans seeded answers and leaves the interview at rules', async () => {
  const params = await atRules();
  const confirmed = await confirmListed(params);
  expect(confirmed).toMatchObject({ status: 200, body: { lines: expect.any(Array) } });
  expect(await mockStore.dispatch('setup', { params })).toMatchObject({ body: { step: 'rules' } });
  mockStore.reset('rivera');
  const started = await mockStore.dispatch('startSetup', { body: {
    description: 'We run Lakeview Accounts. We always help.', timezone: 'UTC', idempotency_key: 'unsafe-seed',
  } });
  if ('network' in started) throw new Error('start failed');
  const unsafe = { id: (started.body as SetupState).interview_id };
  await mockStore.dispatch('setupConsent', { params: unsafe, body: { allow: false } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', { params: unsafe, body: { question: question.key, text: 'Ask first.' } });
  }
  await mockStore.dispatch('setupRules', { params: unsafe });
  const publicParams = { slug: (started.body as SetupState).slug };
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({
    status: 200, body: { charter: [] },
  });
  expect(await confirmListed(unsafe)).toMatchObject({
    status: 422, body: { error: 'line_refused', key: 'policy:about', reason: ['mock_scan'] },
  });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({
    status: 200, body: { charter: expect.not.arrayContaining([expect.objectContaining({ fact_id: 'charter:policy:about' })]) },
  });
  expect(await mockStore.dispatch('setupPublicLines', { params: unsafe })).toMatchObject({
    status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key: 'policy:about', text: 'We always help.' })]) },
  });
});

it('shows saved and confirmed lines in the public charter for their claims', async () => {
  const params = await atRules();
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup read failed');
  const { slug } = setup.body as SetupState;
  for (const [key, text] of [
    ['policy:about', 'We help local businesses.'],
    ['policy:intake', 'Ask Linda for a quote.'],
  ]) {
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({ status: 200 });
  }
  const confirmed = await confirmShown(params);
  if ('network' in confirmed) throw new Error('confirm failed');
  expect(confirmed.status).toBe(200);
  expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject({
    status: 200,
    body: {
      charter: [...(confirmed.body as SetupPublicLines).lines.map(({ key, text }) => expect.objectContaining({
        fact_id: `charter:${key}`, title: text,
      })), expect.objectContaining({ fact_id: 'charter:hours', title: 'Weekdays, 9:00 am to 6:00 pm' })],
    },
  });
});

it('keeps refused seeded lines private before and after a refused confirm while publishing accepted edits', async () => {
  const refused = 'After hours, we always charge $20.';
  const key = 'policy:after_hours';
  const params = await atRules({ contact_and_after_hours: refused }, 'Lakeview Accounts. We help local businesses.');
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup read failed');
  const { slug } = setup.body as SetupState;
  const ownerDraft = { status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text: refused })]) } };
  const hiddenClaim = { status: 200, body: { charter: expect.not.arrayContaining([expect.objectContaining({ fact_id: `charter:${key}` })]) } };
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject(ownerDraft);
  expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject(hiddenClaim);
  expect(await confirmListed(params)).toMatchObject({
    status: 422, body: { error: 'line_refused', key },
  });
  expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject(hiddenClaim);
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject(ownerDraft);

  const accepted = 'Ask Linda for a quote.';
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: accepted } })).toMatchObject({ status: 200 });
  expect(await confirmListed(params)).toMatchObject({ status: 200 });
  const published = { status: 200, body: { charter: expect.arrayContaining([
    expect.objectContaining({ fact_id: `charter:${key}`, title: accepted, text: accepted }),
  ]) } };
  expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject(published);
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: refused } })).toMatchObject({
    status: 422, body: { error: 'line_refused', key },
  });
  expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject(published);
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
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:intake', text } })).toMatchObject({
      status: 422, body: { error: 'line_refused', key: 'policy:intake' },
    });
  }
});

it('refuses free and numeric durations in seeded public lines, confirm and edits', async () => {
  for (const text of [
    'free', 'FREE', '20 minutes', '1 minute', '2 hours', '1 hour', '2 days', '1 day',
    '20-minute', '1-hour', '2-day', '0.5 hours',
  ]) {
    mockStore.reset('rivera');
    const key = 'policy:after_hours';
    const seeded = `After hours, we reply in ${text}.`;
    const params = await atRules({ contact_and_after_hours: seeded }, 'Lakeview Accounts. We help local businesses.');
    const setup = await mockStore.dispatch('setup', { params });
    if ('network' in setup) throw new Error('setup read failed');
    const publicParams = { slug: (setup.body as SetupState).slug };
    expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({
      status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text: seeded })]) },
    });
    const hiddenClaim = { status: 200, body: { charter: expect.not.arrayContaining([expect.objectContaining({ fact_id: `charter:${key}` })]) } };
    expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject(hiddenClaim);
    expect(await confirmListed(params)).toMatchObject({
      status: 422, body: { error: 'line_refused', key },
    });
    expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject(hiddenClaim);
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:about', text } })).toMatchObject({
      status: 422, body: { error: 'line_refused', key: 'policy:about' },
    });
  }
});

it('seeds How we help as customer-readable lines that pass the scan', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  expect(read.status).toBe(200);
  const line = (read.body as SetupPublicLines).lines.find(({ key }) => key === 'policy:how_we_help');
  expect(line).toMatchObject({ editable: false });
  const jobs = line!.text.split('\n');
  expect(jobs).toEqual([
    'New clients book a short introductory call.',
    'Before their call, new clients answer three short questions.',
    'Clients get a secure link to pay a retainer before work starts.',
  ]);
  for (const job of jobs) {
    expect(job).not.toContain(':');
    expect(job).not.toMatch(/\b(?:you|your|free)\b|\d/i);
    expect(publicLineRefused(job)).toBe(false);
  }
});

let cardRuns = 0;

/**
 * The CPA starter with its cards, then on to the rules step. Each job card is decided by `decide`, given
 * the job and how many of its cards came before (a changed card is a new one): true or false is the
 * card's buttons, with an amount for a retainer, and a string is typed as the answer to the card.
 */
async function cpaAtRulesDeciding(decide: (job: string, before: number) => boolean | string) {
  const query = { cards: '1' };
  const started = await mockStore.dispatch('startSetup', { query, body: {
    description: START_EXAMPLES.en.examples[3]!.description,
    timezone: 'America/Los_Angeles', idempotency_key: `how-we-help-${++cardRuns}`,
  } });
  if ('network' in started) throw new Error('start failed');
  const params = { id: (started.body as SetupState).interview_id };
  const next = async (key: 'setupConsent' | 'setupAnswer' | 'setupSuggestions' | 'setupProposal', body: unknown, proposal_id?: string) => {
    const answer = await mockStore.dispatch(key, { params: { ...params, ...(proposal_id ? { proposal_id } : {}) }, query, body });
    if ('network' in answer || answer.status !== 200) throw new Error(`${key} must answer 200`);
    return answer.body as SetupState;
  };
  let state = await next('setupConsent', { allow: true });
  state = await next('setupAnswer', { question: state.question, text: 'Both, about evenly' });
  const seen = new Map<string, number>();
  while (state.pending_card) {
    const card = state.messages.findLast((message) => message.card?.proposal_id === state.pending_card)!.card!;
    const before = seen.get(card.job?.job ?? '') ?? 0;
    if (card.job) seen.set(card.job.job, before + 1);
    const answer = card.job === null || decide(card.job.job, before);
    if (typeof answer === 'string') state = await next('setupAnswer', { question: null, card: card.proposal_id, text: answer });
    else state = await next('setupProposal', answer && card.job?.job === 'payment' ? { accept: true, amount_cents: 50000 } : { accept: answer }, card.proposal_id);
  }
  if (state.step !== 'tools') state = await next('setupSuggestions', {});
  await mockStore.dispatch('setupRules', { params });
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read || read.status !== 200) throw new Error('public lines unavailable');
  return (read.body as SetupPublicLines).lines.find(({ key }) => key === 'policy:how_we_help');
}

it('leaves out of How we help the job the owner turned down, and the line when they turned down every job', async () => {
  const booking = 'New clients book a short introductory call.';
  const intake = 'Before their call, new clients answer three short questions.';
  const retainer = 'Clients get a secure link to pay a retainer before work starts.';
  expect((await cpaAtRulesDeciding(() => true))?.text).toBe([booking, intake, retainer].join('\n'));
  expect((await cpaAtRulesDeciding((job) => job !== 'payment'))?.text).toBe([booking, intake].join('\n'));
  expect((await cpaAtRulesDeciding((job) => job !== 'intake'))?.text).toBe([booking, retainer].join('\n'));
  expect(await cpaAtRulesDeciding(() => false)).toBeUndefined();
});

it('reads How we help from the current card and the owner’s typed answer, and keeps the sentence of a retainer setup declined for having no amount', async () => {
  const booking = 'New clients book a short introductory call.';
  const intake = 'Before their call, new clients answer three short questions.';
  const retainer = 'Clients get a secure link to pay a retainer before work starts.';
  // A changed intro call, then "Not now" on the changed card: the booking's sentence goes; accepted, it stays.
  const changeThen = (yes: boolean) => (job: string, before: number) => job !== 'schedule' || (before === 0 ? 'Make it 30 minutes' : yes);
  expect((await cpaAtRulesDeciding(changeThen(false)))?.text).toBe([intake, retainer].join('\n'));
  expect((await cpaAtRulesDeciding(changeThen(true)))?.text).toBe([booking, intake, retainer].join('\n'));
  // "Not now" typed on the retainer's card is the owner's no.
  expect((await cpaAtRulesDeciding((job) => job !== 'payment' || 'Not now'))?.text).toBe([booking, intake].join('\n'));
  // A typed yes on a retainer with no amount is setup's decline, not the owner's: its sentence stays (#855).
  expect((await cpaAtRulesDeciding((job) => job !== 'payment' || 'Yes, please'))?.text).toBe([booking, intake, retainer].join('\n'));
});

it('scans read-only How we help before confirmation and public publication', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const key = 'policy:how_we_help';
  const text = 'Book a free 20-minute call.';
  // Reproduce an unsafe code-built draft without allowing an owner to edit the read-only claim.
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.map((line) =>
    line.key === key ? { ...line, text, source: 'owner' } : line,
  ));
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({
    status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text, editable: false })]) },
  });
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup read failed');
  const publicParams = { slug: (setup.body as SetupState).slug };
  const hiddenClaim = { status: 200, body: { charter: expect.not.arrayContaining([expect.objectContaining({ fact_id: `charter:${key}` })]) } };
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject(hiddenClaim);
  expect(await confirmListed(params)).toMatchObject({
    status: 422, body: { error: 'line_refused', key },
  });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject(hiddenClaim);
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: 'A replacement.' } })).toMatchObject({
    status: 422, body: { error: 'not_editable', key },
  });
});

it('publishes only owner lines and adopts every suggestion on confirmation', async () => {
  const params = await atRules();
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup read failed');
  const publicParams = { slug: (setup.body as SetupState).slug };
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const suggested = (read.body as SetupPublicLines).lines.map((line) => ({ ...line, source: 'suggested' as const }));
  storePublicLines(mockStore.world, params.id, suggested);
  expect(suggested.every((line) => line.source === 'suggested')).toBe(true);
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({ status: 200, body: { charter: [] } });
  const key = 'policy:about';
  const text = 'We help local businesses.';
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({
    status: 200, body: { charter: [expect.objectContaining({ fact_id: `charter:${key}`, title: text })] },
  });
  const confirmed = await confirmShown(params);
  if ('network' in confirmed) throw new Error('confirm failed');
  expect(confirmed.status).toBe(200);
  const lines = (confirmed.body as SetupPublicLines).lines;
  expect(lines.every((line) => line.source === 'owner')).toBe(true);
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({ status: 200, body: { lines } });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({
    status: 200, body: { charter: [...lines.map(({ key, text }) => expect.objectContaining({ fact_id: `charter:${key}`, title: text })), expect.objectContaining({ fact_id: 'charter:hours' })] },
  });
});

it('scans the whole candidate owner charter on PUT and refuses atomically with the first key', async () => {
  const afterHours = 'After hours, we reply the next business day.';
  const params = await atRules({ contact_and_after_hours: afterHours }, 'Lakeview Accounts. We always help.');
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:after_hours', text: 'After hours, we respond by email.' } })).toMatchObject({
    status: 422, body: { error: 'line_refused', key: 'policy:about', reason: ['mock_scan'] },
  });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({
    status: 200, body: { lines: [
      expect.objectContaining({ key: 'policy:about', text: 'We always help.' }),
      expect.objectContaining({ key: 'policy:after_hours', text: afterHours }),
    ] },
  });
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:about', text: 'We help local businesses.' } })).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:after_hours', text: 'After hours, we respond by email.' } })).toMatchObject({ status: 200 });
});

it('enforces the API limit for About, other lines and the contact claim', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  storePublicLines(mockStore.world, params.id, [...(read.body as SetupPublicLines).lines.filter((line) => line.key !== 'contact'), {
    key: 'contact', text: 'Contact the office.', source: 'owner', editable: true,
  }]);
  for (const [key, limit] of [['policy:about', 1500], ['policy:intake', 500], ['contact', 200]] as const) {
    const text = 'x'.repeat(limit);
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({ status: 200 });
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: text + 'x' } })).toMatchObject({
      status: 422, body: { error: 'invalid' },
    });
    expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({
      status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text })]) },
    });
  }
});


it('seeds held CPA hours and prices with a stable revision that changes on PUT', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  expect(read).toMatchObject({ status: 200, body: {
    revision: expect.any(String),
    hours: { source: 'suggested', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '18:00:00' }] },
    prices: { source: 'suggested', items: [
      { item_id: 'tax-return-review', title: 'Tax return review', unit_cents: 25000 },
      { item_id: 'business-tax-return', title: 'Business tax return', unit_cents: 60000 },
      { item_id: 'monthly-bookkeeping', title: 'Monthly bookkeeping', unit_cents: 15000 },
    ] },
  } });
  if ('network' in read) throw new Error('read failed');
  const before = read.body as SetupPublicLines;
  expect(before.revision.trim()).not.toBe('');
  expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(read);
  const saved = await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:about', text: 'We help local businesses.' } });
  if ('network' in saved) throw new Error('save failed');
  expect(saved.status).toBe(200);
  const after = saved.body as SetupPublicLines;
  expect(after.revision).not.toBe(before.revision);
  expect(after.hours).toEqual(before.hours);
  expect(after.prices).toEqual(before.prices);
  expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(saved);
});

it('confirms listed hours and prices only when explicitly selected and leaves every line untouched', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.map((line) => ({ ...line, source: 'suggested' })));
  const seeded = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in seeded) throw new Error('read failed');
  let current = seeded.body as SetupPublicLines;
  for (const key of ['hours', 'prices'] as const) {
    const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: [key], revision: current.revision } });
    if ('network' in confirmed) throw new Error('confirm failed');
    expect(confirmed.status).toBe(200);
    const next = confirmed.body as SetupPublicLines;
    expect(next[key]).toEqual({ ...current[key], source: 'owner' });
    const other = key === 'hours' ? 'prices' : 'hours';
    expect(next[other]).toEqual(current[other]);
    expect(next.lines).toEqual(current.lines);
    expect(next.revision).not.toBe(current.revision);
    expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(confirmed);
    current = next;
  }
  expect(current.lines.every((line) => line.source === 'suggested')).toBe(true);
});


it('refuses missing, empty, unknown or unlisted confirmation keys and revisions without changing state', async () => {
  const params = await atRules();
  const seed = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in seed) throw new Error('read failed');
  storePublicState(mockStore.world, params.id, {
    lines: (seed.body as SetupPublicLines).lines.filter((line) => line.key !== 'contact'), hours: null, prices: null,
  });
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const { revision } = read.body as SetupPublicLines;
  for (const body of [
    {}, { keys: [], revision }, { keys: ['policy:about'] },
    { keys: ['policy:about'], revision: '' }, { keys: 'policy:about', revision },
    { keys: ['policy:unknown'], revision }, { keys: ['contact'], revision },
    { keys: ['hours'], revision }, { keys: ['prices'], revision },
    { keys: ['policy:about', 'policy:unknown'], revision },
  ]) {
    expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body })).toMatchObject({
      status: 422, body: { error: 'invalid' },
    });
    expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(read);
  }
});


it.each([1, 7])('confirms only selected line keys with %s listed lines and holds unseen suggestions', async (count) => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.slice(0, count).map((line) => ({ ...line, source: 'suggested' })));
  const current = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in current) throw new Error('read failed');
  const before = current.body as SetupPublicLines;
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: before.revision } });
  if ('network' in confirmed) throw new Error('confirm failed');
  expect(confirmed.status).toBe(200);
  const after = confirmed.body as SetupPublicLines;
  expect(after.revision).not.toBe(before.revision);
  expect(after.lines[0]).toEqual({ ...before.lines[0], source: 'owner' });
  expect(after.lines.slice(1)).toEqual(before.lines.slice(1));
  expect(after.hours).toEqual(before.hours);
  expect(after.prices).toEqual(before.prices);
  expect(after.hours?.source).toBe('suggested');
  expect(after.prices?.source).toBe('suggested');
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup read failed');
  expect(await mockStore.dispatch('publicDesk', { params: { slug: (setup.body as SetupState).slug } })).toMatchObject({
    status: 200, body: { charter: [expect.objectContaining({ fact_id: 'charter:policy:about', title: before.lines[0]!.text })] },
  });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toEqual(confirmed);
});


it('holds an unselected unsafe suggestion but still scans the whole owner charter', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const lines = (read.body as SetupPublicLines).lines.map((line) => line.key === 'policy:intake' ? { ...line, text: 'Always charge $20.', source: 'suggested' as const } : line);
  storePublicLines(mockStore.world, params.id, lines);
  const current = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in current) throw new Error('read failed');
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: (current.body as SetupPublicLines).revision } });
  expect(confirmed).toMatchObject({ status: 200, body: { lines: expect.arrayContaining([
    expect.objectContaining({ key: 'policy:intake', text: 'Always charge $20.', source: 'suggested' }),
  ]) } });
  if ('network' in confirmed) throw new Error('confirm failed');
  storePublicLines(mockStore.world, params.id, (confirmed.body as SetupPublicLines).lines.map((line) => line.key === 'policy:intake' ? { ...line, source: 'owner' } : line));
  const owner = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in owner) throw new Error('read failed');
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: (owner.body as SetupPublicLines).revision } })).toMatchObject({
    status: 422, body: { error: 'line_refused', key: 'policy:intake' },
  });
});


it('rejects a stale confirmation after an unseen structured value changes without adopting anything', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const before = read.body as SetupPublicLines;
  const changed = storePublicState(mockStore.world, params.id, { ...before, prices: {
    ...before.prices!, items: before.prices!.items.map((item, index) => index === 0 ? { ...item, unit_cents: item.unit_cents + 1 } : item),
  } });
  expect(changed.revision).not.toBe(before.revision);
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: before.revision } })).toMatchObject({
    status: 409, body: { error: 'conflict' },
  });
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({ status: 200, body: changed });
  expect(changed.lines).toEqual(before.lines);
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: changed.revision } });
  expect(confirmed).toMatchObject({ status: 200, body: {
    prices: changed.prices, hours: before.hours,
    lines: expect.arrayContaining([expect.objectContaining({ key: 'policy:about', source: 'owner' })]),
  } });
});
