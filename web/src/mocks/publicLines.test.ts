import { beforeEach, expect, it } from 'vitest';

import type { PublicDesk } from '../api/contracts.ts';
import type { SetupPublicLines, QuestionKey, SetupState } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { SETUP_QUESTIONS } from './setup.ts';
import { mockStore } from './store.ts';
import { publicLineRefused } from './publicLineScan.ts';
import { holdPublicLineOnSeed, storePublicLines, storePublicState } from './publicLineStore.ts';
import { cardChrome } from '../ds/components/ReplyCard/chrome.ts';

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


/** Existing scan/publication cases explicitly approve the current listed lines, never hidden fields. */
async function confirmListed(params: { id: string }) {
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read || read.status !== 200) throw new Error('public lines unavailable');
  const state = read.body as SetupPublicLines;
  return mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: state.lines.map((line) => line.key), revision: state.revision } });
}

it('holds the signed CPA Contact until confirmation and projects its Contact label', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const lines = (read.body as SetupPublicLines).lines;
  expect(lines[1]).toEqual({ key: 'contact', text: '(408) 555-0199, linda@chenandco.com', source: 'suggested', editable: true, held: false });
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
  const key = 'policy:pricing';
  const text = 'The owner’s stored pricing words.';
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.map((line) =>
    line.key === key ? { ...line, text, source: 'owner', held: true } : line,
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
  const key = 'policy:pricing';
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

it('reads the eight public lines in order without moving the interview', async () => {
  const params = await atRules();
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  expect(read.status).toBe(200);
  const lines = (read.body as SetupPublicLines).lines;
  expect(lines.map((line) => line.key)).toEqual([
    'policy:about', 'contact', 'policy:pricing', 'policy:intake', 'policy:after_hours',
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
    ['contact', '(408) 555-0199, linda@chenandco.com'],
    ['pricing', 'We price each engagement after the intro consult, and new work starts with a retainer.'],
    ['intake', 'Before a consult, the Desk asks whether it’s for you, your business or both, which tax years or months need work, and whether you use bookkeeping software.'],
    ['after_hours', 'Outside business hours, the Desk takes a message and Linda replies the next business day.'],
    ['urgent', 'A notice from the IRS or the state with a deadline this week is urgent: the Desk tells Linda right away.'],
    ['service_area', 'Clients in San Jose and the South Bay, in person or online.'],
    ['how_we_help', 'New clients book a short introductory call.\nBefore their call, new clients answer three short questions.\nClients get a secure link to pay a retainer before work starts.'],
  ];
  const expected = { lines: board.map(([key, text]) => ({ key: key === 'contact' ? key : `policy:${key}`, text, source: 'suggested', editable: key !== 'how_we_help' })) };
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
    ['policy:pricing', 'Ask Linda for a quote.'],
  ]) {
    expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({ status: 200 });
  }
  const confirmed = await confirmListed(params);
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
  expect((read.body as SetupPublicLines).lines.every((line) => line.source === 'suggested')).toBe(true);
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({ status: 200, body: { charter: [] } });
  const key = 'policy:about';
  const text = 'We help local businesses.';
  expect(await mockStore.dispatch('setupPublicLine', { params, body: { key, text } })).toMatchObject({ status: 200 });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({
    status: 200, body: { charter: [expect.objectContaining({ fact_id: `charter:${key}`, title: text })] },
  });
  const confirmed = await confirmListed(params);
  if ('network' in confirmed) throw new Error('confirm failed');
  expect(confirmed.status).toBe(200);
  const lines = (confirmed.body as SetupPublicLines).lines;
  expect(lines.every((line) => line.source === 'owner')).toBe(true);
  expect(await mockStore.dispatch('setupPublicLines', { params })).toMatchObject({ status: 200, body: { lines } });
  expect(await mockStore.dispatch('publicDesk', { params: publicParams })).toMatchObject({
    status: 200, body: { charter: lines.map(({ key, text }) => expect.objectContaining({ fact_id: `charter:${key}`, title: text })) },
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
  storePublicLines(mockStore.world, params.id, [...(read.body as SetupPublicLines).lines, {
    key: 'contact', text: 'Contact the office.', source: 'owner', editable: true,
  }]);
  for (const [key, limit] of [['policy:about', 1500], ['policy:pricing', 500], ['contact', 200]] as const) {
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
    hours: { source: 'suggested', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }] },
    prices: { source: 'suggested', items: [
      { title: 'Tax return review', unit_cents: 25000 },
      { title: 'Business tax return', unit_cents: 60000 },
      { title: 'Monthly bookkeeping', unit_cents: 15000 },
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


it('refuses missing, empty, unknown or unlisted confirmation keys and revisions without changing state', async () => {
  const params = await atRules();
  const seed = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in seed) throw new Error('read failed');
  storePublicLines(mockStore.world, params.id, (seed.body as SetupPublicLines).lines.filter((line) => line.key !== 'contact'));
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
  storePublicLines(mockStore.world, params.id, (read.body as SetupPublicLines).lines.slice(0, count));
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
  const lines = (read.body as SetupPublicLines).lines.map((line) => line.key === 'policy:pricing' ? { ...line, text: 'Always charge $20.' } : line);
  storePublicLines(mockStore.world, params.id, lines);
  const current = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in current) throw new Error('read failed');
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: (current.body as SetupPublicLines).revision } });
  expect(confirmed).toMatchObject({ status: 200, body: { lines: expect.arrayContaining([
    expect.objectContaining({ key: 'policy:pricing', text: 'Always charge $20.', source: 'suggested' }),
  ]) } });
  if ('network' in confirmed) throw new Error('confirm failed');
  storePublicLines(mockStore.world, params.id, (confirmed.body as SetupPublicLines).lines.map((line) => line.key === 'policy:pricing' ? { ...line, source: 'owner' } : line));
  const owner = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in owner) throw new Error('read failed');
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: (owner.body as SetupPublicLines).revision } })).toMatchObject({
    status: 422, body: { error: 'line_refused', key: 'policy:pricing' },
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
  expect(changed.lines.every((line) => line.source === 'suggested')).toBe(true);
  const confirmed = await mockStore.dispatch('setupPublicLinesConfirm', { params, body: { keys: ['policy:about'], revision: changed.revision } });
  expect(confirmed).toMatchObject({ status: 200, body: {
    prices: changed.prices, hours: before.hours,
    lines: expect.arrayContaining([expect.objectContaining({ key: 'policy:about', source: 'owner' })]),
  } });
});
