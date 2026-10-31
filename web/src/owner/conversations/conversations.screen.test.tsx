/**
 * Conversations in a real browser against the mock API: the list beside the open conversation,
 * receipts under each message that open the full trace, the owner's receipts in the owner's
 * words, held requests answered in place, take-over with the owner's own words, whispers, the
 * typing both ways, and recorded history.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { Decision, StatusEvent } from '../../api/contracts.ts';
import type { ConversationSummary, NeedsYouItem, OwnerTranscript } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { typingPingMs } from '../../app/poll.ts';
import { formatClock } from '../../lib/format.ts';
import { AFTER_VERIFY, DECISIONS, DEMO_CODE, SCRIPT, VISITOR_PLAIN, turnEnd, writing } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE, type SessionRecord } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics, focusIsOn } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;
const LIST = `${DESK}/conversations`;
const LA = 'America/Los_Angeles';
const OWNER = rivera.business.ownerName;
const DANA = rivera.people.dana.name;
/** What the seeded hold and Dana's held refund asked, as the kernel's owner line says it. */
const SEEDED_REASON = rivera.decisions.held.reason_plain;
const REFUND_REASON = rivera.heldRefund.reason_plain;

/** The seeded chats: Dana's live one, and the visitor whose 15% discount is held. */
const DANA_LIVE = 'ses-dana-web';
const SEEDED_HOLD = 'ses-visitor-web';

const conversation = (sessionId: string) => `${LIST}/${sessionId}`;

/** The owner's line for a read the server failed. */
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';
/** The owner's line for an answer to a request that changed while they were looking. */
const CHANGED = 'This changed while you were looking. Reload to see where it stands.';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** Waits for `key` to be read `n` more times than now. */
async function readsMore(key: string, n: number): Promise<void> {
  const from = requests(key).length;
  await expect.poll(() => requests(key).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(from + n);
}

function session(sessionId: string): SessionRecord {
  const found = mockStore.world.sessions.get(sessionId);
  if (!found) throw new Error(`the mock has no chat ${sessionId}`);
  return found;
}

/** Names a seeded chat, as a visitor who gave their name would have it. */
function named(sessionId: string, name: string): SessionRecord {
  const chat = session(sessionId);
  chat.displayName = name;
  return chat;
}

function log(screen: RenderResult) {
  return screen.getByRole('log');
}

/** A receipt in the conversation, by the words it shows. */
function receipt(screen: RenderResult, plain: string) {
  return log(screen).getByRole('button', { name: `${plain} Open the full trace.`, exact: true });
}

/** The reads of one decision. */
const decisionReads = (decisionId: string) => requests('decision').filter((r) => r.path.endsWith(`/${encodeURIComponent(decisionId)}`));

/** The signed status event for `decision` as it stands, as the API streams it. */
function statusOf(type: StatusEvent['type'], decision: Decision): StatusEvent {
  const { decision_id, state, visitor_plain, ledger_seq, signature } = decision;
  return { type, decision_id, state, visitor_plain, ledger_seq, signature } as StatusEvent;
}

/**
 * Dana's verified chat, with three decisions: her refund, held and then allowed (a held receipt,
 * then an executed one); a quote Claude ran on its own (one executed receipt, sent after it ran);
 * and a booking allowed but refused when it came to run, because the rules changed in between (one
 * `refused_at_execution` receipt). Each has a reply with its check under it.
 */
function danasChatWithThreeDecisions() {
  const world = mockStore.world;
  const refund = world.addHeldRefund();
  const chat = session(refund.session_id);
  let quote: Decision | null = null;
  let booking: Decision | null = null;
  world.replay(chat, world.now() - MINUTE / 2, [
    {
      text: 'How much is a drain clearing?',
      steps: [
        (ctx) => {
          quote = ctx.decide(DECISIONS.quote);
          return ctx.status('receipt', quote);
        },
        writing,
        (ctx) => ctx.reply([rivera.blocks.quote[ctx.language]]),
      ],
    },
    {
      text: 'Book the first one.',
      steps: [
        (ctx) => {
          const allowed = ctx.decide(DECISIONS.book);
          const record = world.decisions.get(allowed.decision_id);
          if (!record) throw new Error('the booking was recorded');
          record.decision = { ...allowed, state: 'refused_at_execution', visitor_plain: VISITOR_PLAIN.en.refused_at_execution };
          booking = record.decision;
          return ctx.status('receipt', booking);
        },
        writing,
        (ctx) => ctx.reply([rivera.blocks.handoff[ctx.language]]),
      ],
    },
  ], 10_000);
  // Maria allowed the refund: it ran, and its outcome came after the hold.
  const record = world.decisions.get(refund.decision_id);
  if (!record || quote === null || booking === null) throw new Error("Dana's chat has its three decisions");
  const refunded = world.answer(record, 'allow_once');
  world.emit(chat, statusOf('resolved', refunded));
  return { chat, refund, refunded, quote: quote as Decision, booking: booking as Decision };
}

/** The owner's reads of the Desk's conversations, of one chat and of Needs you, as the mock answers them now. */
async function served<T>(key: 'conversations' | 'conversation' | 'needsYou', params: Record<string, string>): Promise<T> {
  const answer = await mockStore.dispatch(key, { params });
  if ('network' in answer || answer.status !== 200) throw new Error(`the mock reads ${key}`);
  return answer.body as T;
}

/** A held request's card, by what was asked. */
function heldCard(screen: RenderResult, reason: string) {
  return screen.getByRole('article', { name: `Held for you: ${reason}`, exact: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Conversations', () => {
  it('conversation_matches_its_board', async () => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const receipts = log(screen).getByRole('button', { name: /Open the full trace\.$/ });
    await expect.poll(() => receipts.elements().length).toBeGreaterThanOrEqual(6);
    // The list is its own read, which can land after the conversation's.
    const links = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link');
    await expect.poll(() => links.elements()).toHaveLength(3);
    const rows = links.elements() as HTMLElement[];

    // Dana's live conversation as N-Conv-Run1 and N-Conv-TakeOver draw it, at 1440 px: the page
    // fills the main area, and Tab goes through the list, then the receipts, then the take-over bar.
    await expectOwnerBoard(screen.container, {
      current: 'Conversations',
      fill: true,
      transcript: true,
      tabStops: [...rows, ...(receipts.elements() as HTMLElement[]), takeOver.element() as HTMLElement],
    });
  });

  it('list_and_detail', async () => {
    named(DANA_LIVE, DANA);
    const { screen, router } = await renderRoute(LIST);

    // Newest first: Dana's live chat, the visitor whose discount is held, then Alex Kim's assistant.
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    await expect.element(list.getByRole('link', { name: new RegExp(DANA) })).toBeVisible();
    const rows = list.getByRole('link').elements();
    expect(rows.map((row) => row.querySelector('[data-copy="user"]')?.textContent)).toEqual([DANA, 'Visitor', rivera.conversations.alexAgent.name]);
    expect(rows[1]?.textContent).toContain('Needs you');
    expect(rows[0]?.textContent).toContain(formatClock(new Date(session(DANA_LIVE).lastActivity).toISOString(), LA));
    await expectScreenBasics(screen.container, { owner: true });

    // Dana's conversation opens beside the list, at its own address.
    await list.getByRole('link', { name: new RegExp(DANA) }).click();
    await expect.poll(() => router.state.location.pathname).toBe(conversation(DANA_LIVE));
    await expect.element(screen.getByRole('heading', { level: 2, name: DANA })).toBeVisible();
    await expect.element(list.getByRole('link', { name: new RegExp(DANA) })).toHaveAttribute('aria-current', 'true');

    // Her messages, Claude's replies with their checks under them, and Maria's whisper.
    const chat = log(screen);
    const [first, second] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(chat.getByText(first ?? '', { exact: true })).toBeVisible();
    await expect.element(chat.getByText(second ?? '', { exact: true })).toBeVisible();
    const receipts = chat.getByRole('button', { name: /Open the full trace\.$/ });
    await expect.poll(() => receipts.elements().length).toBeGreaterThanOrEqual(6);
    await expect.element(chat.getByRole('button', { name: "Reply checked against Maria Rivera's rules Open the full trace." }).first()).toBeVisible();
    const whisper = session(DANA_LIVE).items.find((item) => item.kind === 'whisper');
    await expect
      .element(chat.getByText(`Your whisper, ${formatClock(whisper?.created_at ?? '', LA)}. Only Claude sees this.`, { exact: true }))
      .toBeVisible();
    await expect.element(chat.getByText('offer Thursday morning too', { exact: true })).toBeVisible();

    // While Claude answers: Take over, and whispers.
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // A copy with no chats yet says how one starts.
    const quiet = await renderRoute(LIST, { seed: 'rivera_quiet' });
    await expect.element(quiet.screen.getByText('No conversations yet', { exact: true })).toBeVisible();
    await expect.element(quiet.screen.getByText('When someone writes to your Desk, it shows up here.', { exact: true })).toBeVisible();
    expect(quiet.screen.getByText('Choose a conversation to read it.').elements()).toHaveLength(0);
    await expectScreenBasics(quiet.screen.container, { owner: true });
  });

  it('agent_name_reads_as_its_own_words', async () => {
    // An agent's chat: the name it gave is its own words wherever the page shows it, the caption
    // over the transcript included.
    const name = 'Trip planner for Sam Ortiz';
    const chat = named(DANA_LIVE, name);
    chat.state = { ...chat.state, kind: 'agent' };
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    await expect.element(screen.getByRole('heading', { level: 2, name })).toBeVisible();
    const caption = screen.getByText(/, signed requests from /);
    await expect.element(caption).toBeVisible();
    expect(caption.element().textContent).toMatch(new RegExp(`, signed requests from ${name}$`));
    expect(caption.element().querySelector('[data-copy="user"]')?.textContent).toBe(name);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('receipt_opens_the_trace', async () => {
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const chat = log(screen);
    // The first receipt is the first reply's check, signed with its own ledger entry.
    const reply = session(DANA_LIVE).items.find((item) => item.kind === 'delivered');
    const seq = reply?.event?.ledger_seq ?? 0;
    const receipt = chat.getByRole('button', { name: /Open the full trace\.$/ }).first();
    await expect.element(receipt).toBeVisible();

    // Enter on it opens the trace of that entry, with focus in it.
    (receipt.element() as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    const trace = screen.getByRole('region', { name: `Full trace of entry ${seq}`, exact: true });
    await expect.element(trace).toBeVisible();
    await expect.poll(() => trace.element().contains(document.activeElement)).toBe(true);
    await expect.element(trace.getByText(String(seq), { exact: true })).toBeVisible();
    expect(requests('ledger')).toHaveLength(1);

    // Escape closes it, and focus goes back to the receipt.
    await userEvent.keyboard('{Escape}');
    await expect.element(trace).not.toBeInTheDocument();
    expect(document.activeElement).toBe(receipt.element());
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('trace_that_cant_be_read_offers_try_again_and_close', async () => {
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const chat = log(screen);
    const reply = session(DANA_LIVE).items.find((item) => item.kind === 'delivered');
    const seq = reply?.event?.ledger_seq ?? 0;
    const receipt = chat.getByRole('button', { name: /Open the full trace\.$/ }).first();
    await expect.element(receipt).toBeVisible();
    const tryAgain = chat.getByRole('button', { name: 'Try again', exact: true });
    const close = chat.getByRole('button', { name: 'Close', exact: true });

    // The record can't be read, nor on its one retry: the owner's line, with a way to read it
    // again and a way to close it, each a click away, and focus in it.
    mockStore.inject({ route: 'ledger', status: 500, times: 2 });
    await receipt.click();
    await expect.element(chat.getByRole('alert').getByText(UNAVAILABLE, { exact: true }), { timeout: 5_000 }).toBeVisible();
    await expect.element(tryAgain).toBeVisible();
    await expect.element(close).toBeVisible();
    expect(document.activeElement?.closest('.cd-conversation__trace')).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: true });

    // Close closes it, and focus goes back to the receipt.
    await close.click();
    await expect.element(tryAgain).not.toBeInTheDocument();
    expect(chat.getByRole('alert').elements()).toHaveLength(0);
    expect(document.activeElement).toBe(receipt.element());

    // Opened again, it still can't be read; Try again reads it, and the trace opens with focus in it.
    mockStore.inject({ route: 'ledger', status: 500, times: 2 });
    await receipt.click();
    await expect.poll(() => requests('ledger').length, { timeout: 5_000 }).toBe(4);
    await expect.element(tryAgain).toBeVisible();
    await tryAgain.click();
    const trace = screen.getByRole('region', { name: `Full trace of entry ${seq}`, exact: true });
    await expect.element(trace).toBeVisible();
    await expect.poll(() => trace.element().contains(document.activeElement)).toBe(true);
    expect(requests('ledger')).toHaveLength(5);
    expect(chat.getByRole('alert').elements()).toHaveLength(0);
  });

  it('take_over_then_say', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { generation } = chat.state;
    const { screen } = await renderRoute(conversation(DANA_LIVE));

    // Taking over posts the generation last read, and the owner's composer takes the whisper's place.
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation }]);
    await expect.element(screen.getByRole('button', { name: 'Hand back to Claude' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Whisper to Claude' }).elements()).toHaveLength(0);

    // Her words go to Dana exactly as she wrote them, and show here as hers.
    const words = 'Hi Dana, it is Maria. I can come at 4 today.';
    await box.fill(words);
    await userEvent.keyboard('{Enter}');
    const mine = log(screen).getByText(words, { exact: true });
    await expect.element(mine).toBeVisible();
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: words, kind: 'say' }]);
    const message = mine.element().closest('.cd-person-message');
    expect(message?.querySelector('.cd-person-message__name')?.textContent).toBe('You');
    expect(message?.querySelector('.cd-person-message__avatar')?.textContent).toBe('MR');

    // Dana's stream got Maria joining, then the words, as Maria's (with her typing between, which
    // carries no words: `owner_typing_reaches_the_visitor`).
    const sent = chat.events.map(({ ev }) => ev).filter((ev) => ev.type !== 'owner_typing').slice(-2);
    expect(sent[0]).toEqual({ type: 'owner_joined', name: OWNER });
    expect(sent[1]).toMatchObject({ type: 'message', author: 'owner' });
    expect(sent[1]?.type === 'message' && sent[1].blocks.map((b) => b.text)).toEqual([words]);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('unsent_words_never_replace_newer_ones', async () => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();

    // The reply check stops her words, a moment after she sends them (a price in prose).
    mockStore.inject({ route: 'ownerMessage', status: 200, delayMs: 600, body: { message_id: 'msg-stopped', verdict: { ok: false }, ledger_seq: 1 } });
    const stopped = 'The drain clearing is $89 today.';
    await box.fill(stopped);
    await userEvent.keyboard('{Enter}');

    // While they are on their way the box takes nothing new, so nothing typed meanwhile can be
    // overwritten when they come back.
    await expect.element(box).toBeDisabled();
    await userEvent.keyboard('Newer words');

    // They come back to the box, alone, with the line saying why, and the box has focus again.
    await expect
      .element(screen.getByRole('alert').getByText("That wasn't sent: the reply check stopped it. Your words are back in the box to change.", { exact: true }))
      .toBeVisible();
    await expect.element(box).toHaveValue(stopped);
    await expect.element(box).not.toBeDisabled();
    expect(document.activeElement).toBe(box.element());

    // Words that go through leave the box empty and ready for the next ones.
    await box.fill('I can come at 4 today.');
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText('I can come at 4 today.', { exact: true })).toBeVisible();
    await expect.element(box).toHaveValue('');
    await expect.poll(() => document.activeElement).toBe(box.element());
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('whisper_in_ai_mode', async () => {
    const chat = session(DANA_LIVE);
    const streamed = chat.events.length;
    const { screen } = await renderRoute(conversation(DANA_LIVE));

    // While Claude answers, the owner's words go to Claude only.
    const box = screen.getByRole('textbox', { name: 'Whisper to Claude' });
    await expect.element(box).toHaveAttribute('placeholder', "Whisper to Claude. They won't see it.");
    const words = 'mention the Thursday 8 am opening';
    await box.fill(words);
    await userEvent.keyboard('{Enter}');

    // A captioned whisper in the conversation, with its time on the business's clock.
    const shown = log(screen).getByText(words, { exact: true });
    await expect.element(shown).toBeVisible();
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: words, kind: 'whisper' }]);
    const kept = chat.items.filter((item) => item.kind === 'whisper').at(-1);
    expect(kept?.text).toBe(words);
    await expect
      .element(log(screen).getByText(`Your whisper, ${formatClock(kept?.created_at ?? '', LA)}. Only Claude sees this.`, { exact: true }).last())
      .toBeVisible();
    await expect.element(box).toHaveValue('');

    // Nothing new reached Dana: no event on her stream, and no typing either.
    expect(chat.events.length).toBe(streamed);
    expect(requests('ownerTyping')).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('stale_generation_refetches', async () => {
    const chat = session(DANA_LIVE);
    const read = chat.state.generation;
    // No poll lands while the test counts reads.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();

    // The chat moves on after the owner read it: Claude's next turn, say.
    chat.state = { ...chat.state, generation: read + 1 };
    const reads = requests('conversation').length;
    await takeOver.click();

    // The take-over named the generation she read, the API turned it back, and the chat is read again.
    await expect
      .element(screen.getByRole('alert').getByText('This chat changed while you were acting. Check the latest and try again.', { exact: true }))
      .toBeVisible();
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation: read }]);
    expect(requests('conversation').length).toBeGreaterThan(reads);
    expect(chat.state.mode).toBe('ai');

    // Trying again acts on the chat as it stands now.
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation: read }, { generation: read + 1 }]);
    expect(chat.state.mode).toBe('owner');
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('say_needs_take_over', async () => {
    const chat = named(DANA_LIVE, DANA);
    // No poll lands while the test counts reads, and typing pings at most once in the test.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const reads = requests('conversation').length;
    await takeOver.click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    // The take-over reads the chat again, and it is hers in that read.
    await expect.poll(() => requests('conversation').length, { timeout: 5_000 }).toBeGreaterThan(reads);

    // She writes while the chat is hers: one typing ping, which the API takes.
    const words = 'I can come at 4 today.';
    await box.fill(words);
    await expect.poll(() => requests('ownerTyping').length).toBe(1);

    // The chat goes back to Claude from another tab before she sends.
    mockStore.world.handBack(chat);
    const streamed = chat.events.length;
    await userEvent.keyboard('{Enter}');

    // The API turns her words back, nothing reaches Dana, and the screen says what to do.
    await expect.element(screen.getByRole('alert').getByText('Take over first, then write to them.', { exact: true })).toBeVisible();
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: words, kind: 'say' }]);
    expect(chat.events.slice(streamed).filter(({ ev }) => ev.type === 'message')).toEqual([]);
    expect(log(screen).getByText(words, { exact: true }).elements()).toHaveLength(0);

    // The chat as read again is Claude's: Take over and the whisper box, never her words in it.
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toHaveValue('');

    // Her words wait for the box they were written in: taking over again gives them back, and
    // words the page puts back are not her typing.
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toHaveValue(words);
    expect(requests('ownerTyping')).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('earlier_words_never_confirm_a_later_send', async () => {
    const chat = named(DANA_LIVE, DANA);
    const words = 'On my way';
    // No poll lands, so the only reads of the chat are the ones sending makes.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    // The page's first read is in before the count, so the take-over's read is the one awaited
    // below, and none is still out to take a fault planted for a later read.
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const reads = requests('conversation').length;
    await takeOver.click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    await expect.poll(() => requests('conversation').length, { timeout: 5_000 }).toBeGreaterThan(reads);

    // Her words go to Dana, but the read after them fails (and its one retry), so the chat as last
    // read doesn't show them.
    mockStore.inject({ route: 'conversation', status: 500, times: 2 });
    await box.fill(words);
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true }), { timeout: 5_000 }).toBeVisible();
    await expect.element(box, { timeout: 5_000 }).not.toBeDisabled();
    await expect.element(box).toHaveValue('');
    expect(log(screen).getByText(words, { exact: true }).elements()).toHaveLength(0);

    // The same words again, and this answer is lost before they reach the API. The chat read
    // afterwards holds the first ones, which never pass for these.
    mockStore.inject({ route: 'ownerMessage', status: 'network' });
    await box.fill(words);
    await userEvent.keyboard('{Enter}');
    await expect
      .element(screen.getByRole('alert').getByText("We couldn't confirm that went through. Check the chat before you send it again.", { exact: true }))
      .toBeVisible();
    await expect.element(box).toHaveValue(words);
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([
      { text: words, kind: 'say' },
      { text: words, kind: 'say' },
    ]);
    const said = chat.events.filter(({ ev }) => ev.type === 'message' && ev.author === 'owner');
    expect(said).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('words_wait_for_a_read_of_the_chat_after_one_fails', async () => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    // The page's first read is in before the count, so the take-over's read is the one awaited
    // below, and none is still out to take a fault planted for a later read.
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const reads = requests('conversation').length;
    await takeOver.click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    await expect.poll(() => requests('conversation').length, { timeout: 5_000 }).toBeGreaterThan(reads);

    // Her words go, and the read after them fails.
    mockStore.inject({ route: 'conversation', status: 500, times: 2 });
    await box.fill('On my way');
    await userEvent.keyboard('{Enter}');
    await expect.element(box, { timeout: 5_000 }).not.toBeDisabled();
    await expect.element(box).toHaveValue('');

    // Her next words wait for a read of the chat; while it still can't be read, they don't go,
    // and they stay in the box with the owner's line for the failed read.
    mockStore.inject({ route: 'conversation', status: 500, times: 2 });
    const next = 'About 10 minutes out.';
    await box.fill(next);
    await userEvent.keyboard('{Enter}');
    await expect.element(box, { timeout: 5_000 }).toHaveValue(next);
    await expect.element(box, { timeout: 5_000 }).not.toBeDisabled();
    const controls = box.element().closest('.cd-conversation__controls');
    expect(controls?.querySelector('[role="alert"]')?.textContent).toBe(UNAVAILABLE);
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: 'On my way', kind: 'say' }]);

    // Once the chat can be read, they go, after the first ones.
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText(next, { exact: true })).toBeVisible();
    await expect.element(log(screen).getByText('On my way', { exact: true })).toBeVisible();
    await expect.element(box).toHaveValue('');
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([
      { text: 'On my way', kind: 'say' },
      { text: next, kind: 'say' },
    ]);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_request_answerable_during_take_over', async () => {
    const chat = session(SEEDED_HOLD);
    const { screen } = await renderRoute(conversation(SEEDED_HOLD));
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card).toBeVisible();

    // The card sits right after the row its hold's receipt is under.
    const heldReceipt = receipt(screen, 'Held for you');
    await expect.element(heldReceipt).toBeVisible();
    const row = heldReceipt.element().closest('.cd-transcript-row');
    expect(row?.nextElementSibling?.contains(card.element())).toBe(true);

    // Taking over leaves it to be answered, and answering it keeps the owner in the chat.
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }]);
    expect(chat.state.mode).toBe('owner');
    await expect.element(screen.getByRole('button', { name: 'Hand back to Claude' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_request_keeps_focus', async () => {
    // The kernel's own conflict: the request changed while the owner was looking. The chat reads
    // Needs you once, and that read no longer offers Allow. Polls stay out of the way.
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { pollScale: 100 });
    const card = heldCard(screen, SEEDED_REASON);
    const allow = card.getByRole('button', { name: 'Allow this time' });
    const deny = card.getByRole('button', { name: 'Deny this time' });
    await expect.element(allow).toBeVisible();
    const items = await served<NeedsYouItem[]>('needsYou', { desk_id: RIVERA.deskId });
    const changed = items.map((item) => (item.decision != null ? { ...item, decision: { ...item.decision, answers: ['deny_once'] } } : item));
    mockStore.inject({ route: 'answer', status: 409, body: { error: 'kernel', code: 'conflict' } });
    mockStore.inject({ route: 'needsYou', status: 200, body: changed });

    // Allow had focus, and it went with Allow: focus lands on the request, under the conflict's line.
    await allow.click();
    await expect.element(allow).not.toBeInTheDocument();
    await expect.element(screen.getByRole('alert').getByText(CHANGED, { exact: true })).toBeVisible();
    await expect.element(deny).not.toHaveAttribute('aria-disabled');
    expect(focusIsOn(card.element())).toBe(true);

    // Deny goes through: the answered request keeps focus as Deny leaves.
    await deny.click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }, { answer: 'deny_once' }]);
    await expect.poll(() => focusIsOn(heldCard(screen, SEEDED_REASON).element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_requests_that_cant_be_read_say_so', async () => {
    // What needs the owner can't be read (the read and its one retry fail): the chat says so, with
    // a way to read it again, rather than showing a hold with nothing to answer.
    mockStore.inject({ route: 'needsYou', status: 500, times: 2 });
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { pollScale: 100 });
    // With no card under it, the hold's receipt says why itself.
    await expect.element(receipt(screen, `Held for you. ${SEEDED_REASON}`)).toBeVisible();
    const line = screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 4_000 }).toBeVisible();
    expect(heldCard(screen, SEEDED_REASON).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });

    // Reading again works: the request is there to answer, and the line goes.
    await screen.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(line).not.toBeInTheDocument();
    // The card says why now, so the receipt over it names only the state.
    await expect.element(receipt(screen, 'Held for you')).toBeVisible();
  });

  it('paused_offers_resume', async () => {
    // Claude paused the chat after repeated blocked attempts: nobody answers until the owner acts.
    const chat = session(DANA_LIVE);
    mockStore.world.pause(chat);
    const { generation } = chat.state;
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    await expect.element(screen.getByText('Claude paused this chat after repeated blocked attempts.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    // No composer while paused: whispers steer no one, and her words need a take-over first.
    expect(screen.getByRole('textbox').elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });

    // Resume Claude posts the generation she read, and Claude answers again, with whispers.
    await screen.getByRole('button', { name: 'Resume Claude' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toBeVisible();
    expect(requests('resume').map((r) => r.body)).toEqual([{ generation }]);
    expect(chat.state.mode).toBe('ai');
    await expect.element(screen.getByRole('button', { name: 'Resume Claude' })).not.toBeInTheDocument();
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('visitor_text_is_literal', async () => {
    mockStore.world.visitorText(session(DANA_LIVE), '<b>hi</b> <img src=x onerror=alert(1)>');
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const words = log(screen).getByText('<b>hi</b> <img src=x onerror=alert(1)>', { exact: true });
    await expect.element(words).toBeVisible();
    // Her words as she typed them: text, never markup, and marked as someone's own words.
    expect(log(screen).element().querySelector('b, img')).toBeNull();
    expect(words.element().closest('[data-copy="user"]')).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('translation_is_labelled', async () => {
    const chat = session(DANA_LIVE);
    mockStore.world.visitorText(chat, '¿Pueden venir el jueves por la tarde?');
    const item = chat.items.at(-1);
    if (item) item.owner_translation = 'Can you come Thursday afternoon?';
    const { screen } = await renderRoute(conversation(DANA_LIVE));

    // Her own words, then Claude's translation for the owner, labelled as Claude's.
    await expect.element(log(screen).getByText('¿Pueden venir el jueves por la tarde?', { exact: true })).toBeVisible();
    const translation = log(screen).getByText('Can you come Thursday afternoon?', { exact: true });
    await expect.element(translation).toBeVisible();
    expect(translation.element().closest('[data-copy="user"]')).not.toBeNull();
    expect(translation.element().parentElement?.textContent).toBe('Translated by Claude: Can you come Thursday afternoon?');
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('owner_receipts_show_the_kernel_reason', async () => {
    const { chat, refund, refunded, quote, booking } = danasChatWithThreeDecisions();
    const replyChecked = VISITOR_PLAIN.en.reply_checked;
    // Every receipt has words of its own, so each line below can only be the one it names.
    const words = [refund.visitor_plain, refund.reason_plain, refunded.visitor_plain, quote.visitor_plain, quote.reason_plain, booking.visitor_plain, booking.reason_plain, replyChecked];
    expect(new Set(words).size).toBe(words.length);

    const { screen } = await renderRoute(conversation(chat.state.session_id));

    // The hold, answered so no card is under it, and the quote Claude ran on its own name their
    // state in the owner's words, then say why: the kernel's reason, read once by each decision.
    await expect.element(receipt(screen, `Held for you. ${REFUND_REASON}`)).toBeVisible();
    await expect.element(receipt(screen, `Automatic. ${quote.reason_plain}`)).toBeVisible();
    expect(decisionReads(refund.decision_id)).toHaveLength(1);
    expect(decisionReads(quote.decision_id)).toHaveLength(1);

    // The refund's outcome keeps its own words, never the hold's, and reads nothing.
    await expect.element(receipt(screen, refunded.visitor_plain)).toBeVisible();
    // The booking refused when it came to run keeps its words, never the reason it was allowed.
    await expect.element(receipt(screen, booking.visitor_plain)).toBeVisible();
    expect(log(screen).getByText(booking.reason_plain, { exact: false }).elements()).toHaveLength(0);
    expect(decisionReads(booking.decision_id)).toHaveLength(0);
    // Each reply's check keeps its own line.
    await expect.poll(() => receipt(screen, replyChecked).elements().length).toBe(3);
    // The visitor's words for the hold and the quote show nowhere: the owner's replace them.
    expect(log(screen).getByText(refund.visitor_plain, { exact: true }).elements()).toHaveLength(0);
    expect(log(screen).getByText(quote.visitor_plain, { exact: true }).elements()).toHaveLength(0);

    // Two more polls of the conversation read no decision again.
    await readsMore('conversation', 2);
    expect(requests('decision')).toHaveLength(2);
    await expectScreenBasics(screen.container, { owner: true });

    // A hold still waiting, its card right under the row, reads "Held for you" alone: the card's
    // headline already says why.
    const waiting = await renderRoute(conversation(SEEDED_HOLD));
    const card = heldCard(waiting.screen, SEEDED_REASON);
    await expect.element(card).toBeVisible();
    const held = receipt(waiting.screen, 'Held for you');
    await expect.element(held).toBeVisible();
    expect(held.element().closest('.cd-transcript-row')?.nextElementSibling?.contains(card.element())).toBe(true);
    expect(held.element().textContent).not.toContain(SEEDED_REASON);
    await expectScreenBasics(waiting.screen.container, { owner: true });

    // When the reason can't be read, the hold shows the visitor's words: never nothing.
    mockStore.inject({ route: 'decision', status: 500, times: 10 });
    const again = await renderRoute(conversation(chat.state.session_id));
    await expect.element(receipt(again.screen, refund.visitor_plain)).toBeVisible();
    await expect.element(receipt(again.screen, quote.visitor_plain)).toBeVisible();
    expect(log(again.screen).getByText(REFUND_REASON, { exact: false }).elements()).toHaveLength(0);
  });
  it('a_turn_claude_starts_explains_its_reply', async () => {
    // Dana asked for her invoice and got the verify card; she then confirmed it's her with the demo
    // code, and the API woke Claude, which released the invoice. No words of hers began that turn.
    const world = mockStore.world;
    const desk = world.desk(RIVERA.deskId);
    const invoiceRule = SCRIPT.find((rule) => rule.name === 'invoice');
    if (!desk || !invoiceRule) throw new Error("the copy has Rivera's main Desk and the script its invoice row");
    const chat = world.addSession(desk);
    world.replay(chat, world.now() - MINUTE, [{ text: 'Can you send my invoice?', steps: invoiceRule.steps }]);
    expect(world.checkCode(chat, DEMO_CODE)).toBe(true);
    const woke = world.context(chat, 'en', '');
    for (const step of [...AFTER_VERIFY, turnEnd]) world.emit(chat, step(woke));

    const { screen } = await renderRoute(conversation(chat.state.session_id));
    const verifyCard = log(screen).getByRole('article', { name: "Confirm it's you" });
    const invoice = log(screen).getByRole('article', { name: 'Document, only for you' });
    await expect.element(invoice).toBeVisible();
    const rowOf = (card: typeof invoice) => card.element().closest('.cd-transcript-row');

    // The release's receipt, in the owner's words, sits under the invoice it explains, never under
    // the card that asked for the code, which keeps the receipt of the code it sent.
    const released = receipt(screen, `Automatic. ${DECISIONS.releaseInvoice.reasonPlain}`);
    const started = receipt(screen, `Automatic. ${DECISIONS.startVerification.reasonPlain}`);
    await expect.element(released).toBeVisible();
    await expect.element(started).toBeVisible();
    expect(rowOf(invoice)?.contains(released.element())).toBe(true);
    expect(rowOf(verifyCard)?.contains(released.element())).toBe(false);
    expect(rowOf(verifyCard)?.contains(started.element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('answer_row_follows_the_decided_look', async () => {
    // The seeded 15% hold, from a visitor not on record, held by a limit: two plain answers.
    const seeded = await renderRoute(conversation(SEEDED_HOLD));
    const limitHold = heldCard(seeded.screen, SEEDED_REASON);
    await expect.element(limitHold).toBeVisible();
    const plain = limitHold.getByRole('group', { name: 'Your answer' }).getByRole('button');
    expect(plain.elements().map((b) => b.textContent)).toEqual(['Allow this time', 'Deny this time']);
    expect(plain.elements().some((b) => b.hasAttribute('aria-haspopup'))).toBe(false);
    expect(plain.elements()[1]?.classList.contains('cd-button--danger')).toBe(true);
    expect(seeded.screen.container.textContent).not.toContain('Or save a rule');
    await expectScreenBasics(seeded.screen.container, { owner: true });

    // Dana's refund, verified, held by an ask card: all four answers, two in each menu.
    const refund = mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(conversation(refund.session_id));
    const card = heldCard(screen, REFUND_REASON);
    await expect.element(card).toBeVisible();
    const allow = card.getByRole('button', { name: 'Allow', exact: true });
    const deny = card.getByRole('button', { name: 'Deny', exact: true });
    await expect.element(allow).toHaveAttribute('aria-haspopup', 'menu');
    await expect.element(deny).toHaveAttribute('aria-haspopup', 'menu');
    expect(deny.element().classList.contains('cd-button--danger')).toBe(true);

    await allow.click();
    const allowMenu = screen.getByRole('menu', { name: 'Allow' });
    expect(allowMenu.getByRole('menuitem').elements().map((item) => item.firstElementChild?.textContent)).toEqual([
      'This time',
      `Only for ${DANA}, always`,
    ]);
    await userEvent.keyboard('{Escape}');

    await deny.click();
    const denyMenu = screen.getByRole('menu', { name: 'Deny' });
    expect(denyMenu.getByRole('menuitem').elements().map((item) => item.firstElementChild?.textContent)).toEqual(['This time', 'Always']);
    await denyMenu.getByRole('menuitem', { name: 'Always' }).click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'deny_always' }]);
    expect(screen.container.textContent).not.toContain('Or save a rule');
    // "Always" saved nothing yet: as on Today, the rule it drafted waits for her review.
    await expect.element(screen.getByText('Your answer also drafted a rule. Review it before it applies.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Review the rule' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('visitor_typing_shows_a_bubble', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const bubble = log(screen).getByRole('status').filter({ hasText: `${DANA} is typing` });
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(log(screen).getByText(first ?? '', { exact: true })).toBeVisible();
    // Nobody is typing: no dots, and the screen never guesses.
    expect(bubble.elements()).toHaveLength(0);

    // A read that says she is typing: one bubble at the end of the chat, on her side, with no words.
    mockStore.world.visitorTyping(chat);
    await expect.element(bubble).toBeInTheDocument();
    expect(bubble.elements()).toHaveLength(1);
    expect(bubble.element().classList.contains('cd-writing-indicator--bubble')).toBe(true);
    expect(bubble.element().textContent?.replace(/\s+/g, ' ').trim()).toBe(`${DANA} is typing`);
    const rows = log(screen).element().querySelectorAll('.cd-transcript-row');
    expect(rows[rows.length - 1]?.contains(bubble.element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });

    // The next read says she isn't: gone within a poll.
    chat.typingUntil = null;
    await expect.poll(() => bubble.elements().length, { timeout: 1_000 }).toBe(0);

    // She types again, then sends: her message takes the bubble's place, even while the API still
    // reports the signal she sent before it.
    chat.visitorTypedAt = null;
    mockStore.world.visitorTyping(chat);
    await expect.element(bubble, { timeout: 1_000 }).toBeInTheDocument();
    const until = chat.typingUntil;
    mockStore.world.visitorText(chat, 'Thursday works too.');
    chat.typingUntil = until;
    await expect.element(log(screen).getByText('Thursday works too.', { exact: true })).toBeVisible();
    await expect.poll(() => bubble.elements().length, { timeout: 1_000 }).toBe(0);

    // The API's word stands, never this browser's clock: a signal whose time this clock has
    // already passed (it may run ahead of the API's) still shows while the read carries it.
    chat.typingUntil = null;
    const read = await served<OwnerTranscript>('conversation', { session_id: DANA_LIVE });
    const behind = new Date(Date.now() - 60_000).toISOString();
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...read, typing_until: behind } });
    await expect.element(bubble, { timeout: 1_000 }).toBeInTheDocument();
    await readsMore('conversation', 2);
    expect(bubble.elements()).toHaveLength(1);
  });

  it('owner_typing_is_sent_after_take_over', async () => {
    const chat = named(DANA_LIVE, DANA);
    // Pings go at most every 2 s, scaled. No poll lands, and the clock the pings are timed by moves
    // only when the test moves it, so how long typing takes in the browser never changes how many go.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    /** Moves the clock past the interval between pings. */
    const intervalPasses = () => vi.advanceTimersByTime(typingPingMs());
    const pings = () => requests('ownerTyping');
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // A whisper is for Claude: typing one tells Dana nothing.
    await screen.getByRole('textbox', { name: 'Whisper to Claude' }).fill('offer Thursday');
    await wait(200);
    expect(pings()).toHaveLength(0);

    // In the chat she took over, her typing reaches Dana as her name and dots, never her words.
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    const streamed = chat.events.length;
    await userEvent.type(box, 'On my');
    await expect.poll(() => pings().length).toBe(1);
    expect(pings().map((r) => r.body)).toEqual([{ generation: chat.state.generation }]);
    expect(chat.events.slice(streamed).map(({ ev }) => ev)).toEqual([{ type: 'owner_typing', name: OWNER, until: expect.any(String) as string }]);

    // More keystrokes within the interval send no more; after it, one more.
    await userEvent.type(box, ' way');
    expect(pings()).toHaveLength(1);
    intervalPasses();
    await userEvent.type(box, ' now');
    await expect.poll(() => pings().length).toBe(2);
    await wait(200);
    expect(pings()).toHaveLength(2);

    // An emptied composer sends nothing.
    intervalPasses();
    await box.clear();
    await wait(200);
    expect(pings()).toHaveLength(2);

    // Sending ends it: nothing more goes once her words have.
    await userEvent.type(box, 'Be there soon');
    await expect.poll(() => pings().length).toBe(3);
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText('Be there soon', { exact: true })).toBeVisible();
    intervalPasses();
    await wait(200);
    expect(pings()).toHaveLength(3);

    // Words the screen puts back in the box (the reply check stopped them) aren't typing.
    mockStore.inject({ route: 'ownerMessage', status: 200, body: { message_id: 'msg-stopped', verdict: { ok: false }, ledger_seq: 1 } });
    await userEvent.type(box, 'It is $89.');
    await expect.poll(() => pings().length).toBe(4);
    await userEvent.keyboard('{Enter}');
    await expect.element(box).toHaveValue('It is $89.');
    intervalPasses();
    await wait(300);
    expect(pings()).toHaveLength(4);
    await box.clear();

    // The API turns a ping back (take over first): no line, one read of the chat, and no more
    // pings for the chat as it was read. Polls stay out of the way while the reads are counted.
    const again = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const write = again.screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(write).toBeVisible();
    mockStore.inject({ route: 'ownerTyping', status: 409, body: { error: 'take_over_first' } });
    const reads = requests('conversation').length;
    await userEvent.type(write, 'Still');
    await expect.poll(() => pings().length).toBe(5);
    await expect.poll(() => requests('conversation').length).toBe(reads + 1);
    intervalPasses();
    await userEvent.type(write, ' there');
    await wait(300);
    expect(pings()).toHaveLength(5);
    expect(requests('conversation')).toHaveLength(reads + 1);
    expect(again.screen.getByRole('alert').elements()).toHaveLength(0);
    await expectScreenBasics(again.screen.container, { owner: true });
  });

  it('recorded_conversations_are_tagged', async () => {
    const label = 'Includes recorded history';
    const note = 'Recorded history, replayed into your copy. It happened before you arrived.';
    /** The list's rows, newest first: Dana's live chat, the seeded visitor's, then Alex Kim's assistant's. */
    const rowsOf = (screen: RenderResult) => screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^(?!Includes)/ });
    const tagsIn = (row: Element) => [...row.querySelectorAll('span')].filter((span) => span.textContent?.trim() === 'Recorded');
    named(DANA_LIVE, DANA);

    // A copy with no recorded history says nothing of it: no caption, no tag, no note.
    const plain = await renderRoute(conversation(SEEDED_HOLD));
    await expect.element(plain.screen.getByRole('heading', { level: 2, name: 'Visitor' })).toBeVisible();
    await expect.poll(() => rowsOf(plain.screen).elements()).toHaveLength(3);
    expect(plain.screen.getByRole('link', { name: label }).elements()).toHaveLength(0);
    expect(rowsOf(plain.screen).elements().flatMap(tagsIn)).toHaveLength(0);
    expect(plain.screen.getByText(/^Recorded history/).elements()).toHaveLength(0);

    // The seeded visitor's chat replayed from the recorded history into this copy; Dana's is live.
    const list = await served<ConversationSummary[]>('conversations', { desk_id: RIVERA.deskId });
    const chat = await served<OwnerTranscript>('conversation', { session_id: SEEDED_HOLD });
    mockStore.inject({
      route: 'conversations',
      status: 200,
      times: 10_000,
      body: list.map((s) => (s.session_id === SEEDED_HOLD ? { ...s, replayed: true } : s)),
    });
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...chat, replayed: true } });
    const { screen, router } = await renderRoute(conversation(SEEDED_HOLD));

    // "Recorded", with its history icon, at the end of the replayed row's status line only.
    await expect.poll(() => rowsOf(screen).elements()).toHaveLength(3);
    const [live, replayed] = rowsOf(screen).elements();
    expect(live?.textContent).toContain(DANA);
    expect(tagsIn(live as Element)).toHaveLength(0);
    const tags = tagsIn(replayed as Element);
    expect(tags).toHaveLength(1);
    const tag = tags[0] as HTMLElement;
    expect(tag.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(tag.parentElement?.lastElementChild).toBe(tag);

    // The page says so under its title, linking to the record where each replayed entry says so.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const link = nav.getByRole('link', { name: label });
    await expect.element(link).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    expect(getComputedStyle(link.element()).textDecorationLine).toBe('underline');
    const title = nav.getByRole('heading', { level: 1, name: 'Conversations' }).element();
    expect(title.compareDocumentPosition(link.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The open chat says it happened before she arrived, with the history icon, between its head
    // and the transcript.
    const line = screen.getByText(note, { exact: true });
    await expect.element(line).toBeVisible();
    const noteLine = line.element().closest('p');
    expect(noteLine).not.toBeNull();
    expect((noteLine as HTMLElement).querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const head = screen.getByRole('heading', { level: 2, name: 'Visitor' }).element();
    expect(head.compareDocumentPosition(noteLine as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((noteLine as HTMLElement).compareDocumentPosition(log(screen).element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No one is on the other side of a recorded chat: nothing to take over, whisper or write.
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Visitor' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take over' }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Resume Claude' }).elements()).toHaveLength(0);
    expect(screen.getByRole('textbox').elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });

    await link.click();
    await expect.poll(() => `${router.state.location.pathname}${router.state.location.search}`).toBe(`${DESK}/safety?view=entries`);
  });

  it('conversations_fit_a_phone', async () => {
    named(DANA_LIVE, DANA);
    mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(LIST, { viewport: 'phone' });

    // The list has the page to itself.
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    await expect.element(list.getByRole('link', { name: new RegExp(DANA) }).first()).toBeVisible();
    expect(screen.getByText('Choose a conversation to read it.').elements().every((el) => el.getClientRects().length === 0)).toBe(true);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    // A conversation, with its held request and the owner's controls, then has it, with a way back.
    await list.getByRole('link', { name: new RegExp(`^${DANA}`) }).first().click();
    await expect.element(screen.getByRole('heading', { level: 2, name: DANA })).toBeVisible();
    // The list steps aside: hidden from sight and from the accessibility tree alike.
    expect(list.elements()).toHaveLength(0);
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
    await screen.getByRole('link', { name: 'All conversations' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(LIST);
    await expect.element(list).toBeVisible();
  });
});
