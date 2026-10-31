import { beforeAll, expect, it, vi } from 'vitest';

import { ROUTES } from '../api/routes.ts';
import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { RIVERA } from '../mocks/seed.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { holdReads } from '../test/holdReads.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectScreenBasics } from '../test/screen.ts';
import { expectSkeletonLoad, expectSkeletonStill, type SkeletonAnchor } from '../test/skeleton.ts';

beforeAll(loadWebFonts);

const CHAT = `/d/${RIVERA.slug}`;
const CHAT_READ = ROUTES.publicDesk.path.replace('{slug}', RIVERA.slug);
const AGENTS = `${CHAT}/agents`;
const AGENTS_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'brand-header', page: '.cd-public-brand', size: true },
  { name: 'back-link', page: '.cd-agents-page__back' },
  { name: 'page-title', page: '.cd-agents-page__head h1' },
  { name: 'disclosure', page: '.cd-agents-page__head .cd-disclosure-line' },
  { name: 'send-card', page: '.cd-agents-page__cards > section:first-child', size: true },
];
const CHAT_ANCHORS: readonly SkeletonAnchor[] = [
  { name: 'brand-header', page: '.cd-public-brand', size: true },
  { name: 'chat-title', page: '.cd-public-shell__chat-title > h2' },
  { name: 'disclosure', page: '.cd-public-shell__disclosure' },
  { name: 'composer', page: '.cd-composer__box', size: true },
  { name: 'concept-footer', page: '.cd-public-shell__footer .cd-concept-footer', size: true },
];

it('public_chat_opens_in_place_desktop', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Opening the chat',
    anchors: [...CHAT_ANCHORS, { name: 'about-title', page: '.cd-public-shell__about > h2' }],
    open: async () => {
      await renderRoute(CHAT, { pollScale: 100 });
      await vi.waitFor(() => expect(read.held()).toBe(1));
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('public_chat_opens_in_place_phone', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Opening the chat',
    anchors: CHAT_ANCHORS,
    open: async () => {
      await renderRoute(CHAT, { viewport: 'phone', pollScale: 100 });
      await vi.waitFor(() => expect(read.held()).toBe(1));
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('public_chat_opens_in_spanish', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Abriendo el chat',
    anchors: CHAT_ANCHORS.map((anchor) => anchor.name === 'disclosure' ? { ...anchor, dimensions: ['height'] } : anchor),
    open: async () => {
      await renderRoute(CHAT, { viewport: 'phone', language: 'es-MX', pollScale: 100 });
      await vi.waitFor(() => expect(document.querySelector('[role="status"][lang="es"]')?.textContent).toBe('Abriendo el chat'));
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('setup_preview_opens_in_place', async () => {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: "Rivera Plumbing. I'm Maria, a plumber in Oakland.",
    timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey(),
  } });
  if ('network' in started || started.status !== 201) throw new Error('Setup did not start');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text: 'Yes, that works.' } });
  }
  await mockStore.dispatch('setupRules', { params });
  await mockStore.dispatch('setupSituations', { params });
  await mockStore.dispatch('setupSafetyCheck', { params });
  await mockStore.dispatch('setupConfirm', { params });
  const read = holdReads(ROUTES.publicDesk.path.replace('{slug}', state.slug));
  await expectSkeletonLoad({
    status: 'Opening the chat',
    anchors: CHAT_ANCHORS.filter((anchor) => anchor.name !== 'concept-footer'),
    open: async () => {
      await renderRoute(`/app/setup/${state.interview_id}`, { pollScale: 100 });
      await vi.waitFor(() => expect(read.held()).toBe(1));
      const preview = document.querySelector('.cd-setup-live__preview')!;
      expect(preview.querySelector('.cd-public-shell--skeleton')).not.toBeNull();
      expect(preview.querySelector('.cd-concept-footer')).toBeNull();
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('agents_page_opens_in_place_desktop', async () => {
  const desk = holdReads(CHAT_READ);
  const card = holdReads(ROUTES.agentCard.path.replace('{slug}', RIVERA.slug));
  await expectSkeletonLoad({
    status: 'Opening the page for AI agents',
    anchors: AGENTS_ANCHORS,
    open: async () => {
      await renderRoute(AGENTS, { pollScale: 100 });
      await vi.waitFor(() => expect(card.held()).toBe(1));
      desk.release();
      await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
      expect(document.querySelector('.cd-agents-page__cards > section')).toBeNull();
    },
    release: card.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('agents_page_opens_in_place_phone', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Opening the page for AI agents',
    anchors: AGENTS_ANCHORS,
    open: async () => {
      await renderRoute(AGENTS, { viewport: 'phone', pollScale: 100 });
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('public_chat_still_under_reduced_motion_phone', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonStill({
    status: 'Opening the chat', anchors: CHAT_ANCHORS,
    open: async () => {
      await renderRoute(CHAT, { viewport: 'phone', pollScale: 100 });
      expect(document.querySelector('[data-skeleton-anchor="composer"]')?.classList.contains('cd-skeleton')).toBe(true);
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('public_chat_still_under_reduced_motion_desktop', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonStill({
    status: 'Opening the chat', anchors: CHAT_ANCHORS,
    open: async () => { await renderRoute(CHAT, { pollScale: 100 }); },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('agents_page_still_under_reduced_motion_phone', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonStill({
    status: 'Opening the page for AI agents', anchors: AGENTS_ANCHORS,
    open: async () => { await renderRoute(AGENTS, { viewport: 'phone', pollScale: 100 }); },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it('agents_page_still_under_reduced_motion_desktop', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonStill({
    status: 'Opening the page for AI agents', anchors: AGENTS_ANCHORS,
    open: async () => { await renderRoute(AGENTS, { pollScale: 100 }); },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

it.each(['en', 'es'] as const)('public_chat_headers_%s_record_closed_and_no_hours_once', async (language) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const open = structuredClone(desk.openStatus)!;
  for (const kind of ['open', 'closed', 'no-hours'] as const) {
    desk.openStatus = kind === 'no-hours' ? null : structuredClone(open);
    if (kind === 'closed') desk.openStatus![language] = {
      ...open[language], open: false, until: null, opens_at: '2026-11-02T08:00:00-08:00',
      text: language === 'en' ? 'Closed now. Opens Monday at 8:00 am' : 'Cerrado ahora. Abre el lunes a las 8:00',
    };
    const read = holdReads(CHAT_READ);
    await renderRoute(CHAT, { viewport: 'phone', language: language === 'en' ? 'en-US' : 'es-MX', pollScale: 100 });
    await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
    const shape = document.querySelector('[data-skeleton-anchor="brand-header"]')!.getBoundingClientRect();
    const heights: number[] = [];
    const record = () => {
      const header = [...document.querySelectorAll('.cd-public-brand')].find((el) => !el.closest('.cd-skeleton-screen__layer'))
        ?? document.querySelector('[data-skeleton-anchor="brand-header"]');
      if (!header) return;
      const height = header.getBoundingClientRect().height;
      if (heights.at(-1) !== height) heights.push(height);
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    try {
      read.release();
      await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
      const real = document.querySelector('.cd-public-brand')!.getBoundingClientRect();
      for (const edge of ['top', 'left', 'width'] as const) expect(Math.abs(real[edge] - shape[edge])).toBeLessThanOrEqual(2);
      expect(shape.height).toBe(92);
      expect(real.height).toBe(kind === 'open' ? 92 : kind === 'closed' ? 111 : 76);
      expect(heights).toEqual(kind === 'open' ? [92] : [92, real.height]);
    } finally {
      observer.disconnect();
      read.release();
    }
  }
});

it.each(['desktop', 'phone'] as const)('agents_reference_cards_land_in_place_%s', async (viewport) => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Opening the page for AI agents',
    anchors: [
      { name: 'can-do-card', page: '.cd-agents-page__cards > section:nth-child(2)', size: true },
      { name: 'prove-card', page: '.cd-agents-page__cards > section:nth-child(3)', size: true },
      { name: 'connect-card', page: '.cd-agents-page__cards > section:nth-child(4)', size: true },
      { name: 'key-card', page: '.cd-agents-page__cards > section:nth-child(5)', size: true },
      { name: 'agents-footer', page: '.cd-agents-page__main > .cd-concept-footer', size: true },
    ],
    open: async () => { await renderRoute(AGENTS, { viewport, pollScale: 100 }); },
    release: read.release,
  });
});

it('agents_failure_waits_for_both_opening_reads', async () => {
  const desk = holdReads(CHAT_READ);
  mockStore.inject({ route: 'agentCard', status: 503 });
  const { screen } = await renderRoute(AGENTS, { pollScale: 100 });
  await vi.waitFor(() => expect(desk.held()).toBe(1));
  await vi.waitFor(() => expect(mockStore.requests.filter(({ key }) => key === 'agentCard')).toHaveLength(1));
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  expect(screen.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(0);
  desk.release();
  await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
});
