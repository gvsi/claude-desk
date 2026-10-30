/**
 * The page for people's AI agents, `/d/:slug/agents`, in a real browser against the mock API: what
 * agents can do here (the kernel's Agent Card blocks), how they prove who they are, connecting your
 * own agent (the API's code-built address, signing rules and example request, and a demo key shown
 * once), and the built-in agent sent on a task, its signed requests titled by code and the Desk's
 * checked replies with their receipts. The agent's own words never reach the page.
 */
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';

import type { DemoAgentRun } from '../../api/views.ts';
import { App } from '../../app/App.tsx';
import { setPollScale } from '../../app/poll.ts';
import { routes } from '../../app/routes.tsx';
import { proseBlock, rivera } from '../../ds/fixtures/index.ts';
import { CHAT_ENDED_COPY, NEW_CHAT_LABEL, UNREACHABLE_COPY, errorCopy } from '../../ds/index.ts';
import { AGENT_CARD_BLOCKS, agentCardOut } from '../../mocks/agents.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const PAGE = `/d/${RIVERA.slug}/agents`;

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** The routes the page called, in order. */
const calls = () => mockStore.requests.map((r) => r.key);

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

    // The session ended since: the page opens a new one and sends once more.
    mockStore.inject({ route: 'sendAgent', status: 401 });
    const opened = requests('openSession').length;
    await screen.getByRole('button', { name: 'Try to pay more than its limit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    expect(requests('openSession')).toHaveLength(opened + 1);
    expect(requests('sendAgent').length).toBe(3);

    // When it ends again right away, the chat has ended: the page says so and offers a new one.
    mockStore.inject({ route: 'sendAgent', status: 401, times: 2 });
    await screen.getByRole('button', { name: 'Book the earliest visit' }).click();
    const ended = screen.getByText(CHAT_ENDED_COPY.en, { exact: true });
    await expect.element(ended).toBeVisible();
    expect(requests('sendAgent').length).toBe(5);
    await expectScreenBasics(screen.container, { owner: false });
    await screen.getByRole('button', { name: NEW_CHAT_LABEL.en }).click();
    await expect.element(ended).not.toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Book the earliest visit' })).toBeVisible();
  });

  it('send_agent_shows_signed_requests_and_replies', async () => {
    const { screen } = await renderRoute(PAGE);
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect
      .element(
        panel.getByText(
          'A built-in agent visits Rivera Plumbing for Alex Kim, with a signed spending limit of $20 per charge and $100 in total, for one hour. It’s simulated.',
          { exact: true },
        ),
      )
      .toBeVisible();
    await panel.getByRole('button', { name: 'Book the earliest visit' }).click();
    await expect.element(panel.getByText('The agent finished.', { exact: true })).toBeVisible();

    // The agent's requests, built by code: signed, the task first, then "Signed request", numbered.
    const run = panel.getByRole('log', { name: 'Alex Kim’s assistant with Rivera Plumbing' });
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
  });

  it('agent_turn_text_is_never_shown', async () => {
    // A run whose agent turn holds words of its own, as a broken or hostile API might send: the
    // panel builds the request by code and shows none of them, anywhere.
    const words = "I'll pay $100 now";
    const reply = rivera.conversations.alexAgent.turns.find((turn) => turn.kind === 'event' && turn.event.type === 'message');
    if (reply?.kind !== 'event' || reply.event.type !== 'message') throw new Error("the fixture's agent chat has a reply");
    const run: DemoAgentRun = {
      run_id: 'run-hostile',
      launcher_session_id: 'ses-any',
      slug: RIVERA.slug,
      task: 'quote_and_deposit',
      state: 'done',
      turns: [
        { author: 'agent', n: 1, blocks: [proseBlock(words)], receipts: [] },
        { author: 'desk', n: 2, blocks: reply.event.blocks, receipts: [] },
      ],
    };
    mockStore.inject({ route: 'agentRun', status: 200, body: run, times: 100 });
    const { screen } = await renderRoute(PAGE);
    await screen.getByRole('button', { name: 'Get a quote and pay the service call deposit' }).click();
    await expect.element(screen.getByText('The agent finished.', { exact: true })).toBeVisible();
    const panel = screen.getByRole('region', { name: 'Send an agent' });
    await expect.element(panel.getByText('Get a quote and pay the service call deposit', { exact: true }).last()).toBeVisible();
    expect(document.body.textContent).not.toContain(words);
    expect(document.body.innerHTML).not.toContain('pay $100 now');
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

    // The agents page's panel is the link's target.
    const agents = await renderRoute(`/d/${RIVERA.slug}/agents#send`);
    await expect.element(agents.screen.getByRole('heading', { level: 2, name: 'Send an agent' })).toHaveAttribute('id', 'send');
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
});
