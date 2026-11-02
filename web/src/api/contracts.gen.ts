// Contract types, generated, do not edit.
// Source: backend/desk/contracts.schema.json. Run `npm run gen:contracts` after it changes.
// Import these from src/api/contracts.ts, the one import path for contract types.

export type AnyToolName =
  | (
      | "native.quote"
      | "native.find_slots"
      | "native.book"
      | "native.release_document"
      | "native.payment_link"
      | "native.charge_mandate"
      | "native.capture_lead"
      | "native.request_callback"
      | "native.start_verification"
      | "native.fetch_website"
      | "native.read_memory"
      | "native.web_search"
      | "payments.list_charges"
      | "payments.create_refund"
    )
  | string;
export type BusinessToolName = string;
export type SseEvent =
  | EvWriting
  | EvMessage
  | EvTurnEnd
  | EvReceipt
  | EvHeld
  | EvResolved
  | EvOwnerJoined
  | EvOwnerTyping
  | EvOwnerLeft
  | EvDemoInbox
  | EvError;
export type ToolName =
  | "native.quote"
  | "native.find_slots"
  | "native.book"
  | "native.release_document"
  | "native.payment_link"
  | "native.charge_mandate"
  | "native.capture_lead"
  | "native.request_callback"
  | "native.start_verification"
  | "native.fetch_website"
  | "native.read_memory"
  | "native.web_search"
  | "payments.list_charges"
  | "payments.create_refund";

export interface A2ARequest {
  desk_slug: string;
  session_id?: string | null;
  message: string;
  mandate?: Mandate | null;
  verify_code?: string | null;
}
export interface Mandate {
  mandate_id: string;
  issuer: string;
  agent_key_id: string;
  desk_id: string;
  on_behalf_of?: string | null;
  allowed_effects: "charge"[];
  per_charge_cents: number;
  total_cents: number;
  currency: "usd";
  expires_at: string;
  nonce: string;
  sig: string;
}
export interface A2AResponse {
  session_id: string;
  disclosure: "ai";
  blocks: RenderedBlock[];
  receipts: (EvReceipt | EvHeld | EvResolved)[];
}
export interface RenderedBlock {
  kind: "prose" | "card";
  template?:
    | (
        | "quote"
        | "booking_options"
        | "booking_confirmed"
        | "payment_link"
        | "document_link"
        | "hours"
        | "policy"
        | "contact"
        | "handoff"
        | "verify_prompt"
        | "owner_said"
        | "charges"
        | "refund_issued"
        | "charge_confirmed"
        | "callback_confirmed"
        | "payment_confirmed"
        | "link_cancelled"
      )
    | null;
  text: string;
  fact_id?: string | null;
  title?: string | null;
  lines?: string[];
  href?: string | null;
  options?: CardOption[];
}
export interface CardOption {
  option_id: string;
  label: string;
}
export interface EvReceipt {
  type: "receipt";
  decision_id: string;
  state:
    | "allowed"
    | "held"
    | "refused"
    | "approved"
    | "denied"
    | "expired"
    | "cancelled"
    | "executed"
    | "failed"
    | "unknown"
    | "refused_at_execution";
  visitor_plain: string;
  ledger_seq: number;
  signature: string;
}
export interface EvHeld {
  type: "held";
  decision_id: string;
  state:
    | "allowed"
    | "held"
    | "refused"
    | "approved"
    | "denied"
    | "expired"
    | "cancelled"
    | "executed"
    | "failed"
    | "unknown"
    | "refused_at_execution";
  visitor_plain: string;
  ledger_seq: number;
  signature: string;
}
export interface EvResolved {
  type: "resolved";
  decision_id: string;
  state:
    | "allowed"
    | "held"
    | "refused"
    | "approved"
    | "denied"
    | "expired"
    | "cancelled"
    | "executed"
    | "failed"
    | "unknown"
    | "refused_at_execution";
  visitor_plain: string;
  ledger_seq: number;
  signature: string;
}
export interface AgentAuth {
  agent_key_id: string;
  ts: string;
  nonce: string;
  sig: string;
}
export interface AnswerRequest {
  answer: "allow_once" | "deny_once" | "allow_person" | "deny_always";
}
export interface Approval {
  approval_id: string;
  decision_id: string;
  answer: "allow_once" | "deny_once" | "allow_person" | "deny_always";
  nonce: string;
  binding_sha256: string;
  policy_version: number;
  expires_at: string;
  consumed_at?: string | null;
}
export interface ApprovalResult {
  decision: Decision;
  execution: ExecResult | null;
  card_diff: RuleCard[] | null;
  approved?: Decision | null;
}
export interface Decision {
  decision_id: string;
  session_id: string;
  call_id: string;
  action: NormalizedAction | null;
  outcome: "allow" | "hold" | "refuse";
  state:
    | "allowed"
    | "held"
    | "refused"
    | "approved"
    | "denied"
    | "expired"
    | "cancelled"
    | "executed"
    | "failed"
    | "unknown"
    | "refused_at_execution";
  policy_version: number;
  policy_ids: string[];
  card_ids: string[];
  review?: Review | null;
  reason_plain: string;
  owner_plain?: string | null;
  visitor_plain: string;
  answers?: ("allow_once" | "deny_once" | "allow_person" | "deny_always")[];
  expires_at: string;
  inbox?: InboxNotice[];
  ledger_seq: number;
  signature: string;
}
export interface NormalizedAction {
  action_id: string;
  copy_id: string;
  desk_id: string;
  session_id: string;
  generation: number;
  tool:
    | (
        | "native.quote"
        | "native.find_slots"
        | "native.book"
        | "native.release_document"
        | "native.payment_link"
        | "native.charge_mandate"
        | "native.capture_lead"
        | "native.request_callback"
        | "native.start_verification"
        | "native.fetch_website"
        | "native.read_memory"
        | "native.web_search"
        | "payments.list_charges"
        | "payments.create_refund"
      )
    | string;
  effects: ("read" | "private_data" | "change" | "charge" | "pay_out" | "send_message")[];
  args_sha256: string;
  profile_sha256: string;
  resource: ResourceRef;
  list_cents: number | null;
  discount_bp: number | null;
  amount_cents: number | null;
  recipient: ("owner" | "verified_contact") | null;
  starts_at: string | null;
}
export interface ResourceRef {
  kind: "quote" | "slot" | "booking" | "document" | "charge" | "desk";
  id: string;
  owner_person_id: string | null;
}
export interface Review {
  within_charter_bp: number;
  manipulation_bp: number;
  recommendation: "allow" | "hold" | "block";
}
export interface InboxNotice {
  entry_id: string;
  to: string;
  preview: string;
}
export interface ExecResult {
  action_id: string;
  state: "succeeded" | "failed" | "unknown";
  facts: Fact[];
  model_view: Record<string, unknown>;
  inbox?: InboxNotice[];
}
export interface Fact {
  fact_id: string;
  kind:
    | "quote"
    | "booking"
    | "payment_link"
    | "document"
    | "charter"
    | "knowledge"
    | "owner_statement"
    | "charge"
    | "refund"
    | "handoff"
    | "slots";
  status: "available" | "proposed" | "committed" | "expired";
  source: "kernel" | "owner";
  claims: Claim[];
  label: Label;
  expires_at?: string | null;
}
export interface Claim {
  key: string;
  kind: "money" | "percent_bp" | "datetime" | "text" | "ref";
  value: number | string;
}
export interface Label {
  readers?: string[];
  record_owner?: string | null;
}
export interface RuleCard {
  card_id: string;
  applies_to: string;
  mode: "auto" | "ask" | "never";
  who: "anyone" | "verified" | "record_owner" | "person" | "agent";
  person_id?: string | null;
  agent_key_id?: string | null;
  max_amount_cents?: number | null;
  max_discount_bp?: number;
  hours?: HoursWindow | null;
  review?: boolean;
  is_default?: boolean;
  reason: string;
}
export interface HoursWindow {
  /**
   * @minItems 1
   */
  days: [
    "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
    ...("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[]
  ];
  start: string;
  end: string;
}
export interface BusinessSeed {
  name: string;
  owner_display_name: string;
  timezone: string;
  brand?: {
    [k: string]: string;
  };
  existing_business_id?: string | null;
}
export interface BusinessTool {
  title: string;
  description: string;
  config: IntakeConfig | TypedBookingConfig | PurposePaymentConfig | UrgentConfig;
  tool: string;
}
export interface IntakeConfig {
  block: "intake";
  /**
   * @minItems 1
   * @maxItems 5
   */
  questions:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string];
}
export interface TypedBookingConfig {
  block: "typed_booking";
  appointment_type: string;
  minutes: number;
}
export interface PurposePaymentConfig {
  block: "purpose_payment";
  purpose: string;
  amount_cents: number;
}
export interface UrgentConfig {
  block: "urgent";
  urgent_when: string;
}
export interface BusinessToolDef {
  title: string;
  description: string;
  config: IntakeConfig | TypedBookingConfig | PurposePaymentConfig | UrgentConfig;
}
export interface BusinessToolsRequest {
  /**
   * @maxItems 8
   */
  tools:
    | []
    | [BusinessTool]
    | [BusinessTool, BusinessTool]
    | [BusinessTool, BusinessTool, BusinessTool]
    | [BusinessTool, BusinessTool, BusinessTool, BusinessTool]
    | [BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool]
    | [BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool]
    | [BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool]
    | [BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool, BusinessTool];
}
export interface CalendarSlot {
  slot_id: string;
  starts_at: string;
  minutes: number;
}
export interface CancelRequest {
  session_id: string;
}
export interface CheckReplyRequest {
  draft: ReplyDraft;
  final?: boolean;
}
export interface ReplyDraft {
  session_id: string;
  generation: number;
  prose: string;
  clauses?: Clause[];
}
export interface Clause {
  template:
    | "quote"
    | "booking_options"
    | "booking_confirmed"
    | "payment_link"
    | "document_link"
    | "hours"
    | "policy"
    | "contact"
    | "handoff"
    | "verify_prompt"
    | "owner_said"
    | "charges"
    | "refund_issued"
    | "charge_confirmed"
    | "callback_confirmed"
    | "payment_confirmed"
    | "link_cancelled";
  fact_id?: string | null;
}
export interface ContextClock {
  as_of_utc: string;
  local_now: string;
  local_date: string;
  weekday: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  timezone: string;
}
export interface CopyCreated {
  copy_id: string;
  desk_ids: string[];
  owner_session: SessionState;
  owner_token: string;
  seeded_chat?: SeededChat | null;
  replayed_messages?: ReplayedEvent[];
  replay_id?: string | null;
}
export interface SessionState {
  session_id: string;
  kind: "visitor" | "agent" | "owner";
  verified: boolean;
  assurance: "none" | "demo_code" | "owner_session";
  mode: "ai" | "owner" | "paused";
  generation: number;
}
export interface SeededChat {
  session_id: string;
  visitor_line: string;
  decision: Decision;
}
export interface ReplayedEvent {
  session_id: string;
  shown_at: string;
  kind: "visitor_message" | "reply" | "receipt";
  text: string | null;
  verdict: ReplyVerdict | null;
  decision: Decision | null;
  author?: "claude" | "desk";
}
export interface ReplyVerdict {
  ok: boolean;
  language: "en" | "es";
  blocks: RenderedBlock[];
  violations: Violation[];
  message_id: string;
  generation: number;
  visitor_plain: string;
  ledger_seq: number;
  signature: string;
}
export interface Violation {
  kind:
    | "number_in_prose"
    | "promise_word"
    | "soft_promise"
    | "unknown_fact"
    | "unentitled_fact"
    | "stale_fact"
    | "canary"
    | "unsupported_language"
    | "uncertain_language"
    | "check_unavailable"
    | "session_paused";
  span: string;
  fact_ids?: string[];
  rule_id: string;
}
export interface CreateCopyRequest {
  replay_night?: boolean;
}
export interface CreateDeskRequest {
  business: BusinessSeed;
  desk: DeskSeed;
}
export interface DeskSeed {
  name: string;
  charter: Claim[];
  auto_money_cap_cents?: number;
  hours: HoursWindow[];
  price_items: PriceItem[];
  calendar_slots: CalendarSlot[];
  people: SeedPerson[];
  documents: SeedDocument[];
  notifications: NotificationDefaults;
  connections?: "mock_payments"[];
}
export interface PriceItem {
  item_id: string;
  title: string;
  unit_cents: number;
}
export interface SeedPerson {
  ref: string;
  display_name: string;
  contact: string;
  notes?: string;
}
export interface SeedDocument {
  ref: string;
  title: string;
  body: string;
  record_owner_ref?: string | null;
}
export interface NotificationDefaults {
  now: string[];
  briefing: string[];
}
export interface CreateSessionRequest {
  desk_slug: string;
  kind: "visitor" | "agent";
  mandate?: Mandate | null;
  preview?: boolean;
}
export interface DecideRequest {
  session_id: string;
  generation: number;
  call: ToolCall;
  desk_id?: string | null;
}
export interface ToolCall {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
}
export interface DemoAgentIssued {
  agent_key_id: string;
  agent_private_key_hex: string;
  mandate: Mandate;
}
export interface DemoAgentRequest {
  desk_id: string;
}
export interface DemoInboxEntry {
  entry_id: string;
  to: string;
  kind: "verification_code" | "alert" | "head_checkpoint";
  body: string;
  created_at: string;
  decision_id?: string | null;
  title?: string | null;
}
export interface DeskAnsweringRequest {
  on: boolean;
}
export interface DeskBusinessRequest {
  name: string;
  owner_display_name: string;
  timezone: string;
  brand?: {
    [k: string]: string;
  };
  brand_palette?: ("none" | "teal" | "clay" | "navy" | "forest" | "plum" | "rust" | "slate") | null;
}
export interface DeskCalendarRequest {
  calendar_slots: CalendarSlot[];
}
export interface DeskCharterRequest {
  charter: Claim[];
}
export interface DeskCreated {
  desk_id: string;
  slug: string;
}
export interface DeskHoursRequest {
  hours: HoursWindow[];
}
export interface DeskMemoryRequest {
  about: string;
  /**
   * @maxItems 20
   */
  items:
    | []
    | [MemoryItem]
    | [MemoryItem, MemoryItem]
    | [MemoryItem, MemoryItem, MemoryItem]
    | [MemoryItem, MemoryItem, MemoryItem, MemoryItem]
    | [MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem]
    | [MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem]
    | [MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem]
    | [MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem]
    | [MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem, MemoryItem]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ]
    | [
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem,
        MemoryItem
      ];
}
/**
 * An untrusted simulated owner note, shared by the write contract and memory reader.
 */
export interface MemoryItem {
  id: string;
  title: string;
  /**
   * @maxItems 10
   */
  topics:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  text: string;
}
export interface DeskNotificationsRequest {
  notifications: NotificationDefaults;
}
export interface DeskPeopleRequest {
  upsert?: PersonUpsert[];
  remove?: string[];
}
export interface PersonUpsert {
  ref: string;
  display_name: string;
  contact: string | null;
  notes?: string;
}
export interface DeskPricesRequest {
  price_items: PriceItem[];
}
export interface DeskUpdated {
  desk_id: string;
  updated_at: string;
}
export interface DocumentCreated {
  document_id: string;
}
export interface DocumentUploadRequest {
  desk_id: string;
  document: SeedDocument;
}
export interface EvDemoInbox {
  type: "demo_inbox";
  entry_id: string;
  to: string;
  preview: string;
}
export interface EvError {
  type: "error";
  code: "kernel_unavailable" | "session" | "rate_limited" | "internal";
}
export interface EvMessage {
  type: "message";
  message_id: string;
  generation: number;
  author: "claude" | "owner" | "desk";
  language: "en" | "es";
  handoff: boolean;
  blocks: RenderedBlock[];
  visitor_plain: string;
  ledger_seq: number;
  signature: string;
}
export interface EvOwnerJoined {
  type: "owner_joined";
  name: string;
}
export interface EvOwnerLeft {
  type: "owner_left";
  resuming?: boolean;
  generation?: number | null;
}
export interface EvOwnerTyping {
  type: "owner_typing";
  name: string;
  until: string;
}
export interface EvTurnEnd {
  type: "turn_end";
  generation?: number | null;
}
export interface EvWriting {
  type: "writing";
}
export interface ExecuteRequest {
  decision_id: string;
  session_id: string;
  generation?: number | null;
  approval_id?: string | null;
}
export interface Health {
  version: string;
  proof_mode: "symcc" | "bounded";
  dev_signing_key: boolean;
  public_key_hex: string;
  key_id: string;
  unproved_seeds: string[];
}
export interface KernelError {
  code:
    | "auth"
    | "not_found"
    | "closed"
    | "stale_generation"
    | "mode_owner"
    | "mode_paused"
    | "replayed"
    | "conflict"
    | "invalid"
    | "rate_limited"
    | "seed_unproved"
    | "internal";
  detail?: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[A-Za-z0-9_.:-]{1,120}$".
     */
    [k: string]: string[];
  } | null;
}
export interface KnowledgeItem {
  item_id: string;
  source: "website" | "upload" | "setup" | "memory_import" | "web_search";
  title: string;
  text: string;
  label: Label;
}
export interface KnowledgeRequest {
  desk_id: string;
  item: KnowledgeItem;
}
export interface LedgerAppendRequest {
  desk_id: string;
  event: LedgerEvent;
}
export interface LedgerEvent {
  kind:
    | "session"
    | "auth"
    | "verify"
    | "decide"
    | "review"
    | "breaker"
    | "approval"
    | "execute"
    | "payment"
    | "document_link"
    | "reply"
    | "policy"
    | "tool_pin"
    | "takeover"
    | "whisper"
    | "rate_limit"
    | "agent_auth"
    | "head_checkpoint"
    | "desk_data"
    | "web_search"
    | "business_tools";
  origin: "kernel" | "api";
  session_id?: string | null;
  ref_id?: string | null;
  summary: Record<string, unknown>;
}
export interface LedgerEntry {
  copy_id: string;
  desk_id: string;
  seq: number;
  prev_hash: string;
  created_at: string;
  event: LedgerEvent;
  hash: string;
  signature: string;
  key_id: string;
}
export interface LedgerPage {
  entries: LedgerEntry[];
  head: string;
  chain_ok: boolean;
  first_bad_seq: number | null;
  public_key_hex: string;
  key_id: string;
}
export interface LinkCancelled {
  link_id: string;
  session_id: string;
  verdict: ReplyVerdict;
}
export interface ModeRequest {
  mode: "ai" | "owner" | "paused";
  generation: number;
}
export interface OpenStatus {
  open: boolean;
  until: string | null;
  opens_at: string | null;
  text: string;
  as_of: string;
  refresh_at: string;
}
export interface OwnerMessageRequest {
  session_id: string;
  text: string;
  kind: "say" | "whisper";
}
export interface OwnerMessageResult {
  message_id: string;
  verdict: ReplyVerdict | null;
  ledger_seq: number;
}
export interface PaymentLinkActionRequest {}
export interface PaymentLinkStateResult {
  state: "issued" | "paid" | "expired" | "cancelled" | "unknown";
  session_id: string;
  verdict: ReplyVerdict | null;
}
export interface PaymentLinkView {
  title: string;
  amount_cents: number;
  state: "issued" | "paid" | "expired" | "cancelled" | "unknown";
  language: "en" | "es";
  business_name: string;
  customer_name: string | null;
  cancel_reason?: "rules_changed" | null;
}
export interface PolicyConfirmRequest {
  desk_id: string;
  version: number;
}
export interface PolicyDraftRequest {
  desk_id: string;
  cards: RuleCard[];
  expected_parent: number | null;
  auto_money_cap_cents?: number | null;
}
export interface PolicyProbeRequest {
  desk_id: string;
  probes: Probe[];
}
export interface Probe {
  actor: "visitor" | "agent" | "owner";
  who: "anyone" | "verified" | "record_owner" | "person" | "agent";
  subject_id?: string | null;
  agent_mandate_remaining_cents?: number | null;
  call: ToolCall;
  resource_kind: "quote" | "slot" | "booking" | "document" | "charge" | "desk";
  resource_owner?: "caller" | "other" | "none";
  amount_cents?: number | null;
  starts_at?: string | null;
}
export interface PolicyVersion {
  desk_id: string;
  version: number;
  parent_version: number | null;
  cards: RuleCard[];
  cedar_sha256: string;
  schema_sha256: string;
  baseline_sha256: string;
  profiles_sha256: string;
  invariants_sha256: string;
  review_thresholds_version: number;
  auto_money_cap_cents?: number;
  status: "draft" | "proved" | "rejected" | "active" | "superseded";
  proof?: ProofReport | null;
}
export interface ProofReport {
  ok: boolean;
  method: "symcc" | "bounded";
  cases?: number | null;
  timed_out?: boolean;
  checks: ProofCheck[];
}
export interface ProofCheck {
  name: string;
  ok: boolean;
  counterexample_plain?: string | null;
  counterexample_raw?: Record<string, unknown> | null;
}
export interface ProbeResult {
  probe: Probe;
  outcome: "allow" | "hold" | "refuse";
  depends_on_review: boolean;
  card_ids: string[];
  reason_plain: string;
}
export interface PublicDesk {
  business_name: string;
  desk_name: string;
  owner_display_name: string;
  brand: {
    [k: string]: string;
  };
  charter: RenderedBlock[];
  agent_card: RenderedBlock[];
  open_status?: OpenStatus | null;
  starters?: string[];
}
export interface ReviewThresholds {
  min_within_charter_bp: number;
  max_manipulation_bp: number;
}
export interface SessionContext {
  clock: ContextClock;
  tools: ToolProfile[];
  tools_declared: ToolProfile[];
  facts: Fact[];
  knowledge: KnowledgeItem[];
}
export interface ToolProfile {
  tool:
    | (
        | "native.quote"
        | "native.find_slots"
        | "native.book"
        | "native.release_document"
        | "native.payment_link"
        | "native.charge_mandate"
        | "native.capture_lead"
        | "native.request_callback"
        | "native.start_verification"
        | "native.fetch_website"
        | "native.read_memory"
        | "native.web_search"
        | "payments.list_charges"
        | "payments.create_refund"
      )
    | string;
  source: "native" | "mcp" | "business";
  effects: ("read" | "private_data" | "change" | "charge" | "pay_out" | "send_message")[];
  reversible: boolean;
  adapter: string;
  resource_kind: "quote" | "slot" | "booking" | "document" | "charge" | "desk";
  description_confirmed: string;
  input_schema: Record<string, unknown>;
  definition_sha256?: string | null;
  pending_definition_text?: string | null;
  pending_sha256?: string | null;
  status: "enabled" | "needs_review" | "disabled";
  review_reason?: ("new" | "changed" | "delisted") | null;
  business?: BusinessToolDef | null;
}
export interface SessionCreated {
  state: SessionState;
  session_token: string | null;
}
export interface ToolConfirmed {
  profiles: ToolProfile[];
  draft: PolicyVersion | null;
}
export interface ToolPin {
  tool:
    | (
        | "native.quote"
        | "native.find_slots"
        | "native.book"
        | "native.release_document"
        | "native.payment_link"
        | "native.charge_mandate"
        | "native.capture_lead"
        | "native.request_callback"
        | "native.start_verification"
        | "native.fetch_website"
        | "native.read_memory"
        | "native.web_search"
        | "payments.list_charges"
        | "payments.create_refund"
      )
    | string;
  definition_sha256: string;
}
export interface ToolsConfirmRequest {
  desk_id: string;
  /**
   * @minItems 1
   * @maxItems 22
   */
  tools: [ToolPin, ...ToolPin[]];
  enable: boolean;
}
export interface ToolsConnectRequest {
  desk_id: string;
  server: "mock_payments";
}
export interface ToolsSimulateChangeRequest {
  desk_id: string;
  tool:
    | "native.quote"
    | "native.find_slots"
    | "native.book"
    | "native.release_document"
    | "native.payment_link"
    | "native.charge_mandate"
    | "native.capture_lead"
    | "native.request_callback"
    | "native.start_verification"
    | "native.fetch_website"
    | "native.read_memory"
    | "native.web_search"
    | "payments.list_charges"
    | "payments.create_refund";
}
export interface TurnRequest {
  generation: number;
  text: string;
  desk_id?: string | null;
}
export interface TurnStarted {
  language: "en" | "es";
}
export interface VerifyCheckRequest {
  session_id: string;
  code: string;
}
export interface VerifyStartRequest {
  session_id: string;
  contact: string;
}
export interface VerifyStarted {
  message: string;
  inbox: InboxNotice[];
}
export interface WhoAmI {
  kind: "visitor" | "agent" | "owner";
  copy_id: string;
  desk_id: string | null;
  desk_ids: string[];
  session: SessionState | null;
}
