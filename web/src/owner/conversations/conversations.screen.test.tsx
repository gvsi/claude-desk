/**
 * Conversations in a real browser against the mock API: the list beside the open conversation,
 * receipts under each message that open the full trace, the owner's receipts in the owner's
 * words, held requests answered in place, take-over with the owner's own words, whispers, the
 * typing both ways, and recorded history.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { Decision, StatusEvent } from '../../api/contracts.ts';
import type { ConversationSummary, OwnerTranscript } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { formatClock } from '../../lib/format.ts';
import { DECISIONS, VISITOR_PLAIN, writing } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE, type SessionRecord } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

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

/** The owner's reads of the Desk's conversations and of one chat, as the mock answers them now. */
async function served<T>(key: 'conversations' | 'conversation', params: Record<string, string>): Promise<T> {
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
    const rows = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link').elements() as HTMLElement[];
    expect(rows).toHaveLength(2);

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

    // Newest first: Dana's live chat, then the visitor whose discount is held.
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    await expect.element(list.getByRole('link', { name: new RegExp(DANA) })).toBeVisible();
    const rows = list.getByRole('link').elements();
    expect(rows.map((row) => row.querySelector('[data-copy="user"]')?.textContent)).toEqual([DANA, 'Visitor']);
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
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();

    // The chat goes back to Claude from another tab before she sends.
    mockStore.world.handBack(chat);
    const streamed = chat.events.length;
    const words = 'I can come at 4 today.';
    await box.fill(words);
    await userEvent.keyboard('{Enter}');

    // The API turns her words back, nothing reaches Dana, and the screen says what to do.
    await expect.element(screen.getByRole('alert').getByText('Take over first, then write to them.', { exact: true })).toBeVisible();
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: words, kind: 'say' }]);
    expect(chat.events.slice(streamed).filter(({ ev }) => ev.type === 'message')).toEqual([]);
    expect(log(screen).getByText(words, { exact: true }).elements()).toHaveLength(0);

    // The chat as read again is Claude's: Take over and the whisper box, never her words in it.
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toHaveValue('');

    // Her words wait for the box they were written in: taking over again gives them back.
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toHaveValue(words);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_request_answerable_during_take_over', async () => {
    const chat = session(SEEDED_HOLD);
    const { screen } = await renderRoute(conversation(SEEDED_HOLD));
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card).toBeVisible();

    // The card sits right after the row its hold's receipt is under.
    const heldReceipt = log(screen).getByRole('button', { name: `${SEEDED_REASON} Open the full trace.` });
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

    // The hold, and the quote Claude ran on its own, say why in the owner's words: the kernel's
    // reason, read once by each decision.
    await expect.element(receipt(screen, REFUND_REASON)).toBeVisible();
    await expect.element(receipt(screen, quote.reason_plain)).toBeVisible();
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

    // When the reason can't be read, the hold shows the visitor's words: never nothing.
    mockStore.inject({ route: 'decision', status: 500, times: 10 });
    const again = await renderRoute(conversation(chat.state.session_id));
    await expect.element(receipt(again.screen, refund.visitor_plain)).toBeVisible();
    await expect.element(receipt(again.screen, quote.visitor_plain)).toBeVisible();
    expect(log(again.screen).getByText(REFUND_REASON, { exact: false }).elements()).toHaveLength(0);
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
  it('visitor_typing_shows_as_a_bubble', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const bubble = log(screen).getByRole('status').filter({ hasText: `${DANA} is typing` });
    await expect.element(log(screen).getByText(rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []))[0] ?? '', { exact: true })).toBeVisible();
    // Nobody is typing: no dots, and the screen never guesses.
    expect(bubble.elements()).toHaveLength(0);

    // Dana types on the public page: her dots show at the end of the chat, on her side.
    mockStore.world.visitorTyping(chat);
    await expect.element(bubble).toBeInTheDocument();
    expect(bubble.element().classList.contains('cd-writing-indicator--bubble')).toBe(true);
    const rows = log(screen).element().querySelectorAll('.cd-transcript-row');
    expect(rows[rows.length - 1]?.contains(bubble.element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });

    // Her message takes their place at once, even while the signal she sent before it still runs.
    const until = chat.typingUntil;
    mockStore.world.visitorText(chat, 'Thursday works too.');
    chat.typingUntil = until;
    await expect.element(log(screen).getByText('Thursday works too.', { exact: true })).toBeVisible();
    await expect.poll(() => bubble.elements().length, { timeout: 1_000 }).toBe(0);

    // She types again: a new signal shows again, until it runs out.
    chat.visitorTypedAt = null;
    mockStore.world.visitorTyping(chat);
    await expect.element(bubble, { timeout: 1_000 }).toBeInTheDocument();
    const shortly = Date.now() + 400;
    chat.typingUntil = shortly;
    await readsMore('conversation', 1);
    await expect.poll(() => bubble.elements().length, { timeout: 1_500 }).toBe(0);
    expect(Date.now()).toBeGreaterThanOrEqual(shortly);
  });
  it('owner_typing_reaches_the_visitor', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE));

    // A whisper is for Claude: typing one tells Dana nothing.
    await screen.getByRole('textbox', { name: 'Whisper to Claude' }).fill('offer Thursday');
    expect(requests('ownerTyping')).toHaveLength(0);

    // In the chat she took over, her typing reaches Dana as her name and three dots: never her words.
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    const streamed = chat.events.length;
    await userEvent.type(box, 'On my way');
    await expect.poll(() => requests('ownerTyping').length).toBe(1);
    expect(requests('ownerTyping').map((r) => r.body)).toEqual([{ generation: chat.state.generation }]);
    expect(chat.events.slice(streamed).map(({ ev }) => ev)).toEqual([{ type: 'owner_typing', name: OWNER, until: expect.any(String) as string }]);

    // About every 2 s while she keeps typing, never once per key.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await userEvent.type(box, ' now');
    await expect.poll(() => requests('ownerTyping').length).toBe(2);
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('recorded_history_is_marked', async () => {
    const label = 'Includes recorded history';
    // A copy with no recorded history says nothing of it.
    const plain = await renderRoute(conversation(SEEDED_HOLD));
    await expect.element(plain.screen.getByRole('heading', { level: 2, name: 'Visitor' })).toBeVisible();
    expect(plain.screen.getByRole('link', { name: label }).elements()).toHaveLength(0);
    expect(plain.screen.getByText(/^Recorded history/).elements()).toHaveLength(0);

    // The seeded visitor's chat replayed from the recorded history into this copy.
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

    // The page says so under its title, linking to the record where each replayed entry says so.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const link = nav.getByRole('link', { name: label });
    await expect.element(link).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    expect(getComputedStyle(link.element()).textDecorationLine).toBe('underline');
    // The open chat says it happened before she arrived.
    await expect
      .element(screen.getByText('Recorded history, replayed into your copy. It happened before you arrived.', { exact: true }))
      .toBeVisible();
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
