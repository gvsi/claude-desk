import type { DecisionState, EvMessage, StatusEvent } from '../../../api/contracts.ts';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/** What a receipt reports on: a reply's check (`handoff` when it was blocked), or an action's decision. */
export type ReceiptSource = { kind: 'reply'; handoff: boolean } | { kind: 'decision'; state: DecisionState };

/** Each decision state's dot. A state missing here is a compile error. */
const DECISION_TONES = {
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
} as const satisfies Record<DecisionState, StatusTone>;

/**
 * The receipt's status dot. A reply is handled only when it passed its check (`handoff: false`);
 * a blocked draft goes to the owner, so it waits like a hold. A state this build doesn't know
 * reads as held, never as handled.
 */
export function receiptTone(source: ReceiptSource): StatusTone {
  if (source.kind === 'reply') return source.handoff === false ? 'handled' : 'held';
  return Object.hasOwn(DECISION_TONES, source.state) ? DECISION_TONES[source.state] : 'held';
}

/** A margin receipt's data, read from one signed event: the props `MarginReceipt` takes. */
export interface ReceiptView {
  source: ReceiptSource;
  /** The event's `visitor_plain`, the kernel's status line, unchanged. */
  plain: string;
  /** The ledger entry the event was signed with, which the owner's full trace opens. */
  ledgerSeq: number;
}

/**
 * The receipt for a delivered message (its reply check) or a status event (its action's state).
 * The line is the event's own `visitor_plain`: nothing here writes or rewrites status copy.
 */
export function receiptFromEvent(ev: EvMessage | StatusEvent): ReceiptView {
  const source: ReceiptSource = ev.type === 'message' ? { kind: 'reply', handoff: ev.handoff } : { kind: 'decision', state: ev.state };
  return { source, plain: ev.visitor_plain, ledgerSeq: ev.ledger_seq };
}
