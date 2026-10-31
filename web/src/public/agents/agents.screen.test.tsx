/**
 * The page for people's AI agents, `/d/:slug/agents`, in a real browser against the mock API: the
 * built-in agent sent on a task, its signed requests titled by code and the Desk's checked replies
 * with their receipts; then what agents can do here (the kernel's Agent Card blocks), how they prove
 * who they are, and connecting your own agent (the API's code-built address, signing rules and
 * example request, and a demo key shown once). The agent's own words never reach the page.
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
import { VIEWPORTS, renderRoute, type Viewport } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { pageActions } from './SendAgentPanel.tsx';

const PAGE = `/d/${RIVERA.slug}/agents`;

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** The routes the page called, in order. */
const calls = () => mockStore.requests.map((r) => r.key);

/** The panel's three tasks. */
const TASKS = ['Book the earliest visit', 'Get a quote and pay the service call deposit', 'Try to pay more than its limit'];

/** The panel's lead before a run, as boards 03 to 05 write it. */
const LEAD = 'A built-in agent visits Rivera Plumbing for Alex Kim. It’s simulated.';

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
    const disclosure = screen.getByText('Rivera Plumbing answers with Claude, an AI.', { exact: true }).element();
    expect(follows(disclosure, screen.getByRole('region', { name: 'Send an agent' }).element())).toBe(true);
  });

  it('agent_card_discloses_ai', async () => {
    // The page's title, its disclosure and its cards in the browser's language, under the brand header.
    const en = await renderRoute(PAGE);
    await expect.element(en.screen.getByRole('heading', { level: 1, name: 'Rivera Plumbing for AI agents' })).toBeVisible();
    await expect.element(en.screen.getByText('Rivera Plumbing answers with Claude, an AI.', { exact: true })).toBeVisible();
    expect(en.screen.getByRole('banner').element().textContent).toContain('Rivera Plumbing');
    await expectScreenBasics(en.screen.container, { owner: false });

    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect.element(es.screen.getByRole('heading', { level: 1, name: 'Rivera Plumbing para agentes de IA' })).toBeVisible();
    await expect.element(es.screen.getByText('Rivera Plumbing responde con Claude, una IA.', { exact: true })).toBeVisible();
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
    await expectScreenBasics(es.screen.container, { owner: false });

    // Before the Desk shows, and when it can't be read, the page still says who answers.
    mockStore.inject({ route: 'agentCard', status: 503 });
    const down = await renderRoute(PAGE);
    await expect.element(down.screen.getByText(UNREACHABLE_COPY.en, { exact: true })).toBeVisible();
    await expect.element(down.screen.getByText('This page is part of a chat with Claude, an AI.', { exact: true })).toBeVisible();
    await expectScreenBasics(down.screen.container, { owner: false });
    // "Try again" reads it again, and the page shows.
    await down.screen.getByRole('button', { name: 'Try again' }).click();
    await expect.element(down.screen.getByRole('heading', { level: 1, name: 'Rivera Plumbing for AI agents' })).toBeVisible();

    // A Desk that isn't there says so, with the disclosure.
    const gone = await renderRoute('/d/no-such-desk/agents');
    await expect.element(gone.screen.getByText("This Desk isn't available", { exact: true })).toBeVisible();
    await expect.element(gone.screen.getByText('This page is part of a chat with Claude, an AI.', { exact: true })).toBeVisible();
    await expectScreenBasics(gone.screen.container, { owner: false });
  });

  it('agents_document_language_follows_the_page', async () => {
    // The document's language, as index.html sets it (the test browser's page has its own).
    document.documentElement.lang = 'en';
    // A Spanish browser: the whole document is Spanish while the page is open, from its first line.
    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect.element(es.screen.getByRole('heading', { level: 1, name: 'Rivera Plumbing para agentes de IA' })).toBeVisible();
    expect(document.documentElement.lang).toBe('es');
    // Leaving the page hands the document its language back.
    await es.router.navigate('/no/such/page');
    await expect.element(es.screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    expect(document.documentElement.lang).toBe('en');
  });

  it('agent_page_opens_a_session_first', async () => {
    // The mock, like the API, refuses to send an agent for a browser with no chat.
    mockStore.reset('rivera');
    const refused = await mockStore.dispatch('sendAgent', { params: { slug: RIVERA.slug }, body: { task: 'book_visit' } });
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

  it('send_agent_shows_signed_requests_and_replies', async () => {
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByText(LEAD, { exact: true })).toBeVisible();
    expect(limitIn(screen)).toEqual({ values: LIMIT_VALUES, source: LIMIT_SOURCE });
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

  it('agent_turn_text_is_never_shown', async () => {
    // A run whose agent turn holds words of its own, as a broken or hostile API might send: the
    // panel builds the request by code and shows none of them, anywhere.
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
    const strict = await renderStrict(PAGE);
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

  it('public_page_links_to_agents', async () => {
    // The public page's about column, under "For AI agents": both links lead to the agents page,
    // "Send an agent" to its panel. The about blocks stay the charter's.
    const { screen } = await renderRoute(`/d/${RIVERA.slug}`);
    const about = screen.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expect.element(about.getByRole('heading', { name: 'For AI agents' })).toBeVisible();
    const links = about.getByRole('link').elements();
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['What agents can do here', `/d/${RIVERA.slug}/agents`],
      ['Send an agent', `/d/${RIVERA.slug}/agents#send`],
    ]);
    expect(about.element().querySelectorAll('.cd-reply-card')).toHaveLength(rivera.publicDesk.en.charter.length);
    await expectScreenBasics(screen.container, { owner: false });

    const es = await renderRoute(`/d/${RIVERA.slug}`, { language: 'es-ES' });
    const acerca = es.screen.getByRole('complementary', { name: /Rivera Plumbing/ });
    await expect.element(acerca.getByRole('heading', { name: 'Para agentes de IA' })).toBeVisible();
    expect(acerca.getByRole('link').elements().map((link) => link.textContent)).toEqual(['Qué pueden hacer los agentes aquí', 'Enviar un agente']);

    // The agents page's panel is the link's target. It leads the page, so it is in view on arrival
    // and the page doesn't move: the title and the AI disclosure above it stay on screen.
    const agents = await renderRoute(`/d/${RIVERA.slug}/agents#send`);
    await expect.element(agents.screen.getByRole('heading', { level: 2, name: 'Send an agent' })).toHaveAttribute('id', 'send');
    expect(document.scrollingElement?.scrollTop).toBe(0);
    await expect.element(agents.screen.getByText('Rivera Plumbing answers with Claude, an AI.', { exact: true })).toBeInViewport();
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
    // A fresh copy has Alex Kim's assistant's chat: Maria reads its signed requests, in its own
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
    // A fresh page, where both actions start before the visitor's session has opened: one session
    // opens, and the key and the run both belong to it, so the run is read to its end.
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
    const opened = requests('openSession').length;
    await again.screen.getByRole('button', { name: 'Get a demo key' }).click();
    await again.screen.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await expect.element(again.screen.getByRole('group', { name: 'Private key' })).toBeVisible();
    await expect.element(again.screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('openSession')).toHaveLength(opened + 1);
  });

  it('both_actions_share_one_reopened_session', async () => {
    // The session opens with a key request the demo refuses as busy.
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

  it('lost_start_offers_no_second_agent', async () => {
    // The start's answer is lost: the agent may be on its way, and no read can find its run, so the
    // page says it couldn't confirm and offers no task to send it twice. A reload is the retry.
    for (const status of ['network', 503] as const) {
      mockStore.inject({ route: 'sendAgent', status, afterCommit: true });
      const { screen } = await renderRoute(PAGE);
      await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
      const panel = screen.getByRole('region', { name: 'Send an agent' });
      await expect.element(panel.getByText(AGENT_START_LOST_COPY.en, { exact: true })).toBeVisible();
      expect(chipsIn(screen)).toEqual([]);
      expect(requests('agentRun')).toHaveLength(0);
      await expectScreenBasics(screen.container, { owner: false });
      // "Reload the page" reloads it: the retry, on a page that reads where things stand.
      const reload = vi.spyOn(pageActions, 'reload').mockImplementation(() => {});
      await panel.getByRole('button', { name: RELOAD_PAGE_LABEL.en }).click();
      expect(reload).toHaveBeenCalledTimes(1);
      reload.mockRestore();
    }
    expect(requests('sendAgent')).toHaveLength(2);
  });

  it('spent_demo_budget_sends_nothing', async () => {
    // The demo's model budget is spent: the API refused before starting the agent, so the panel
    // says so and offers the tasks again.
    mockStore.inject({ route: 'sendAgent', status: 503, body: { error: 'demo_budget' } });
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText(DEMO_BUDGET_COPY.en, { exact: true })).toBeVisible();
    expect(panel.getByText(AGENT_START_LOST_COPY.en).elements()).toHaveLength(0);
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
    const name = 'RiveraPlumbingHeatingAndDrainServicesForTheWholeEastBayIncorporated';
    expect(name.length).toBeGreaterThanOrEqual(60);
    expect(name.length).toBeLessThanOrEqual(80);
    await plantDesk({ business_name: name });
    const { screen } = await renderRoute(PAGE, { viewport: 'phone' });
    await expect.element(screen.getByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 }).element().textContent).toContain(name);
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
