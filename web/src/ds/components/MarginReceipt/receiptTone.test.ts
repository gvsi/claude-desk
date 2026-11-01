import { describe, expect, it } from 'vitest';

import {
  DECISION_STATES,
  type Decision,
  type DecisionState,
  type EvMessage,
  type SseEvent,
  type StatusEvent,
} from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import type { OwnerReasonState } from '../../index.ts';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';
import { OWNER_REASON_STATES, OWNER_STATE_WORDS, receiptFromEvent, receiptLine, receiptTone } from './receiptTone.ts';

/** The owner's words for the receipt that reports what the kernel decided, written out here as the oracle. */
const EXPECTED_WORDS: Record<OwnerReasonState, string> = {
  held: 'Held for you',
  refused: 'Stopped',
  executed: 'Automatic',
  allowed: 'Running',
};

/** The plan's tone table, written out here as the oracle the implementation is held to. */
const EXPECTED_TONES: Record<DecisionState, StatusTone> = {
  allowed: 'handled',
  approved: 'handled',
  executed: 'handled',
  held: 'held',
  unknown: 'held',
  refused: 'refused',
  denied: 'refused',
  failed: 'refused',
  refused_at_execution: 'refused',
  expired: 'info',
  cancelled: 'info',
};

/** The one event of `type` in a stored SSE sequence. */
function only<T extends SseEvent['type']>(events: readonly SseEvent[], type: T): Extract<SseEvent, { type: T }> {
  const found = events.filter((event): event is Extract<SseEvent, { type: T }> => event.type === type);
  if (found.length !== 1) throw new Error(`expected one ${type} event, found ${found.length}`);
  return found[0] as Extract<SseEvent, { type: T }>;
}

describe('OWNER_STATE_WORDS', () => {
  it('reason_states_are_the_decide_outcomes', () => {
    expect(OWNER_REASON_STATES).toEqual(['held', 'refused', 'executed', 'allowed']);
  });

  it('words_cover_only_the_reason_states', () => {
    // Words for the receipt that reports what the kernel decided, not general outcome words: a
    // later state keeps the kernel's line, so it has none here.
    expect(Object.keys(OWNER_STATE_WORDS).sort()).toEqual([...OWNER_REASON_STATES].sort());
    for (const state of OWNER_REASON_STATES) expect(OWNER_STATE_WORDS[state], state).toBe(EXPECTED_WORDS[state]);
  });

  // Importing the index transforms every component, which takes longer than the default 5 s when
  // the browser projects run beside it (as in guards.test.ts).
  it('exported_from_the_design_system', { timeout: 60_000 }, async () => {
    const index: Record<string, unknown> = await import('../../index.ts');
    expect(index.OWNER_STATE_WORDS).toBe(OWNER_STATE_WORDS);
    expect(index.OWNER_REASON_STATES).toBe(OWNER_REASON_STATES);
  });
});

/** A decision's receipt as an owner screen passes it: its state, its `visitor_plain` and its `reason_plain`. */
function ownerInput(decision: Decision) {
  return { source: { kind: 'decision', state: decision.state } as const, plain: decision.visitor_plain, reason: decision.reason_plain };
}

describe('receiptLine', () => {
  it('owner_reason_follows_the_state_words', () => {
    // "{words}. {reason}" on the receipt that reports what the kernel decided; the period after the
    // words belongs to the lead. Each decision is one whose first receipt reads that state: the
    // held quote, the refused document and Dana's quote, which the rules allowed and which then ran.
    const firstReceipts = [rivera.decisions.held, rivera.decisions.refused, { ...rivera.decisions.allowed, state: 'executed' as const }, rivera.decisions.allowed];
    expect(firstReceipts.map((decision) => decision.state)).toEqual([...OWNER_REASON_STATES]);
    for (const decision of firstReceipts) {
      expect(receiptLine(ownerInput(decision)), decision.state).toEqual({ lead: `${EXPECTED_WORDS[decision.state]}.`, text: decision.reason_plain });
    }
    expect(receiptLine(ownerInput(rivera.decisions.refused))).toEqual({
      lead: 'Stopped.',
      text: "A visitor not on record asked for Bob Okafor's warranty. Documents go only to their own verified customer, so nothing was shared.",
    });
  });

  it('reason_on_a_later_state_keeps_plain', () => {
    // reason_plain is written once, at decide time, so it explains only the receipt that reports
    // what the kernel decided. On any later state ("Automatic" for a hold the owner later allowed)
    // it would say something false, so the line stays the kernel's.
    const later = ['approved', 'denied', 'expired', 'cancelled', 'failed', 'unknown', 'refused_at_execution'] as const;
    expect([...later, 'held', 'refused', 'executed', 'allowed'].sort()).toEqual([...DECISION_STATES].sort());
    for (const state of later) {
      const input = ownerInput(rivera.decisions[state]);
      for (const cardBelow of [false, true]) {
        expect(receiptLine({ ...input, cardBelow }), `${state} ${String(cardBelow)}`).toEqual({ text: input.plain });
      }
    }
    // The fixture's executed decision is the held discount after it was allowed: the case the rule exists for.
    expect(rivera.decisions.executed.reason_plain).toBe(rivera.decisions.held.reason_plain);
  });

  it('no_reason_keeps_plain', () => {
    // Without a reason, or with one that is empty after trimming, the line is the kernel's, unchanged.
    for (const state of DECISION_STATES) {
      const input = ownerInput(rivera.decisions[state]);
      for (const reason of [undefined, '', '   ', '\n\t ']) {
        expect(receiptLine({ ...input, reason }), `${state} ${JSON.stringify(reason)}`).toEqual({ text: input.plain });
      }
    }
  });

  it('held_with_card_below_is_the_words_alone', () => {
    // The card's headline already gives the reason, so the receipt names the state and stops,
    // with no period, like the kernel's lines; with or without a reason.
    const input = ownerInput(rivera.decisions.held);
    expect(receiptLine({ ...input, cardBelow: true })).toEqual({ lead: 'Held for you', text: '' });
    expect(receiptLine({ ...input, reason: undefined, cardBelow: true })).toEqual({ lead: 'Held for you', text: '' });
    expect(receiptLine({ ...input, reason: '  ', cardBelow: true })).toEqual({ lead: 'Held for you', text: '' });
    expect(receiptLine({ ...input, cardBelow: false })).toEqual({ lead: 'Held for you.', text: input.reason });
  });

  it('card_below_is_ignored_unless_held', () => {
    for (const state of DECISION_STATES.filter((s) => s !== 'held')) {
      const input = ownerInput(rivera.decisions[state]);
      expect(receiptLine({ ...input, cardBelow: true }), state).toEqual(receiptLine(input));
      expect(receiptLine({ ...input, reason: undefined, cardBelow: true }), state).toEqual({ text: input.plain });
    }
  });

  it('reply_ignores_reason_and_card_below', () => {
    // A reply's check has no owner words: its line is always the event's visitor_plain.
    const reason = rivera.decisions.held.reason_plain;
    for (const ev of [only(rivera.events.heldTurn, 'message'), only(rivera.events.quoteTurn, 'message')]) {
      const { source, plain } = receiptFromEvent(ev);
      for (const cardBelow of [undefined, false, true]) {
        expect(receiptLine({ source, plain, reason, cardBelow }), `${ev.message_id} ${String(cardBelow)}`).toEqual({ text: plain });
      }
    }
  });

  it('unknown_state_keeps_plain', () => {
    // A state this build has no words for keeps the kernel's line, which names its state; the
    // reason alone would leave the state to the dot's color.
    const { plain, reason } = ownerInput(rivera.decisions.held);
    for (const state of ['bogus', '', 'HELD', 'held ', '__proto__', 'toString', 'constructor']) {
      const source = { kind: 'decision', state: state as DecisionState } as const;
      for (const cardBelow of [false, true]) {
        expect(receiptLine({ source, plain, reason, cardBelow }), `${JSON.stringify(state)} ${String(cardBelow)}`).toEqual({ text: plain });
      }
    }
  });
});

describe('receiptTone', () => {
  it('every_state_has_a_tone', () => {
    expect([...DECISION_STATES].sort()).toEqual(Object.keys(EXPECTED_TONES).sort());
    for (const state of DECISION_STATES) {
      expect(receiptTone({ kind: 'decision', state }), state).toBe(EXPECTED_TONES[state]);
    }
  });

  it('reply_receipts_follow_handoff', () => {
    // A reply showing no handoff clause is handled, kept cards included; one showing it waits, like a hold.
    expect(receiptTone({ kind: 'reply', handoff: false })).toBe('handled');
    expect(receiptTone({ kind: 'reply', handoff: true })).toBe('held');
  });

  it('unknown_values_read_as_held', () => {
    // Fail closed: a state this build doesn't know, or a reply whose handoff isn't exactly false,
    // waits like a hold and never reads as handled.
    for (const state of ['bogus', '', 'ALLOWED', 'executed ', '__proto__', 'toString', 'constructor']) {
      expect(receiptTone({ kind: 'decision', state: state as DecisionState }), JSON.stringify(state)).toBe('held');
    }
    expect(receiptTone({ kind: 'decision', state: undefined as unknown as DecisionState })).toBe('held');
    for (const handoff of [undefined, null, 'false', 0, '']) {
      expect(receiptTone({ kind: 'reply', handoff: handoff as unknown as boolean }), JSON.stringify(handoff)).toBe('held');
    }
  });

  it('receipt_from_event_uses_visitor_plain', () => {
    const held: StatusEvent = only(rivera.events.heldTurn, 'held');
    expect(receiptFromEvent(held)).toEqual({
      source: { kind: 'decision', state: 'held' },
      plain: held.visitor_plain,
      ledgerSeq: held.ledger_seq,
    });
    expect(held.visitor_plain).toBe('Waiting for Mike Turner to approve');

    const handoff: EvMessage = only(rivera.events.heldTurn, 'message');
    expect(handoff.handoff).toBe(true);
    expect(receiptFromEvent(handoff)).toEqual({
      source: { kind: 'reply', handoff: true },
      plain: handoff.visitor_plain,
      ledgerSeq: handoff.ledger_seq,
    });

    // A receipt and a resolved event are decisions too, with their own state.
    const resolved = only(rivera.events.resolvedTurn, 'resolved');
    expect(receiptFromEvent(resolved).source).toEqual({ kind: 'decision', state: 'executed' });
    const checked = only(rivera.events.quoteTurn, 'message');
    expect(receiptFromEvent(checked).source).toEqual({ kind: 'reply', handoff: false });
  });
});
