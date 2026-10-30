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

/**
 * The owner's words for each decision state, which lead a decision's receipt on owner screens so
 * the line, not only the dot's color, names the state. A state missing here is a compile error.
 */
export const OWNER_STATE_WORDS = {
  held: 'Held for you',
  refused: 'Stopped',
  executed: 'Automatic',
  allowed: 'Running',
  approved: 'You allowed it',
  denied: 'You denied it',
  expired: 'Expired',
  cancelled: 'They cancelled it',
  failed: "Didn't run",
  refused_at_execution: "Didn't run",
  unknown: 'Still checking what happened',
} as const satisfies Record<DecisionState, string>;

/** What `receiptLine` reads: a receipt's source and line, and the owner screen's two extras. */
export interface ReceiptLineInput {
  source: ReceiptSource;
  /** The event's `visitor_plain`. */
  plain: string;
  /** Owner screens: the decision's `reason_plain`. */
  reason?: string;
  /** Owner screens: the request's `ApprovalCard` is drawn right under this receipt's row. */
  cardBelow?: boolean;
}

/** A receipt's line: the owner's words for its state when they lead it, then the rest. */
export interface ReceiptLine {
  /** The state's words, with the period after them when more follows. */
  lead?: string;
  /** The rest of the line. */
  text: string;
}

/**
 * What a receipt's line shows. A reply's line is always `plain`. A decision's is, in order:
 * - with `cardBelow` and state `held`, the words alone, "Held for you": the card's headline gives the reason;
 * - with a `reason` that isn't empty after trimming, "{words}. {reason}";
 * - otherwise `plain`, unchanged.
 * A state this build has no words for keeps `plain`, which names its state.
 */
export function receiptLine({ source, plain, reason, cardBelow = false }: ReceiptLineInput): ReceiptLine {
  if (source.kind !== 'decision' || !Object.hasOwn(OWNER_STATE_WORDS, source.state)) return { text: plain };
  const words = OWNER_STATE_WORDS[source.state];
  if (cardBelow && source.state === 'held') return { lead: words, text: '' };
  if (reason !== undefined && reason.trim() !== '') return { lead: `${words}.`, text: reason };
  return { text: plain };
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
 * The line is the event's own `visitor_plain`, unchanged: this never writes or rewrites status copy.
 */
export function receiptFromEvent(ev: EvMessage | StatusEvent): ReceiptView {
  const source: ReceiptSource = ev.type === 'message' ? { kind: 'reply', handoff: ev.handoff } : { kind: 'decision', state: ev.state };
  return { source, plain: ev.visitor_plain, ledgerSeq: ev.ledger_seq };
}
