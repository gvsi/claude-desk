import { beforeEach, expect, it } from 'vitest';

import type { SetupPublicLines, QuestionKey, SetupState } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { SETUP_QUESTIONS } from './setup.ts';
import { mockStore } from './store.ts';
import { publicLineRefused } from './publicLineScan.ts';
import { storePublicLines } from './publicLineStore.ts';

beforeEach(() => mockStore.reset('rivera'));

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
  await mockStore.dispatch('setupRules', { params });
  return params;
}

it('reads the seven public lines in order without moving the interview', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  expect(read.status).toBe(200);
  const lines = (read.body as SetupPublicLines).lines;
  expect(lines.map((line) => line.key)).toEqual([
    'policy:about', 'policy:pricing', 'policy:intake', 'policy:after_hours',
    'policy:urgent', 'policy:service_area', 'policy:how_we_help',
  ]);
  expect(lines.at(-1)).toMatchObject({ editable: false });
  expect(lines.at(-1)?.text.split('\n')).toHaveLength(3);
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
    ['about', 'Chen & Co. CPA is a two-person CPA firm in San Jose. We do tax returns and bookkeeping for individuals and small businesses.'],
    ['pricing', 'We price each engagement after the intro consult, and new work starts with a retainer.'],
    ['intake', 'Before a consult, the Desk asks whether it’s for you, your business or both, which tax years or months need work, and whether you use bookkeeping software.'],
    ['after_hours', 'Outside business hours, the Desk takes a message and Linda replies the next business day.'],
    ['urgent', 'A notice from the IRS or the state with a deadline this week is urgent: the Desk tells Linda right away.'],
    ['service_area', 'Clients in San Jose and the South Bay, in person or online.'],
    ['how_we_help', 'New clients book a short introductory call.\nBefore their call, new clients answer three short questions.\nClients get a secure link to pay a retainer before work starts.'],
  ];
  const expected = { lines: board.map(([key, text]) => ({ key: `policy:${key}`, text, source: 'suggested', editable: key !== 'how_we_help' })) };
  const read = await mockStore.dispatch('setupPublicLines', { params });
  expect(read).toMatchObject({ status: 200, body: expected });
  if ('network' in read) throw new Error('read failed');
  for (const answer of Object.values(limits)) {
    for (const line of (read.body as SetupPublicLines).lines) expect(line.text).not.toContain(answer);
  }
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} })).toMatchObject({ status: 200, body: expected });
});

it('seeds other businesses only from their About and explicit after-hours clauses', async () => {
  const limits = {
    quote_limit: 'Always ask me first for quotes.',
    discounts: 'Never offer discounts.',
    documents_and_payments: 'Documents require verification and payments always ask me.',
    money_limit: '$500 is the money limit.',
  };
  const knownAbout = { key: 'policy:about', text: 'We help local businesses.', source: 'owner', editable: true };
  for (const [contact, afterHours] of [
    ['Email me at lee@example.com; After hours, take a message.', 'After hours, take a message.'],
    ['Call me. Outside business hours, take a message.', 'Outside business hours, take a message.'],
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
    expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} })).toMatchObject({ status: 200 });
  }
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
  expect(read).toMatchObject({ body: { lines: expect.arrayContaining([{ key, text: 'x'.repeat(500), source: 'owner', editable: true }]) } });
});

it('confirms all lines, rescans seeded answers and leaves the interview at rules', async () => {
  const params = await atRules();
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} });
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
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params: unsafe, body: {} })).toMatchObject({
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
      charter: (confirmed.body as SetupPublicLines).lines.map(({ key, text }) => expect.objectContaining({
        fact_id: `charter:${key}`, title: text,
      })),
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
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} })).toMatchObject({
    status: 422, body: { error: 'line_refused', key },
  });
  expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject(hiddenClaim);
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject(ownerDraft);

  const accepted = 'Ask Linda for a quote.';
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: accepted } })).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} })).toMatchObject({ status: 200 });
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
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:pricing', text } })).toMatchObject({
      status: 422, body: { error: 'line_refused', key: 'policy:pricing' },
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
    const seeded = `After hours, ${text}.`;
    const params = await atRules({ contact_and_after_hours: seeded }, 'Lakeview Accounts. We help local businesses.');
    const setup = await mockStore.dispatch('setup', { params });
    if ('network' in setup) throw new Error('setup read failed');
    const publicParams = { slug: (setup.body as SetupState).slug };
    expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({
      status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text: seeded })]) },
    });
    const hiddenClaim = { status: 200, body: { charter: expect.not.arrayContaining([expect.objectContaining({ fact_id: `charter:${key}` })]) } };
    expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject(hiddenClaim);
    expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} })).toMatchObject({
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

it('scans read-only How we help before confirmation and public publication', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const key = 'policy:how_we_help';
  const text = 'Book a free 20-minute call.';
  // Reproduce an unsafe code-built draft without allowing an owner to edit the read-only claim.
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.map((line) =>
    line.key === key ? { ...line, text } : line,
  ));
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({
    status: 200, body: { lines: expect.arrayContaining([expect.objectContaining({ key, text, editable: false })]) },
  });
  const setup = await mockStore.dispatch('setup', { params });
  if ('network' in setup) throw new Error('setup read failed');
  const publicParams = { slug: (setup.body as SetupState).slug };
  const hiddenClaim = { status: 200, body: { charter: expect.not.arrayContaining([expect.objectContaining({ fact_id: `charter:${key}` })]) } };
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject(hiddenClaim);
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: {} })).toMatchObject({
    status: 422, body: { error: 'line_refused', key },
  });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject(hiddenClaim);
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text: 'A replacement.' } })).toMatchObject({
    status: 422, body: { error: 'not_editable', key },
  });
});
