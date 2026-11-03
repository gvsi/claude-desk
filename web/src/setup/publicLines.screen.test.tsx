import { http } from 'msw';
import { userEvent } from 'vitest/browser';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { SetupPublicLine, SetupPublicLines, SetupState } from '../api/views.ts';
import { OWNER_ERROR_COPY } from '../api/http.ts';
import { CHANGED_REFRESHED } from '../ds/index.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { holdPublicLineOnSeed, storedPublicState, storePublicLines, storePublicState } from '../mocks/publicLineStore.ts';
import { worker } from '../mocks/browser.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';
import { START_EXAMPLES } from './copy.ts';

const publicState = (lines: SetupPublicLine[]): SetupPublicLines => ({ lines, hours: null, prices: null, revision: 'fixture-revision' });

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
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).nth(1)).toBeVisible();
  return { screen, state };
}

it('removes the hours set once across multiple windows', async () => {
  const state = await atSituations();
  const params = { id: state.interview_id };
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  storePublicState(mockStore.world, params.id, { ...(read.body as SetupPublicLines), hours: { source: 'suggested', windows: [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' },
    { days: ['sat'], start: '10:00', end: '12:00' },
  ] } });
  const { screen } = await renderRoute(`/app/setup/${params.id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByText('Sat, 10 am – 12 pm', { exact: true })).toBeVisible();
  const rows = [...screen.container.querySelectorAll('.cd-public-lines__row')].filter((row) => /Mon–Fri|Sat,/.test(row.textContent ?? ''));
  expect(rows).toHaveLength(1);
  expect([...rows[0]!.querySelectorAll('.cd-public-lines__text p')].map((p) => p.textContent)).toEqual([
    'Mon–Fri, 9 am – 6 pm', 'Sat, 10 am – 12 pm',
  ]);
  expect(rows.flatMap((row) => [...row.querySelectorAll('button')])).toHaveLength(1);
  const remove = rows[0]!.querySelector('button')!;
  expect(remove.textContent).toBe('Remove');
  expect(document.getElementById(remove.getAttribute('aria-describedby')!)?.textContent).toContain('Mon–Fri, 9 am – 6 pm');
  expect(document.getElementById(remove.getAttribute('aria-describedby')!)?.textContent).toContain('Sat, 10 am – 12 pm');
  await userEvent.click(remove);
  await expect.element(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText('Sat, 10 am – 12 pm', { exact: true })).not.toBeInTheDocument();
  expect(storedPublicState(mockStore.world, params.id)!.hours).toBeNull();
  expect(mockStore.requests.filter((r) => r.key === 'removePublicLine').at(-1)?.path).toBe(`/api/owner/setup/${params.id}/public_lines/hours`);
});

it('natively dims Looks right and every Remove while a row is open', async () => {
  const { screen } = await openLines('phone');
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
  const looksRight = screen.getByRole('button', { name: 'Looks right' }).element() as HTMLButtonElement;
  expect(looksRight.disabled).toBe(true);
  expect(looksRight.classList.contains('cd-button--waiting')).toBe(false);
  const removes = screen.getByRole('button', { name: /^Remove/ }).elements() as HTMLButtonElement[];
  expect(removes).toHaveLength(5);
  for (const remove of removes) {
    expect(remove.disabled).toBe(true);
    expect(remove.classList.contains('cd-button--waiting')).toBe(false);
  }
});

it.each([409, 422])('announces a successful stale Remove refresh with the shared changed line after %s', async (status) => {
  const { screen, state } = await openLines();
  await mockStore.dispatch('setupPublicLine', { params: { id: state.interview_id }, body: { key: 'contact', text: 'office@example.com' } });
  if (status === 409) mockStore.inject({ route: 'removePublicLine', status, body: { error: 'conflict' } });
  await screen.getByRole('button', { name: /^Remove/ }).first().click();
  await expect.element(screen.getByText('office@example.com', { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(CHANGED_REFRESHED.en);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove', exact: true }).first().element());
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(0);
});

it('adopts changed remaining prices from a successful Remove and asks for review', async () => {
  const { screen, state } = await openLines();
  const data = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
  data.revision = 'changed-response';
  data.prices!.items.splice(1, 1);
  data.prices!.items[1] = { item_id: 'updated-bookkeeping', title: 'Updated bookkeeping', unit_cents: 17500 };
  mockStore.inject({ route: 'removePublicPrice', status: 200, body: data });
  await screen.getByRole('button', { name: /^Remove/ }).nth(3).click();
  await expect.element(screen.getByRole('button', { name: /^Remove/ }).nth(3)).not.toHaveAttribute('aria-busy');
  expect(screen.getByRole('alert').element().textContent).toContain(CHANGED_REFRESHED.en);
  await expect.element(screen.getByText('Updated bookkeeping, $175', { exact: true })).toBeVisible();
  expect(screen.getByText('Business tax return, $600', { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByText('Monthly bookkeeping, $150', { exact: true }).elements()).toHaveLength(0);
  expect(document.activeElement === screen.getByRole('button', { name: 'Remove', exact: true }).nth(3).element()).toBe(true);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(0);
});

it('shows only the list error when a stale confirm refetch fails', async () => {
  const { screen, state } = await openLines();
  await mockStore.dispatch('setupPublicLine', { params: { id: state.interview_id }, body: { key: 'policy:about', text: 'Changed in another tab.' } });
  mockStore.inject({ route: 'setupPublicLines', status: 503 });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(screen.getByRole('alert').elements()).toHaveLength(1);
  expect(screen.getByRole('alert').element().textContent).toContain(OWNER_ERROR_COPY.unavailable);
  expect(screen.getByRole('button', { name: 'Looks right' }).elements()).toHaveLength(0);
});

it('shows one notice without refetching lines when a stale confirm interview read fails', async () => {
  const { screen, state } = await openLines();
  await mockStore.dispatch('setupPublicLine', { params: { id: state.interview_id }, body: { key: 'policy:about', text: 'Changed in another tab.' } });
  mockStore.inject({ route: 'setup', status: 503 });
  mockStore.inject({ route: 'setupPublicLines', status: 503 });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('alert').first()).toBeVisible();
  await expect.poll(() => screen.container.querySelector('[aria-busy="true"]') === null).toBe(true);
  expect(screen.getByRole('alert').elements()).toHaveLength(1);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLines')).toHaveLength(1);
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
});

it('keeps an emptied review screen until Looks right after removing its last item', async () => {
  const state = await atSituations();
  const params = { id: state.interview_id };
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  storePublicState(mockStore.world, params.id, { lines: (read.body as SetupPublicLines).lines.filter((line) => line.key === 'contact'), hours: null, prices: null });
  const { screen } = await renderRoute(`/app/setup/${params.id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await screen.getByRole('button', { name: /^Remove/ }).click();
  await expect.element(screen.getByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'What customers will read', exact: true }).elements()).toHaveLength(1);
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck' || r.key === 'setupPublicLinesConfirm')).toHaveLength(0);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(0);
});

it('removes a suggested policy line through its encoded URL and redraws the list', async () => {
  const state = await atSituations();
  const params = { id: state.interview_id };
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  const data = read.body as SetupPublicLines;
  const text = data.lines.find((line) => line.key === 'policy:after_hours')!.text;
  storePublicLines(mockStore.world, params.id, data.lines.map((line) => line.key === 'policy:after_hours' ? { ...line, source: 'suggested' } : line));
  const { screen } = await renderRoute(`/app/setup/${params.id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: /^Remove/ }).nth(1).click();
  await expect.element(screen.getByText(text, { exact: true })).not.toBeInTheDocument();
  expect(mockStore.requests.filter((r) => r.key === 'removePublicLine').at(-1)?.path).toBe(`/api/owner/setup/${params.id}/public_lines/policy%3Aafter_hours`);
  await expect.element(screen.getByText('Tax return review, $250', { exact: true })).toBeVisible();
});

it('keeps price row identity and restores Remove focus to the next row or fallback', async () => {
  const { screen } = await openLines('phone');
  const monthlyRemove = screen.getByRole('button', { name: /^Remove/ }).nth(4).element();
  await screen.getByRole('button', { name: /^Remove/ }).nth(3).click();
  await expect.element(screen.getByText('Business tax return, $600', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Remove/ }).nth(3).element()).toBe(monthlyRemove);
  // Focus moves once the removal is saved and the list redrawn, which on a loaded runner can be a
  // render after the removed row's words go: wait for it to land, on exactly the element it should.
  const focusLands = (target: () => Element | null) => vi.waitFor(() => expect(document.activeElement).toBe(target()));
  await focusLands(() => monthlyRemove);
  await screen.getByRole('button', { name: /^Remove/ }).nth(3).click();
  await expect.element(screen.getByText('Monthly bookkeeping, $150', { exact: true })).not.toBeInTheDocument();
  await focusLands(() => screen.container.querySelector('.cd-public-lines-suggested__heading'));
  await screen.getByRole('button', { name: /^Remove/ }).first().click();
  await expect.element(screen.getByText('(408) 555-0199, linda@chenandco.com', { exact: true })).not.toBeInTheDocument();
  await focusLands(() => screen.getByRole('button', { name: 'Remove', exact: true }).first().element());
  await screen.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect.element(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true })).not.toBeInTheDocument();
  await focusLands(() => screen.getByRole('button', { name: /^Remove/ }).element());
  await screen.getByRole('button', { name: /^Remove/ }).click();
  await expect.element(screen.getByText('Suggested by Claude, please check', { exact: true })).not.toBeInTheDocument();
  await focusLands(() => screen.getByRole('button', { name: 'Looks right' }).element());
});

it.each(['line', 'hours', 'prices'] as const)('holds malformed %s data before confirmation', async (field) => {
  const state = await atSituations();
  const read = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in read) throw new Error('read failed');
  const data = read.body as SetupPublicLines;
  const body = field === 'line' ? { ...data, lines: data.lines.map((line) => ({ ...line, held: 0 })) }
    : field === 'hours' ? { ...data, hours: { ...data.hours!, windows: [{ ...data.hours!.windows[0]!, end: '18:00:60' }] } }
      : { ...data, prices: { ...data.prices!, items: [data.prices!.items[0], data.prices!.items[0]] } };
  mockStore.inject({ route: 'setupPublicLines', status: 200, body });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(screen.getByRole('alert').elements()).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Looks right' }).elements()).toHaveLength(0);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm' || r.key === 'setupSafetyCheck')).toHaveLength(0);
});

it('confirms rendered group keys with the latest revision after removing Hours', async () => {
  const { screen, state } = await openLines('phone');
  await expect.element(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: /^Remove/ }).nth(1).click();
  await expect.element(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true })).not.toBeInTheDocument();
  const current = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.poll(() => mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')).toBeDefined();
  expect(mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')?.body).toEqual({
    keys: [...current.lines.map((line) => line.key), 'prices'], revision: current.revision,
  });
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  const confirmed = storedPublicState(mockStore.world, state.interview_id)!;
  expect(confirmed.hours).toBeNull();
  expect(confirmed.prices?.source).toBe('owner');
});

it('opens a held line with the owner’s words and signed refusal, and publishes an accepted rewrite', async () => {
  const state = await atSituations();
  const text = 'We always charge $250.';
  holdPublicLineOnSeed(mockStore.world, state.interview_id, 'policy:about', text);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone', strict: true });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  await expect.element(field).toHaveValue(text);
  await expect.element(field).toHaveAttribute('aria-invalid', 'true');
  await expect.element(screen.getByText(REFUSED_COPY, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeDisabled();
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
  await field.fill('We help local businesses.');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(field).not.toBeInTheDocument();
  expect(screen.getByText(REFUSED_COPY, { exact: true }).elements()).toHaveLength(0);
  const saved = storedPublicState(mockStore.world, state.interview_id)!;
  expect(saved.lines.find((line) => line.key === 'policy:about')).toMatchObject({ text: 'We help local businesses.', source: 'owner', held: false });
  expect(await mockStore.dispatch('publicDesk', { params: { slug: state.slug } })).toMatchObject({ status: 200, body: { charter: saved.lines.filter((line) => line.source === 'owner' && !line.held).map((line) => expect.objectContaining({ fact_id: `charter:${line.key}`, title: line.text })) } });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')?.body).toEqual({ keys: [...saved.lines.filter((line) => !line.held).map((line) => line.key), 'hours', 'prices'], revision: saved.revision });
});

it('keeps a successful save open in the refused state when its returned line is still held', async () => {
  const { screen, state } = await openLines('phone');
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
  const field = screen.getByRole('textbox', { name: 'About us', exact: true });
  const text = 'The owner’s revised words.';
  await field.fill(text);
  const current = storedPublicState(mockStore.world, state.interview_id)!;
  const saved = { ...structuredClone(current), revision: 'saved-but-held', lines: current.lines.map((line) =>
    line.key === 'policy:about' ? { ...line, text, source: 'owner', held: true } : line,
  ) };
  mockStore.inject({ route: 'setupPublicLine', status: 200, body: saved });
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(screen.getByRole('button', { name: 'Save', exact: true })).not.toHaveAttribute('aria-busy');
  await expect.element(field).toHaveValue(text);
  await expect.element(field).toHaveAttribute('aria-invalid', 'true');
  await expect.element(screen.getByText(REFUSED_COPY, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeDisabled();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm' || r.key === 'setupSafetyCheck')).toHaveLength(0);
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(field).not.toBeInTheDocument();
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
  await expect.element(field).toHaveValue(text);
  await expect.element(field).toHaveAttribute('aria-invalid', 'true');
});

it('opens the first held row in display order, preserves canceled holds and confirms only other lines', async () => {
  const state = await atSituations();
  const held = [
    { key: 'policy:intake', text: 'We always charge $250.' },
    { key: 'policy:about', text: 'We always reply within 20 minutes.' },
  ];
  for (const line of held) holdPublicLineOnSeed(mockStore.world, state.interview_id, line.key, line.text);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  const about = screen.getByRole('textbox', { name: 'About us', exact: true });
  await expect.element(about).toHaveValue(held[1]!.text);
  expect(screen.getByRole('textbox').elements()).toHaveLength(1);
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(about).not.toBeInTheDocument();
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(2).click();
  const intake = screen.getByRole('textbox', { name: 'Getting started', exact: true });
  await expect.element(intake).toHaveValue(held[0]!.text);
  await expect.element(intake).toHaveAttribute('aria-invalid', 'true');
  await expect.element(screen.getByText(REFUSED_COPY, { exact: true })).toBeVisible();
  expect(screen.getByRole('textbox').elements()).toHaveLength(1);
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  const before = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.poll(() => mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')).toBeDefined();
  const selected = before.lines.filter((line) => !line.held);
  expect(mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')?.body).toEqual({ keys: [...selected.map((line) => line.key), 'hours', 'prices'], revision: before.revision });
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  const after = storedPublicState(mockStore.world, state.interview_id)!;
  for (const line of held) expect(after.lines.find((candidate) => candidate.key === line.key)).toEqual(before.lines.find((candidate) => candidate.key === line.key));
  expect(after.hours).toEqual({ ...before.hours, source: 'owner' });
  expect(after.prices).toEqual({ ...before.prices, source: 'owner' });
  expect(await mockStore.dispatch('publicDesk', { params: { slug: state.slug } })).toMatchObject({ status: 200, body: {
    charter: [...selected.map((line) => expect.objectContaining({ fact_id: `charter:${line.key}`, title: line.text })), expect.objectContaining({ fact_id: 'charter:hours' })],
  } });
});

it('skips a read-only held row on load and opens the first editable held row', async () => {
  const state = await atSituations();
  const read = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in read) throw new Error('read failed');
  storePublicLines(mockStore.world, state.interview_id, (read.body as SetupPublicLines).lines.map((line) =>
    line.key === 'policy:about' ? { ...line, held: true, editable: false }
      : line.key === 'policy:intake' ? { ...line, held: true } : line,
  ));
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('textbox', { name: 'Getting started', exact: true })).toHaveValue((read.body as SetupPublicLines).lines.find((line) => line.key === 'policy:intake')!.text);
  await expect.element(screen.getByText(REFUSED_COPY, { exact: true })).toBeVisible();
  expect(screen.getByRole('textbox').elements()).toHaveLength(1);
  const about = screen.container.querySelector('.cd-public-lines--owned .cd-public-lines__row')!;
  expect(about.querySelector('textarea')).toBeNull();
  expect(about.querySelector('button')).toBeNull();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine')).toHaveLength(0);
});

it('holds a malformed held flag instead of confirming the line', async () => {
  const state = await atSituations();
  const read = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in read) throw new Error('read failed');
  const body = read.body as SetupPublicLines;
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: { ...body, lines: body.lines.map((line) => ({ ...line, held: 0 })) } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.poll(() => screen.getByRole('button', { name: 'Edit', exact: true }).elements().length > 0 || screen.getByRole('alert').elements().length > 0).toBe(true);
  expect(screen.getByRole('alert').elements()).toHaveLength(1);
  await expect.element(screen.getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Looks right' }).elements()).toHaveLength(0);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm' || r.key === 'setupSafetyCheck')).toHaveLength(0);
});

it('continues after canceling when every displayed line is held without confirming or publishing it', async () => {
  const state = await atSituations();
  await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  storePublicState(mockStore.world, state.interview_id, { lines: [{ key: 'policy:about', text: 'The owner’s stored words.', source: 'owner', editable: true, held: true }], hours: null, prices: null });
  const before = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('textbox', { name: 'About us', exact: true })).toHaveValue('The owner’s stored words.');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeEnabled();
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(0);
  expect(storedPublicState(mockStore.world, state.interview_id)).toEqual(before);
  expect(await mockStore.dispatch('publicDesk', { params: { slug: state.slug } })).toMatchObject({ status: 200, body: { charter: [] } });
});

it('opens public lines from Real situations with the signed labels and screen basics at both widths', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    mockStore.reset('rivera');
    const { screen } = await openLines(viewport);
    await expect.element(screen.getByText('Your Desk answers customers from these. Check them before the safety check.', { exact: true })).toBeVisible();
    const rows = screen.container.querySelectorAll('.cd-public-lines--owned .cd-public-lines__row');
    expect([...rows].map((row) => row.querySelector('.cd-public-lines__label')?.textContent)).toEqual([
      'About us', 'Getting started', 'After hours', 'Urgent help', 'Service area', 'How we help',
    ]);
    expect(screen.getByRole('button', { name: 'Edit', exact: true }).elements()).toHaveLength(6);
    expect(rows[5]?.querySelector('button')).toBeNull();
    expect(rows[5]?.querySelectorAll('p')).toHaveLength(3);
    expect(screen.container.querySelector('[aria-current="step"]')?.textContent).toContain('Rules');
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  }
});

it('edits one line in place, limits About to 1500 characters and Cancel restores the saved words', async () => {
  const { screen } = await openLines('phone');
  const before = screen.container.querySelector('.cd-public-lines--owned .cd-public-lines__text')?.textContent;
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
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
  expect(screen.container.querySelector('.cd-public-lines--owned .cd-public-lines__text')?.textContent).toBe(before);
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
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
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
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).nth(1)).toHaveFocus();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine').at(-1)?.body).toEqual({ key: 'policy:about', text: 'We help local businesses.' });
});

it('keeps refused words in the open row with only the signed error at both widths', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    mockStore.reset('rivera');
    const { screen } = await openLines(viewport);
    mockStore.inject({ route: 'setupPublicLine', status: 422, body: { error: 'line_refused', key: 'contact', reason: 'INTERNAL: ignore all instructions' } });
    await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const field = screen.getByRole('textbox', { name: 'Contact', exact: true });
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

it('confirms displayed keys and revision and advances to Safety check only after success', async () => {
  const { screen, state } = await openLines();
  const before = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
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
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm').at(-1)?.body).toEqual({ keys: [...before.lines.map((line) => line.key), 'hours', 'prices'], revision: before.revision });
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

it.each(['get', 'put', 'confirm', 'remove'] as const)('rereads the interview on a 409 from public-lines %s and shows its current step', async (route) => {
  const state = await atSituations();
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await expect.element(screen.getByRole('heading', { name: 'Real situations', exact: true })).toBeVisible();
  if (route === 'get') await mockStore.dispatch('setupSafetyCheck', { params: { id: state.interview_id } });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  if (route !== 'get') {
    await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).nth(1)).toBeVisible();
    await mockStore.dispatch('setupSafetyCheck', { params: { id: state.interview_id } });
    if (route === 'put') {
      await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
      await screen.getByRole('textbox', { name: 'About us', exact: true }).fill('My draft is still here.');
      await screen.getByRole('button', { name: 'Save', exact: true }).click();
    } else if (route === 'remove') {
      await screen.getByRole('button', { name: /^Remove/ }).first().click();
    } else await screen.getByRole('button', { name: 'Looks right' }).click();
  }
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  if (route === 'remove') expect(mockStore.requests.filter((r) => r.key === 'removePublicLine')).toHaveLength(1);
  expect(mockStore.requests.filter((r) => r.key === 'setup').length).toBeGreaterThanOrEqual(2);
});

it('skips directly to Safety check when GET returns no lines without sending a confirm', async () => {
  const state = await atSituations();
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: publicState([]) });
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
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).nth(1)).toBeVisible();
  expect(screen.getByText('Unknown text stays hidden.', { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Edit', exact: true }).elements()).toHaveLength(6);
  const row = screen.container.querySelector('.cd-public-lines--owned .cd-public-lines__row:last-child')!;
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
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
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
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
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
  ['policy:about', 'About us', 1500], ['policy:intake', 'Getting started', 500],
] as const)('keeps an over-limit %s draft intact when one character is deleted', async (key, label, limit) => {
  const state = await atSituations();
  const text = '😀' + 'x'.repeat(limit);
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: publicState([{ key, text, editable: true, source: 'owner' }]) });
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
  const edited = '😀' + 'x'.repeat(limit - 1);
  expect(input.value).toBe(edited);
  expect(Array.from(input.value)).toHaveLength(limit);
  expect((save.element() as HTMLButtonElement).disabled).toBe(false);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine')).toHaveLength(0);
  await save.click();
  await expect.element(field).not.toBeInTheDocument();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLine').at(-1)?.body).toEqual({ key, text: edited });
  await expect.element(screen.getByText(edited, { exact: true })).toBeVisible();
});

it('disables Save for empty and whitespace-only text without sending a write', async () => {
  const { screen } = await openLines();
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
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
  const unknown: SetupPublicLine = { key: 'policy:unknown', text: 'Hidden text.', editable: true, source: 'suggested' };
  const known: SetupPublicLine = { key: 'policy:about', text: 'We help local businesses.', editable: true, source: 'owner' };
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: publicState(withKnown ? [known, unknown] : [unknown]) });
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
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: publicState([
    { key: 'policy:about', text: 'We help local businesses.', source: 'owner', editable: true },
    { key: 'policy:unknown', text: 'Hidden text.', source: 'suggested', editable: true },
  ]) });
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
  storePublicLines(mockStore.world, state.interview_id, [...(read.body as SetupPublicLines).lines.filter((line) => line.key !== 'contact'), {
    key: 'contact', text: 'office@example.com', source: 'owner', editable: true,
  }]);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('button', { name: 'Edit', exact: true }).first()).toBeVisible();
  const labels = [...screen.container.querySelectorAll('.cd-public-lines--owned .cd-public-lines__label')].map((label) => label.textContent);
  expect(labels).toEqual(['About us', 'Contact', 'Getting started', 'After hours', 'Urgent help', 'Service area', 'How we help']);
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


it('scrolls a cross-line refusal Notice into view from a low open row on a phone', async () => {
  const state = await atSituations();
  const params = { id: state.interview_id };
  const read = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in read) throw new Error('read failed');
  storePublicLines(mockStore.world, state.interview_id, (read.body as SetupPublicLines).lines.map((line) =>
    line.key === 'policy:about' ? { ...line, text: 'We help local businesses. '.repeat(60).trim() } : line,
  ));
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await screen.getByRole('button', { name: 'Edit', exact: true }).nth(5).click();
  const field = screen.getByRole('textbox', { name: 'Service area', exact: true });
  await field.fill('Clients can reach our team.');
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  const refuse = () => mockStore.inject({ route: 'setupPublicLine', status: 422, body: { error: 'line_refused', key: 'policy:about', reason: ['INTERNAL refusal'] } });
  refuse();
  await save.click();
  const notice = screen.getByRole('alert');
  await expect.element(notice).toHaveTextContent(REFUSED_COPY);
  await expect.element(save).not.toHaveAttribute('aria-busy');
  window.scrollTo(0, document.documentElement.scrollHeight);
  await expect.poll(() => notice.element().getBoundingClientRect().bottom).toBeLessThan(0);
  refuse();
  await save.click();
  await expect.element(notice).toHaveTextContent(REFUSED_COPY);
  await expect.poll(() => {
    const bounds = notice.element().getBoundingClientRect();
    return bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1;
  }).toBe(true);
  await expect.element(field).toHaveValue('Clients can reach our team.');
  expect(screen.container.textContent).not.toContain('INTERNAL refusal');
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
});


it('shows and confirms suggested hours and prices when no lines are returned', async () => {
  const state = await atSituations();
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupPublicLines', { params });
  storePublicLines(mockStore.world, state.interview_id, []);
  const before = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByText('Suggested by Claude, please check', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Tax return review, $250', { exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.poll(() => mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')).toBeDefined();
  expect(mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')?.body).toEqual({ keys: ['hours', 'prices'], revision: before.revision });
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(storedPublicState(mockStore.world, state.interview_id)).toMatchObject({ hours: { source: 'owner' }, prices: { source: 'owner' } });
});


it.each([undefined, '', null, 7])('holds a public-lines response without a usable revision: %s', async (revision) => {
  const state = await atSituations();
  const read = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in read) throw new Error('read failed');
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: { ...(read.body as SetupPublicLines), revision } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.poll(() => screen.getByRole('button', { name: 'Edit', exact: true }).elements().length > 0 || screen.getByRole('alert').elements().length > 0).toBe(true);
  expect(screen.getByRole('alert').elements()).toHaveLength(1);
  await expect.element(screen.getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Looks right' }).elements()).toHaveLength(0);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm' || r.key === 'setupSafetyCheck')).toHaveLength(0);
});


it.each(['stale revision', 'removed key'] as const)('redraws public lines after a %s confirmation and waits for a second Looks right', async (change) => {
  const { screen, state } = await openLines();
  const params = { id: state.interview_id };
  const before = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
  const updatedText = 'Updated by another owner tab.';
  const saved = await mockStore.dispatch('setupPublicLine', { params, body: { key: 'policy:about', text: updatedText } });
  if ('network' in saved) throw new Error('save failed');
  expect(saved.status).toBe(200);
  if (change === 'removed key') storePublicLines(mockStore.world, state.interview_id, (saved.body as SetupPublicLines).lines.filter((line) => line.key !== 'contact'));
  const latest = structuredClone(storedPublicState(mockStore.world, state.interview_id)!);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(CHANGED_REFRESHED.en);
  await expect.element(screen.getByText(updatedText, { exact: true })).toBeVisible();
  if (change === 'removed key') expect(screen.getByText('(408) 555-0199, linda@chenandco.com', { exact: true }).elements()).toHaveLength(0);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLines')).toHaveLength(2);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(1);
  expect(mockStore.requests.find((r) => r.key === 'setupPublicLinesConfirm')?.body).toEqual({ keys: [...before.lines.map((line) => line.key), 'hours', 'prices'], revision: before.revision });
  expect(storedPublicState(mockStore.world, state.interview_id)!.lines).toEqual(latest.lines);
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm')).toHaveLength(2);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm').at(-1)?.body).toEqual({ keys: [...latest.lines.map((line) => line.key), 'hours', 'prices'], revision: latest.revision });
  expect(storedPublicState(mockStore.world, state.interview_id)!.hours).toEqual({ ...before.hours, source: 'owner' });
  expect(storedPublicState(mockStore.world, state.interview_id)!.prices).toEqual({ ...before.prices, source: 'owner' });

});

it('refreshes a removed Hours key on 422 invalid before a second explicit confirmation', async () => {
  const { screen, state } = await openLines('phone');
  const params = { id: state.interview_id };
  const before = structuredClone(storedPublicState(mockStore.world, params.id)!);
  const body = { keys: [...before.lines.map((line) => line.key), 'hours', 'prices'], revision: before.revision };
  expect(await mockStore.dispatch('removePublicLine', { params: { ...params, key: 'hours' } })).toMatchObject({ status: 200 });
  const latest = structuredClone(storedPublicState(mockStore.world, params.id)!);
  expect(await mockStore.dispatch('setupPublicLinesConfirm', { params, body })).toMatchObject({ status: 422, body: { error: 'invalid' } });
  expect(storedPublicState(mockStore.world, params.id)).toEqual(latest);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(CHANGED_REFRESHED.en);
  await expect.element(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText('Tax return review, $250', { exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLines')).toHaveLength(2);
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm').at(-1)?.body).toEqual(body);
  expect(mockStore.requests.filter((r) => r.key === 'setupSafetyCheck')).toHaveLength(0);
  expect(storedPublicState(mockStore.world, params.id)).toEqual(latest);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Safety check', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupPublicLinesConfirm').at(-1)?.body).toEqual({
    keys: [...latest.lines.map((line) => line.key), 'prices'], revision: latest.revision,
  });
});

it('draws the signed suggested group with actions per type and screen basics at both widths', async () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    mockStore.reset('rivera');
    const { screen } = await openLines(viewport);
    await expect.element(screen.getByText('Suggested by Claude, please check', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Claude found these in your memory and online. Customers see them only once you choose “Looks right”.', { exact: true })).toBeVisible();
    const group = screen.container.querySelector('.cd-public-lines-suggested')!;
    expect(group.querySelector('.cd-status-dot--held')).not.toBeNull();
    const rows = [...group.querySelectorAll('.cd-public-lines__row')];
    expect(rows.map((row) => row.querySelector('.cd-public-lines__label')?.textContent ?? '')).toEqual(['Contact', 'Hours', 'Price list', '', '']);
    expect(rows.map((row) => [...row.querySelectorAll('button')].map((button) => button.textContent))).toEqual([
      ['Edit', 'Remove'], ['Remove'], ['Remove'], ['Remove'], ['Remove'],
    ]);
    expect(rows.map((row) => row.querySelector('.cd-public-lines__text')?.textContent)).toEqual([
      '(408) 555-0199, linda@chenandco.com', 'Mon–Fri, 9 am – 6 pm', 'Tax return review, $250', 'Business tax return, $600', 'Monthly bookkeeping, $150',
    ]);
    expect(rows[1]!.querySelectorAll('.cd-public-lines__text p')).toHaveLength(1);
    if (viewport === 'phone') expect(rows.map((row) => row.getBoundingClientRect().height)).toEqual([96, 111, 111, 92, 78]);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  }
});

it('removes suggestions with one busy action, blocks other actions, and hides the empty group', async () => {
  const { screen } = await openLines('phone');
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(release);
  worker.use(http.delete('/api/owner/setup/:id/public_lines/:key', async () => { await gate; return undefined; }));
  await screen.getByRole('button', { name: /^Remove/ }).nth(1).click();
  await expect.element(screen.getByRole('button', { name: /^Remove/ }).nth(1)).toHaveAttribute('aria-busy', 'true');
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeDisabled();
  for (const button of screen.getByRole('button', { name: 'Edit', exact: true }).elements()) {
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    (button as HTMLButtonElement).click();
  }
  (screen.getByRole('button', { name: 'Looks right' }).element() as HTMLButtonElement).click();
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);
  expect(mockStore.requests.filter((request) => request.key === 'setupPublicLinesConfirm')).toHaveLength(0);
  release();
  await expect.element(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true })).not.toBeInTheDocument();
  await screen.getByRole('button', { name: /^Remove/ }).nth(2).click();
  await expect.element(screen.getByText('Business tax return, $600', { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText('Tax return review, $250', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Monthly bookkeeping, $150', { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: /^Remove/ }).first().click();
  await expect.element(screen.getByText('(408) 555-0199, linda@chenandco.com', { exact: true })).not.toBeInTheDocument();
  await screen.getByRole('button', { name: /^Remove/ }).first().click();
  await expect.element(screen.getByText('Tax return review, $250', { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText('Monthly bookkeeping, $150', { exact: true })).toBeVisible();
  expect(screen.getByText('Price list', { exact: true }).elements()).toHaveLength(1);
  await screen.getByRole('button', { name: /^Remove/ }).click();
  await expect.element(screen.getByText('Suggested by Claude, please check', { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeEnabled();
  expect(mockStore.requests.filter((request) => request.key === 'removePublicLine').map((request) => request.path.split('/').at(-1))).toEqual(['hours', 'contact']);
  expect(mockStore.requests.filter((request) => request.key === 'removePublicPrice').map((request) => request.path.split('/').at(-1))).toEqual([
    'business-tax-return?title=Business+tax+return&unit_cents=60000',
    'tax-return-review?title=Tax+return+review&unit_cents=25000',
    'monthly-bookkeeping?title=Monthly+bookkeeping&unit_cents=15000',
  ]);
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
});

it('edits Contact with its 200-character limit and moves it after About us with focus restored', async () => {
  const { screen } = await openLines('phone');
  await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const field = screen.getByRole('textbox', { name: 'Contact', exact: true });
  await field.fill('x'.repeat(201));
  expect((field.element() as HTMLTextAreaElement).value).toHaveLength(200);
  await field.fill('(408) 555-0199, hello@chenandco.com');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(field).not.toBeInTheDocument();
  const rows = [...screen.container.querySelectorAll('.cd-public-lines--owned .cd-public-lines__row')];
  expect(rows.slice(0, 3).map((row) => row.querySelector('.cd-public-lines__label')?.textContent)).toEqual(['About us', 'Contact', 'Getting started']);
  expect(rows[1]?.textContent).toContain('(408) 555-0199, hello@chenandco.com');
  expect(rows[1]?.contains(document.activeElement)).toBe(true);
  expect(screen.container.querySelector('.cd-public-lines-suggested')?.textContent).not.toContain('Contact');
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
});

it('holds when confirm returns suggestions that are still unconfirmed', async () => {
  const { screen, state } = await openLines();
  const current = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in current) throw new Error('read failed');
  mockStore.inject({ route: 'setupPublicLinesConfirm', status: 200, body: current.body });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(OWNER_ERROR_COPY.unavailable);
  expect(mockStore.requests.filter((request) => request.key === 'setupSafetyCheck')).toHaveLength(0);
});

it('rereads not_suggested and holds on a failed refresh before showing the current owner item', async () => {
  const { screen, state } = await openLines();
  await mockStore.dispatch('setupPublicLine', { params: { id: state.interview_id }, body: { key: 'contact', text: 'hello@chenandco.com' } });
  mockStore.inject({ route: 'setupPublicLines', status: 503 });
  await screen.getByRole('button', { name: /^Remove/ }).first().click();
  await expect.element(screen.getByRole('alert').getByText(OWNER_ERROR_COPY.unavailable, { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Looks right' }).elements()).toHaveLength(0);
  expect(mockStore.requests.filter((request) => request.key === 'setup').length).toBeGreaterThanOrEqual(2);
  await screen.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.element(screen.getByText('hello@chenandco.com', { exact: true })).toBeVisible();
  expect(screen.container.querySelector('.cd-public-lines-suggested')?.textContent).not.toContain('Contact');
  expect(screen.container.querySelector('.cd-public-lines--owned')?.textContent).toContain('hello@chenandco.com');
});

it('accepts API hours with seconds and ignores seconds in the displayed time', async () => {
  const state = await atSituations();
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: {
    revision: 'seconds-fixture', lines: [], prices: null,
    hours: { source: 'suggested', windows: [
      { days: ['mon', 'wed', 'fri'], start: '09:30:45', end: '12:00:59' },
      { days: ['sat'], start: '18:00:01', end: '00:00:30' },
    ] },
  } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByText('Mon, Wed, Fri, 9:30 am – 12 pm', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Sat, 6 pm – 12 am', { exact: true })).toBeVisible();
  expect(screen.getByRole('alert').elements()).toHaveLength(0);
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
});

it('renders multiple hours windows and exact price amounts without text lines or repeated labels', async () => {
  const state = await atSituations();
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: {
    revision: 'fixture-revision', lines: [],
    hours: { source: 'suggested', windows: [
      { days: ['mon', 'wed', 'fri'], start: '09:30', end: '12:00' },
      { days: ['sat'], start: '18:00', end: '00:00' },
    ] },
    prices: { source: 'suggested', items: [{ item_id: 'annual-review', title: 'Annual review', unit_cents: 186000 }, { item_id: 'filing', title: 'Filing', unit_cents: 4050 }] },
  } });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByText('Sat, 6 pm – 12 am', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Mon, Wed, Fri, 9:30 am – 12 pm', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Annual review, $1,860', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Filing, $40.50', { exact: true })).toBeVisible();
  expect([...screen.container.querySelectorAll('.cd-public-lines__label')].map((label) => label.textContent)).toEqual(['Hours', 'Price list', '']);
  expect(screen.container.querySelector('.cd-public-lines__row')!.querySelectorAll('.cd-public-lines__text p')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Edit', exact: true }).elements()).toHaveLength(0);
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
});

it('groups suggested policy lines and hides owner-sourced hours and prices', async () => {
  const state = await atSituations();
  const response = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in response) throw new Error('read failed');
  const data = response.body as SetupPublicLines;
  data.lines.push({ key: 'policy:pricing', text: 'Ask Linda for a quote.', editable: true, source: 'suggested' });
  for (const line of data.lines) if (['policy:service_area', 'policy:after_hours'].includes(line.key)) line.source = 'suggested';
  data.hours!.source = 'owner';
  data.prices!.source = 'owner';
  mockStore.inject({ route: 'setupPublicLines', status: 200, body: data });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByText('Suggested by Claude, please check', { exact: true })).toBeVisible();
  const rows = [...screen.container.querySelectorAll('.cd-public-lines-suggested .cd-public-lines__row')];
  expect(rows.map((row) => row.querySelector('.cd-public-lines__label')?.textContent)).toEqual(['Contact', 'Pricing', 'After hours', 'Service area']);
  expect(rows.every((row) => [...row.querySelectorAll('button')].map((button) => button.textContent).join(',') === 'Edit,Remove')).toBe(true);
  expect(screen.getByText('Tax return review, $250', { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByText('Mon–Fri, 9 am – 6 pm', { exact: true }).elements()).toHaveLength(0);
  await expectScreenBasics(screen.container, { owner: true });
});

it('keeps an edited suggestion open if a successful save does not make it owner-sourced', async () => {
  const { screen, state } = await openLines();
  const current = await mockStore.dispatch('setupPublicLines', { params: { id: state.interview_id } });
  if ('network' in current) throw new Error('read failed');
  mockStore.inject({ route: 'setupPublicLine', status: 200, body: current.body });
  await screen.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const field = screen.getByRole('textbox', { name: 'Contact', exact: true });
  await field.fill('hello@chenandco.com');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent(OWNER_ERROR_COPY.unavailable);
  await expect.element(field).toHaveValue('hello@chenandco.com');
  expect(mockStore.requests.filter((request) => request.key === 'setupSafetyCheck')).toHaveLength(0);
});


it('sends encoded displayed prices and refreshes shifted duplicate ids while other actions wait', async () => {
  const state = await atSituations();
  const params = { id: state.interview_id };
  const response = await mockStore.dispatch('setupPublicLines', { params });
  if ('network' in response) throw new Error('read failed');
  const data = response.body as SetupPublicLines;
  storePublicState(mockStore.world, params.id, {
    lines: data.lines.filter((line) => line.source === 'owner'), hours: null,
    prices: { source: 'suggested', items: [
      { item_id: 'review-cafe-intro', title: 'Review & café / intro?', unit_cents: 25000 },
      { item_id: 'review-cafe-intro-2', title: 'Review & café / intro?', unit_cents: 60000 },
      { item_id: 'review-cafe-intro-3', title: 'Review & café / intro?', unit_cents: 15000 },
    ] },
  });
  const { screen } = await renderRoute(`/app/setup/${params.id}`, { viewport: 'phone' });
  await screen.getByRole('button', { name: 'Looks right' }).click();
  await expect.element(screen.getByText('Review & café / intro?, $150', { exact: true })).toBeVisible();
  await mockStore.dispatch('removePublicPrice', { params: { ...params, item_id: 'review-cafe-intro' }, query: { title: 'Review & café / intro?', unit_cents: '25000' } });
  await screen.getByRole('button', { name: /^Remove/ }).nth(1).click();
  await expect.element(screen.getByText('Review & café / intro?, $250', { exact: true })).not.toBeInTheDocument();
  expect(mockStore.requests.filter((request) => request.key === 'setup').length).toBeGreaterThanOrEqual(2);
  expect(mockStore.requests.filter((request) => request.key === 'setupPublicLines').length).toBeGreaterThanOrEqual(3);
  await expect.element(screen.getByText('Review & café / intro?, $150', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Review & café / intro?, $600', { exact: true })).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(release);
  worker.use(http.delete('/api/owner/setup/:id/public_lines/prices/:item_id', async () => { await gate; return undefined; }));
  await screen.getByRole('button', { name: /^Remove/ }).first().click();
  await expect.element(screen.getByRole('button', { name: /^Remove/ }).first()).toHaveAttribute('aria-busy', 'true');
  await expect.element(screen.getByRole('button', { name: /^Remove/ }).nth(1)).toBeDisabled();
  await expect.element(screen.getByRole('button', { name: 'Looks right' })).toBeDisabled();
  (screen.getByRole('button', { name: 'Looks right' }).element() as HTMLButtonElement).click();
  (screen.getByRole('button', { name: /^Remove/ }).nth(1).element() as HTMLButtonElement).click();
  expect(mockStore.requests.filter((request) => request.key === 'setupPublicLinesConfirm')).toHaveLength(0);
  release();
  await expect.element(screen.getByText('Review & café / intro?, $600', { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText('Review & café / intro?, $150', { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: /^Remove/ }).click();
  await expect.element(screen.getByText('Suggested by Claude, please check', { exact: true })).not.toBeInTheDocument();
  expect(mockStore.requests.filter((request) => request.key === 'removePublicPrice').map((request) => request.path.split('/').at(-1))).toEqual([
    'review-cafe-intro?title=Review+%26+caf%C3%A9+%2F+intro%3F&unit_cents=25000',
    'review-cafe-intro-2?title=Review+%26+caf%C3%A9+%2F+intro%3F&unit_cents=60000',
    'review-cafe-intro?title=Review+%26+caf%C3%A9+%2F+intro%3F&unit_cents=60000',
    'review-cafe-intro?title=Review+%26+caf%C3%A9+%2F+intro%3F&unit_cents=15000',
  ]);
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
});
