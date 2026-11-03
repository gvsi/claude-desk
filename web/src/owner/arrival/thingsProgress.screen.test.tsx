import { focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest';

import { proseBlock } from '../../ds/fixtures/index.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { attempts } from '../../mocks/readModels.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

const TODAY = `/app/${RIVERA.deskId}/today`;

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/** The shared type roles also cover done and empty detail lines. */
function expectThingsType(things: Element) {
  const meta = { fontSize: '14px', lineHeight: '19px' };
  expectComputed(things.querySelector<HTMLElement>('.cd-things__caption')!, meta);
  for (const title of things.querySelectorAll<HTMLElement>('.cd-things__item-title')) {
    expect(title).toHaveClass('cd-type-control');
    expectComputed(title, { fontSize: '15px', lineHeight: '21px' });
  }
  for (const detail of things.querySelectorAll<HTMLElement>('.cd-things__detail')) {
    expect(detail).toHaveClass('cd-type-meta');
    expectComputed(detail, meta);
  }
}

async function tryThree() {
  await mockStore.dispatch('openPreview', { params: { desk_id: RIVERA.deskId } });
  await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Do you work weekends?' } });
  const preview = mockStore.visitorSession(RIVERA.slug);
  if (!preview?.ownerPreview) throw new Error('the owner has a preview chat');
  mockStore.world.reply(preview, [proseBlock('It costs $1 today.')], 'en', { blocked: true });
  const started = await mockStore.dispatch('startDemoVisitor', { params: { desk_id: RIVERA.deskId }, body: { idempotency_key: 'three-things' } });
  if ('network' in started || started.status !== 202) throw new Error('the demo visitor starts');
  const { run_id: runId } = started.body as { run_id: string };
  await mockStore.dispatch('stopDemoVisitor', { params: { desk_id: RIVERA.deskId, run_id: runId } });
}

it('draws_six_neutral_progress_segments_when_nothing_is_done', async () => {
  const { screen } = await renderRoute(TODAY);
  const progress = screen.getByRole('progressbar', { name: 'About 10 minutes. No real customer sees any of it.' });
  await expect.element(progress).toBeVisible();
  expect(progress.element().children).toHaveLength(6);
  expect(progress.element().querySelectorAll('.cd-things__segment--done')).toHaveLength(0);
  await expect.element(progress).toHaveAttribute('aria-valuenow', '0');
  await expect.element(progress).toHaveAttribute('aria-valuemax', '6');
  expectThingsType(progress.element().closest('.cd-things')!);
});

it('opens_the_latest_stopped_entry_with_its_trace_and_remembers_the_visit', async () => {
  await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
  const visitor = mockStore.visitorSession(RIVERA.slug)!;
  mockStore.world.reply(visitor, [proseBlock('It costs $1 today.')], 'en', { blocked: true });
  const { screen, router } = await renderRoute(TODAY);
  const things = () => screen.getByRole('region', { name: 'Things to try' });
  await expect.element(things().getByRole('heading', { name: 'See what was stopped' })).toBeVisible();
  expect(things().getByRole('listitem').elements()).toHaveLength(6);
  await expect.element(things().getByText('Open the latest request Claude turned down, and see which check stopped it.', { exact: true })).toBeVisible();
  const latest = attempts(mockStore.world, mockStore.world.desk(RIVERA.deskId)!)[0]!;
  await things().getByRole('link', { name: 'Open in Safety', exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/safety/${latest.ref_id}`);
  await expect.element(screen.getByRole('region', { name: `Full trace of entry ${latest.ledger_seq}`, exact: true })).toBeVisible();
  await router.navigate(TODAY);
  await expect.element(things().getByText('Done. You saw which check stopped it.', { exact: true })).toBeVisible();
  await expect.element(things().getByText('1 of 6 done. No real customer sees any of it.', { exact: true })).toBeVisible();
  expect(things().getByRole('link', { name: 'Open in Safety', exact: true }).elements()).toHaveLength(0);
  // The bar fills from the left by count, whichever thing is done: the fourth thing done fills the first segment.
  expect([...things().element().querySelectorAll('.cd-things__segment')].map((segment) => segment.classList.contains('cd-things__segment--done'))).toEqual([true, false, false, false, false, false]);
  await router.navigate(`/app/${RIVERA.deskId}/conversations`);
  await router.navigate(TODAY);
  await expect.element(things().getByText('Done. You saw which check stopped it.', { exact: true })).toBeVisible();
  // A new app run starts with no visit remembered.
  const reloaded = await renderRoute(TODAY);
  await expect.element(reloaded.screen.getByRole('link', { name: 'Open in Safety', exact: true })).toBeVisible();
});

it('three_done_cards_recede_to_check_discs_and_three_green_segments', async () => {
  await tryThree();
  const { screen } = await renderRoute(TODAY);
  const things = screen.getByRole('region', { name: 'Things to try' });
  await expect.element(things.getByText('3 of 6 done. No real customer sees any of it.', { exact: true })).toBeVisible();
  const segments = [...things.element().querySelectorAll('.cd-things__segment')];
  expect(segments.map((segment) => segment.classList.contains('cd-things__segment--done'))).toEqual([true, true, true, false, false, false]);
  for (const card of things.getByRole('listitem').elements().slice(0, 3)) {
    expect(card.classList.contains('cd-things__item--done')).toBe(true);
    expect(getComputedStyle(card).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    const disc = card.querySelector('.cd-things__icon')!;
    expect(getComputedStyle(disc).borderRadius).toBe('999px');
    expect(getComputedStyle(disc).backgroundColor).toBe(getComputedStyle(segments[0]!).backgroundColor);
    expect(disc.querySelector('.cd-things__check')).not.toBeNull();
    expect(card.querySelector('.cd-pill, .cd-things__action, button, a')).toBeNull();
  }
  await expect.element(things.getByText('Done. You watched a demo visitor.', { exact: true })).toBeVisible();
  expectThingsType(things.element());
});

it('keeps_the_stopped_thing_empty_without_a_step_until_something_is_stopped', async () => {
  const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
  const things = screen.getByRole('region', { name: 'Things to try' });
  await expect.element(things.getByText('When Claude turns a request down, it shows up here.', { exact: true })).toBeVisible();
  const row = things.getByRole('heading', { name: 'See what was stopped' }).element().closest('li')!;
  expect(row.querySelector('button, a')).toBeNull();
  expect(row.classList.contains('cd-things__item--done')).toBe(false);
  expectThingsType(things.element());
});

it('all_six_done_fills_every_segment_and_a_new_copy_clears_the_safety_visit', async () => {
  mockStore.reset('rivera_two_desks');
  await tryThree();
  const held = [...mockStore.world.decisions.values()].find((record) => record.decision.state === 'held')!.decision;
  await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'deny_once' } });
  const { screen, router } = await renderRoute(`/app/${RIVERA.deskId}/safety`);
  await expect.element(screen.getByRole('region', { name: 'Details', exact: true })).toBeVisible();
  await router.navigate(TODAY);
  const things = screen.getByRole('region', { name: 'Things to try' });
  await expect.element(things.getByText('All 6 done. No real customer sees any of it.', { exact: true })).toBeVisible();
  expect(things.element().querySelectorAll('.cd-things__segment--done')).toHaveLength(6);
  expect(things.element().querySelectorAll('.cd-things__item--done')).toHaveLength(6);
  await expect.element(things.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '6');
  expectThingsType(things.element());
  await screen.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await screen.getByRole('dialog', { name: 'Reset demo?' }).getByRole('button', { name: 'Reset demo', exact: true }).click();
  // The two-Desk seed still completes Create, but none of the owner's actions in the old copy count.
  await expect.element(things.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  await expect.element(things.getByText('Done. You saw which check stopped it.', { exact: true })).not.toBeInTheDocument();
});

it('only_a_stopped_entry_in_the_every_entry_view_completes_the_thing', async () => {
  const { screen, router } = await renderRoute(`/app/${RIVERA.deskId}/safety?view=entries`);
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const stopped = attempts(mockStore.world, desk)[0]!;
  const ordinary = desk.ledger.find((entry) => entry.event.kind === 'session')!;
  await screen.getByRole('button', { name: new RegExp(`^Entry ${ordinary.seq},`) }).click();
  await expect.element(screen.getByRole('region', { name: `Full trace of entry ${ordinary.seq}`, exact: true })).toBeVisible();
  await router.navigate(TODAY);
  const progress = screen.getByRole('region', { name: 'Things to try' }).getByRole('progressbar');
  await expect.element(progress).toHaveAttribute('aria-valuenow', '0');
  await router.navigate(`/app/${RIVERA.deskId}/safety?view=entries`);
  await screen.getByRole('button', { name: new RegExp(`^Entry ${stopped.ledger_seq},`) }).click();
  await expect.element(screen.getByRole('region', { name: `Full trace of entry ${stopped.ledger_seq}`, exact: true })).toBeVisible();
  await router.navigate(TODAY);
  await expect.element(screen.getByText('Done. You saw which check stopped it.', { exact: true })).toBeVisible();
  await expect.element(progress).toHaveAttribute('aria-valuenow', '1');
});

it('a_hidden_list_does_not_read_safety_when_the_window_regains_focus', async () => {
  const { screen } = await renderRoute(TODAY, { pollScale: 100 });
  const things = screen.getByRole('region', { name: 'Things to try' });
  await expect.element(things.getByRole('link', { name: 'Open in Safety', exact: true })).toBeVisible();
  await things.getByRole('button', { name: 'Hide this list', exact: true }).click();
  const reads = () => mockStore.requests.filter((request) => request.key === 'safety').length;
  const before = reads();
  onTestFinished(() => focusManager.setFocused(undefined));
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(reads()).toBe(before);
});

it('the_phone_waiting_line_uses_only_the_room_the_board_shows', async () => {
  const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
  await expect.element(screen.getByRole('heading', { level: 3, name: 'Answer a held request' })).toBeVisible();
  const row = screen.getByRole('heading', { level: 3, name: 'Answer a held request' }).element().closest('li')!;
  const detail = row.querySelector('.cd-things__detail')!;
  expect(detail.getBoundingClientRect().height).toBe(Number.parseFloat(getComputedStyle(detail).lineHeight));
});
