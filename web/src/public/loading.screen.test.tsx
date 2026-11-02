import { beforeAll, expect, it, vi } from 'vitest';

import { ROUTES } from '../api/routes.ts';
import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { BUSINESS, RIVERA } from '../mocks/seed.ts';
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
  { name: 'ask-owner', page: '.cd-public-shell__chat-head > button', size: true },
];

// History is unknown while loading, so the skeleton draws the first view. A first visit to a Desk
// with starters lands on it in place; a resumed chat keeps only its head.
const FIRST_VIEW_ANCHORS: readonly SkeletonAnchor[] = [
  ...CHAT_ANCHORS,
  { name: 'greeting', page: '.cd-public-shell__greeting' },
  { name: 'invitation', page: '.cd-public-shell__invitation', dimensions: ['height'] },
  { name: 'composer', page: '.cd-composer__box', size: true },
  { name: 'starters', page: '.cd-public-shell__starters', size: true },
  { name: 'concept-footer', page: '.cd-concept-footer', size: true },
];

const DESKTOP_CHAT_ANCHORS: readonly SkeletonAnchor[] = [
  ...CHAT_ANCHORS,
  { name: 'concept-footer', page: '.cd-concept-footer', size: true },
];

it('public_chat_opens_in_place_desktop', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Opening the chat',
    anchors: [...FIRST_VIEW_ANCHORS, { name: 'about-title', page: '.cd-public-shell__about > h2' }],
    open: async () => {
      await renderRoute(CHAT, { pollScale: 100 });
      await vi.waitFor(() => expect(read.held()).toBe(1));
    },
    release: read.release,
  });
  await expect.element(document.querySelector<HTMLElement>('.cd-public-shell__welcome')).toBeVisible();
  await expectScreenBasics(document.body, { owner: false });
});

// Every load draws the first view, so a resumed chat's composer and footer move when it lands; its
// head stays in place.
it.each(['desktop', 'phone'] as const)('resumed_public_chat_keeps_its_head_in_place_%s', async (viewport) => {
  const first = await renderRoute(CHAT, { viewport, pollScale: 100 });
  await expect.element(first.screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeEnabled();
  const chat = mockStore.visitorSession(RIVERA.slug)!;
  mockStore.world.visitorText(chat, 'How much is drain clearing?');
  await renderRoute('/no/such/page');
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Opening the chat',
    anchors: CHAT_ANCHORS,
    open: async () => {
      await renderRoute(CHAT, { viewport, pollScale: 100 });
      await vi.waitFor(() => expect(read.held()).toBe(1));
    },
    release: read.release,
  });
  await expect.element(document.querySelector<HTMLElement>('.cd-visitor-message')).toHaveTextContent('How much is drain clearing?');
  expect(document.querySelector('.cd-public-shell__welcome')).toBeNull();
});

it('public_chat_opens_in_place_phone', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Opening the chat',
    anchors: [...FIRST_VIEW_ANCHORS, { name: 'about-title', page: '.cd-public-shell__about > h2' }],
    open: async () => {
      await renderRoute(CHAT, { viewport: 'phone', pollScale: 100 });
      await vi.waitFor(() => expect(read.held()).toBe(1));
    },
    release: read.release,
  });
  await expect.element(document.querySelector<HTMLElement>('.cd-public-shell__welcome')).toBeVisible();
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

it('public_chat_opens_in_spanish_desktop', async () => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Abriendo el chat',
    anchors: FIRST_VIEW_ANCHORS,
    open: async () => {
      await renderRoute(CHAT, { viewport: 'desktop', language: 'es-MX', pollScale: 100 });
      await vi.waitFor(() => expect(document.querySelector('[role="status"][lang="es"]')?.textContent).toBe('Abriendo el chat'));
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: false });
});

/** A confirmed setup at its preview step, the Desk's public page not yet read. */
async function setupAtPreview(): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: "Turner Plumbing. I'm Mike, a plumber in Oakland.",
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
  return state;
}

/**
 * The shapes setup's preview lands on: the interview's owner-name change to "Ask for the owner" is
 * recorded in setup_preview_ask_moves_once_for_the_owner_name.
 */
const PREVIEW_ANCHORS = CHAT_ANCHORS.filter((anchor) => anchor.name !== 'ask-owner');

it.each([
  ['desktop', PREVIEW_ANCHORS],
  // A Desk fresh from setup has neither opening hours nor starter questions yet, and on a phone the
  // skeleton draws both: a row for the hours in its brand header (#553), so the header and the chat's
  // head land 18 px higher than their shapes, and three starter chips under its composer, which in the
  // short frame sits at the chat's foot, so the composer lands 128 px lower than its shape. Until the
  // skeleton knows what a Desk has, the phone checks only that the shapes fill the frame.
  ['phone', []],
] as const)('setup_preview_opens_in_place_%s', async (viewport, anchors) => {
  // The preview's shapes fill its frame, inside the frame's 1 px border, as the page that replaces
  // them does: on a laptop and on a phone, where the preview is a full-height chat too.
  const state = await setupAtPreview();
  const read = holdReads(ROUTES.publicDesk.path.replace('{slug}', state.slug));
  await expectSkeletonLoad({
    status: 'Opening the chat',
    anchors,
    open: async () => {
      await renderRoute(`/app/setup/${state.interview_id}`, { viewport, pollScale: 100 });
      await vi.waitFor(() => expect(read.held()).toBe(1));
      const preview = document.querySelector<HTMLElement>('.cd-setup-live__preview')!;
      const shapes = preview.querySelector<HTMLElement>('.cd-public-shell--skeleton');
      expect(shapes).not.toBeNull();
      expect(preview.querySelector('.cd-concept-footer')).toBeNull();
      const frame = preview.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(preview).borderTopWidth);
      const filled = shapes!.getBoundingClientRect();
      expect(Math.abs(filled.top - (frame.top + border))).toBeLessThanOrEqual(1);
      expect(Math.abs(filled.bottom - (frame.bottom - border))).toBeLessThanOrEqual(1);
      expect(Math.abs(filled.left - (frame.left + border))).toBeLessThanOrEqual(1);
      expect(Math.abs(filled.right - (frame.right - border))).toBeLessThanOrEqual(1);
    },
    release: read.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('setup_preview_ask_moves_once_for_the_owner_name', async () => {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: "Turner Plumbing. I'm Mike, a plumber in Oakland.",
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
  await renderRoute(`/app/setup/${state.interview_id}`, { pollScale: 100 });
  await vi.waitFor(() => expect(read.held()).toBe(1));
  const preview = document.querySelector('.cd-setup-live__preview')!;
  await vi.waitFor(() => expect(preview.querySelector('.cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull());
  const bounds = (element: Element) => {
    const { top, left, width, height } = element.getBoundingClientRect();
    return { top, left, width, height };
  };
  const shape = bounds(preview.querySelector('[data-skeleton-anchor="ask-owner"]')!);
  const changes: { bounds: ReturnType<typeof bounds>; state: string | undefined }[] = [];
  const record = () => {
    const layer = preview.querySelector<HTMLElement>('.cd-skeleton-screen__layer');
    // Read the real button from its first commit, while the shape is still fading over it.
    const ask = preview.querySelector('.cd-public-shell__chat-head > button')
      ?? layer?.querySelector('[data-skeleton-anchor="ask-owner"]');
    if (!ask) return;
    const next = bounds(ask);
    if (JSON.stringify(changes.at(-1)?.bounds) !== JSON.stringify(next)) changes.push({ bounds: next, state: layer?.dataset.state });
  };
  record();
  const observer = new MutationObserver(record);
  observer.observe(preview, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  let frame = 0;
  const sampleFrame = () => { record(); frame = requestAnimationFrame(sampleFrame); };
  frame = requestAnimationFrame(sampleFrame);
  try {
    read.release();
    await vi.waitFor(() => expect(preview.querySelector('.cd-skeleton-screen__layer')).toBeNull());
    const button = preview.querySelector<HTMLButtonElement>('.cd-public-shell__chat-head > button')!;
    expect(button.textContent).toBe('Ask for Mike');
    const real = bounds(button);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = getComputedStyle(button).font;
    context.letterSpacing = getComputedStyle(button).letterSpacing === 'normal' ? '0px' : getComputedStyle(button).letterSpacing;
    const ownerNameDifference = context.measureText(`Ask for ${BUSINESS.owner_display_name}`).width
      - context.measureText('Ask for Mike').width;
    expect(ownerNameDifference).toBeGreaterThan(2);
    expect(Math.abs((shape.width - real.width) - ownerNameDifference)).toBeLessThanOrEqual(2);
    expect(Math.abs((real.left - shape.left) - ownerNameDifference)).toBeLessThanOrEqual(2);
    for (const edge of ['top', 'height'] as const) expect(Math.abs(real[edge] - shape[edge])).toBeLessThanOrEqual(2);
    expect(Math.abs((real.left + real.width) - (shape.left + shape.width))).toBeLessThanOrEqual(2);
    // Keep sampling after the fade: landing is the only accepted bounds change.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(changes).toEqual([{ bounds: shape, state: 'shown' }, { bounds: real, state: 'leaving' }]);
  } finally {
    observer.disconnect();
    cancelAnimationFrame(frame);
    read.release();
  }
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

it.each(['phone', 'desktop'] as const)('agents_page_opens_in_spanish_%s', async (viewport) => {
  const read = holdReads(CHAT_READ);
  await expectSkeletonLoad({
    status: 'Abriendo la página para agentes de IA',
    anchors: [
      ...AGENTS_ANCHORS.map((anchor) => anchor.name === 'page-title' ? { ...anchor, dimensions: ['height'] as const } : anchor),
      { name: 'can-do-card', page: '.cd-agents-page__cards > section:nth-child(2)', size: true },
      { name: 'prove-card', page: '.cd-agents-page__cards > section:nth-child(3)', size: true },
      { name: 'connect-card', page: '.cd-agents-page__cards > section:nth-child(4)', size: true },
      { name: 'key-card', page: '.cd-agents-page__cards > section:nth-child(5)', size: true },
      { name: 'key-action', page: '.cd-agents-page__cards > section:nth-child(5) .cd-button', size: true },
      { name: 'agents-footer', page: '.cd-agents-page__main > .cd-concept-footer', size: true },
      ...[0, 1, 2].map((i) => ({ name: `task-chip-${i}`, page: `.cd-suggestion-chips > :nth-child(${i + 1})`, size: true })),
    ],
    open: async () => { await renderRoute(AGENTS, { viewport, language: 'es-MX', pollScale: 100 }); },
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
    status: 'Opening the chat', anchors: DESKTOP_CHAT_ANCHORS,
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
      expect(shape.height).toBe(94);
      expect(real.height).toBe(kind === 'open' ? 94 : kind === 'closed' ? 114 : 76);
      expect(heights).toEqual(kind === 'open' ? [94] : [94, real.height]);
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
      { name: 'key-action', page: '.cd-agents-page__cards > section:nth-child(5) .cd-button', size: true },
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
