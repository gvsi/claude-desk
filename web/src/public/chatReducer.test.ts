/**
 * The visitor's chat as a pure reducer: what the stream, the transcript and the composer do to the
 * rows, the receipts under them and the writing line.
 */
import { describe, expect, it } from 'vitest';

import type { EvMessage, SseEvent, StatusEvent } from '../api/contracts.ts';
import type { TranscriptItem, VisitorTranscript } from '../api/views.ts';
import { receiptFromEvent } from '../ds/index.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { chatReducer, initialChatState, type ChatAction, type ChatState } from './chatReducer.ts';

/** The fixtures' quote turn: the action's receipt, writing, the checked reply, the turn's end. */
const [quoteReceipt, , quoteMessage] = rivera.events.quoteTurn as [StatusEvent, SseEvent, EvMessage, SseEvent];

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
    expect(answered.rows).toEqual([{ item: { kind: 'message', seq: 2, ev: quoteMessage }, receipts: [receiptFromEvent(quoteMessage)] }]);
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
    expect(taken.rows).toEqual([{ item: { kind: 'system', seq: 2, ev: joined }, receipts: [] }]);
    const left = run(events([{ type: 'owner_left' }], 3), taken);
    expect(left.rows.map((row) => row.item.kind)).toEqual(['system', 'system']);
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
    const [, ownerSaid] = rivera.events.takeOver as [SseEvent, EvMessage];
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
});

function item(n: number, kind: TranscriptItem['kind']): TranscriptItem {
  return { n, kind, created_at: '2026-10-30T17:04:00.000000Z', text: null, event: null };
}

function visitorText(n: number, text: string): TranscriptItem {
  return { ...item(n, 'visitor_text'), text };
}

function transcript(lastSeq: number, items: TranscriptItem[]): VisitorTranscript {
  return { state: rivera.sessions.public, items, last_seq: lastSeq };
}
