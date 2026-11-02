/**
 * The page for people's AI agents, `/d/:slug/agents`, in a real browser against the mock API: the
 * built-in agent sent on a task, its signed requests titled by code, each quoting the words it sent
 * as the agent's own text, and the Desk's checked replies with their receipts; then what agents can
 * do here (the kernel's Agent Card blocks), how they prove who they are, and connecting your own
 * agent (the API's code-built address, signing rules and example request, and a demo key shown
 * once). Nothing else an agent's turn holds reaches the page.
 */
import { http } from 'msw';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { cleanup, render, type RenderResult } from 'vitest-browser-react';

import type { EvReceipt, PublicDesk } from '../../api/contracts.ts';
import type { DemoAgentRun } from '../../api/views.ts';
import { App } from '../../app/App.tsx';
import { setPollScale } from '../../app/poll.ts';
import { routes } from '../../app/routes.tsx';
import { proseBlock, rivera } from '../../ds/fixtures/index.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import {
  AGENT_START_LOST_COPY,
  CHAT_ENDED_COPY,
  DEMO_BUDGET_COPY,
  NEW_CHAT_LABEL,
  RELOAD_PAGE_LABEL,
  UNREACHABLE_COPY,
  errorCopy,
} from '../../ds/index.ts';
import { AGENT_CARD_BLOCKS, agentCardOut } from '../../mocks/agents.ts';
import { worker } from '../../mocks/browser.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { liveSetupDesk } from '../../test/liveSetupDesk.ts';
import { VIEWPORTS, renderRoute, type Viewport } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { agentStartLostLine } from './copy.ts';
import { KEY_RETRY_WINDOW_MS, pageActions } from './SendAgentPanel.tsx';

const PAGE = `/d/${RIVERA.slug}/agents`;

/** The requests a route got, by key, from the `from`th request on. */
const requests = (key: string, from = 0) => mockStore.requests.slice(from).filter((r) => r.key === key);

/** How many runs the built-in agent has made in the mock: each opens an agent session. */
const agentRuns = () => [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').length;

/** The routes the page called, in order. */
const calls = () => mockStore.requests.map((r) => r.key);

/** The panel's four tasks. */
const TASKS = ['Book the earliest visit', 'Ask about heater flushes', 'Get a quote and pay the service call deposit', 'Try to pay more than its limit'];

/** The panel's lead before a run, as boards 03 to 05 write it. */
const LEAD = 'A built-in agent visits Turner Plumbing for Alex Kim. It’s simulated.';

/** The signed limit panel's values and source, as the agents boards write them. */
const LIMIT_VALUES = ['$20', '$100', 'One hour'];
const LIMIT_SOURCE = 'Signed limit from Alex Kim’s demo wallet';

/** The send panel's signed limit: its values, and whose wallet signed it. */
function limitIn(screen: RenderResult, panelName = 'Send an agent', regionName = 'Signed limit') {
  const region = screen.getByRole('region', { name: panelName }).getByRole('region', { name: regionName });
  const el = region.element();
  return { values: [...el.querySelectorAll('dd')].map((dd) => dd.textContent), source: el.querySelector('p')?.textContent };
}

/** Whether `later` comes after `earlier` in the page's order. */
const follows = (earlier: Element | null | undefined, later: Element | null | undefined): boolean =>
  earlier != null && later != null && (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** The panel's group of task chips. */
const chipGroup = (screen: RenderResult) => screen.getByRole('region', { name: 'Send an agent' }).getByRole('group', { name: 'Tasks for the agent' }).element();

/** The task chips the panel offers now, by name. */
const chipsIn = (screen: RenderResult) =>
  screen.getByRole('region', { name: 'Send an agent' }).getByRole('button').elements().map((el) => el.textContent).filter((name) => TASKS.includes(name ?? ''));

/** The run's rows the panel shows now, in order. */
const runRows = (screen: RenderResult) => [...screen.getByRole('region', { name: 'Send an agent' }).element().querySelectorAll('.cd-transcript-row')];

/** Resolves once the window has stopped scrolling: its place unchanged for 300 ms. */
async function whenStill(): Promise<void> {
  const start = performance.now();
  let at = window.scrollY;
  let since = start;
  while (performance.now() - since < 300) {
    await sleep(20);
    if (window.scrollY !== at) {
      at = window.scrollY;
      since = performance.now();
    }
    if (performance.now() - start > 5_000) throw new Error('the window never stopped scrolling');
  }
}

/**
 * The agents page at phone width (or `viewport`), from its top. A smooth scroll the page before it
 * left going carries on into this one, so the window is put at the top once it has stopped.
 */
async function renderFromTheTop(viewport: Viewport = 'phone'): Promise<RenderResult> {
  const { screen } = await renderRoute(PAGE, { viewport });
  await expect.element(screen.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
  await whenStill();
  document.documentElement.scrollTop = 0;
  await whenStill();
  expect(document.documentElement.scrollTop, 'the window is at the top').toBe(0);
  return screen;
}

/** Whether any of `el` shows in the window. */
const onScreen = (el: Element): boolean => {
  const { top, bottom } = el.getBoundingClientRect();
  return bottom > 0 && top < innerHeight;
};

/** Fails unless `el` lies wholly inside the window. */
function expectInView(el: Element | undefined, what: string): void {
  expect(el, what).toBeDefined();
  const { top, bottom } = (el as Element).getBoundingClientRect();
  expect(top, `${what}: its top is in the window`).toBeGreaterThanOrEqual(0);
  expect(bottom, `${what}: its foot is in the window`).toBeLessThanOrEqual(innerHeight);
}

/** A run as the API reports it, for a test to plant. */
function plantedRun(state: DemoAgentRun['state']): DemoAgentRun {
  return { run_id: `run-${state}`, launcher_session_id: 'ses-any', slug: RIVERA.slug, task: 'book_visit', state, turns: [] };
}

/**
 * A run the test plays a turn at a time, planted for the page's reads: each `exchange` adds the
 * agent's request, then the Desk's reply with its card, and `shown` waits until the page draws
 * them and any scroll they start has had time to end.
 */
function playedRun(): { run: DemoAgentRun; exchange: () => void; shown: (screen: RenderResult) => Promise<void> } {
  const reply = rivera.conversations.alexAgent.turns.find((turn) => turn.kind === 'event' && turn.event.type === 'message');
  if (reply?.kind !== 'event' || reply.event.type !== 'message') throw new Error("the fixture's agent chat has a reply");
  const { blocks } = reply.event;
  const run: DemoAgentRun = { ...plantedRun('running'), turns: [] };
  mockStore.inject({ route: 'agentRun', status: 200, times: 1_000, body: run });
  return {
    run,
    exchange() {
      run.turns.push({ author: 'agent', n: run.turns.length + 1, blocks: [], receipts: [] });
      run.turns.push({ author: 'desk', n: run.turns.length + 1, blocks, receipts: [] });
    },
    async shown(screen) {
      await until(() => expect(runRows(screen)).toHaveLength(run.turns.length));
      await sleep(400);
    },
  };
}

/** The app at `path` inside React's StrictMode, as `main.tsx` mounts it: every effect runs, is cleaned up and runs again. */
async function renderStrict(path: string) {
  await cleanup();
  setPollScale(0.05);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <StrictMode>
      <App router={router} />
    </StrictMode>,
  );
}

/** The page's real timers, kept before any test fakes them. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** Lets requests in flight reach the mock and the page act on their answers, in real time. */
const settle = () => sleep(150);

/** Polls `check` in real time until it passes: unlike `expect.poll`, it never moves fake timers on. */
async function until(check: () => void, timeoutMs = 5_000): Promise<void> {
  const start = performance.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (performance.now() - start > timeoutMs) throw err;
    }
    await sleep(20);
  }
}

/**
 * Fake timers and a fake clock for the page's own waits between reads of a run: a read goes only
 * when the test moves the clock. The mock API and the test's own waits (`until`, `settle`) keep
 * real time. Checks that run axe need real timers, so none runs while these are on.
 */
function useRunClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Moves the page's clock by `ms`, then waits in real time for the run's `n`th read and its answer. */
async function readAfter(ms: number, n: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await until(() => expect(requests('agentRun')).toHaveLength(n));
  await settle();
}

/** Makes the tab hidden or visible, as the browser announces it. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** The public Desk the mock serves now, with `patch` applied, planted for the page's reads. */
async function plantDesk(patch: Partial<PublicDesk>): Promise<void> {
  for (const lang of ['en', 'es']) {
    const answer = await mockStore.dispatch('publicDesk', { params: { slug: RIVERA.slug }, query: { lang } });
    if ('network' in answer) throw new Error('the mock serves the public Desk');
    mockStore.inject({ route: 'publicDesk', status: 200, times: 1, body: { ...(answer.body as PublicDesk), ...patch } });
  }
}

describe('agents page', () => {
  it('agent_card_lists_skills_and_endpoint', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    onTestFinished(() => writeText.mockRestore());
    const card = agentCardOut(RIVERA.slug);
    const { screen } = await renderRoute(PAGE);

    // What agents can do here: the kernel's blocks, each as written.
    const canDo = screen.getByRole('region', { name: 'What agents can do here' });
    await expect.element(canDo).toBeVisible();
    for (const block of AGENT_CARD_BLOCKS.en) await expect.element(canDo.getByText(block.text, { exact: true })).toBeVisible();

    // Connecting your own: the API's address, its signing rules in plain lines and its example request.
    const connect = screen.getByRole('region', { name: 'Connect your own agent' });
    await expect.element(connect.getByText(card.endpoint, { exact: true })).toBeVisible();
    await expect.element(connect.getByText(`Headers: ${card.signing.headers.join(', ')}`, { exact: true })).toBeVisible();
    await expect.element(connect.getByText(`Payload fields: ${card.signing.payload_fields.join(', ')}`, { exact: true })).toBeVisible();
    await expect.element(connect.getByText(`Canonical form: ${card.signing.canonical} JSON`, { exact: true })).toBeVisible();
    await expect.element(connect.getByText(`Algorithm: ${card.signing.algorithm}`, { exact: true })).toBeVisible();
    await expect.element(connect.getByText(`Encoding: ${card.signing.encoding}`, { exact: true })).toBeVisible();
    await expect.element(connect.getByText('Time window: 5 minutes', { exact: true })).toBeVisible();
    expect(connect.element().querySelector('pre')?.textContent).toBe(card.example_request);
    await expect
      .element(connect.getByText('Connecting your own Claude means pointing an A2A client at this address. It isn’t a ready-made connector.'))
      .toBeVisible();

    // "Copy address" writes the address, and says so.
    await connect.getByRole('button', { name: 'Copy address' }).click();
    expect(writeText).toHaveBeenCalledWith(card.endpoint);
    await expect.element(connect.getByText('Copied.', { exact: true })).toBeVisible();

    // At phone width it fits, with nothing scrolling sideways.
    const phone = await renderRoute(PAGE, { viewport: 'phone' });
    await expect.element(phone.screen.getByRole('region', { name: 'Connect your own agent' })).toBeVisible();
    expectNoHorizontalScroll();
    await expectScreenBasics(phone.screen.container, { owner: false });
  });

  it('a_desk_setup_made_offers_its_own_tasks', async () => {
    // A dentist's Desk, which setup made as an office without enabled payment tools: its consult and question,
    // in English and Spanish, never Turner's visit or service call deposit; the run's first request
    // is titled with the chip picked. The Desk's set is read once, with the visitor's chat. (The CPA
    // starter is an office too, but the mock's setup runs it as its consultant interview, which this
    // helper doesn't answer; the mock's unit test types every starter.)
    const slug = await liveSetupDesk("I'm Dana Park. Park Dental is a family dentist in Fremont, and new patients start with a checkup.");
    const office = ['Book the earliest consult', 'Ask what to bring'];
    const { screen } = await renderRoute(`/d/${slug}/agents`);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByRole('button', { name: office[0] })).toBeVisible();
    const names = () => panel.getByRole('button').elements().map((el) => el.textContent);
    expect(names().filter((name) => office.includes(name ?? ''))).toEqual(office);
    expect(names()).not.toContain('Book the earliest visit');
    expect(names()).not.toContain('Get a quote and pay the service call deposit');
    expect(names()).not.toContain('Pay up front, within its limit');
    expect(names()).not.toContain('Try to pay more than its limit');
    expect(requests('agentTasks')).toHaveLength(1);
    expect(calls().indexOf('openSession')).toBeLessThan(calls().indexOf('agentTasks'));

    await panel.getByRole('button', { name: office[0] }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('sendAgent').at(-1)?.body).toMatchObject({ task: 'book_visit' });
    const titles = [...panel.element().querySelectorAll('.cd-agent-message__title')].map((title) => title.textContent);
    expect(titles[0]).toBe(office[0]);
    await expectScreenBasics(screen.container, { owner: false });

    const es = await renderRoute(`/d/${slug}/agents`, { language: 'es-MX' });
    const enviar = es.screen.getByRole('region', { name: 'Enviar un agente' });
    await expect.element(enviar.getByRole('button', { name: 'Reservar la primera consulta libre' })).toBeVisible();
    expect(enviar.getByRole('button').elements().map((el) => el.textContent)).toEqual(['Reservar la primera consulta libre', 'Preguntar qué llevar']);
  });

  it('offers_the_listed_tasks_in_page_order_and_all_four_for_older_or_unreadable_reads', async () => {
    const all = ['Book the earliest consult', 'Ask what to bring', 'Pay up front, within its limit', 'Try to pay more than its limit'];
    const bodies = [
      { task_set: 'office', tasks: ['book_visit'] },
      { task_set: 'office', tasks: ['push_the_limit', 'ask_question', 'book_visit', 'quote_and_deposit'] },
      { task_set: 'office' },
      { task_set: 'office', tasks: null },
      { task_set: 'office', tasks: ['book_visit', 'unknown'] },
      { task_set: 'office', tasks: 'book_visit' },
      { task_set: 'office', tasks: [] },
    ];
    for (const [index, body] of bodies.entries()) {
      mockStore.inject({ route: 'agentTasks', status: 200, body });
      const { screen } = await renderRoute(PAGE);
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      await expect.element(panel.getByRole('button', { name: all[0] })).toBeVisible();
      expect(panel.getByRole('button').elements().map((el) => el.textContent).filter((name) => all.includes(name ?? '')))
        .toEqual(index === 0 ? all.slice(0, 1) : all);
    }
    const { screen } = await renderRoute(PAGE);
    await expect.element(screen.getByRole('button', { name: TASKS[0] })).toBeVisible();
    expect(chipsIn(screen)).toEqual(TASKS);
  });

  it('the_tasks_wait_in_shapes_and_a_failed_read_offers_plain_words', async () => {
    // While the Desk's set is read, the tasks' shapes hold their place and no task can be picked yet.
    mockStore.inject({ route: 'agentTasks', status: 200, body: { task_set: 'rivera' }, delayMs: 1_000 });
    const slow = await renderRoute(PAGE);
    const waiting = slow.screen.getByRole('region', { name: 'Send an agent' });
    await expect.poll(() => waiting.element().querySelectorAll('[data-loading="task-chips"] .cd-skeleton').length).toBe(4);
    expect(chipsIn(slow.screen)).toEqual([]);
    await expect.element(waiting.getByRole('button', { name: TASKS[0] })).toBeVisible();
    expect(waiting.element().querySelector('[data-loading="task-chips"]')).toBeNull();

    // A read that fails, or a session that won't open for it, never holds the page up: the tasks come
    // in plain words for any business, and the agent still goes out on the one picked.
    const plain = ['Book the earliest appointment', 'Ask what to know first', 'Pay up front, within its limit', 'Try to pay more than its limit'];
    const failures = [
      { route: 'agentTasks', status: 200, body: null },
      { route: 'agentTasks', status: 200, body: { task_set: 'unknown', tasks: ['book_visit'] } },
      { route: 'agentTasks', status: 503 },
      { route: 'agentTasks', status: 'network' },
      { route: 'openSession', status: 429 },
      { route: 'openSession', status: 'network' },
    ] as const;
    for (const failure of failures) {
      mockStore.inject({ ...failure });
      const { screen } = await renderRoute(PAGE);
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      await expect.element(panel.getByRole('button', { name: plain[0] })).toBeVisible();
      for (const name of plain) await expect.element(panel.getByRole('button', { name })).toBeVisible();
      await expect.element(screen.getByRole('region', { name: 'What agents can do here' })).toBeVisible();
      await panel.getByRole('button', { name: 'Try to pay more than its limit' }).click();
      await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
      expect(requests('sendAgent').at(-1)?.body).toMatchObject({ task: 'push_the_limit' });
    }
  });

  it('send_an_agent_leads_the_cards', async () => {
    // The page's one live moment comes first, right under the title and the AI disclosure; the
    // reference follows in its own order: what agents can do, how they prove who they are, then
    // connecting your own agent and its demo key.
    const { screen } = await renderRoute(PAGE);
    await expect.element(screen.getByRole('region', { name: 'Send an agent' })).toBeVisible();
    const cards = screen.container.querySelector('.cd-agents-page__cards');
    expect([...(cards?.children ?? [])].map((card) => card.getAttribute('aria-label'))).toEqual([
      'Send an agent',
      'What agents can do here',
      'How agents prove who they are',
      'Connect your own agent',
      'Try it with a demo key',
    ]);
    const disclosure = screen.getByText('Turner Plumbing answers with Claude, an AI.', { exact: true }).element();
    expect(follows(disclosure, screen.getByRole('region', { name: 'Send an agent' }).element())).toBe(true);
  });

  it('agent_card_discloses_ai', async () => {
    // The page's title, its disclosure and its cards in the browser's language, under the brand header.
    const en = await renderRoute(PAGE);
    await expect.element(en.screen.getByRole('heading', { level: 1, name: 'Turner Plumbing for AI agents' })).toBeVisible();
    await expect.element(en.screen.getByText('Turner Plumbing answers with Claude, an AI.', { exact: true })).toBeVisible();
    expect(en.screen.getByRole('banner').element().textContent).toContain('Turner Plumbing');
    await expectScreenBasics(en.screen.container, { owner: false });

    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect.element(es.screen.getByRole('heading', { level: 1, name: 'Turner Plumbing para agentes de IA' })).toBeVisible();
    await expect.element(es.screen.getByText('Turner Plumbing responde con Claude, una IA.', { exact: true })).toBeVisible();
    const canDo = es.screen.getByRole('region', { name: 'Qué pueden hacer los agentes aquí' });
    for (const block of AGENT_CARD_BLOCKS.es) await expect.element(canDo.getByText(block.text, { exact: true })).toBeVisible();
    await expectScreenBasics(es.screen.container, { owner: false });
    // The signed limit and a run in Spanish: the panel's words and the signed request's pill.
    expect(limitIn(es.screen, 'Enviar un agente', 'Límite firmado')).toEqual({
      values: ['$20', '$100', 'Una hora'],
      source: 'Límite firmado por la billetera de demostración de Alex Kim',
    });
    await es.screen.getByRole('button', { name: 'Reservar la primera visita libre' }).click();
    await expect.element(es.screen.getByText('El agente terminó.', { exact: true })).toBeVisible();
    const pills = [...es.screen.container.querySelectorAll('.cd-agent-message .cd-pill')].map((pill) => pill.textContent);
    expect(pills).toEqual(['Firmado', 'Firmado']);
    // The agent's words are its own, in English, the language it writes in: their quote says so,
    // inside a message that is Spanish like the page.
    const quotes = [...es.screen.container.querySelectorAll('.cd-agent-message__text')];
    expect(quotes).toHaveLength(2);
    for (const quote of quotes) {
      expect(quote.getAttribute('lang')).toBe('en');
      expect(quote.closest('.cd-agent-message')?.getAttribute('lang')).toBe('es');
    }
    await expectScreenBasics(es.screen.container, { owner: false });

    // Before the Desk shows, and when it can't be read, the page still says who answers.
    mockStore.inject({ route: 'agentCard', status: 503 });
    const down = await renderRoute(PAGE);
    await expect.element(down.screen.getByText(UNREACHABLE_COPY.en, { exact: true })).toBeVisible();
    await expect.element(down.screen.getByText('This page is part of a chat with Claude, an AI.', { exact: true })).toBeVisible();
    await expectScreenBasics(down.screen.container, { owner: false });
    // "Try again" reads it again, and the page shows.
    await down.screen.getByRole('button', { name: 'Try again' }).click();
    await expect.element(down.screen.getByRole('heading', { level: 1, name: 'Turner Plumbing for AI agents' })).toBeVisible();

    // A Desk that isn't there says so, with the disclosure.
    const gone = await renderRoute('/d/no-such-desk/agents');
    await expect.element(gone.screen.getByText("This Desk isn't available", { exact: true })).toBeVisible();
    await expect.element(gone.screen.getByText('This page is part of a chat with Claude, an AI.', { exact: true })).toBeVisible();
    await expectScreenBasics(gone.screen.container, { owner: false });
  });

  it('agents_page_names_the_tab', async () => {
    // The tab carries the page's title, in the page's language; before the Desk shows, and for a
    // Desk that isn't there, the app's own name.
    document.title = 'Claude Desk';
    const en = await renderRoute(PAGE);
    await expect.element(en.screen.getByRole('heading', { level: 1, name: 'Turner Plumbing for AI agents' })).toBeVisible();
    expect(document.title).toBe('Turner Plumbing for AI agents');

    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect.element(es.screen.getByRole('heading', { level: 1, name: 'Turner Plumbing para agentes de IA' })).toBeVisible();
    expect(document.title).toBe('Turner Plumbing para agentes de IA');

    mockStore.inject({ route: 'agentCard', status: 503 });
    const down = await renderRoute(PAGE);
    await expect.element(down.screen.getByText(UNREACHABLE_COPY.en, { exact: true })).toBeVisible();
    expect(document.title).toBe('Claude Desk');
    await down.screen.getByRole('button', { name: 'Try again' }).click();
    await expect.element(down.screen.getByRole('heading', { level: 1, name: 'Turner Plumbing for AI agents' })).toBeVisible();
    expect(document.title).toBe('Turner Plumbing for AI agents');

    const gone = await renderRoute('/d/no-such-desk/agents');
    await expect.element(gone.screen.getByText("This Desk isn't available", { exact: true })).toBeVisible();
    expect(document.title).toBe('Claude Desk');
  });

  it('agents_document_language_follows_the_page', async () => {
    // The document's language, as index.html sets it (the test browser's page has its own).
    document.documentElement.lang = 'en';
    // A Spanish browser: the whole document is Spanish while the page is open, from its first line.
    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect.element(es.screen.getByRole('heading', { level: 1, name: 'Turner Plumbing para agentes de IA' })).toBeVisible();
    expect(document.documentElement.lang).toBe('es');
    // Leaving the page hands the document its language back.
    await es.router.navigate('/no/such/page');
    await expect.element(es.screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    expect(document.documentElement.lang).toBe('en');
  });

  it('agent_page_opens_a_session_first', async () => {
    // The mock, like the API, refuses to send an agent for a browser with no chat.
    mockStore.reset('rivera');
    const refused = await mockStore.dispatch('sendAgent', { params: { slug: RIVERA.slug }, body: { task: 'book_visit', idempotency_key: 'key-1' } });
    expect(refused).toMatchObject({ status: 401 });

    // A fresh render: the page opens a session before it sends the agent, and the agent goes once.
    const { screen } = await renderRoute(PAGE, { seed: 'rivera' });
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(calls().indexOf('openSession')).toBeGreaterThanOrEqual(0);
    expect(calls().indexOf('openSession')).toBeLessThan(calls().indexOf('sendAgent'));
    expect(requests('sendAgent')).toHaveLength(1);

    // On the next visit the session has ended: the page opens it (resuming nothing), sends, is
    // refused, opens a new one and sends once more.
    mockStore.inject({ route: 'sendAgent', status: 401 });
    const opened = requests('openSession').length;
    const next = await renderRoute(PAGE);
    await next.screen.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await expect.element(next.screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('openSession')).toHaveLength(opened + 2);
    expect(requests('sendAgent').length).toBe(3);
    // The send the 401 refused goes once more in the new session with the same key: one click.
    const [firstKey, resentKey] = requests('sendAgent').slice(1).map((r) => (r.body as { idempotency_key?: string }).idempotency_key);
    expect(firstKey).toEqual(expect.any(String));
    expect(resentKey).toBe(firstKey);

    // When it ends again right away, the chat has ended: the page says so and offers a new one.
    mockStore.inject({ route: 'sendAgent', status: 401, times: 2 });
    const last = await renderRoute(PAGE);
    await last.screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    const ended = last.screen.getByText(CHAT_ENDED_COPY.en, { exact: true });
    await expect.element(ended).toBeVisible();
    expect(requests('sendAgent').length).toBe(5);
    expect(chipsIn(last.screen)).toEqual([]);
    // Nothing ran, so the panel keeps its lead rather than naming a task that never started.
    expect(last.screen.getByRole('region', { name: 'Send an agent' }).element().querySelector('.cd-agents-card__lead')?.textContent).toBe(LEAD);
    await expectScreenBasics(last.screen.container, { owner: false });
    await last.screen.getByRole('button', { name: NEW_CHAT_LABEL.en }).click();
    await expect.element(ended).not.toBeInTheDocument();
    await expect.element(last.screen.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();

    // The run's read finds the session gone: the chat has ended, and the panel says so.
    mockStore.inject({ route: 'agentRun', status: 401 });
    await last.screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(last.screen.getByText(CHAT_ENDED_COPY.en, { exact: true })).toBeVisible();
    expect(chipsIn(last.screen)).toEqual([]);
  });

  it.each([true, false])('question_task_finishes_with_payments_%s', async (payments) => {
    const desk = mockStore.world.desks[0]!;
    if (!payments) {
      for (const tool of desk.tools) {
        if (tool.tool === 'native.payment_link' || tool.tool === 'native.charge_mandate') tool.status = 'disabled';
      }
    }
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    const task = panel.getByRole('button', { name: 'Ask about heater flushes' });
    await expect.element(task).toBeVisible();
    expect(chipsIn(screen)).toEqual(payments ? TASKS : TASKS.slice(0, 2));

    await task.click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('sendAgent').at(-1)?.body).toMatchObject({ task: 'ask_question' });
    const run = panel.getByRole('log', { name: 'Alex Kim’s assistant’s visit' });
    await expect.element(run.getByText('Yes, we do water heater flushes.', { exact: true })).toBeVisible();
    expect(run.element().querySelectorAll('.cd-agent-message')).toHaveLength(1);
    expect(run.element().querySelectorAll('.cd-claude-message')).toHaveLength(1);
    expect(run.element().querySelector('.cd-agent-message__title')?.textContent).toBe('Ask about heater flushes');
    expect(chipsIn(screen)).toEqual(payments ? TASKS : TASKS.slice(0, 2));
  });

  it('send_agent_shows_signed_requests_and_replies', async () => {
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByText(LEAD, { exact: true })).toBeVisible();
    expect(limitIn(screen)).toEqual({ values: LIMIT_VALUES, source: LIMIT_SOURCE });
    // The tasks come once the Desk's set is read: Turner's own.
    await expect.element(panel.getByRole('button', { name: TASKS[0] })).toBeVisible();
    expect(chipsIn(screen)).toEqual(TASKS);
    // Before a run, the tasks sit under the signed limit.
    const limitRegion = panel.getByRole('region', { name: 'Signed limit' }).element();
    expect(follows(limitRegion, chipGroup(screen))).toBe(true);
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();

    // The chosen task takes the lead's place, the limit stays, and the tasks are offered again, so
    // the visitor can send the agent on another.
    expect(panel.getByText(LEAD, { exact: true }).elements()).toHaveLength(0);
    expect(panel.element().querySelector('.cd-agents-card__lead')?.textContent).toBe('Book the earliest visit');
    expect(limitIn(screen)).toEqual({ values: LIMIT_VALUES, source: LIMIT_SOURCE });
    expect(chipsIn(screen)).toEqual(TASKS);
    // In the order boards 04 and 05 draw: the limit, the run, "The agent finished.", then the tasks.
    const finished = panel.getByText('The agent finished.', { exact: true }).element();
    const transcript = panel.getByRole('log').element();
    expect(follows(panel.getByRole('region', { name: 'Signed limit' }).element(), transcript)).toBe(true);
    expect(follows(transcript, finished)).toBe(true);
    expect(follows(finished, chipGroup(screen))).toBe(true);

    // The agent's requests, built by code: signed, the task first, then "Signed request", numbered.
    const run = panel.getByRole('log', { name: 'Alex Kim’s assistant’s visit' });
    const requested = [...run.element().querySelectorAll('.cd-agent-message')];
    expect(requested.map((el) => el.querySelector('.cd-agent-message__title')?.textContent)).toEqual(['Book the earliest visit', 'Signed request']);
    expect(requested.map((el) => el.querySelector('.cd-agent-message__meta')?.textContent)).toEqual(['Request 1', 'Request 2']);
    for (const el of requested) expect(el.textContent).toContain('Alex Kim’s assistant');
    for (const el of requested) expect(el.textContent).toContain('Signed');

    // The Desk's checked replies, as they came: Claude's messages with their cards, each receipt the
    // kernel's line under its reply, read-only.
    const agent = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1);
    const replies = (agent?.events ?? []).flatMap(({ ev }) => (ev.type === 'message' ? [ev] : []));
    const receipts = (agent?.events ?? []).flatMap(({ ev }) => (ev.type === 'receipt' ? [ev] : []));
    expect(replies).toHaveLength(2);
    expect(run.element().querySelectorAll('.cd-claude-message')).toHaveLength(2);
    expect(run.element().querySelectorAll('.cd-claude-message .cd-reply-card')).toHaveLength(2);
    await expect.element(run.getByText('Times that are open', { exact: true })).toBeVisible();
    for (const receipt of receipts) await expect.element(run.getByText(receipt.visitor_plain, { exact: true })).toBeVisible();
    expect(run.getByRole('button', { name: /full trace/i }).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: false });

    // At phone width a finished run fits, with nothing scrolling sideways.
    const phone = await renderRoute(PAGE, { viewport: 'phone' });
    await phone.screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(phone.screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
  });

  it('each_request_says_what_it_asks', async () => {
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    const requests = () => [...panel.element().querySelectorAll('.cd-agent-message')];
    const read = (selector: string) => requests().map((el) => el.querySelector(selector)?.textContent ?? null);

    // The booking run: each request quotes what the agent asked, under titles that stay the page's.
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(read('.cd-agent-message__title')).toEqual(['Book the earliest visit', 'Signed request']);
    expect(read('.cd-agent-message__text')).toEqual([
      'What’s your earliest visit for a leaking water heater? Any day this week.',
      'Book Tuesday, November 3 at 2:00 pm for Alex Kim.',
    ]);
    expect(read('.cd-agent-message__meta')).toEqual(['Request 1', 'Request 2']);
    // The time it books is the first the open-times card offered.
    await expect.element(panel.getByText('Tuesday, November 3, 2:00 pm', { exact: true })).toBeVisible();

    // The over-limit run: its one request says the $185 it tried, over the kernel's refusal.
    await panel.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(read('.cd-agent-message__title')).toEqual(['Try to pay more than its limit']);
    expect(read('.cd-agent-message__text')).toEqual(['Charge the full repair, $185, to Alex Kim’s card.']);
    const refusal = panel.element().querySelector('.cd-transcript-row__margin .cd-status-dot--refused');
    expect(refusal).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('agent_words_show_as_the_agents_own_text', async () => {
    // The words an agent turn carries are a model's on the hosted site: untrusted. They show as the
    // agent's own text, quoted under its name, apart from the Desk's checked replies, cut to 280
    // characters, and never as markup. A turn without words draws as before.
    const reply = rivera.conversations.alexAgent.turns.find((turn) => turn.kind === 'event' && turn.event.type === 'message');
    if (reply?.kind !== 'event' || reply.event.type !== 'message') throw new Error("the fixture's agent chat has a reply");
    const { blocks } = reply.event;
    const run: DemoAgentRun = {
      ...plantedRun('done'),
      task: 'quote_and_deposit',
      turns: [
        { author: 'agent', n: 1, blocks: [], receipts: [], text: '<b>x</b> Quote   the\n\ndeposit, please.' },
        { author: 'desk', n: 2, blocks, receipts: [], text: 'A desk turn’s words never show' },
        { author: 'agent', n: 3, blocks: [], receipts: [], text: `${'y'.repeat(300)} and more` },
        { author: 'desk', n: 4, blocks, receipts: [], text: null },
        { author: 'agent', n: 5, blocks: [], receipts: [], text: null },
        { author: 'agent', n: 6, blocks: [], receipts: [] },
      ],
    };
    mockStore.inject({ route: 'agentRun', status: 200, body: run, times: 100 });
    const { screen } = await renderRoute(PAGE);
    await screen.getByRole('button', { name: 'Get a quote and pay the service call deposit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    const panel = screen.getByRole('region', { name: 'Send an agent' }).element();
    const requests = [...panel.querySelectorAll('.cd-agent-message')];
    expect(requests).toHaveLength(4);
    // The titles and counts are the page's, as before.
    expect(requests.map((el) => el.querySelector('.cd-agent-message__title')?.textContent)).toEqual([
      'Get a quote and pay the service call deposit',
      'Signed request',
      'Signed request',
      'Signed request',
    ]);
    expect(requests.map((el) => el.querySelector('.cd-agent-message__meta')?.textContent)).toEqual(['Request 1', 'Request 2', 'Request 3', 'Request 4']);

    // Markup-looking words show literally, as one line of text, with no element made from them.
    const [first, long, empty, missing] = requests.map((el) => el.querySelector('.cd-agent-message__text'));
    expect(first?.textContent).toBe('<b>x</b> Quote the deposit, please.');
    expect(first?.querySelector('*')).toBeNull();
    expect(panel.querySelector('.cd-agent-message b')).toBeNull();

    // The agent's: quoted user text inside its own row, under its name and over the page's count.
    const row = requests[0]!;
    expect(first?.tagName).toBe('BLOCKQUOTE');
    expect(first?.getAttribute('data-copy')).toBe('user');
    expect(first?.closest('.cd-agent-message')).toBe(row);
    expect(first?.closest('.cd-claude-message')).toBeNull();
    const name = row.querySelector('.cd-agent-message__name');
    expect(name?.textContent).toBe('Alex Kim’s assistant');
    expect(name!.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first!.compareDocumentPosition(row.querySelector('.cd-agent-message__meta')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Unlike the Desk's checked replies: the interface's sans type behind a rule at its left, where
    // Claude's words are serif with no rule.
    const prose = panel.querySelector('.cd-claude-message__prose')!;
    expectComputed(first!, { borderLeftWidth: '2px', borderLeftStyle: 'solid' });
    expect(getComputedStyle(first!).fontFamily).toContain('Hanken Grotesk');
    expect(getComputedStyle(prose).fontFamily).toContain('Source Serif 4');
    expectComputed(prose, { borderLeftWidth: '0px' });

    // Long words are cut to 280 characters, "…" included.
    expect(long?.textContent).toBe(`${'y'.repeat(279)}…`);

    // A turn with no words, null or missing, draws as it did: its title and count.
    expect(empty).toBeNull();
    expect(missing).toBeNull();
    expect(requests[2]?.textContent).toBe('Alex Kim’s assistantSignedSigned requestRequest 3');
    expect(requests[3]?.textContent).toBe('Alex Kim’s assistantSignedSigned requestRequest 4');
    // A Desk turn's words are never shown.
    expect(document.body.textContent).not.toContain('A desk turn’s words never show');
  });

  it('agent_words_are_capped_at_280_characters', async () => {
    // 280 characters show whole; 281 or more are cut to 279 and "…", with no space left before
    // it; words that are all whitespace show no quote, and the row draws as before.
    const run: DemoAgentRun = {
      ...plantedRun('done'),
      task: 'quote_and_deposit',
      turns: [
        { author: 'agent', n: 1, blocks: [], receipts: [], text: 'e'.repeat(280) },
        { author: 'agent', n: 2, blocks: [], receipts: [], text: 'f'.repeat(281) },
        { author: 'agent', n: 3, blocks: [], receipts: [], text: `${'g'.repeat(278)} and more` },
        { author: 'agent', n: 4, blocks: [], receipts: [], text: ' \n\t ' },
      ],
    };
    mockStore.inject({ route: 'agentRun', status: 200, body: run, times: 100 });
    const { screen } = await renderRoute(PAGE);
    await screen.getByRole('button', { name: 'Get a quote and pay the service call deposit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    const requests = [...screen.getByRole('region', { name: 'Send an agent' }).element().querySelectorAll('.cd-agent-message')];
    expect(requests).toHaveLength(4);
    const words = requests.map((el) => el.querySelector('.cd-agent-message__text')?.textContent ?? null);
    expect(words).toEqual(['e'.repeat(280), `${'f'.repeat(279)}…`, `${'g'.repeat(278)}…`, null]);
    expect(requests[3]?.textContent).toBe('Alex Kim’s assistantSignedSigned requestRequest 4');
  });

  it('newest_step_follows_in_view', async () => {
    // On a phone, and on a laptop, the run grows past the window's foot: as each of the agent's
    // requests and the Desk's replies arrives, the newest stays in view, down to "The agent finished.".
    for (const viewport of ['phone', 'desktop'] as const) {
      const screen = await renderFromTheTop(viewport);
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
      for (let n = 1; n <= 4; n += 1) {
        await until(() => expect(runRows(screen).length).toBeGreaterThanOrEqual(n));
        await until(() => expectInView(runRows(screen).at(-1), `${viewport}: the newest of ${runRows(screen).length} rows`));
      }
      const finished = panel.getByText('The agent finished.', { exact: true });
      await expect.element(finished).toBeVisible();
      await until(() => expectInView(finished.element(), `${viewport}: "The agent finished."`));
      expectInView(runRows(screen).at(-1), `${viewport}: the last row`);
      expect(document.scrollingElement?.scrollTop, `${viewport}: the page followed the run down`).toBeGreaterThan(0);
    }
  });

  it('pressing_a_task_brings_its_run_into_view', async () => {
    // A visitor at the end of a finished run presses another task under it: the run empties for
    // the new one and the page grows much shorter, and the new run comes into view rather than
    // leaving them at the cards below. It plays in view to its end.
    const screen = await renderFromTheTop();
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    const finished = panel.getByText('The agent finished.', { exact: true });
    await until(() => expectInView(finished.element(), '"The agent finished."'));
    await until(() => expectInView(panel.getByRole('button', { name: 'Try to pay more than its limit' }).element(), 'the task under the run'));
    const ranTo = document.scrollingElement?.scrollTop ?? 0;
    expect(ranTo, 'the first run took the page down').toBeGreaterThan(0);

    const working = () => panel.getByRole('status').elements().find((el) => el.textContent === 'Alex Kim’s assistant is at work');
    const playsInView = async (task: string) => {
      await until(() => expectInView(working() ?? runRows(screen).at(-1), `the run for "${task}"`));
      await until(() => expect(panel.element().querySelector('.cd-agent-message__title')?.textContent).toBe(task));
      await until(() => expectInView(finished.element(), `"The agent finished." after "${task}"`));
      expectInView(runRows(screen).at(-1), `the last row of the run for "${task}"`);
    };
    await panel.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await playsInView('Try to pay more than its limit');

    // A visitor who has scrolled away to the foot of the page presses a task without the window
    // moving to it, as a screen reader can: the new run still comes into view.
    await whenStill();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(100);
    expect(onScreen(finished.element()), 'the visitor scrolled away from the run').toBe(false);
    (panel.getByRole('button', { name: 'Get a quote and pay the service call deposit' }).element() as HTMLElement).click();
    await playsInView('Get a quote and pay the service call deposit');
  });

  it('a_visitor_who_scrolls_away_is_left_there', async () => {
    const played = playedRun();
    const { run, exchange } = played;
    const screen = await renderFromTheTop();
    const shown = () => played.shown(screen);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();

    // The page follows the run down...
    let exchanges = 0;
    do {
      exchange();
      await shown();
      exchanges += 1;
    } while ((document.scrollingElement?.scrollTop ?? 0) === 0 && exchanges < 6);
    expect(document.scrollingElement?.scrollTop, 'the page followed the run down').toBeGreaterThan(0);
    expectInView(runRows(screen).at(-1), 'the newest row');

    // ...until the visitor scrolls back up to read: then it leaves them there as the run goes on...
    await whenStill();
    window.scrollTo(0, 0);
    await sleep(100);
    exchange();
    await shown();
    exchange();
    await shown();
    expect(document.scrollingElement?.scrollTop, 'the page stayed where the visitor scrolled to').toBe(0);

    // ...and follows it again once they scroll back down to its end.
    window.scrollTo(0, panel.element().getBoundingClientRect().bottom + window.scrollY - innerHeight);
    await whenStill();
    exchange();
    await shown();
    await until(() => expectInView(runRows(screen).at(-1), 'the newest row, after the visitor came back to the end'));

    // Away again, they stay away to the run's end.
    window.scrollTo(0, 0);
    await sleep(100);
    run.state = 'done';
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeInTheDocument();
    await sleep(400);
    expect(document.scrollingElement?.scrollTop, 'the page stayed where the visitor scrolled to').toBe(0);
    expect(onScreen(runRows(screen).at(-1) as Element), 'the newest row is out of view').toBe(false);

    // Scrolling away past the run, to the page's foot, is the same: the run goes on out of view.
    run.turns.length = 0;
    run.state = 'running';
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    exchange();
    await shown();
    await whenStill();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(100);
    const demoKey = screen.getByRole('region', { name: 'Try it with a demo key' }).element();
    expect(onScreen(demoKey), 'the visitor is reading the demo key').toBe(true);
    exchange();
    await shown();
    exchange();
    await shown();
    expect(onScreen(demoKey), 'the visitor is still reading the demo key').toBe(true);
    expect(onScreen(runRows(screen).at(-1) as Element), 'the newest row is out of view').toBe(false);
  });

  it('an_interrupted_scroll_leaves_the_visitor_where_it_stopped', async () => {
    const played = playedRun();
    const { exchange } = played;
    const scrollTo = vi.spyOn(window, 'scrollTo');
    onTestFinished(() => scrollTo.mockRestore());
    // In a browser that says when a scroll ends (`scrollend`), and in one that doesn't, where the
    // page waits for the scrolling to pause.
    const scrollEnd = Object.getOwnPropertyDescriptor(window, 'onscrollend');
    onTestFinished(() => {
      if (scrollEnd) Object.defineProperty(window, 'onscrollend', scrollEnd);
    });
    for (const sendsScrollEnd of [true, false]) {
      if (!sendsScrollEnd) Reflect.deleteProperty(window, 'onscrollend');
      expect('onscrollend' in window).toBe(sendsScrollEnd);
      played.run.turns.length = 0;
      const screen = await renderFromTheTop();
      const shown = () => played.shown(screen);
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
      let exchanges = 0;
      do {
        exchange();
        await shown();
        exchanges += 1;
      } while ((document.scrollingElement?.scrollTop ?? 0) === 0 && exchanges < 6);
      await whenStill();

      // The next step starts the page's smooth scroll down to the run's end...
      scrollTo.mockClear();
      exchange();
      await until(() => expect(scrollTo).toHaveBeenCalled(), 5_000);
      const [how] = scrollTo.mock.calls[0] as unknown as [ScrollToOptions];
      const target = how.top ?? 0;
      const at = window.scrollY;
      expect(how.behavior).toBe('smooth');
      expect(target - at, 'most of the scroll is still to go').toBeGreaterThan(150);

      // ...and the visitor stops it partway, ahead of where it had got to but well short of the
      // end (the page's last frame may still land a few pixels on).
      window.scrollTo({ top: Math.round(at + (target - at) * 0.3), behavior: 'instant' });
      await whenStill();
      const stoppedAt = window.scrollY;
      expect(target - stoppedAt, 'the scroll stopped well short of the run’s end').toBeGreaterThan(100);

      // They are away from the end now, so the next step leaves them there.
      exchange();
      await shown();
      await whenStill();
      expect(window.scrollY, `the next step left the visitor where they stopped (scrollend: ${sendsScrollEnd})`).toBe(stoppedAt);
    }
  });

  it('the_run_scrolls_at_once_under_reduced_motion', async () => {
    // How the page scrolled the window to the run, each time.
    const scrollTo = vi.spyOn(window, 'scrollTo');
    onTestFinished(() => scrollTo.mockRestore());
    const behaviors = () =>
      scrollTo.mock.calls.flatMap(([how]: [ScrollToOptions | number | undefined, number?]) => (typeof how === 'object' ? [how.behavior] : []));
    const runToItsEnd = async () => {
      const screen = await renderFromTheTop();
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
      await until(() => expectInView(panel.getByText('The agent finished.', { exact: true }).element(), '"The agent finished."'));
    };

    // Smoothly, as the visitor's system allows.
    await runToItsEnd();
    expect(behaviors().length).toBeGreaterThan(0);
    expect(new Set(behaviors())).toEqual(new Set(['smooth']));

    // At once for a visitor who asks for reduced motion.
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    onTestFinished(async () => {
      await cdp().send('Emulation.setEmulatedMedia', { features: [] });
    });
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    scrollTo.mockClear();
    await runToItsEnd();
    expect(behaviors().length).toBeGreaterThan(0);
    expect(new Set(behaviors())).toEqual(new Set(['instant']));
  });

  it('sending_by_keyboard_keeps_the_place', async () => {
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    const title = panel.getByRole('heading', { level: 2, name: 'Send an agent' });
    const task = panel.getByRole('button', { name: 'Book the earliest visit' });
    await expect.element(task).toBeVisible();
    // Opening the page moves no focus.
    expect(document.activeElement).toBe(document.body);

    // Enter on a task: the tasks go while the agent works, and focus moves to the panel's title
    // rather than falling to the page.
    task.element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(title).toHaveFocus();
    expect(title.element().matches(':focus-visible')).toBe(true);
    // It stays there through the run, and the next Tab goes on from the panel, not from the top of the page.
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    await expect.element(title).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    expect(follows(title.element(), document.activeElement)).toBe(true);
    expect(panel.element().contains(document.activeElement)).toBe(true);
    // The run's log still reads each turn out as it comes.
    await expect.element(panel.getByRole('log')).toHaveAttribute('aria-live', 'polite');

    // A task clicked moves focus the same way, with no focus ring for the pointer to see.
    const clicked = await renderRoute(PAGE);
    const clickedTitle = clicked.screen.getByRole('heading', { level: 2, name: 'Send an agent' });
    await clicked.screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(clickedTitle).toHaveFocus();
    expect(clickedTitle.element().matches(':focus-visible')).toBe(false);
  });

  it('agent_turn_blocks_and_receipts_are_never_shown', async () => {
    // A run whose agent turn holds blocks of its own, as a broken or hostile API might send: the
    // panel titles the request by code and shows none of them, anywhere. Only a turn's `text` is
    // the agent's words.
    const words = "I'll pay $100 now";
    // And a receipt on the agent's own turn, which only a Desk turn may carry.
    const agentReceipt: EvReceipt = {
      type: 'receipt',
      decision_id: 'dec-hostile',
      state: 'executed',
      visitor_plain: 'Paid in full by the agent',
      ledger_seq: 1,
      signature: 'f'.repeat(128),
    };
    const reply = rivera.conversations.alexAgent.turns.find((turn) => turn.kind === 'event' && turn.event.type === 'message');
    if (reply?.kind !== 'event' || reply.event.type !== 'message') throw new Error("the fixture's agent chat has a reply");
    const run: DemoAgentRun = {
      run_id: 'run-hostile',
      launcher_session_id: 'ses-any',
      slug: RIVERA.slug,
      task: 'quote_and_deposit',
      state: 'done',
      turns: [
        { author: 'agent', n: 1, blocks: [proseBlock(words)], receipts: [agentReceipt] },
        { author: 'desk', n: 2, blocks: reply.event.blocks, receipts: [] },
      ],
    };
    mockStore.inject({ route: 'agentRun', status: 200, body: run, times: 100 });
    const { screen } = await renderRoute(PAGE);
    await screen.getByRole('button', { name: 'Get a quote and pay the service call deposit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByText('Get a quote and pay the service call deposit', { exact: true }).first()).toBeVisible();
    expect(document.body.textContent).not.toContain(words);
    expect(document.body.innerHTML).not.toContain('pay $100 now');
    expect(document.body.innerHTML).not.toContain(agentReceipt.visitor_plain);
  });

  it('a_desk_reply_in_markdown_shows_bold_and_a_list', async () => {
    // The Desk's checked reply to the agent, in Markdown: bold as bold and the list as a list.
    const items = ['The earliest opening this week', 'A window that suits Alex Kim'];
    const text = `I can book that. **Two choices** to make first:\n\n${items.map((item) => `- ${item}`).join('\n')}`;
    const run: DemoAgentRun = {
      ...plantedRun('done'),
      turns: [
        { author: 'agent', n: 1, blocks: [], receipts: [] },
        { author: 'desk', n: 2, blocks: [proseBlock(text)], receipts: [] },
      ],
    };
    mockStore.inject({ route: 'agentRun', status: 200, body: run, times: 100 });
    const { screen } = await renderRoute(PAGE);
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    const reply = screen.getByRole('region', { name: 'Send an agent' }).getByRole('log').element().querySelector('.cd-claude-message') as HTMLElement;
    expect([...reply.querySelectorAll('strong')].map((el) => el.textContent)).toEqual(['Two choices']);
    expect([...reply.querySelectorAll('li')].map((el) => el.textContent)).toEqual(items);
    expect(reply.textContent).not.toMatch(/\*|^- /m);
  });

  it('over_limit_run_shows_the_kernel_line', async () => {
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await panel.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();

    // The kernel refused the charge over the signed limit: its receipt is the event's line, word for
    // word, with the refused dot, under the Desk's reply.
    const agent = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1);
    const refused = (agent?.events ?? []).flatMap(({ ev }) => (ev.type === 'receipt' && ev.state === 'refused' ? [ev] : []));
    expect(refused).toHaveLength(1);
    const line = panel.getByText(refused[0]?.visitor_plain ?? '', { exact: true });
    await expect.element(line).toBeVisible();
    const receipt = line.element().closest('.cd-transcript-row__margin');
    expect(receipt?.querySelector('.cd-status-dot--refused')).not.toBeNull();
    expect(receipt?.closest('.cd-transcript-row')?.querySelector('.cd-claude-message')).not.toBeNull();
    const titles = [...panel.element().querySelectorAll('.cd-agent-message__title')].map((el) => el.textContent);
    expect(titles).toEqual(['Try to pay more than its limit']);
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('demo_key_is_shown_once', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    onTestFinished(() => writeText.mockRestore());
    const { screen } = await renderRoute(PAGE, { seed: 'rivera' });
    const card = screen.getByRole('region', { name: 'Try it with a demo key' });
    await expect
      .element(
        card.getByText('Simulated in this demo: the built-in agent and its wallet stand in for someone else’s. Neither key is a business credential.', {
          exact: true,
        }),
      )
      .toBeVisible();

    // A session first, then the key, once.
    await card.getByRole('button', { name: 'Get a demo key' }).click();
    const key = card.getByRole('group', { name: 'Private key' });
    await expect.element(key).toBeVisible();
    expect(calls().indexOf('openSession')).toBeGreaterThanOrEqual(0);
    expect(calls().indexOf('openSession')).toBeLessThan(calls().indexOf('agentKey'));
    expect(requests('agentKey')).toHaveLength(1);

    // The key id and the private key in mono, as the API issued them, the key with "Copy key" and
    // the warning beside it; the button is gone, so the key can't be asked for again here.
    const keyId = card.getByRole('group', { name: 'Key id' }).element().querySelector('code[data-copy="code"]')?.textContent ?? '';
    const privateKey = key.element().querySelector('code[data-copy="code"]')?.textContent ?? '';
    expect(keyId).toMatch(/^demo-key-[\w-]+$/);
    expect(privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(card.getByRole('group', { name: 'Key id' }).getByRole('button').elements()).toHaveLength(0);
    await expect.element(key.getByText('Shown once. It’s a demo key for this Desk, not a business credential.', { exact: true })).toBeVisible();
    expect(card.getByRole('button', { name: 'Get a demo key' }).elements()).toHaveLength(0);
    expect(card.getByText(/^Simulated in this demo/).elements()).toHaveLength(0);
    await key.getByRole('button', { name: 'Copy key' }).click();
    expect(writeText).toHaveBeenCalledWith(privateKey);
    await expectScreenBasics(screen.container, { owner: false });

    // Mounted as the app mounts it, in StrictMode, the key still shows once it comes, and so does a run.
    // StrictMode runs the panel's effect twice, yet the Desk's tasks are read once, in one session.
    const strictMark = mockStore.requests.length;
    const strict = await renderStrict(PAGE);
    await expect.element(strict.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
    expect(requests('openSession', strictMark)).toHaveLength(1);
    expect(requests('agentTasks', strictMark)).toHaveLength(1);
    const strictCard = strict.getByRole('region', { name: 'Try it with a demo key' });
    await strictCard.getByRole('button', { name: 'Get a demo key' }).click();
    await expect.element(strictCard.getByRole('group', { name: 'Private key' })).toBeVisible();
    await strict.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(strict.getByText('The agent finished.', { exact: true })).toBeVisible();

    // A busy demo says so, and the button stays to try again.
    mockStore.inject({ route: 'agentKey', status: 429 });
    const busy = await renderRoute(PAGE);
    const again = busy.screen.getByRole('region', { name: 'Try it with a demo key' });
    await again.getByRole('button', { name: 'Get a demo key' }).click();
    await expect.element(again.getByText(errorCopy('rate_limited'), { exact: true })).toBeVisible();
    await expect.element(again.getByRole('button', { name: 'Get a demo key' })).toBeVisible();
  });

  it('demo_key_by_keyboard_keeps_the_place', async () => {
    const { screen } = await renderRoute(PAGE);
    const card = screen.getByRole('region', { name: 'Try it with a demo key' });
    const title = card.getByRole('heading', { level: 2, name: 'Try it with a demo key' });
    const getKey = card.getByRole('button', { name: 'Get a demo key' });
    await expect.element(getKey).toBeVisible();

    // Enter on "Get a demo key": the key takes the button's place, and focus moves to the card's
    // title rather than falling to the page.
    getKey.element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(card.getByRole('group', { name: 'Private key' })).toBeVisible();
    await expect.element(title).toHaveFocus();
    expect(title.element().matches(':focus-visible')).toBe(true);
    // The next Tab goes on to the key's "Copy key", not back to the top of the page.
    await userEvent.keyboard('{Tab}');
    await expect.element(card.getByRole('button', { name: 'Copy key' })).toHaveFocus();

    // A key that comes after the visitor has moved on leaves focus where they put it.
    let land: (value?: unknown) => void = () => {};
    const landed = new Promise((resolve) => {
      land = resolve;
    });
    onTestFinished(() => land());
    mockStore.inject({
      route: 'agentKey',
      status: 200,
      body: { agent_key_id: 'demo-key-late', agent_private_key_hex: 'a'.repeat(64) },
      until: landed,
    });
    const later = await renderRoute(PAGE);
    const laterCard = later.screen.getByRole('region', { name: 'Try it with a demo key' });
    const laterKey = laterCard.getByRole('button', { name: 'Get a demo key' });
    await expect.element(laterKey).toBeVisible();
    const asked = requests('agentKey').length;
    laterKey.element().focus();
    await userEvent.keyboard('{Enter}');
    await until(() => expect(requests('agentKey')).toHaveLength(asked + 1));
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    const movedTo = document.activeElement;
    expect(movedTo).not.toBe(document.body);
    expect(laterCard.element().contains(movedTo)).toBe(false);
    land();
    await expect.element(laterCard.getByRole('group', { name: 'Private key' })).toBeVisible();
    expect(document.activeElement).toBe(movedTo);

    // A busy demo keeps the button, to try again, and so keeps its focus.
    mockStore.inject({ route: 'agentKey', status: 429 });
    const busy = await renderRoute(PAGE);
    const busyCard = busy.screen.getByRole('region', { name: 'Try it with a demo key' });
    const tryAgain = busyCard.getByRole('button', { name: 'Get a demo key' });
    await expect.element(tryAgain).toBeVisible();
    tryAgain.element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(busyCard.getByText(errorCopy('rate_limited'), { exact: true })).toBeVisible();
    await expect.element(tryAgain).toHaveFocus();

    // A key asked for with a click moves focus the same way, with no focus ring for the pointer to see.
    const clicked = await renderRoute(PAGE);
    const clickedCard = clicked.screen.getByRole('region', { name: 'Try it with a demo key' });
    const clickedTitle = clickedCard.getByRole('heading', { level: 2, name: 'Try it with a demo key' });
    await clickedCard.getByRole('button', { name: 'Get a demo key' }).click();
    await expect.element(clickedCard.getByRole('group', { name: 'Private key' })).toBeVisible();
    await expect.element(clickedTitle).toHaveFocus();
    expect(clickedTitle.element().matches(':focus-visible')).toBe(false);
  });

  it('new_chat_for_a_demo_key_keeps_the_place', async () => {
    // The key's session has ended, and so has the new one opened for it: the chat has ended.
    mockStore.inject({ route: 'agentKey', status: 401, times: 2 });
    const { screen } = await renderRoute(PAGE);
    const card = screen.getByRole('region', { name: 'Try it with a demo key' });
    const title = card.getByRole('heading', { level: 2, name: 'Try it with a demo key' });
    const getKey = card.getByRole('button', { name: 'Get a demo key' });
    await expect.element(getKey).toBeVisible();

    // Enter on "Get a demo key": the chat has ended, the notice takes the button's place, and focus
    // moves to the card's title; the next Tab goes on to "New chat".
    getKey.element().focus();
    await userEvent.keyboard('{Enter}');
    const ended = card.getByText(CHAT_ENDED_COPY.en, { exact: true });
    await expect.element(ended).toBeVisible();
    await expect.element(title).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    const newChat = card.getByRole('button', { name: NEW_CHAT_LABEL.en });
    await expect.element(newChat).toHaveFocus();

    // Enter on "New chat": the notice goes with it and "Get a demo key" comes back. Focus moves to
    // the card's title rather than falling to the page, and the next Tab goes on to "Get a demo key".
    await userEvent.keyboard('{Enter}');
    await expect.element(ended).not.toBeInTheDocument();
    await expect.element(title).toHaveFocus();
    expect(title.element().matches(':focus-visible')).toBe(true);
    await userEvent.keyboard('{Tab}');
    await expect.element(getKey).toHaveFocus();
  });

  it('new_chat_for_the_agent_keeps_the_place', async () => {
    // The send's session has ended, and so has the new one opened for it: the chat has ended.
    mockStore.inject({ route: 'sendAgent', status: 401, times: 2 });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    const title = panel.getByRole('heading', { level: 2, name: 'Send an agent' });
    const book = panel.getByRole('button', { name: 'Book the earliest visit' });
    await expect.element(book).toBeVisible();

    // Enter on a task: the chat has ended, and the next Tab from the panel's title goes on to "New chat".
    book.element().focus();
    await userEvent.keyboard('{Enter}');
    const ended = panel.getByText(CHAT_ENDED_COPY.en, { exact: true });
    await expect.element(ended).toBeVisible();
    await expect.element(title).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    const newChat = panel.getByRole('button', { name: NEW_CHAT_LABEL.en });
    await expect.element(newChat).toHaveFocus();

    // Enter on "New chat": the notice goes with it and the tasks come back. Focus moves to the
    // panel's title rather than falling to the page, and the next Tab goes on to the first task.
    await userEvent.keyboard('{Enter}');
    await expect.element(ended).not.toBeInTheDocument();
    await expect.element(title).toHaveFocus();
    expect(title.element().matches(':focus-visible')).toBe(true);
    await userEvent.keyboard('{Tab}');
    await expect.element(book).toHaveFocus();

    // "New chat" clicked moves focus the same way, with no focus ring for the pointer to see.
    mockStore.inject({ route: 'sendAgent', status: 401, times: 2 });
    const clicked = await renderRoute(PAGE);
    const clickedPanel = clicked.screen.getByRole('region', { name: 'Send an agent' });
    const clickedTitle = clickedPanel.getByRole('heading', { level: 2, name: 'Send an agent' });
    await clickedPanel.getByRole('button', { name: 'Book the earliest visit' }).click();
    const clickedEnded = clickedPanel.getByText(CHAT_ENDED_COPY.en, { exact: true });
    await expect.element(clickedEnded).toBeVisible();
    await clickedPanel.getByRole('button', { name: NEW_CHAT_LABEL.en }).click();
    await expect.element(clickedEnded).not.toBeInTheDocument();
    await expect.element(clickedTitle).toHaveFocus();
    expect(clickedTitle.element().matches(':focus-visible')).toBe(false);
  });

  it('try_again_by_keyboard_keeps_the_place', async () => {
    // The page can't be read, and the read "Try again" starts is held until the test lets it fail too.
    let land: (value?: unknown) => void = () => {};
    const landed = new Promise((resolve) => {
      land = resolve;
    });
    onTestFinished(() => land());
    mockStore.inject({ route: 'agentCard', status: 503 });
    mockStore.inject({ route: 'agentCard', status: 503, until: landed });
    const { screen } = await renderRoute(PAGE);
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    await expect.element(tryAgain).toBeVisible();
    // Opening the page moves no focus.
    expect(document.activeElement).toBe(document.body);

    // Enter on "Try again": the shapes take the notice's place while the page is read again,
    // and the button goes with the notice.
    tryAgain.element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('status')).toHaveTextContent('Opening the page for AI agents');
    await expect.element(screen.getByRole('status')).toHaveClass('cd-sr-only');
    expect(screen.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(0);

    // The read fails again: focus moves to the new "Try again" rather than falling to the page, so
    // the next Enter tries once more. The notice is still an alert, read out at once.
    land();
    await expect.element(tryAgain).toHaveFocus();
    expect(tryAgain.element().matches(':focus-visible')).toBe(true);
    await expect.element(screen.getByRole('alert').getByText(UNREACHABLE_COPY.en, { exact: true })).toBeVisible();

    // Enter on it, and the page is read: it draws in the notice's place, and focus is at its start.
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Turner Plumbing for AI agents' })).toBeVisible();
    expect(document.activeElement).toBe(document.body);

    // Focus put somewhere else while the page is read again stays there when the read fails. Nothing
    // in the shapes takes focus, so here it is a control the test puts outside the page.
    let fail: (value?: unknown) => void = () => {};
    const failed = new Promise((resolve) => {
      fail = resolve;
    });
    onTestFinished(() => fail());
    mockStore.inject({ route: 'agentCard', status: 503 });
    mockStore.inject({ route: 'agentCard', status: 503, until: failed });
    const moved = await renderRoute(PAGE);
    const movedTryAgain = moved.screen.getByRole('button', { name: 'Try again' });
    await expect.element(movedTryAgain).toBeVisible();
    movedTryAgain.element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(moved.screen.getByRole('status')).toHaveTextContent('Opening the page for AI agents');
    await expect.element(moved.screen.getByRole('status')).toHaveClass('cd-sr-only');
    const elsewhere = document.body.appendChild(document.createElement('button'));
    onTestFinished(() => elsewhere.remove());
    elsewhere.focus();
    fail();
    await expect.element(movedTryAgain).toBeVisible();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();

    // "Try again" pressed without focus on it, as a script's click or a browser that doesn't focus
    // what is clicked does: focus stays on the page when the read fails, as it was.
    let drop: (value?: unknown) => void = () => {};
    const dropped = new Promise((resolve) => {
      drop = resolve;
    });
    onTestFinished(() => drop());
    mockStore.inject({ route: 'agentCard', status: 503 });
    mockStore.inject({ route: 'agentCard', status: 503, until: dropped });
    const unfocused = await renderRoute(PAGE);
    const unfocusedTryAgain = unfocused.screen.getByRole('button', { name: 'Try again' });
    await expect.element(unfocusedTryAgain).toBeVisible();
    expect(document.activeElement).toBe(document.body);
    (unfocusedTryAgain.element() as HTMLButtonElement).click();
    await expect.element(unfocused.screen.getByRole('status')).toHaveTextContent('Opening the page for AI agents');
    await expect.element(unfocused.screen.getByRole('status')).toHaveClass('cd-sr-only');
    drop();
    await expect.element(unfocusedTryAgain).toBeVisible();
    expect(document.activeElement).toBe(document.body);

    // "Try again" clicked moves focus the same way, with no focus ring for the pointer to see.
    mockStore.inject({ route: 'agentCard', status: 503, times: 2 });
    const clicked = await renderRoute(PAGE);
    const clickedTryAgain = clicked.screen.getByRole('button', { name: 'Try again' });
    await expect.element(clickedTryAgain).toBeVisible();
    const read = requests('agentCard').length;
    await clickedTryAgain.click();
    await until(() => expect(requests('agentCard')).toHaveLength(read + 1));
    await expect.element(clickedTryAgain).toHaveFocus();
    expect(clickedTryAgain.element().matches(':focus-visible')).toBe(false);
  });

  it('public_page_links_to_agents', async () => {
    // The public page's about column, under "For AI agents": both links lead to the agents page,
    // "Send an agent" to its panel. The about blocks stay the charter's.
    const { screen } = await renderRoute(`/d/${RIVERA.slug}`);
    const about = screen.getByRole('complementary', { name: 'About Turner Plumbing' });
    await expect.element(about.getByRole('heading', { name: 'For AI agents' })).toBeVisible();
    const links = about.getByRole('link').elements();
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['What agents can do here', `/d/${RIVERA.slug}/agents`],
      ['Send an agent', `/d/${RIVERA.slug}/agents#send`],
    ]);
    expect(about.element().querySelectorAll('.cd-reply-card')).toHaveLength(rivera.publicDesk.en.charter.length);
    await expectScreenBasics(screen.container, { owner: false });

    const es = await renderRoute(`/d/${RIVERA.slug}`, { language: 'es-ES' });
    const acerca = es.screen.getByRole('complementary', { name: /Turner Plumbing/ });
    await expect.element(acerca.getByRole('heading', { name: 'Para agentes de IA' })).toBeVisible();
    expect(acerca.getByRole('link').elements().map((link) => link.textContent)).toEqual(['Qué pueden hacer los agentes aquí', 'Enviar un agente']);

    // The agents page's panel is the link's target. It leads the page, so it is in view on arrival
    // and the page doesn't move: the title and the AI disclosure above it stay on screen.
    const agents = await renderRoute(`/d/${RIVERA.slug}/agents#send`);
    await expect.element(agents.screen.getByRole('heading', { level: 2, name: 'Send an agent' })).toHaveAttribute('id', 'send');
    expect(document.scrollingElement?.scrollTop).toBe(0);
    await expect.element(agents.screen.getByText('Turner Plumbing answers with Claude, an AI.', { exact: true })).toBeInViewport();
  });

  it('send_link_lands_on_the_whole_panel_in_a_short_window', async () => {
    // A phone on its side: the panel's title is on screen on arrival but its tasks aren't. Landing
    // on #send brings the card into view, its title and its tasks.
    await cleanup();
    await page.viewport(844, 390);
    onTestFinished(async () => {
      await page.viewport(VIEWPORTS.desktop.width, VIEWPORTS.desktop.height);
    });
    setPollScale(0.05);
    const screen = await render(<App router={createMemoryRouter(routes, { initialEntries: [`${PAGE}#send`] })} />);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByRole('heading', { level: 2, name: 'Send an agent' })).toBeInTheDocument();
    await until(() => {
      expectInView(panel.getByRole('heading', { level: 2, name: 'Send an agent' }).element(), 'the panel’s title');
      for (const task of TASKS) expectInView(panel.getByRole('button', { name: task }).element(), `the task "${task}"`);
    });
  });

  it('owner_sees_agent_conversation', async () => {
    // A fresh copy has Alex Kim's assistant's chat: Mike reads its signed requests, in its own
    // words, with the Desk's checked replies.
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/conversations/ses-alex-agent`);
    const name = rivera.conversations.alexAgent.name;
    await expect.element(screen.getByRole('heading', { level: 2, name })).toBeVisible();
    const chat = screen.getByRole('log', { name: `Conversation with ${name}` });
    await expect.element(chat.getByText('Request 1', { exact: true })).toBeVisible();
    const requested = [...chat.element().querySelectorAll('.cd-agent-message')];
    expect(requested).toHaveLength(2);
    for (const el of requested) {
      expect(el.querySelector('.cd-agent-message__name')?.textContent).toBe(name);
      expect(el.querySelector('.cd-pill')?.textContent).toBe('Signed');
    }
    const words = rivera.conversations.alexAgent.turns.flatMap((turn) => (turn.kind === 'agent' ? [turn.text] : []));
    expect(requested.map((el) => el.querySelector('.cd-agent-message__text')?.textContent)).toEqual(words);
    expect(chat.element().querySelectorAll('.cd-claude-message')).toHaveLength(2);
    await expectScreenBasics(screen.container, { owner: true });

    // The built-in agent sent from the public page shows up there too, as its own chat.
    const sent = await renderRoute(PAGE);
    await sent.screen.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await expect.element(sent.screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    const agent = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1);
    const owner = await renderRoute(`/app/${RIVERA.deskId}/conversations/${agent?.state.session_id ?? ''}`);
    const theirs = owner.screen.getByRole('log', { name: `Conversation with ${name}` });
    await expect.element(theirs.getByText('Request 1', { exact: true })).toBeVisible();
    expect(theirs.element().querySelectorAll('.cd-agent-message')).toHaveLength(1);
    // Mike reads the words the visitor's page quoted.
    expect(theirs.element().querySelector('.cd-agent-message__text')?.textContent).toBe('Charge the full repair, $185, to Alex Kim’s card.');
  });

  it('stopped_or_busy_run_says_so', async () => {
    const STOPPED = 'The agent stopped before finishing. Try again.';
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    const book = panel.getByRole('button', { name: 'Book the earliest visit' });

    // The run failed: it says so, and the tasks are there to try again.
    mockStore.inject({
      route: 'agentRun',
      status: 200,
      times: 100,
      body: plantedRun('failed'),
    });
    await book.click();
    await expect.element(panel.getByText(STOPPED, { exact: true })).toBeVisible();
    expect(panel.getByText('The agent finished.').elements()).toHaveLength(0);
    await expect.element(book).toBeVisible();
    expect(chipsIn(screen)).toEqual(TASKS);
    // The tasks come after the stopped line, at the end of the run.
    expect(follows(panel.getByText(STOPPED, { exact: true }).element(), chipGroup(screen))).toBe(true);

    // The run isn't there any more (a 404): the same.
    mockStore.reset('rivera', {});
    mockStore.inject({ route: 'agentRun', status: 404 });
    await book.click();
    await expect.element(panel.getByText(STOPPED, { exact: true })).toBeVisible();
    expect(chipsIn(screen)).toEqual(TASKS);
    expect(follows(panel.getByText(STOPPED, { exact: true }).element(), chipGroup(screen))).toBe(true);

    // A read the API refuses for good (403, 409, 422) ends the run as stopped too, rather than
    // being read forever.
    for (const status of [403, 409, 422]) {
      mockStore.inject({ route: 'agentRun', status });
      await book.click();
      await expect.element(panel.getByText(STOPPED, { exact: true })).toBeVisible();
      expect(chipsIn(screen)).toEqual(TASKS);
    }

    // The demo agent is busy (a 429): it says so, and nothing runs.
    mockStore.inject({ route: 'sendAgent', status: 429 });
    const runs = requests('agentRun').length;
    await book.click();
    await expect.element(panel.getByText('The demo agent is busy. Try again in a minute.', { exact: true })).toBeVisible();
    expect(requests('agentRun')).toHaveLength(runs);
    expect(chipsIn(screen)).toEqual(TASKS);
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('both_actions_share_one_session', async () => {
    // A fresh page, whose session opens slowly: the page's read of the Desk's tasks opens it, and the
    // key and the run, sent once the tasks show, both belong to it, so the run is read to its end.
    worker.use(
      http.post(`/api/public/desks/${RIVERA.slug}/sessions`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return undefined;
      }),
    );
    const { screen } = await renderRoute(PAGE, { seed: 'rivera' });
    await screen.getByRole('button', { name: 'Get a demo key' }).click();
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(screen.getByRole('group', { name: 'Private key' })).toBeVisible();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('openSession')).toHaveLength(1);
    expect(requests('agentRun').length).toBeGreaterThan(0);

    // When both find the session gone at once, one new session opens for both.
    mockStore.reset('rivera', {});
    const again = await renderRoute(PAGE);
    await expect.element(again.screen.getByRole('button', { name: 'Try to pay more than its limit' })).toBeVisible();
    mockStore.dropVisitorCookie(RIVERA.slug);
    const opened = requests('openSession').length;
    await again.screen.getByRole('button', { name: 'Get a demo key' }).click();
    await again.screen.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await expect.element(again.screen.getByRole('group', { name: 'Private key' })).toBeVisible();
    await expect.element(again.screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('openSession')).toHaveLength(opened + 1);
  });

  it('a_send_shares_the_open_after_a_failed_task_read', async () => {
    // The page's read of the Desk's tasks finds no session it can open (a 429), so the plain tasks
    // show. A demo key and a task, pressed together, then share the one session the first opens.
    mockStore.inject({ route: 'openSession', status: 429 });
    worker.use(
      http.post(`/api/public/desks/${RIVERA.slug}/sessions`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return undefined;
      }),
    );
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByRole('button', { name: 'Book the earliest appointment' })).toBeVisible();
    expect(requests('agentTasks')).toHaveLength(0);
    const mark = mockStore.requests.length;
    await screen.getByRole('button', { name: 'Get a demo key' }).click();
    await panel.getByRole('button', { name: 'Book the earliest appointment' }).click();
    await expect.element(screen.getByRole('group', { name: 'Private key' })).toBeVisible();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('openSession', mark)).toHaveLength(1);
  });

  it('both_actions_share_one_reopened_session', async () => {
    // The page opens its session to read the Desk's tasks, and a key request in it is refused as busy.
    mockStore.inject({ route: 'agentKey', status: 429 });
    const { screen } = await renderRoute(PAGE);
    const card = screen.getByRole('region', { name: 'Try it with a demo key' });
    await card.getByRole('button', { name: 'Get a demo key' }).click();
    await expect.element(card.getByText(errorCopy('rate_limited'), { exact: true })).toBeVisible();
    const opened = requests('openSession').length;
    expect(opened).toBe(1);

    // Both actions then find it gone at once: one new session opens for both, and both go through.
    mockStore.inject({ route: 'agentKey', status: 401, delayMs: 1_000 });
    mockStore.inject({ route: 'sendAgent', status: 401, delayMs: 1_000 });
    await card.getByRole('button', { name: 'Get a demo key' }).click();
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(card.getByRole('group', { name: 'Private key' })).toBeVisible();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('openSession')).toHaveLength(opened + 1);
    expect(requests('agentKey')).toHaveLength(3);
    expect(requests('sendAgent')).toHaveLength(2);
  });

  it('lost_start_is_sent_again_with_its_key', async () => {
    // The start's answer is lost (no answer or a 5xx), whether or not the API started the agent: the
    // panel says so and offers no task, only "Try again", which sends the same task with the same
    // key. The API answers the run the first send started, or starts it now: the agent runs once.
    const lost = [
      { status: 'network' as const, afterCommit: true },
      { status: 503 as const, afterCommit: true },
      { status: 'network' as const },
    ];
    for (const fault of lost) {
      mockStore.inject({ route: 'sendAgent', ...fault });
      const { screen } = await renderRoute(PAGE);
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      await expect.element(panel.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
      const mark = mockStore.requests.length;
      const runs = agentRuns();
      await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
      await expect.element(panel.getByText(agentStartLostLine('en'), { exact: true })).toBeVisible();
      expect(chipsIn(screen)).toEqual([]);
      expect(panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).elements()).toHaveLength(0);
      expect(requests('agentRun', mark)).toHaveLength(0);
      await expectScreenBasics(screen.container, { owner: false });

      await panel.getByRole('button', { name: 'Try again' }).click();
      await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
      expect(panel.getByText(agentStartLostLine('en')).elements()).toHaveLength(0);
      // "Try again" goes with its line, so focus moves to the panel's title, as after a task.
      await expect.element(panel.getByRole('heading', { level: 2, name: 'Send an agent' })).toHaveFocus();
      const sent = requests('sendAgent', mark).map((r) => r.body as { task: string; idempotency_key?: string });
      expect(sent, JSON.stringify(fault)).toHaveLength(2);
      expect(sent[0]?.task).toBe('book_visit');
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[0]?.idempotency_key).toMatch(/^[^\x00-\x1f\x7f]{1,128}$/);
      expect(agentRuns(), JSON.stringify(fault)).toBe(runs + 1);
      expect(new Set(requests('agentRun', mark).map((r) => r.path)).size).toBe(1);
    }
  });

  it('lost_start_whose_key_moved_session_offers_a_reload', async () => {
    // A lost start, then "Try again" finds the session gone: a new one opens and the same key goes
    // again, but the API answers 409 `conflict`, since the key belongs to the old session, where the
    // agent may be running. This page can't find that run, so no same-key retry is safe any more: it
    // falls back to a reload, with no task to send it twice. (A first send's 409 stays "not sent".)
    mockStore.inject({ route: 'sendAgent', status: 'network', afterCommit: true });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
    const runs = agentRuns();
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The chat's session ends: the mock answers the send 401, the page opens a new session, and the
    // mock, which keeps the key for the old one, answers the same key 409 `conflict`.
    const opened = requests('openSession').length;
    mockStore.dropVisitorCookie(RIVERA.slug);
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect.element(panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en })).toBeVisible();
    await expect.element(panel.getByText(AGENT_START_LOST_COPY.en, { exact: true })).toBeVisible();
    expect(panel.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(0);
    expect(panel.getByText(UNREACHABLE_COPY.en).elements()).toHaveLength(0);
    expect(chipsIn(screen)).toEqual([]);
    expect(requests('openSession')).toHaveLength(opened + 1);
    const keys = requests('sendAgent').map((r) => (r.body as { idempotency_key?: string }).idempotency_key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(agentRuns()).toBe(runs + 1);
    await expectScreenBasics(screen.container, { owner: false });
    // "Reload the page" reloads it: the only retry left on this page view.
    const reload = vi.spyOn(pageActions, 'reload').mockImplementation(() => {});
    await panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).click();
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  });

  it('lost_start_stays_unresolved_when_its_session_cannot_reopen', async () => {
    // "Try again" after a lost start finds the session gone (the mock ends it, so the send is
    // answered 401), and opening a new one fails (a 429, or no answer). The send itself never
    // answered, so the start is still unresolved: the lost line and "Try again" stay, with no task to
    // send a second agent and no busy line. The next "Try again" opens a new session, where the key,
    // the old session's, is a 409 `conflict`: the reload, with no task, and the agent ran once. The
    // page opened its session when it read the Desk's tasks, so the first send opens none.
    for (const failure of [{ status: 429 as const }, { status: 'network' as const }]) {
      mockStore.inject({ route: 'sendAgent', status: 'network', afterCommit: true });
      const { screen } = await renderRoute(PAGE);
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      const what = JSON.stringify(failure);
      await expect.element(panel.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
      const mark = mockStore.requests.length;
      const runs = agentRuns();
      await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
      await expect.element(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
      mockStore.dropVisitorCookie(RIVERA.slug);
      mockStore.inject({ route: 'openSession', ...failure });
      await panel.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(() => requests('openSession', mark).length, { message: what }).toBe(1);
      await expect.element(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect.element(panel.getByText(agentStartLostLine('en'), { exact: true })).toBeVisible();
      expect(chipsIn(screen), what).toEqual([]);
      expect(panel.getByText('The demo agent is busy. Try again in a minute.').elements(), what).toHaveLength(0);
      expect(panel.getByText(UNREACHABLE_COPY.en).elements(), what).toHaveLength(0);

      await panel.getByRole('button', { name: 'Try again' }).click();
      await expect.element(panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en })).toBeVisible();
      await expect.element(panel.getByText(AGENT_START_LOST_COPY.en, { exact: true })).toBeVisible();
      expect(chipsIn(screen), what).toEqual([]);
      expect(requests('openSession', mark), what).toHaveLength(2);
      const keys = requests('sendAgent', mark).map((r) => (r.body as { idempotency_key?: string }).idempotency_key);
      expect(keys, what).toHaveLength(3);
      expect(new Set(keys).size, what).toBe(1);
      expect(agentRuns(), what).toBe(runs + 1);
    }
  });

  it('lost_start_whose_chat_ends_offers_a_reload', async () => {
    // "Try again" meets a 401, a new session opens, and the send meets a 401 again: the chat has
    // ended, but the start is still unresolved, so the page offers the reload, never a new chat
    // with fresh tasks.
    mockStore.inject({ route: 'sendAgent', status: 'network', afterCommit: true });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
    const runs = agentRuns();
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
    mockStore.inject({ route: 'sendAgent', status: 401, times: 2 });
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect.element(panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en })).toBeVisible();
    await expect.element(panel.getByText(AGENT_START_LOST_COPY.en, { exact: true })).toBeVisible();
    expect(panel.getByRole('button', { name: NEW_CHAT_LABEL.en }).elements()).toHaveLength(0);
    expect(panel.getByText(CHAT_ENDED_COPY.en).elements()).toHaveLength(0);
    expect(chipsIn(screen)).toEqual([]);
    expect(requests('sendAgent')).toHaveLength(3);
    expect(agentRuns()).toBe(runs + 1);
  });

  it('kernel_conflict_on_a_retry_is_not_a_moved_session', async () => {
    // A 409 from the kernel (`{error: "kernel"}`) refused the send itself, which freed its key: as
    // on a first send, it wasn't sent, and the tasks come back. Only the API's own key conflict
    // means the key moved session.
    mockStore.inject({ route: 'sendAgent', status: 'network' });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
    mockStore.inject({ route: 'sendAgent', status: 409, body: { error: 'kernel', code: 'conflict' } });
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect.element(panel.getByText(UNREACHABLE_COPY.en, { exact: true })).toBeVisible();
    expect(chipsIn(screen)).toEqual(TASKS);
    expect(panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).elements()).toHaveLength(0);
  });

  it('lost_start_past_its_keys_retry_window_offers_a_reload', async () => {
    // The API keeps a send's key for its run's hour, so "Try again" is offered only while the key is
    // younger than 55 minutes; past that, a same-key retry could start a second agent, and the page
    // falls back to a reload. The page's clock moves only when the test moves it.
    mockStore.inject({ route: 'sendAgent', status: 'network', afterCommit: true });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
    useRunClock();
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await until(() => expect(panel.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(1));
    expect(KEY_RETRY_WINDOW_MS).toBe(55 * 60_000);
    vi.advanceTimersByTime(KEY_RETRY_WINDOW_MS - 1);
    await settle();
    expect(panel.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(1);
    // The visitor is on "Try again" when the window closes: the reload takes its place in the same
    // notice, and the visitor's focus stays there, on "Reload the page", rather than falling to the page.
    (panel.getByRole('button', { name: 'Try again' }).element() as HTMLElement).focus();
    vi.advanceTimersByTime(1);
    await until(() => expect(panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).elements()).toHaveLength(1));
    expect(panel.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(0);
    expect(document.activeElement).toBe(panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).element());
    expect(panel.getByText(AGENT_START_LOST_COPY.en, { exact: true }).elements()).toHaveLength(1);
    expect(chipsIn(screen)).toEqual([]);
    expect(requests('sendAgent')).toHaveLength(1);

    // A tab whose timers were held back (a hidden tab's are) checks the key's age on the press as
    // well: past the window, "Try again" sends nothing and offers the reload, which takes the same
    // button, so the focus stays on it as on the timer's path.
    mockStore.inject({ route: 'sendAgent', status: 'network', afterCommit: true });
    const next = (await renderRoute(PAGE)).screen.getByRole('region', { name: 'Send an agent' });
    await until(() => expect(next.getByRole('button', { name: 'Book the earliest visit' }).elements()).toHaveLength(1));
    await next.getByRole('button', { name: 'Book the earliest visit' }).click();
    await until(() => expect(next.getByRole('button', { name: 'Try again' }).elements()).toHaveLength(1));
    vi.setSystemTime(Date.now() + KEY_RETRY_WINDOW_MS);
    await next.getByRole('button', { name: 'Try again' }).click();
    await until(() => expect(next.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).elements()).toHaveLength(1));
    expect(document.activeElement).toBe(next.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).element());
    expect(requests('sendAgent')).toHaveLength(2);
  });

  it('each_task_click_sends_a_new_key', async () => {
    // A key belongs to one click: a task pressed again, or another task, is a new send with a new key.
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    const runs = agentRuns();
    for (const task of ['Book the earliest visit', 'Book the earliest visit', 'Try to pay more than its limit']) {
      await panel.getByRole('button', { name: task }).click();
      await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    }
    const keys = requests('sendAgent').map((r) => (r.body as { idempotency_key?: string }).idempotency_key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(agentRuns()).toBe(runs + 3);
  });

  it('conflicting_key_is_not_sent', async () => {
    // The API refuses the key (409 `conflict`: another task, session or Desk used it): nothing was
    // sent, so the panel says so, keeps its lead and offers the tasks again, and the next click
    // sends a new key.
    mockStore.inject({ route: 'sendAgent', status: 409, body: { error: 'conflict' } });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText(UNREACHABLE_COPY.en, { exact: true })).toBeVisible();
    expect(chipsIn(screen)).toEqual(TASKS);
    expect(panel.element().querySelector('.cd-agents-card__lead')?.textContent).toBe(LEAD);
    expect(panel.getByText(agentStartLostLine('en')).elements()).toHaveLength(0);
    expect(requests('agentRun')).toHaveLength(0);
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    const keys = requests('sendAgent').map((r) => (r.body as { idempotency_key?: string }).idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('spent_demo_budget_sends_nothing', async () => {
    // The demo's model budget is spent: the API refused before starting the agent, so the panel
    // says so and offers the tasks again.
    mockStore.inject({ route: 'sendAgent', status: 503, body: { error: 'demo_budget' } });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText(DEMO_BUDGET_COPY.en, { exact: true })).toBeVisible();
    expect(panel.getByText(agentStartLostLine('en')).elements()).toHaveLength(0);
    expect(chipsIn(screen)).toEqual(TASKS);
    expect(panel.element().querySelector('.cd-agents-card__lead')?.textContent).toBe(LEAD);
    expect(requests('agentRun')).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('long_run_is_read_until_it_ends', async () => {
    // Reads go every 50 ms here (the poll scale), and five times slower once the run has been read
    // for a scaled minute (3 s). The clock moves only when the test moves it.
    mockStore.inject({ route: 'agentRun', status: 200, times: 5, body: plantedRun('running') });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
    useRunClock();
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await until(() => expect(requests('sendAgent')).toHaveLength(1));
    await settle();
    await readAfter(50, 1);
    await readAfter(50, 2);
    await readAfter(50, 3);

    // An hour on, the agent still runs: it is read again, and nothing calls it stopped or offers another task.
    await readAfter(60 * 60_000, 4);
    expect(panel.getByText('The agent stopped before finishing. Try again.').elements()).toHaveLength(0);
    expect(chipsIn(screen)).toEqual([]);
    expect(panel.getByRole('status').elements().some((el) => el.textContent === 'Alex Kim’s assistant is at work')).toBe(true);

    // Past the minute, reads go five times slower: none at the poll's pace, one at the slower one.
    vi.advanceTimersByTime(50);
    await settle();
    expect(requests('agentRun')).toHaveLength(4);
    await readAfter(200, 5);

    // The run is read until it ends, always the same run.
    await readAfter(250, 6);
    await until(() => expect(panel.getByText('The agent finished.', { exact: true }).elements()).toHaveLength(1));
    expect(new Set(requests('agentRun').map((r) => r.path)).size).toBe(1);

    // Reads that fail say so after five in a row and go on; the run is still read to its end.
    mockStore.inject({ route: 'agentRun', status: 503, times: 6 });
    const next = await renderRoute(PAGE);
    const nextPanel = next.screen.getByRole('region', { name: 'Send an agent' });
    await nextPanel.getByRole('button', { name: 'Get a quote and pay the service call deposit' }).click();
    await until(() => expect(requests('sendAgent')).toHaveLength(2));
    await settle();
    for (let n = 7; n <= 11; n += 1) await readAfter(50, n);
    await until(() => expect(nextPanel.getByText(UNREACHABLE_COPY.en, { exact: true }).elements()).toHaveLength(1));
    expect(chipsIn(next.screen)).toEqual([]);
    await readAfter(50, 12);
    // The agent's own turns move on the same clock: two seconds see it through, then a read finds it done.
    await readAfter(2_000, 13);
    await until(() => expect(nextPanel.getByText('The agent finished.', { exact: true }).elements()).toHaveLength(1));
    expect(nextPanel.getByText(UNREACHABLE_COPY.en).elements()).toHaveLength(0);
  });

  it('reads_pause_while_hidden_and_stop_on_unmount', async () => {
    mockStore.inject({ route: 'agentRun', status: 200, times: 100, body: plantedRun('running') });
    const { screen } = await renderRoute(PAGE);
    await expect.element(screen.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'visibilityState');
    });
    useRunClock();
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await until(() => expect(requests('sendAgent')).toHaveLength(1));
    await settle();
    await readAfter(50, 1);

    // While the tab is hidden, no read goes, however long; once it is back, one does.
    setHidden(true);
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(requests('agentRun')).toHaveLength(1);
    setHidden(false);
    await until(() => expect(requests('agentRun')).toHaveLength(2));
    await settle();

    // The page goes away while it waits for the tab: the wait ends with it, and nothing more is read.
    // The hidden minute has passed, so the next wait is the slower one (250 ms).
    setHidden(true);
    vi.advanceTimersByTime(250);
    await settle();
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    onTestFinished(() => {
      added.mockRestore();
      removed.mockRestore();
    });
    await cleanup();
    expect(removed.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);
    setHidden(false);
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(requests('agentRun')).toHaveLength(2);
    expect(added.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(0);
  });

  it('long_business_name_fits_a_phone', async () => {
    // A business's name with no break in it, as the kernel may serve one: the page, its panel and a
    // run all stay inside a phone's width.
    const name = 'TurnerPlumbingHeatingAndDrainServicesForTheWholeEastBayIncorporated';
    expect(name.length).toBeGreaterThanOrEqual(60);
    expect(name.length).toBeLessThanOrEqual(80);
    await plantDesk({ business_name: name });
    const { screen } = await renderRoute(PAGE, { viewport: 'phone' });
    const heading = screen.getByRole('heading', { level: 1, name: `${name} for AI agents` });
    await expect.element(heading).toBeVisible();
    expect(heading.element().textContent).toContain(name);
    expectNoHorizontalScroll();
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
  });

  it('business_name_is_marked_as_its_own_words', async () => {
    // The business's name is its own words wherever the page writes it, the panel's lead included,
    // so the copy check never reads it as the page's (all capitals and an exclamation mark here).
    await plantDesk({ business_name: 'ACME!' });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel).toBeVisible();
    const lead = panel.element().querySelector('.cd-agents-card__lead');
    await until(() => expect(lead?.textContent).toBe('A built-in agent visits ACME! for Alex Kim. It’s simulated.'));
    expect(lead?.querySelector('[data-copy="user"]')?.textContent).toBe('ACME!');
    await expectScreenBasics(screen.container, { owner: false });
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: false });

    await plantDesk({ business_name: 'ACME!' });
    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect.element(es.screen.getByRole('region', { name: 'Enviar un agente' })).toBeVisible();
    const esLead = () => es.screen.getByRole('region', { name: 'Enviar un agente' }).element().querySelector('.cd-agents-card__lead');
    await until(() => expect(esLead()?.textContent).toBe('Un agente integrado visita ACME! en nombre de Alex Kim. Es simulado.'));
    expect(esLead()?.querySelector('[data-copy="user"]')?.textContent).toBe('ACME!');
    await expectScreenBasics(es.screen.container, { owner: false });
  });
});
