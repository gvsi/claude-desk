// The one import path for contract types in the web app. contracts.gen.ts is generated from
// backend/desk/contracts.schema.json (`npm run gen:contracts`); this file adds names for the
// unions the schema writes inline, the exhaustive lists components iterate over, and the effects
// that move money.

import type {
  Approval,
  Decision,
  DemoInboxEntry,
  DeskBusinessRequest,
  EvError,
  EvHeld,
  EvReceipt,
  EvResolved,
  KernelError,
  PaymentLinkView,
  RenderedBlock,
  SessionState,
  ToolProfile,
} from './contracts.gen';

export type * from './contracts.gen';

export type BrandPalette = NonNullable<DeskBusinessRequest['brand_palette']>;

export type ActorKind = SessionState['kind'];
export type ClauseTemplate = NonNullable<RenderedBlock['template']>;
export type ApprovalAnswer = Approval['answer'];
export type DecisionState = Decision['state'];
export type Outcome = Decision['outcome'];
export type Effect = ToolProfile['effects'][number];
export type ToolStatus = ToolProfile['status'];
export type Assurance = SessionState['assurance'];
export type SessionMode = SessionState['mode'];
export type InboxKind = DemoInboxEntry['kind'];
export type PaymentLinkState = PaymentLinkView['state'];
export type KernelErrorCode = KernelError['code'];
export type EvErrorCode = EvError['code'];

/** A typed reply card: a rendered block of kind `card` with its template. */
export type CardBlock = RenderedBlock & { kind: 'card'; template: ClauseTemplate };

/** The signed status events that become margin receipts. */
export type StatusEvent = EvReceipt | EvHeld | EvResolved;

// Each list is written as an object that `satisfies Record<Union, true>`, so a missing or an
// unknown member is a compile error; contracts.test.ts also checks each against the schema.

const clauseTemplates = {
  quote: true,
  booking_options: true,
  booking_confirmed: true,
  payment_link: true,
  document_link: true,
  hours: true,
  policy: true,
  contact: true,
  handoff: true,
  verify_prompt: true,
  owner_said: true,
  charges: true,
  refund_issued: true,
  charge_confirmed: true,
  callback_confirmed: true,
  payment_confirmed: true,
  link_cancelled: true,
} as const satisfies Record<ClauseTemplate, true>;

const decisionStates = {
  allowed: true,
  held: true,
  refused: true,
  approved: true,
  denied: true,
  expired: true,
  cancelled: true,
  executed: true,
  failed: true,
  unknown: true,
  refused_at_execution: true,
} as const satisfies Record<DecisionState, true>;

const kernelErrorCodes = {
  auth: true,
  not_found: true,
  closed: true,
  stale_generation: true,
  mode_owner: true,
  mode_paused: true,
  replayed: true,
  conflict: true,
  invalid: true,
  rate_limited: true,
  seed_unproved: true,
  internal: true,
} as const satisfies Record<KernelErrorCode, true>;

const evErrorCodes = {
  kernel_unavailable: true,
  session: true,
  rate_limited: true,
  internal: true,
} as const satisfies Record<EvErrorCode, true>;

/** Every `ClauseTemplate`, in the schema's order. */
export const CLAUSE_TEMPLATES = Object.keys(clauseTemplates) as readonly ClauseTemplate[];
/** Every `DecisionState`, in the schema's order. */
export const DECISION_STATES = Object.keys(decisionStates) as readonly DecisionState[];
/** Every `KernelError.code`, in the schema's order. */
export const KERNEL_ERROR_CODES = Object.keys(kernelErrorCodes) as readonly KernelErrorCode[];
/** Every `EvError.code` a visitor turn can end with, in the schema's order. */
export const EV_ERROR_CODES = Object.keys(evErrorCodes) as readonly EvErrorCode[];

/**
 * The effects that move money (master "Decision semantics", step 5): a request with one is a money
 * request, and an automatic rule on one takes a limit. Read as strings, so an `effect:` card's
 * target can be looked up.
 */
export const MONEY_EFFECTS: ReadonlySet<string> = new Set<Effect>(['charge', 'pay_out']);
