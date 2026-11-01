import type { DecisionState, EvMessage, StatusEvent } from '../../../api/contracts.ts';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/** What a receipt reports on: a reply's check (`handoff` when it shows the handoff clause), or an action's decision. */
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
 * The receipt's status dot. A reply is handled when it shows no handoff clause (`handoff: false`),
 * the checked cards kept from a draft whose prose failed included; a reply that shows the handoff
 * clause goes to the owner, so it waits like a hold. A state this build doesn't know reads as
 * held, never as handled.
 */
export function receiptTone(source: ReceiptSource): StatusTone {
  if (source.kind === 'reply') return source.handoff === false ? 'handled' : 'held';
  return Object.hasOwn(DECISION_TONES, source.state) ? DECISION_TONES[source.state] : 'held';
}

/**
 * The states of the receipt that reports what the kernel decided: a decision's first receipt when
 * it reads one of these. Only that receipt takes the decision's `reason_plain`, which is written
 * once, at decide time; every later receipt keeps the kernel's line.
 */
export const OWNER_REASON_STATES = ['held', 'refused', 'executed', 'allowed'] as const;

/** A state in `OWNER_REASON_STATES`. */
export type OwnerReasonState = (typeof OWNER_REASON_STATES)[number];

/** Whether `state` is one the decision's reason explains. A state this build doesn't know isn't. */
function isOwnerReasonState(state: DecisionState): state is OwnerReasonState {
  return (OWNER_REASON_STATES as readonly string[]).includes(state);
}

/**
 * The owner's words for the receipt that reports what the kernel decided, which lead its line on
 * owner screens so the line, not only the dot's color, names the state. They are not general
 * outcome words: "Automatic" is true only of an action the rules ran on their own, so a later
 * state has no words here and keeps the kernel's line. A reason state missing here is a compile error.
 */
export const OWNER_STATE_WORDS = {
  held: 'Held for you',
  refused: 'Stopped',
  executed: 'Automatic',
  allowed: 'Running',
} as const satisfies Record<OwnerReasonState, string>;

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
 * What a receipt's line shows. A reply's line is always `plain`, and so is a decision's on any state
 * outside `OWNER_REASON_STATES`, even with a `reason`. On those four states it is, in order:
 * - with `cardBelow` and state `held`, the words alone, "Held for you": the card's headline gives the reason;
 * - with a `reason` that isn't empty after trimming, "{words}. {reason}";
 * - otherwise `plain`, unchanged.
 */
export function receiptLine({ source, plain, reason, cardBelow = false }: ReceiptLineInput): ReceiptLine {
  if (source.kind !== 'decision' || !isOwnerReasonState(source.state)) return { text: plain };
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
