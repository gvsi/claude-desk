import { describe, expect, it } from 'vitest';

import { DECISION_STATES, type DecisionState, type EvMessage, type SseEvent, type StatusEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';
import { receiptFromEvent, receiptTone } from './receiptTone.ts';

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

describe('receiptTone', () => {
  it('every_state_has_a_tone', () => {
    expect([...DECISION_STATES].sort()).toEqual(Object.keys(EXPECTED_TONES).sort());
    for (const state of DECISION_STATES) {
      expect(receiptTone({ kind: 'decision', state }), state).toBe(EXPECTED_TONES[state]);
    }
  });

  it('reply_receipts_follow_handoff', () => {
    // A reply that passed its check is handled; a blocked draft handed off to the owner waits, like a hold.
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
    expect(held.visitor_plain).toBe('Waiting for Maria Rivera to approve');

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
