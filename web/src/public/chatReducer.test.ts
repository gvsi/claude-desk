/**
 * The visitor's chat as a pure reducer: what the stream, the transcript and the composer do to the
 * rows, the receipts under them and the writing line.
 */
import { describe, expect, it } from 'vitest';

import { EV_ERROR_CODES, type EvMessage, type EvOwnerJoined, type EvOwnerTyping, type SessionState, type SseEvent, type StatusEvent } from '../api/contracts.ts';
import type { TranscriptItem, VisitorTranscript } from '../api/views.ts';
import { receiptFromEvent } from '../ds/index.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { chatReducer, initialChatState, ownerInChatNow, ownerTypingDelayMs, type ChatAction, type ChatState } from './chatReducer.ts';

/** The fixtures' quote turn: the action's receipt, writing, the checked reply, the turn's end. */
const [quoteReceipt, , quoteMessage] = rivera.events.quoteTurn as [StatusEvent, SseEvent, EvMessage, SseEvent];

/** The fixtures' take-over, each event found by what it is rather than where it sits. */
const takeOver: readonly SseEvent[] = rivera.events.takeOver;
const ownerJoined = takeOver.find((ev): ev is EvOwnerJoined => ev.type === 'owner_joined') as EvOwnerJoined;
const ownerTyping = takeOver.find((ev): ev is EvOwnerTyping => ev.type === 'owner_typing') as EvOwnerTyping;
const ownerSaid = takeOver.find((ev): ev is EvMessage => ev.type === 'message' && ev.author === 'owner') as EvMessage;

function run(actions: ChatAction[], from: ChatState = initialChatState()): ChatState {
  return actions.reduce(chatReducer, from);
}

/** Stream events from `seq` on, one action each. */
function events(evs: SseEvent[], from = 1): ChatAction[] {
  return evs.map((ev, i) => ({ type: 'event', seq: from + i, ev }));
}

describe('chatReducer', () => {
  it('writing_then_message', () => {
    const writing = run(events([{ type: 'writing' }]));
    expect(writing.writing).toBe(true);
    expect(writing.rows).toEqual([]);

    const answered = run(events([quoteMessage], 2), writing);
    expect(answered.writing).toBe(false);
    expect(answered.lastSeq).toBe(2);
    expect(answered.rows).toEqual([{ item: { kind: 'message', seq: 2, ev: quoteMessage }, receipts: [receiptFromEvent(quoteMessage)], live: true }]);
  });

  it('status_attaches_to_the_last_row', () => {
    const [held, , handoff] = rivera.events.heldTurn as [StatusEvent, SseEvent, EvMessage, SseEvent];
    const [resolved] = rivera.events.resolvedTurn as [StatusEvent];

    // The visitor asks; the hold's receipt waits for Claude's reply and attaches under it, after
    // the reply's own check, as the signed boards show.
    const asked = run([{ type: 'sent', id: 'v1', text: 'Can I get 15% off if I pay cash?' }, ...events([held, { type: 'writing' }])]);
    expect(asked.rows.map((row) => row.receipts)).toEqual([[]]);
    expect(asked.openHolds).toEqual([held.decision_id]);
    const replied = run(events([handoff, { type: 'turn_end' }], 3), asked);
    expect(replied.rows.map((row) => row.receipts)).toEqual([[], [receiptFromEvent(handoff), receiptFromEvent(held)]]);

    // After the reply, a status attaches to the last row at once: the owner answered.
    const answered = run(events([resolved], 5), replied);
    expect(answered.rows.at(-1)?.receipts).toEqual([receiptFromEvent(handoff), receiptFromEvent(held), receiptFromEvent(resolved)]);
    expect(answered.openHolds).toEqual([]);

    // A turn that ends with no reply keeps its receipts, under the visitor's message.
    const silent = run(
      [{ type: 'sent', id: 'v2', text: 'How much is drain clearing?' }, ...events([quoteReceipt, { type: 'writing' }, { type: 'turn_end' }], 6)],
      answered,
    );
    expect(silent.rows.at(-1)).toEqual({
      item: { kind: 'visitor', id: 'v2', text: 'How much is drain clearing?', status: 'sent' },
      receipts: [receiptFromEvent(quoteReceipt)],
    });
  });

  it('a_turn_the_desk_starts_groups_under_its_reply', () => {
    // The visitor asked and Claude answered; the turn ended.
    const answered = run([{ type: 'sent', id: 'v1', text: 'Can you send my invoice?' }, ...events([quoteMessage, { type: 'turn_end' }])]);
    // Then the API wakes Claude with no visitor message (the visitor confirmed it's them): Claude
    // writes, its action's receipt arrives, then its reply. The receipt explains that reply.
    const later: EvMessage = { ...quoteMessage, message_id: 'msg-after-verify' };
    const woke = run(events([{ type: 'writing' }, quoteReceipt, later, { type: 'turn_end' }], 3), answered);
    expect(woke.rows.map((row) => row.receipts)).toEqual([[], [receiptFromEvent(quoteMessage)], [receiptFromEvent(later), receiptFromEvent(quoteReceipt)]]);

    // A woken turn that ends with no reply keeps its receipt, under the last row.
    const silent = run(events([{ type: 'writing' }, quoteReceipt, { type: 'turn_end' }], 3), answered);
    expect(silent.rows.at(-1)?.receipts).toEqual([receiptFromEvent(quoteMessage), receiptFromEvent(quoteReceipt)]);

    // Read back after a reload, where no writing event is stored, the receipt is still the reply's.
    const reloaded = run([
      {
        type: 'history',
        transcript: transcript(6, [
          { ...item(1, 'visitor_text'), text: 'Can you send my invoice?' },
          { ...item(2, 'delivered'), event: quoteMessage },
          { ...item(3, 'status'), event: quoteReceipt },
          { ...item(4, 'delivered'), event: later },
        ]),
      },
    ]);
    expect(reloaded.rows.map((row) => row.receipts)).toEqual(woke.rows.map((row) => row.receipts));
  });

  it('status_before_any_row_is_kept', () => {
    const [resolved] = rivera.events.resolvedTurn as [StatusEvent];
    const state = run(events([resolved]));
    expect(state.rows).toEqual([]);
    expect(state.leading).toEqual([receiptFromEvent(resolved)]);
    // The next row starts the conversation; what came before it stays first.
    const after = run(events([quoteMessage], 2), state);
    expect(after.leading).toEqual([receiptFromEvent(resolved)]);
    expect(after.rows.map((row) => row.receipts)).toEqual([[receiptFromEvent(quoteMessage)]]);
  });

  it('error_stops_writing', () => {
    const asked = run([{ type: 'sent', id: 'v1', text: 'outage' }, ...events([{ type: 'writing' }])]);
    const failed = run(events([{ type: 'error', code: 'kernel_unavailable' }], 2), asked);
    expect(failed.writing).toBe(false);
    expect(failed.error).toBe('kernel_unavailable');
    // The next turn's writing clears the error: Claude is answering again.
    const again = run(events([{ type: 'turn_end' }, { type: 'writing' }], 3), failed);
    expect(again.error).toBeNull();
    expect(again.writing).toBe(true);
  });

  it('silent_end_clears_writing', () => {
    // A turn that ends with nothing to show (fail closed) clears the writing line and adds no row.
    const silent = run(events([{ type: 'writing' }, { type: 'turn_end' }]));
    expect(silent.writing).toBe(false);
    expect(silent.rows).toEqual([]);
    expect(silent.error).toBeNull();

    // The owner joining mid-turn stops Claude: a line about the chat, and no message.
    const joined: SseEvent = { type: 'owner_joined', name: 'Maria Rivera' };
    const taken = run(events([{ type: 'writing' }, joined]));
    expect(taken.writing).toBe(false);
    expect(taken.rows).toEqual([{ item: { kind: 'system', id: 's2', ev: joined }, receipts: [], live: true }]);
    const left = run(events([{ type: 'owner_left' }], 3), taken);
    expect(left.rows.map((row) => row.item.kind)).toEqual(['system', 'system']);
  });

  it('owner_typing_shows_until_her_words', () => {
    // Maria takes over and types: the chat keeps her name and the API's end time, and adds no row.
    const typing = run(events([ownerJoined, ownerTyping]));
    expect(typing.ownerTyping).toEqual({ name: 'Maria Rivera', until: '2026-10-30T17:21:10Z' });
    expect(typing.rows.map((row) => row.item.kind)).toEqual(['system']);

    // Her next typing event replaces the first; her own words then clear it.
    const longer = run(events([{ ...ownerTyping, until: '2026-10-30T17:21:20Z' }], 3), typing);
    expect(longer.ownerTyping).toEqual({ name: 'Maria Rivera', until: '2026-10-30T17:21:20Z' });
    const said = run(events([ownerSaid], 4), longer);
    expect(said.ownerTyping).toBeNull();
    expect(said.rows.at(-1)?.item).toEqual({ kind: 'message', seq: 4, ev: ownerSaid });

    // The stream reconnects and replays from seq 1: the typing it already passed stays gone.
    expect(run(events(takeOver.slice(0, 3)), said)).toEqual(said);

    // Handing back to Claude, or the turn's end, clears it too.
    expect(run(events([{ type: 'owner_left' }], 3), typing).ownerTyping).toBeNull();
    expect(run(events([{ type: 'turn_end' }], 3), typing).ownerTyping).toBeNull();

    // A transcript read before the seqs were known already shows her words; the replayed typing
    // event comes first and her message, matched by its id, still clears it.
    const loaded = run([{ type: 'history', transcript: transcript(0, [{ ...item(1, 'delivered'), event: ownerSaid }]) }]);
    const replayed = run(events(takeOver.slice(0, 3)), loaded);
    expect(replayed.ownerTyping).toBeNull();
    expect(replayed.rows.filter((row) => row.item.kind === 'message')).toEqual(loaded.rows);
  });

  it('replay_dedupes_by_seq', () => {
    const turn = rivera.events.quoteTurn;
    const first = run([{ type: 'sent', id: 'v1', text: 'How much is drain clearing?' }, ...events(turn.slice(0, 3))]);
    // The stream reconnects and replays from seq 1: seqs 1 to 3 again, then 4 for the first time.
    const replayed = run(events(turn), first);
    expect(replayed.lastSeq).toBe(4);
    expect(replayed.rows).toHaveLength(2);
    expect(replayed.rows[1]?.receipts).toEqual([receiptFromEvent(quoteMessage), receiptFromEvent(quoteReceipt)]);
    expect(replayed.writing).toBe(false);
    expect(run(events(turn), replayed)).toEqual(replayed);
  });

  it('reload_without_item_seqs_still_dedupes', () => {
    // The transcript was read before its events' seqs were known (`last_seq` 0), and the stream then
    // replays them from seq 1: each message and receipt is matched by its own identity.
    const history = run([
      {
        type: 'history',
        transcript: transcript(0, [
          visitorText(1, 'How much is drain clearing?'),
          { ...item(2, 'status'), event: quoteReceipt },
          { ...item(3, 'delivered'), event: quoteMessage },
        ]),
      },
    ]);
    const replayed = run(events(rivera.events.quoteTurn), history);
    expect(replayed.rows).toEqual(history.rows);
    expect(replayed.leading).toEqual([]);
    expect(replayed.rows.flatMap((row) => row.receipts)).toEqual([receiptFromEvent(quoteMessage), receiptFromEvent(quoteReceipt)]);
    expect(replayed.writing).toBe(false);
    expect(replayed.lastSeq).toBe(4);
  });

  it('history_rebuilds_rows_in_order', () => {
    const [held, , handoff] = rivera.events.heldTurn as [StatusEvent, SseEvent, EvMessage, SseEvent];
    const items: TranscriptItem[] = [
      { ...item(1, 'visitor_text'), text: 'How much is drain clearing?' },
      { ...item(2, 'status'), event: quoteReceipt },
      { ...item(3, 'delivered'), event: quoteMessage },
      { ...item(4, 'visitor_text'), text: 'Can I get 15% off?' },
      { ...item(5, 'status'), event: held },
      { ...item(6, 'delivered'), event: handoff },
      { ...item(7, 'delivered'), event: ownerSaid },
    ];
    // Stored rows arrive in any order; `n` decides.
    const state = run([{ type: 'history', transcript: transcript(12, [...items].reverse()) }]);
    expect(state.rows).toEqual([
      { item: { kind: 'visitor', id: 'n1', text: 'How much is drain clearing?', status: 'sent' }, receipts: [] },
      { item: { kind: 'message', seq: null, ev: quoteMessage }, receipts: [receiptFromEvent(quoteMessage), receiptFromEvent(quoteReceipt)] },
      { item: { kind: 'visitor', id: 'n4', text: 'Can I get 15% off?', status: 'sent' }, receipts: [] },
      { item: { kind: 'message', seq: null, ev: handoff }, receipts: [receiptFromEvent(handoff), receiptFromEvent(held)] },
      // The owner's own words are a delivered message, with the kernel's line under them.
      { item: { kind: 'message', seq: null, ev: ownerSaid }, receipts: [receiptFromEvent(ownerSaid)] },
    ]);
    expect(state.lastSeq).toBe(12);
    expect(state.openHolds).toEqual([held.decision_id]);
    expect(state.writing).toBe(false);

    // Loading the conversation again replaces what the chat held: nothing doubles.
    const again = run([{ type: 'sent', id: 'local-1', text: 'Thanks' }, { type: 'history', transcript: transcript(12, items) }], state);
    expect(again.rows).toEqual(state.rows);
  });

  it('rows_from_the_stream_arrive_live_until_shown', () => {
    const [held, , handoff] = rivera.events.heldTurn as [StatusEvent, SseEvent, EvMessage, SseEvent];
    const liveOf = (state: ChatState) => state.rows.map((row) => row.live === true);

    // The visitor's own message shows at once; Claude's reply comes from the stream and arrives
    // live, its receipts with it.
    const asked = run([{ type: 'sent', id: 'v1', text: 'How much is drain clearing?' }]);
    expect(liveOf(asked)).toEqual([false]);
    const answered = run(events(rivera.events.quoteTurn), asked);
    expect(liveOf(answered)).toEqual([false, true]);
    expect(answered.rows[1]?.receipts).toEqual([receiptFromEvent(quoteMessage), receiptFromEvent(quoteReceipt)]);

    // Once the page has shown it, it is live no more: a re-render or a remount draws it still.
    const shown = run([{ type: 'shown' }], answered);
    expect(liveOf(shown)).toEqual([false, false]);
    expect(shown.rows.map(({ item, receipts }) => ({ item, receipts }))).toEqual(answered.rows.map(({ item, receipts }) => ({ item, receipts })));
    // Nothing live to clear changes nothing.
    expect(run([{ type: 'shown' }], shown)).toBe(shown);

    // A line about the chat and the owner's own words from the stream arrive live too.
    const takenOver = run(events([ownerJoined, ownerSaid], 5), shown);
    expect(liveOf(takenOver)).toEqual([false, false, true, true]);

    // The stream reconnects and replays what the chat holds: nothing arrives again.
    const replayed = run(events(rivera.events.quoteTurn), shown);
    expect(replayed).toEqual(shown);

    // The stored conversation, read at load or after a reload, draws still, and so does an event
    // the stream replays that the read already showed (matched by its id).
    const reloaded = run([
      {
        type: 'history',
        transcript: transcript(0, [
          visitorText(1, 'Can I get 15% off if I pay cash?'),
          { ...item(2, 'status'), event: held },
          { ...item(3, 'delivered'), event: handoff },
        ]),
      },
    ]);
    expect(liveOf(reloaded)).toEqual([false, false]);
    expect(liveOf(run(events(rivera.events.heldTurn), reloaded))).toEqual([false, false]);
    // A read replaces live rows with still ones.
    expect(liveOf(run([{ type: 'history', transcript: transcript(4, [{ ...item(1, 'delivered'), event: quoteMessage }]) }], answered))).toEqual([false]);
  });

  it('what_the_stream_catches_up_on_draws_still', () => {
    const liveOf = (state: ChatState) => state.rows.map((row) => row.live === true);
    const asked = run([{ type: 'sent', id: 'v1', text: 'How much is drain clearing?' }]);
    const shown = run([...events(rivera.events.quoteTurn), { type: 'shown' }], asked);
    expect(liveOf(shown)).toEqual([false, false]);

    // The connection drops and comes back. What the stream replays after it happened while the
    // chat wasn't following, even what the chat hadn't seen: it draws still.
    const back = run([{ type: 'connection', connection: 'reconnecting' }, { type: 'connection', connection: 'open' }], shown);
    const missed = run(events([ownerJoined, ownerSaid], 5), back);
    expect(liveOf(missed)).toEqual([false, false, false, false]);

    // Once the stream has caught up, what it brings arrives live again.
    const current = run([{ type: 'caught_up' }], missed);
    const said = run(events([{ ...ownerSaid, message_id: 'msg-owner-later' }], 7), current);
    expect(liveOf(said)).toEqual([false, false, false, false, true]);

    // The page coming back to the chat, or a stream the server closed, catches up the same way.
    for (const away of [{ type: 'catching_up' }, { type: 'connection', connection: 'closed' }] as const) {
      const returned = run([away, ...events([{ ...ownerSaid, message_id: `msg-while-${away.type}` }], 8)], said);
      expect(returned.rows.at(-1)?.live).toBeUndefined();
    }

    // A read of the stored conversation is the chat caught up: what follows it arrives live.
    const read = run(
      [{ type: 'catching_up' }, { type: 'history', transcript: transcript(4, [{ ...item(1, 'delivered'), event: quoteMessage }]) }],
      said,
    );
    expect(liveOf(run(events([ownerJoined], 5), read))).toEqual([false, true]);
  });

  it('later_statuses_attach_to_their_hold', () => {
    const [held, , handoff] = rivera.events.heldTurn as [StatusEvent, SseEvent, EvMessage, SseEvent];
    const cancelled: StatusEvent = { ...held, type: 'resolved', state: 'cancelled', visitor_plain: 'Cancelled', ledger_seq: 9 };
    const r = receiptFromEvent;
    const receiptsOf = (state: ChatState) => state.rows.map((row) => row.receipts);

    // The hold's receipt sits under Claude's handoff (row 1); then the chat goes on with a quote (row 3).
    const heldOnRow = run([{ type: 'sent', id: 'v1', text: 'Can I get 15% off if I pay cash?' }, ...events(rivera.events.heldTurn)]);
    const goneOn = run([{ type: 'sent', id: 'v2', text: 'How much is drain clearing?' }, ...events(rivera.events.quoteTurn, 5)], heldOnRow);
    expect(receiptsOf(goneOn)).toEqual([[], [r(handoff), r(held)], [], [r(quoteMessage), r(quoteReceipt)]]);

    // The visitor cancels: the outcome goes under the message that holds the hold, and nothing new
    // under the quote.
    const resolved = run(events([cancelled], 9), goneOn);
    expect(receiptsOf(resolved)).toEqual([[], [r(handoff), r(held), r(cancelled)], [], [r(quoteMessage), r(quoteReceipt)]]);
    expect(resolved.openHolds).toEqual([]);

    // A status for a decision never held on the page still goes under the last row.
    const other: StatusEvent = { ...quoteReceipt, decision_id: 'dec-elsewhere', ledger_seq: 10 };
    const elsewhere = run(events([other], 10), resolved);
    expect(receiptsOf(elsewhere)).toEqual([[], [r(handoff), r(held), r(cancelled)], [], [r(quoteMessage), r(quoteReceipt), r(other)]]);

    // While the hold's own turn waits for its reply, a later status waits with it.
    const early = run([{ type: 'sent', id: 'v1', text: 'Can I get 15% off?' }, ...events([held, { type: 'writing' }, cancelled, handoff])]);
    expect(receiptsOf(early)).toEqual([[], [r(handoff), r(held), r(cancelled)]]);

    // Reloading the conversation puts every line back where it was.
    const stored: TranscriptItem[] = [
      visitorText(1, 'Can I get 15% off if I pay cash?'),
      { ...item(2, 'status'), event: held },
      { ...item(3, 'delivered'), event: handoff },
      visitorText(4, 'How much is drain clearing?'),
      { ...item(5, 'status'), event: quoteReceipt },
      { ...item(6, 'delivered'), event: quoteMessage },
      { ...item(7, 'status'), event: cancelled },
      { ...item(8, 'status'), event: other },
    ];
    const reloaded = run([{ type: 'history', transcript: transcript(10, stored) }]);
    expect(receiptsOf(reloaded)).toEqual(receiptsOf(elsewhere));
    expect(reloaded.openHolds).toEqual([]);
  });

  it('owner_typing_until_the_owner_writes', () => {
    const typing: EvOwnerTyping = { type: 'owner_typing', name: 'Maria Rivera', until: '2026-10-29T15:04:30Z' };
    const joined = run(events([{ type: 'owner_joined', name: 'Maria Rivera' }, typing]));
    // Her name and how long, kept as the event said it, never her words, and no row; nothing says
    // Claude is writing.
    expect(joined.ownerTyping).toEqual({ name: 'Maria Rivera', until: '2026-10-29T15:04:30Z' });
    expect(joined.writing).toBe(false);
    expect(joined.rows).toHaveLength(1);
    expect(joined.lastSeq).toBe(2);

    // Her message takes its place, in one step.
    const said: EvMessage = { ...quoteMessage, message_id: 'msg-owner', author: 'owner' };
    const answered = run(events([said], 3), joined);
    expect(answered.ownerTyping).toBeNull();
    expect(answered.rows.at(-1)?.item).toEqual({ kind: 'message', seq: 3, ev: said });
    // Claude's doesn't: she may still be typing beside it.
    expect(run(events([quoteMessage], 3), joined).ownerTyping).toEqual({ name: 'Maria Rivera', until: '2026-10-29T15:04:30Z' });
    // Handing the chat back ends it, and so does an error, its time running out, the chat ending
    // (a 401) and a new chat.
    expect(run(events([{ type: 'owner_left' }], 3), joined).ownerTyping).toBeNull();
    expect(run(events([{ type: 'error', code: 'kernel_unavailable' }], 3), joined).ownerTyping).toBeNull();
    expect(run([{ type: 'owner_typing_over' }], joined).ownerTyping).toBeNull();
    expect(run([{ type: 'ended' }], joined).ownerTyping).toBeNull();
    expect(run([{ type: 'reset' }], joined).ownerTyping).toBeNull();
    // A replayed event the chat has seen changes nothing.
    expect(run(events([typing], 2), answered).ownerTyping).toBeNull();
    // A stale one shows nothing, and the stream goes on after it.
    const stale = run([{ type: 'stale', seq: 3 }], run(events([{ type: 'owner_joined', name: 'Maria Rivera' }])));
    expect(stale.ownerTyping).toBeNull();
    expect(stale.lastSeq).toBe(3);

    // How long the dots show: until the event's time, never more than the API's 5 s, and nothing
    // for a time already past or one that can't be read.
    const now = Date.parse('2026-10-29T15:04:00Z');
    const until = (ms: number) => ({ ...typing, until: new Date(now + ms).toISOString() });
    expect(ownerTypingDelayMs(until(3_000), now)).toBe(3_000);
    expect(ownerTypingDelayMs(until(9_000), now)).toBe(5_000);
    expect(ownerTypingDelayMs(until(-1_000), now)).toBe(0);
    expect(ownerTypingDelayMs(until(0), now)).toBe(0);
    expect(ownerTypingDelayMs({ ...typing, until: 'soon' }, now)).toBe(0);
  });

  it('reload_during_a_take_over_shows_the_owner_joined', () => {
    // Open throughout: Dana asks for Maria, Claude answers, Maria takes the chat over and writes.
    const live = run([{ type: 'sent', id: 'local-1', text: ASK }, ...events(TAKEN_OVER)]);
    // Reloaded after Maria pressed Take over: the stored conversation holds where she joined.
    const joinedLast = run([{ type: 'history', transcript: transcript(4, STORED_TAKEN_OVER.slice(0, 3)) }]);
    expect(joinedLast.rows.map((row) => row.item.kind)).toEqual(['visitor', 'message', 'system']);
    expect(joinedLast.rows.at(-1)?.item).toMatchObject({ kind: 'system', ev: ownerJoined });

    // Reloaded after her words too: the chat looks as it did to a page open throughout, in the
    // state the live join leaves it in (nothing writing, no typing, no error, no open hold).
    const reloaded = run([{ type: 'history', transcript: transcript(5, STORED_TAKEN_OVER) }]);
    expect(shown(reloaded)).toEqual(shown(live));
    expect(flags(reloaded)).toEqual(flags(live));
    expect(reloaded.lastSeq).toBe(5);
  });

  it('reload_after_a_hand_back_shows_the_join_then_the_leave', () => {
    // Open throughout: Maria joins, writes and hands the chat back, and Claude answers again.
    const later: EvMessage = { ...quoteMessage, message_id: 'msg-after-hand-back' };
    const live = run([
      { type: 'sent', id: 'local-1', text: ASK },
      ...events([...TAKEN_OVER, { type: 'owner_left' }, { type: 'writing' }, later, { type: 'turn_end' }]),
    ]);
    const reloaded = run([
      {
        type: 'history',
        transcript: transcript(9, [...STORED_TAKEN_OVER, { ...item(5, 'owner_left'), event: { type: 'owner_left' } }, { ...item(6, 'delivered'), event: later }]),
      },
    ]);
    // Her join, then her leave, in their places, as the page open throughout showed them.
    const lines = reloaded.rows.flatMap(({ item }) => (item.kind === 'system' ? [item.ev.type] : []));
    expect(lines).toEqual(['owner_joined', 'owner_left']);
    expect(reloaded.rows.map((row) => row.item.kind)).toEqual(['visitor', 'message', 'system', 'message', 'system', 'message']);
    expect(shown(reloaded)).toEqual(shown(live));
    expect(flags(reloaded)).toEqual(flags(live));
  });

  it('join_and_leave_show_once_when_the_stream_resumes_after_the_transcript', () => {
    // Open throughout, to the hand-back.
    const handBack: SseEvent[] = [...TAKEN_OVER, { type: 'owner_left' }];
    const live = run([{ type: 'sent', id: 'local-1', text: ASK }, ...events(handBack)]);

    // Reloaded during the take-over, then the stream replays from seq 1 (a reconnect from an older
    // cursor): the join carries no identity, so the transcript's `last_seq` is what keeps it from
    // showing twice. What the transcript held adds nothing, and the hand-back after it shows once.
    const reloaded = run([{ type: 'history', transcript: transcript(5, STORED_TAKEN_OVER) }]);
    expect(run(events(TAKEN_OVER), reloaded)).toEqual(reloaded);
    const handedBack = run(events(handBack), reloaded);
    expect(shown(handedBack)).toEqual(shown(live));
    expect(flags(handedBack)).toEqual(flags(live));
    expect(lines(handedBack)).toEqual([
      ['n3', 'owner_joined'],
      ['s6', 'owner_left'],
    ]);
    // Replayed again from seq 1, nothing changes.
    expect(run(events(handBack), handedBack)).toEqual(handedBack);
  });

  it('two_joins_in_a_row_each_show', () => {
    // A hand-back the kernel made but whose leave the API never kept (its answer was lost), then a
    // second take-over: two joins with no leave between, each a take-over of its own.
    const later: EvMessage = { ...quoteMessage, message_id: 'msg-after-hand-back' };
    const live = run([
      { type: 'sent', id: 'local-1', text: ASK },
      ...events([...TAKEN_OVER, { type: 'writing' }, later, { type: 'turn_end' }, ownerJoined]),
    ]);
    expect(lines(live)).toEqual([
      ['s4', 'owner_joined'],
      ['s9', 'owner_joined'],
    ]);

    // Reloaded after the second: both joins come back, each in its place.
    const stored = [...STORED_TAKEN_OVER, { ...item(5, 'delivered'), event: later }, { ...item(6, 'owner_joined'), event: ownerJoined }];
    const reloaded = run([{ type: 'history', transcript: transcript(9, stored) }]);
    expect(lines(reloaded)).toEqual([
      ['n3', 'owner_joined'],
      ['n6', 'owner_joined'],
    ]);
    expect(shown(reloaded)).toEqual(shown(live));
    expect(flags(reloaded)).toEqual(flags(live));
  });

  it('a_second_take_over_shows_each_line', () => {
    // Live: Maria joins, hands the chat back and joins again, three lines in order.
    const left: SseEvent = { type: 'owner_left' };
    const live = run(events([ownerJoined, left, ownerJoined]));
    expect(lines(live)).toEqual([
      ['s1', 'owner_joined'],
      ['s2', 'owner_left'],
      ['s3', 'owner_joined'],
    ]);

    // Reloaded after the second join: the same three, and her next hand-back adds a fourth.
    const stored: TranscriptItem[] = [
      { ...item(1, 'owner_joined'), event: ownerJoined },
      { ...item(2, 'owner_left'), event: left },
      { ...item(3, 'owner_joined'), event: ownerJoined },
    ];
    const reloaded = run([{ type: 'history', transcript: transcript(3, stored) }]);
    expect(lines(reloaded)).toEqual([
      ['n1', 'owner_joined'],
      ['n2', 'owner_left'],
      ['n3', 'owner_joined'],
    ]);
    expect(shown(reloaded)).toEqual(shown(live));
    expect(lines(run(events([left], 4), reloaded))).toEqual([...lines(reloaded), ['s4', 'owner_left']]);
  });

  it('a_leave_with_no_join_before_it_still_shows', () => {
    // A take-over whose join the API never kept: Maria types and writes, then hands the chat back.
    // Her leave is a line of its own, and it ends her typing and anything shown writing.
    const left: SseEvent = { type: 'owner_left' };
    const live = run(events([{ type: 'writing' }, ownerTyping, ownerSaid, ownerTyping, left]));
    expect(lines(live)).toEqual([['s5', 'owner_left']]);
    expect(live.writing).toBe(false);
    expect(live.ownerTyping).toBeNull();

    // Read back after a reload, the same line, in the same place.
    const reloaded = run([
      { type: 'history', transcript: transcript(5, [{ ...item(1, 'delivered'), event: ownerSaid }, { ...item(2, 'owner_left'), event: left }]) },
    ]);
    expect(lines(reloaded)).toEqual([['n2', 'owner_left']]);
    expect(shown(reloaded)).toEqual(shown(live));
    expect(flags(reloaded)).toEqual(flags(live));
  });

  it('owner_in_chat_is_the_sessions_mode', () => {
    const inOwnersHands: SessionState = { ...rivera.sessions.public, mode: 'owner' };
    const open = initialChatState();
    // The kernel's mode is the only source: the owner's, and nothing else, says she is in the chat.
    expect(ownerInChatNow(inOwnersHands, open)).toBe(true);
    expect(ownerInChatNow(rivera.sessions.public, open)).toBe(false);
    expect(ownerInChatNow({ ...inOwnersHands, mode: 'paused' }, open)).toBe(false);
    // No session yet, or a mode the page doesn't know.
    expect(ownerInChatNow(null, open)).toBe(false);
    expect(ownerInChatNow({ ...inOwnersHands, mode: 'owner_soon' as SessionState['mode'] }, open)).toBe(false);
    // The chat's own lines say nothing of it: a join last with the session in Claude's hands (a
    // hand-back whose leave was never kept), or no join at all with it in hers.
    const joinedLast = run(events([ownerJoined]));
    expect(ownerInChatNow(rivera.sessions.public, joinedLast)).toBe(false);
    expect(ownerInChatNow(inOwnersHands, run(events([quoteMessage])))).toBe(true);
  });

  it('owner_in_chat_fails_safe_to_false', () => {
    const inOwnersHands: SessionState = { ...rivera.sessions.public, mode: 'owner' };
    const joined = run(events([ownerJoined]));
    expect(ownerInChatNow(inOwnersHands, joined)).toBe(true);
    // Any error on the stream, the chat ending included, and a send that found it ended (a 401).
    for (const code of EV_ERROR_CODES) expect(ownerInChatNow(inOwnersHands, run(events([{ type: 'error', code }], 2), joined)), code).toBe(false);
    expect(ownerInChatNow(inOwnersHands, run([{ type: 'ended' }], joined))).toBe(false);

    // The stream drops or closes: until it has caught up again, the chat can't know she's still there.
    const dropped = run([{ type: 'connection', connection: 'reconnecting' }], joined);
    expect(ownerInChatNow(inOwnersHands, dropped)).toBe(false);
    expect(ownerInChatNow(inOwnersHands, run([{ type: 'connection', connection: 'closed' }], joined))).toBe(false);
    const reopened = run([{ type: 'connection', connection: 'open' }], dropped);
    expect(ownerInChatNow(inOwnersHands, reopened)).toBe(false);
    expect(ownerInChatNow(inOwnersHands, run([{ type: 'caught_up' }], reopened))).toBe(true);
    // The page coming back to the chat catches up the same way.
    const back = run([{ type: 'catching_up' }], joined);
    expect(ownerInChatNow(inOwnersHands, back)).toBe(false);
    expect(ownerInChatNow(inOwnersHands, run([{ type: 'caught_up' }], back))).toBe(true);
  });
});

/** The lines about the chat, in order: each one's id and whether the owner joined or left. */
function lines(state: ChatState): [string, string][] {
  return state.rows.flatMap(({ item }) => (item.kind === 'system' ? [[item.id, item.ev.type] as [string, string]] : []));
}

/** Dana asks for Maria: what she types, and what Claude answers. */
const ASK = "I'd like to talk to Maria Rivera.";

/** The take-over as the stream brings it, from seq 1: Claude's answer, then Maria joins and writes. */
const TAKEN_OVER: SseEvent[] = [{ type: 'writing' }, quoteMessage, { type: 'turn_end' }, ownerJoined, ownerSaid];

/** The same conversation as the API stores it: the visitor's words, the answer, the join, her words. */
const STORED_TAKEN_OVER: TranscriptItem[] = [
  visitorText(1, ASK),
  { ...item(2, 'delivered'), event: quoteMessage },
  { ...item(3, 'owner_joined'), event: ownerJoined },
  { ...item(4, 'delivered'), event: ownerSaid },
];

/** What the chat shows, row by row: the words or event of each row and its receipts, without the ids and seqs that say where each came from. */
function shown(state: ChatState) {
  return state.rows.map(({ item, receipts }) => ({ kind: item.kind, what: item.kind === 'visitor' ? item.text : item.ev, receipts }));
}

/** The chat's state besides its rows: whether Claude is writing, the owner typing, an error, the open holds. */
function flags({ writing, ownerTyping, error, openHolds, leading, pending, awaitingReply }: ChatState) {
  return { writing, ownerTyping, error, openHolds, leading, pending, awaitingReply };
}

function item(n: number, kind: TranscriptItem['kind']): TranscriptItem {
  return { n, kind, created_at: '2026-10-30T17:04:00.000000Z', text: null, event: null };
}

function visitorText(n: number, text: string): TranscriptItem {
  return { ...item(n, 'visitor_text'), text };
}

function transcript(lastSeq: number, items: TranscriptItem[]): VisitorTranscript {
  return { state: rivera.sessions.public, items, last_seq: lastSeq };
}
