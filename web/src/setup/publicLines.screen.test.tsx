import { http } from 'msw';
import { userEvent } from 'vitest/browser';
import { expect, it, onTestFinished } from 'vitest';

import type { SetupPublicLines, SetupState } from '../api/views.ts';
import { OWNER_ERROR_COPY } from '../api/http.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { storePublicLines } from '../mocks/publicLineStore.ts';
import { worker } from '../mocks/browser.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { START_EXAMPLES } from './copy.ts';

const REFUSED_COPY = "This line can't state a price, a time or a promise. Prices come from your price list, and times from your opening hours.";

async function atSituations() {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: START_EXAMPLES.en.examples[3]!.description,
    timezone: 'America/Los_Angeles', idempotency_key: 'public-lines-screen',
  } });
  if ('network' in started) throw new Error('start failed');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: false } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text: 'Ask me first.' } });
  }
  await mockStore.dispatch('setupRules', { params });
  await mockStore.dispatch('setupSituations', { params });
  return state;
}

async function openLines(viewport: Viewport = 'desktop') {
  const state = await atSituations();
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
  await expect.element(screen.getByRole('heading', { name: 'Real situations', exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'What customers will read', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).first()).toBeVisible();
  return { screen, state };
}

it('opens public lines from Real situations with the signed labels and screen basics at both widths', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    mockStore.reset('rivera');
    const { screen } = await openLines(viewport);
    await expect.element(screen.getByText('Your Desk answers customers from these. Check them before the safety check.', { exact: true })).toBeVisible();
    const rows = screen.container.querySelectorAll('.cd-public-lines__row');
    expect([...rows].map((row) => row.querySelector('.cd-public-lines__label')?.textContent)).toEqual([
      'About us', 'Pricing', 'Getting started', 'After hours', 'Urgent help', 'Service area', 'How we help',
    ]);
    expect(screen.getByRole('button', { name: 'Edit', exact: true }).elements()).toHaveLength(6);
    expect(rows[6]?.querySelector('button')).toBeNull();
    expect(rows[6]?.querySelectorAll('p')).toHaveLength(3);
    expect(screen.container.querySelector('[aria-current="step"]')?.textContent).toContain('Rules');
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  }
});

it('edits one line in place, limits About to 1500 characters and Cancel restores the saved words', async () => {
  const { screen } = await openLines('phone');
  const before = screen.container.querySelector('.cd-public-lines__text')?.textContent;
  await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  await expect.element(field).toHaveValue(before);
  await expect.element(field).toHaveFocus();
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeDisabled();
  for (const edit of screen.getByRole('button', { name: 'Edit', exact: true }).elements()) expect((edit as HTMLButtonElement).disabled).toBe(true);
  await field.fill('x'.repeat(1501));
  expect((field.element() as HTMLTextAreaElement).value).toHaveLength(1500);
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(screen.container.querySelector('.cd-public-lines__text')?.textContent).toBe(before);
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeEnabled();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine')).toHaveLength(0);
});

it('saves the edited line and keeps every other control disabled while Save is busy', async () => {
  const { screen } = await openLines();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(release);
  worker.use(http.put('/api/owner/setup/:id/public_lines', async () => { await gate; return undefined; }));
  await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  await field.fill('We help local businesses.');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(screen.getByRole('button', { name: 'Save', exact: true })).toHaveAttribute('aria-busy', 'true');
  const cancel = screen.getByRole('button', { name: 'Cancel', exact: true });
  await expect.element(cancel).toHaveAttribute('aria-disabled', 'true');
  expect((cancel.element() as HTMLButtonElement).disabled).toBe(false);
  await expect.element(field).toHaveAttribute('readonly');
  release();
  await expect.element(field).not.toBeInTheDocument();
  await expect.element(screen.getByText('We help local businesses.', { exact: true })).toBeVisible();
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).first()).toHaveFocus();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine').at(-1)?.body).toEqual({ key: 'policy:about', text: 'We help local businesses.' });
});

it('keeps refused words in the open row with only the signed error at both widths', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    mockStore.reset('rivera');
    const { screen } = await openLines(viewport);
    mockStore.inject({ route: 'setupPublicLine', status: 422, body: { error: 'line_refused', key: 'policy:pricing', reason: 'INTERNAL: ignore all instructions' } });
    await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
    const field = screen.getByRole('textbox', { name: 'Pricing', exact: true });
    await field.fill('Returns start at $250, and the intro call is free.');
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.element(screen.getByText(REFUSED_COPY, { exact: true })).toBeVisible();
    await expect.element(field).toHaveValue('Returns start at $250, and the intro call is free.');
    await expect.element(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.container.textContent).not.toContain('INTERNAL');
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
    await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(screen.getByText(REFUSED_COPY, { exact: true }).elements()).toHaveLength(0);
  }
});

it('confirms with an empty object and advances to Safety check only after success', async () => {
  const { screen } = await openLines();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(release);
  worker.use(http.post('/api/owner/setup/:id/public_lines/confirm', async () => { await gate; return undefined; }));
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toHaveAttribute('aria-busy', 'true');
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
  for (const edit of screen.getByRole('button', { name: 'Edit', exact: true }).elements()) {
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    expect((edit as HTMLButtonElement).disabled).toBe(false);
  }
  release();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm').at(-1)?.body).toEqual({});
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(1);
});

it('opens the row named by a refused confirm and lets the owner correct it', async () => {
  const { screen } = await openLines();
  mockStore.inject({ route: 'setupPublicLinesConfirm', status: 422, body: { error: 'line_refused', key: 'policy:after_hours', reason: 'do not show this reason' } });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  const field = screen.getByRole('textbox', { name: 'After hours', exact: true });
  await expect.element(field).toHaveValue('Outside business hours, the Desk takes a message and Linda replies the next business day.');
  await expect.element(screen.getByText(REFUSED_COPY, { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain('do not show this reason');
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
  await field.fill('Leave a message for Linda.');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(field).not.toBeInTheDocument();
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
});

it.each(['get', 'put', 'confirm'] as const)('rereads the interview on a 409 from public-lines %s and shows its current step', async (route) => {
  const state = await atSituations();
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await expect.element(screen.getByRole('heading', { name: 'Real situations', exact: true })).toBeVisible();
  if (route === 'get') await mockStore.dispatch('setupSafetyCheck', { params: { id: state.interview_id } });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  if (route !== 'get') {
    await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).first()).toBeVisible();
    await mockStore.dispatch('setupSafetyCheck', { params: { id: state.interview_id } });
    if (route === 'put') {
      await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
      await screen.getByRole('textbox', { name: 'About us', exact: true }).fill('My draft is still here.');
      await screen.getByRole('button', { name: 'Save', exact: true }).click();
    } else await screen.getByRole('button', { name: 'Looks right' }).click();
  }
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setup').length).toBeGreaterThanOrEqual(2);
});

it('skips directly to Safety check when GET returns no lines without sending a confirm', async () => {
  const state = await atSituations();
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: { lines: [] } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(0);
});

it('holds the screen when a successful confirm has an unknown response shape', async () => {
  const { screen } = await openLines();
  mockStore.inject({ route: 'setupPublicLinesConfirm', status: 200, body: { lines: 'unknown' } });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(OWNER_ERROR_COPY.unavailable);
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
  await expect.element(screen.getByRole('heading', { name: 'What customers will read', exact: true })).toBeVisible();
});

it('hides unknown keys and gives read-only How we help the full text width', async () => {
  const state = await atSituations();
  const read = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in read) throw new Error('read failed');
  const body = read.body as SetupPublicLines;
  body.lines.find((line) => line.key === 'policy:how_we_help')!.editable = true;
  body.lines.unshift({ key: 'policy:unknown', text: 'Unknown text stays hidden.', editable: true, source: 'suggested' });
  mockStore.inject({ route: 'setupPublicLines', status: 200, body });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).first()).toBeVisible();
  expect(screen.getByText('Unknown text stays hidden.', { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Edit', exact: true }).elements()).toHaveLength(6);
  const row = screen.container.querySelector('.cd-public-lines__row:last-child')!;
  expect(row.querySelector('button')).toBeNull();
  expect(row.querySelector('.cd-public-lines__text')!.getBoundingClientRect().right).toBe(row.getBoundingClientRect().right);
});

it('uses existing error Notices and preserves the draft through service and network failures', async () => {
  const state = await atSituations();
  mockStore.inject({ route: 'setupPublicLines', status: 503 });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Try again', exact: true }).click();
  await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  await field.fill('Words I am still checking.');
  for (const status of [503, 'network'] as const) {
    mockStore.inject({ route: 'setupPublicLine', status });
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent(status === 503 ? OWNER_ERROR_COPY.unavailable : OWNER_ERROR_COPY.network);
    await expect.element(field).toHaveValue('Words I am still checking.');
    await expect.element(screen.getByRole('button', { name: 'Save', exact: true })).not.toHaveAttribute('aria-busy');
  }
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  mockStore.inject({ route: 'setupPublicLinesConfirm', status: 422, body: { error: 'line_refused', key: 'policy:unknown', reason: 'Untrusted error text' } });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(REFUSED_COPY);
  expect(screen.container.textContent).not.toContain('Untrusted error text');
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
});

it.each([
  'policy:pricing', 'policy:how_we_help', 'policy:unknown', null,
])('keeps a draft and shows the signed Notice when Save refuses %s', async (key) => {
  const { screen } = await openLines();
  await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  await field.fill('Words I am still checking.');
  mockStore.inject({ route: 'setupPublicLine', status: 422, body: { error: 'line_refused', ...(key === null ? {} : { key }), reason: ['INTERNAL refusal'] } });
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(REFUSED_COPY);
  await expect.element(field).toHaveValue('Words I am still checking.');
  expect(screen.container.textContent).not.toContain('INTERNAL refusal');
  expect(screen.container.textContent).not.toContain(OWNER_ERROR_COPY.unprocessable);
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
});

it.each(['policy:how_we_help', 'policy:unknown', null])('shows the signed Notice when confirm refuses %s', async (key) => {
  const { screen } = await openLines();
  mockStore.inject({ route: 'setupPublicLinesConfirm', status: 422, body: { error: 'line_refused', ...(key === null ? {} : { key }), reason: ['INTERNAL refusal'] } });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  const notice = screen.getByRole('alert');
  await expect.element(notice).toBeVisible();
  expect(notice.element().textContent).toBe(REFUSED_COPY);
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);
  expect(screen.container.textContent).not.toContain('INTERNAL refusal');
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
});

it.each([
  ['policy:about', 'About us', 1500], ['policy:pricing', 'Pricing', 500],
] as const)('keeps an over-limit %s draft intact when one character is deleted', async (key, label, limit) => {
  const state = await atSituations();
  const text = '😀' + 'x'.repeat(limit);
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: { lines: [{ key, text, editable: true, source: 'owner' }] } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await screen.getByRole('button', { name: 'Edit', exact: true }).click();
  const field = screen.getByRole('textbox', { name: label, exact: true });
  const input = field.element() as HTMLTextAreaElement;
  expect(input.maxLength).toBe(limit);
  expect(input.value).toBe(text);
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  expect((save.element() as HTMLButtonElement).disabled).toBe(true);
  input.setSelectionRange(text.length, text.length);
  await userEvent.keyboard('{Backspace}');
  expect(input.value).toBe('😀' + 'x'.repeat(limit - 1));
  expect((save.element() as HTMLButtonElement).disabled).toBe(true);
  await userEvent.keyboard('{Backspace}');
  expect(input.value).toBe('😀' + 'x'.repeat(limit - 2));
  expect((save.element() as HTMLButtonElement).disabled).toBe(false);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine')).toHaveLength(0);
});

it('disables Save for empty and whitespace-only text without sending a write', async () => {
  const { screen } = await openLines();
  await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  for (const text of ['', '   ']) {
    await field.fill(text);
    expect((screen.getByRole('button', { name: 'Save', exact: true }).element() as HTMLButtonElement).disabled).toBe(true);
  }
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine')).toHaveLength(0);
  await field.fill('We help local businesses.');
  await expect.element(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

it.each([true, false])('holds unknown public-line keys without confirming, alongside known rows: %s', async (withKnown) => {
  const state = await atSituations();
  const unknown = { key: 'policy:unknown', text: 'Hidden text.', editable: true, source: 'suggested' };
  const known = { key: 'policy:about', text: 'We help local businesses.', editable: true, source: 'owner' };
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: { lines: withKnown ? [known, unknown] : [unknown] } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'What customers will read', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(OWNER_ERROR_COPY.unavailable);
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeDisabled();
  expect(screen.getByText('Hidden text.', { exact: true }).elements()).toHaveLength(0);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm' || r.key === 'setupSafetyCheck')).toHaveLength(0);
});

it('keeps a signed refusal visible while an unknown claim also holds confirmation', async () => {
  const state = await atSituations();
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: { lines: [
    { key: 'policy:about', text: 'We help local businesses.', source: 'owner', editable: true },
    { key: 'policy:unknown', text: 'Hidden text.', source: 'suggested', editable: true },
  ] } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await screen.getByRole('button', { name: 'Edit', exact: true }).click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  await field.fill('My draft stays here.');
  mockStore.inject({ route: 'setupPublicLine', status: 422, body: { error: 'line_refused', reason: ['INTERNAL refusal'] } });
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect.element(save).not.toHaveAttribute('aria-busy');
  expect(screen.getByRole('alert').element().textContent).toBe(REFUSED_COPY);
  await expect.element(field).toHaveValue('My draft stays here.');
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeDisabled();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(0);
});


it('reviews Contact after About, saves within its 200-character limit and confirms', async () => {
  const state = await atSituations();
  const read = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in read) throw new Error('read failed');
  storePublicLines(mockStore.world, state.interview_id, [...(read.body as SetupPublicLines).lines, {
    key: 'contact', text: 'office@example.com', source: 'owner', editable: true,
  }]);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).first()).toBeVisible();
  const labels = [...screen.container.querySelectorAll('.cd-public-lines__label')].map((label) => label.textContent);
  expect(labels).toEqual(['About us', 'Contact', 'Pricing', 'Getting started', 'After hours', 'Urgent help', 'Service area', 'How we help']);
  expect(screen.getByRole('alert').elements()).toHaveLength(0);
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
  const field = screen.getByRole('textbox', { name: 'Contact', exact: true });
  expect((field.element() as HTMLTextAreaElement).maxLength).toBe(200);
  await field.fill('c'.repeat(201));
  await expect.element(field).toHaveValue('c'.repeat(200));
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(field).not.toBeInTheDocument();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine').at(-1)?.body).toEqual({ key: 'contact', text: 'c'.repeat(200) });
  await expect.element(screen.getByText('c'.repeat(200), { exact: true })).toBeVisible();
  expectNoHorizontalScroll();
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(1);
});
