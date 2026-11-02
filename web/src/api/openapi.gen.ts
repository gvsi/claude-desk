// API types, generated, do not edit.
// Source: backend/desk/api/openapi.json. Run `npm run gen:api` after it changes.
// Only the API-owned schemas are here; contract types come from src/api/contracts.ts.

import type { BusinessToolDef, Clause, Decision, EvHeld, EvMessage, EvOwnerJoined, EvOwnerLeft, EvReceipt, EvResolved, Health, HoursWindow, KnowledgeItem, PolicyVersion, Probe, ProbeResult, ProofReport, RenderedBlock, RuleCard, SeedDocument, SessionState, ToolPin, Violation } from './contracts.ts';

/**
 * An A2A error answer's body (Plan 02b, "Errors"): what went wrong, and that the answer comes from an AI.
 */
export interface A2AError {
  code: string;
  disclosure: "ai";
}
/**
 * 422 from a drafting route: a new or changed card would take or pay out more on its own than the Desk's money
 * cap, `cap_cents` (0 when unset), so nothing was drafted ("That's above your limit of $X. Raise the limit
 * first.").
 */
export interface AboveMoneyCap {
  error?: "above_money_cap";
  cap_cents: number;
}
/**
 * `GET /api/public/desks/{slug}/agent_card`: built by code from `PUBLIC_ORIGIN` and the slug, with no model
 * text; what agents may do here, one block per ability, is the kernel's `PublicDesk.agent_card`.
 */
export interface AgentCardOut {
  endpoint: string;
  signing: AgentCardSigning;
  example_request: string;
}
/**
 * How an agent signs each request: the headers it sends and the payload its Ed25519 signature covers.
 */
export interface AgentCardSigning {
  headers: string[];
  payload_fields: string[];
  canonical: "RFC 8785";
  algorithm: "Ed25519";
  encoding: "lowercase hex";
  ts_window_s: number;
}
/**
 * 202: the built-in agent is on its way; poll `GET .../send_agent/{run_id}` for its run (Plan 02b).
 */
export interface AgentRunStarted {
  run_id: string;
}
/**
 * Which words the built-in agent's tasks take on the Desk (plan 09, C2): `rivera` on the copy's own Desk, else
 * the business type setup stored for it (`other` without one). Tasks are listed in page order; the payment tasks
 * need an enabled agent payment tool. Keys, never words: the page holds every word.
 */
export interface AgentTasks {
  task_set: "rivera" | "trade" | "office" | "landlord" | "other";
  tasks: ("book_visit" | "ask_question" | "quote_and_deposit" | "push_the_limit")[];
}
/**
 * One side of an exchange in a built-in agent's run: the agent's request (`n`-th), or the Desk's answer to it,
 * with the blocks and signed statuses the kernel checked and the Desk showed the agent.
 *
 * An agent turn's `text` is the message the agent sent the Desk in that request, exactly as signed and sent (at most
 * 2,000 characters, the agent's send limit), shown to the visitor who launched it as a visitor's own message is
 * (owner decision, 2026-11-01). The agent's model writes it from a fixed task line that code picks from signed
 * templates, keyed by the Desk's setup business type, with no owner or visitor text, and the Desk's kernel-checked
 * replies alone, and the kernel doesn't check it. It is untrusted plain text, the agent's words and never the
 * Desk's: the page shows it quoted and labelled as the agent's. A Desk turn's `text` is null; the Desk's replies stay the kernel-checked
 * blocks and statuses.
 */
export interface AgentTurn {
  author: "agent" | "desk";
  n: number;
  text: string | null;
  blocks: RenderedBlock[];
  receipts: (EvReceipt | EvHeld | EvResolved)[];
}
/**
 * 409: the request was no longer waiting for an answer (answered before, expired or cancelled); `decision` is
 * how it stands now, as the kernel signed it.
 */
export interface AlreadyResolved {
  error?: "already_resolved";
  decision: Decision;
}
/**
 * `PUT /api/owner/desks/{desk_id}/answering`: the Answering switch. Off, visitors can only leave their details
 * or ask for a callback.
 */
export interface AnsweringIn {
  on: boolean;
}
/**
 * Every error answer: `error` names what went wrong; `code` is the kernel's, when `error` is "kernel";
 * `retry_after` is the seconds to wait before sending again: on a 429, and on a 409 `in_progress` that names one.
 * Fields that don't apply are left out.
 */
export interface ApiError {
  error: string;
  code?: string | null;
  retry_after?: number | null;
}
/**
 * `POST /api/owner/approvals/{decision_id}/answer`: one of the four answers to a held request.
 */
export interface ApprovalAnswerIn {
  answer: "allow_once" | "deny_once" | "allow_person" | "deny_always";
}
/**
 * The answered request as the kernel signed it, how its execution went (an allow runs inside the answer; None
 * for a denial or a request the rules no longer allow), and the rule cards an `allow_person` or `deny_always`
 * answer drafts, which the owner proves and confirms through the rules routes (Plan 02b).
 */
export interface ApprovalAnswerOut {
  decision: Decision;
  execution_state: ("succeeded" | "failed" | "unknown") | null;
  card_diff: RuleCard[] | null;
}
/**
 * A Safety entry (`GET /api/owner/desks/{desk_id}/safety`): a refused decision (`ref_id` its
 * `decision_id`) or a reply of Claude's it blocked (`ref_id` the reply entry's `seq`, as text). `reason_plain` is the
 * kernel's owner text for a decision, or a line the API composes for a reply; `origin` is the ledger entry's;
 * `ledger_seq` is the entry to show it with. `triage` is AI-written, when there is one (Plan 02b). `cause` is a
 * closed code for a refused request, from the decision's `policy_ids`, its ledger summary's `reason`/`check`
 * and the session's verified state;
 * the web holds its words. It is null for held requests, stopped drafts and unmapped refusals.
 */
export interface Attempt {
  ref_id: string;
  kind: "refused" | "held" | "reply_blocked";
  reason_plain: string;
  card_ids: string[];
  origin: "kernel" | "api";
  created_at: string;
  triage: Triage | null;
  ledger_seq: number;
  cause:
    | (
        | "owner_rule"
        | "not_verified"
        | "not_their_record"
        | "recipient"
        | "no_such_slot"
        | "unknown_item"
        | "over_quote_ceiling"
        | "quote_unpayable"
        | "no_such_charge"
        | "not_refundable"
        | "no_such_document"
        | "no_amount"
        | "tool_not_available"
        | "incomplete_request"
        | "paused"
        | "no_rules"
        | "rules_unchecked"
        | "agent_pay_out"
        | "agent_limit"
        | "other_copy"
        | "no_rule"
      )
    | null;
}
/**
 * A checkpoint event, summarized for the owner (route `triage`): what the person asked for and what the Desk
 * did, and a category for the Safety page's filters. AI-written, for the owner alone.
 */
export interface Triage {
  /**
   * One or two short, plain sentences for the owner.
   */
  summary: string;
  /**
   * The subject of the checkpoint event.
   */
  category: "prices" | "records" | "codes" | "instructions" | "limits" | "wording" | "other";
}
/**
 * "Since last night": from 18:00 yesterday in the business's time zone (`since`) to now. `answers` counts the
 * list's `answer` items, the conversations Claude answered alone; `total` is the length of the full list
 * (`BriefingList`).
 */
export interface Briefing {
  since: string;
  conversations: number;
  bookings: number;
  leads: number;
  turned_down: number;
  answers: number;
  total: number;
  newest: BriefingNewest;
}
/**
 * The newest refused request, booking, and lead or answer (the lead when both share a time); None when none.
 */
export interface BriefingNewest {
  turned_down: BriefingItem | null;
  booking: BriefingItem | null;
  lead_or_answer: BriefingItem | null;
}
/**
 * One thing that happened since last night. `ref_id` is what it links to: the refused decision for `turned_down`,
 * the decision for a booking, the `lead_id`, the session for an answer. `line` is the kernel's owner text for a
 * refusal or a booking, a lead's note (untrusted, as the visitor or Claude wrote it), else None. `cause` is required
 * and nullable: the refused request's closed cause code for `turned_down`, null for other kinds and unmapped
 * refusals. Stopped drafts stay on Safety and out of the briefing. `demo_visitor` is true for a thing in a demo
 * visitor's chat (`owner_reads.demo_visitors`), whose `display_name` is then its persona's first name when the chat
 * gave no name of its own.
 */
export interface BriefingItem {
  kind: "turned_down" | "booking" | "lead" | "answer";
  at: string;
  session_id: string | null;
  display_name: string | null;
  ref_id: string;
  line: string | null;
  cause:
    | (
        | "owner_rule"
        | "not_verified"
        | "not_their_record"
        | "recipient"
        | "no_such_slot"
        | "unknown_item"
        | "over_quote_ceiling"
        | "quote_unpayable"
        | "no_such_charge"
        | "not_refundable"
        | "no_such_document"
        | "no_amount"
        | "tool_not_available"
        | "incomplete_request"
        | "paused"
        | "no_rules"
        | "rules_unchecked"
        | "agent_pay_out"
        | "agent_limit"
        | "other_copy"
        | "no_rule"
      )
    | null;
  demo_visitor?: boolean;
}
/**
 * `GET /api/owner/desks/{desk_id}/briefing`: every item since last night, newest first.
 */
export interface BriefingList {
  since: string;
  items: BriefingItem[];
}
/**
 * `GET /api/owner/desks`: one of the copy's businesses, with its Desks (the Desk switcher).
 */
export interface BusinessOut {
  business_id: string;
  name: string;
  owner_display_name: string;
  timezone: string;
  brand: {
    [k: string]: string;
  };
  desks: DeskSummary[];
}
/**
 * One of the copy's Desks. `setup` is its setup interview while that isn't finished, so the owner can go back
 * into it; null once its setup interview went live (setup's go-live step) and for a Desk made outside setup.
 * `answering` is separate: the Answering switch can turn a Desk on before its setup finishes, and it still lists its
 * setup.
 */
export interface DeskSummary {
  desk_id: string;
  slug: string;
  name: string;
  business_name: string;
  hours: HoursWindow[];
  answering: boolean;
  setup: DeskSetup | null;
}
/**
 * A Desk's setup interview that hasn't gone live: its ID (`GET /api/owner/setup/{id}`) and the step it is at.
 * Setup finishes at its go-live step (step `live`); an interview whose rules are confirmed but that hasn't gone live
 * (`preview`) is still unfinished, since going live is setup's last step.
 */
export interface DeskSetup {
  interview_id: string;
  step: "questions" | "tools" | "rules" | "situations" | "safety_check" | "preview";
}
/**
 * 202: the held request is withdrawn; its outcome arrives on the event stream as `resolved`.
 */
export interface CancelAccepted {
  decision_id: string;
}
/**
 * How a draft's cards differ from the active version's, by `card_id`, default cards left out; `changed` pairs
 * each card before and after.
 */
export interface CardDiff {
  added: RuleCard[];
  removed: RuleCard[];
  changed: [unknown, unknown][];
}
/**
 * 422 from a drafting route: the cards named in `card_ids`, in the draft's order, would change starting a
 * verification, which is always on (codes go only to the contact on record, under the built-in rule), so nothing
 * was drafted.
 */
export interface ChangesAlwaysOn {
  error?: "changes_always_on";
  card_ids: string[];
}
/**
 * A reply of Claude's exactly as it was sent to the kernel's reply check: its prose and its clauses.
 */
export interface CheckedDraft {
  prose: string;
  clauses: Clause[];
}
export interface Choice {
  text: string;
  recommended: boolean;
}
/**
 * `POST /api/owner/policy/{desk_id}/confirm`: the drafted version the owner read and confirms.
 */
export interface ConfirmRulesIn {
  version: number;
}
export interface ConnectorProposal {
  app: "google_calendar" | "gmail" | "google_drive" | "quickbooks" | "stripe" | "square" | "calendly";
  label: string;
  /**
   * Why this helps, at most 200 characters.
   */
  why: string;
  connectable: boolean;
  connected?: boolean;
}
/**
 * A conversation on the Desk: who it is with (`display_name` as `NeedsYouSession`'s), who has it (`mode`), when
 * anything last happened in it, how its requests stand (decisions by state), and whether it is the owner's own
 * preview. `latest_visitor_text` is the newest message the visitor typed, untrusted text shown as typed, with its
 * whitespace runs collapsed to single spaces and trimmed, and cut to 199 characters and "…" when longer than 200;
 * never Claude's words. It is null for an agent's conversation, the owner's preview and a visitor who hasn't
 * written yet. `latest_outcome` is the newest decisive event, derived from stored events, never task names, prose
 * or positive counts; otherwise null. An agent's is an executed booking/mandate charge with its matching shown,
 * checked done card and executed receipt in the same turn, or a Desk-authored payment confirmation; an actual
 * refusal at decide/execution gives `turned_down`, and a later hold or handoff clears success. A visitor's (never
 * the owner's preview) comes from the kernel's decisions, payment links and handoffs alone, timed by their ledger
 * entries: an executed quote (`quoted`), booking (`visit_booked`), lead (`lead_captured`) or document release
 * (`document_sent`), a payment link paid (`deposit_paid`), a refusal at decide/execution (`turned_down`), the
 * owner declining a held request (`owner_declined`), or a call-back the owner marked done (`called_back`); a later
 * request still held, expired or cancelled, or a handoff card opening, clears it to null.
 *
 * An agent's outcome carries the facts behind it, read from the kernel's rows, never from anyone's words:
 * `latest_outcome_starts_at`, the booking's start (`visit_booked`, from the booking decision's action);
 * `latest_outcome_cents`, the amount paid (`deposit_paid`: a mandate charge's action amount, or, for a Desk-authored
 * payment confirmation, its payment link's); and `latest_outcome_cause`, why its request was refused at decide
 * (`turned_down`, the closed code `BriefingItem.cause` uses; null for a refusal at execution). Each is null when its
 * outcome isn't the newest, when the fact can't be read, and for a visitor's conversation or the owner's preview.
 *
 * `demo_visitor` is true for a demo visitor's chat (an AI the owner started to play a customer,
 * `owner_reads.demo_visitors`), listed as soon as it opens; with no verified or lead name, its `display_name` is its
 * persona's first name; and `demo_visitor_run_id` names the run that opened it, None for a mark written before
 * runs were recorded there.
 */
export interface ConversationSummary {
  session_id: string;
  kind: "visitor" | "agent" | "owner";
  display_name: string | null;
  verified: boolean;
  mode: "ai" | "owner" | "paused";
  last_activity: string;
  outcome_counts: {
    [k: string]: number;
  };
  owner_preview: boolean;
  latest_visitor_text: string | null;
  latest_outcome:
    | (
        | "visit_booked"
        | "deposit_paid"
        | "turned_down"
        | "quoted"
        | "lead_captured"
        | "owner_declined"
        | "called_back"
        | "document_sent"
      )
    | null;
  replayed?: boolean;
  latest_outcome_starts_at?: string | null;
  latest_outcome_cents?: number | null;
  latest_outcome_cause?:
    | (
        | "owner_rule"
        | "not_verified"
        | "not_their_record"
        | "recipient"
        | "no_such_slot"
        | "unknown_item"
        | "over_quote_ceiling"
        | "quote_unpayable"
        | "no_such_charge"
        | "not_refundable"
        | "no_such_document"
        | "no_amount"
        | "tool_not_available"
        | "incomplete_request"
        | "paused"
        | "no_rules"
        | "rules_unchecked"
        | "agent_pay_out"
        | "agent_limit"
        | "other_copy"
        | "no_rule"
      )
    | null;
  demo_visitor?: boolean;
  demo_visitor_run_id?: string | null;
}
/**
 * The owner's copy: what `POST /api/owner/copies`, `start_over` and `me` answer with.
 */
export interface CopyOut {
  copy_id: string;
  desks: DeskSummary[];
}
export interface CopyRequest {
  passcode: string;
}
/**
 * A card of the active rules that covers a tool: its own (`shared` false), or one on an effect the tool has, which
 * every tool with that effect shares. A default card is the compiler's ask for a tool no card for anyone covers.
 */
export interface CoveringCard {
  card_id: string;
  mode: "auto" | "ask" | "never";
  reason: string;
  shared: boolean;
}
/**
 * `GET /api/public/desks/{slug}/send_agent/{run_id}`: a built-in agent's run as its launcher's panel shows it,
 * kept in the process's memory for an hour (Plan 02b).
 */
export interface DemoAgentRun {
  run_id: string;
  launcher_session_id: string;
  slug: string;
  task: "book_visit" | "ask_question" | "quote_and_deposit" | "push_the_limit";
  state: "running" | "done" | "failed";
  turns: AgentTurn[];
}
export interface DemoVisitorIn {
  idempotency_key: string;
}
/**
 * A demo visitor's run: an AI that plays a customer in a visitor chat on the owner's own Desk
 * (`demo_visitors.py`), kept in the process's memory for an hour. `first_name` is its persona's, fixed text;
 * `session_id` is its visitor session, None until it is open; `messages_sent` counts the messages it sent the Desk;
 * `ended` says how a run that is no longer `running` ended (`done`: finished, limit or owner_silent; `stopped`:
 * stopped_by_owner or chat_ended; `failed`: budget or failed).
 */
export interface DemoVisitorRun {
  run_id: string;
  desk_id: string;
  first_name: string;
  session_id: string | null;
  state: "running" | "done" | "stopped" | "failed";
  messages_sent: number;
  ended: ("finished" | "stopped_by_owner" | "chat_ended" | "limit" | "owner_silent" | "budget" | "failed") | null;
}
/**
 * 202 from `POST /api/owner/desks/{desk_id}/demo_visitor`: the demo visitor's run and its open visitor session,
 * on `desk_id`. While one runs in the copy, starting another answers that one, so `desk_id` can be another of the
 * copy's Desks. Poll `GET /api/owner/desks/{desk_id}/demo_visitor` for how it stands.
 */
export interface DemoVisitorStarted {
  run_id: string;
  desk_id: string;
  session_id: string;
}
/**
 * `POST /api/owner/desks/{desk_id}/documents`: a document for the Desk, the owner's alone or a customer's on
 * record (`record_owner_ref`), released only through the kernel's single-use links.
 */
export interface DocumentIn {
  document: SeedDocument;
}
/**
 * `POST /api/owner/policy/{desk_id}/draft`: cards to add to the active owner cards, such as an approval's
 * `card_diff`; a card with the ID of an active one takes its place. Each card is bounded as `DraftCardsIn`'s are,
 * and so is the Desk's count of owner cards once these are added: beyond any bound, 422 `invalid`.
 */
export interface DraftAddIn {
  /**
   * @minItems 1
   * @maxItems 60
   */
  add: [RuleCard, ...RuleCard[]];
}
/**
 * `POST /api/owner/policy/{desk_id}/draft`: the owner cards as they should stand, on the version they were read
 * from (the kernel answers 409 `conflict` once another is active). At most 60 cards (default asks need not be
 * sent: the kernel adds its own), each `card_id` at most 128 characters and each `reason` at most 200, as a rules
 * chat writes them; beyond any of these, 422 `invalid`. A card the kernel drafted for one person or agent from an
 * approval keeps its reason as the kernel wrote it, however long the name it quotes.
 */
export interface DraftCardsIn {
  /**
   * @maxItems 60
   */
  cards: RuleCard[];
  expected_parent: number;
}
/**
 * `POST /api/owner/conversations/{session_id}/{takeover,handback,resume,typing}`: the session's generation as the
 * owner last read it; a change made at a generation the session has since left is refused.
 */
export interface GenerationIn {
  generation: number;
}
/**
 * A conversation handed to the owner (`kernel_ro.handoffs`), of one of two kinds:
 *
 * - `callback`: a visitor's call-back request. `reason` is "<name> · <contact> · <reason>" as the visitor typed them
 *   (untrusted text); `callback_window` is "<start>/<end>" in ISO 8601, or None without one.
 * - `card`: the handoff card the session saw (a passed reply citing it, or a blocked final draft or one no rewrite
 *   fixes). `reason` is the kernel's own template ("The Desk handed this to you."), and `callback_window` is None:
 *   no call back was promised.
 *
 * A null window alone can't tell them apart; `kind` does, and a row's kind never changes. A card handoff opens
 * none in the owner's preview, while a held request awaits the owner, or while the session has an open handoff. A
 * call-back request closes the session's open card handoff (it reads `done` from then on) and opens its own
 * `callback` row with a new ID.
 */
export interface Handoff {
  handoff_id: string;
  session_id: string;
  reason: string;
  callback_window: string | null;
  status: "open" | "done";
  kind: "callback" | "card";
}
/**
 * `GET /api/health`: 200 with the kernel's health, or 503 with `ok` false and no kernel field.
 */
export interface HealthOut {
  ok: boolean;
  kernel: Health | null;
}
export interface IntakeProposalConfig {
  block: "intake";
  /**
   * 1 to 5 intake questions, each 1 to 120 characters.
   *
   * @minItems 1
   * @maxItems 5
   *
   * Items: 1 to 120 characters.
   */
  questions:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string];
}
export interface JobProposal {
  job: "answer" | "intake" | "schedule" | "price" | "documents" | "status" | "payment" | "urgent";
  /**
   * Title, at most 60 characters.
   */
  title: string;
  /**
   * Who this is for, at most 60 characters; empty if unclear.
   */
  who?: string;
  /**
   * Why this helps, at most 200 characters.
   */
  why: string;
  /**
   * How the Desk helps, at most 300 characters.
   */
  how: string;
  autonomy: "auto" | "ask";
  can_do_today: boolean;
  config:
    (IntakeProposalConfig | TypedBookingProposalConfig | PurposePaymentProposalConfig | UrgentProposalConfig) | null;
}
export interface TypedBookingProposalConfig {
  block: "typed_booking";
  /**
   * Appointment name, 1 to 60 characters.
   */
  appointment_type: string;
  /**
   * Appointment length, 15 to 60 minutes.
   */
  minutes: number;
}
export interface PurposePaymentProposalConfig {
  block: "purpose_payment";
  /**
   * Payment purpose, 1 to 60 characters.
   */
  purpose: string;
  amount_cents: number | null;
}
export interface UrgentProposalConfig {
  block: "urgent";
  /**
   * When a request is urgent, 1 to 300 characters.
   */
  urgent_when: string;
}
/**
 * `POST /api/owner/desks/{desk_id}/knowledge`: something the owner tells Claude about the business (untrusted
 * text, never policy), owner-only (`Label(readers=["owner"])`) or public (`Label(readers=["public"])`); posting an
 * item again under its `item_id` replaces it, so marking one public is posting it with the public label.
 */
export interface KnowledgeIn {
  item: KnowledgeItem;
}
/**
 * An owner-only read of `kernel_ro.knowledge_items`. `title` and `text` are null exactly when the view
 * masks them for a kernel-forced owner-only item. `created_at` is when it was first added, null for legacy rows
 * without a timestamp. Every field is always sent.
 */
export interface KnowledgeRow {
  item_id: string;
  title: string | null;
  text: string | null;
  readers: string[];
  source: "website" | "upload" | "setup" | "memory_import" | "web_search";
  created_at: string | null;
}
/**
 * Details a visitor left: the name and note as they typed them (untrusted text, either may be missing).
 */
export interface Lead {
  lead_id: string;
  display_name: string | null;
  note: string | null;
  created_at: string;
  replayed?: boolean;
  demo_visitor?: boolean;
}
/**
 * 202: the visitor's message is stored; Claude's answer arrives on the event stream.
 */
export interface MessageAccepted {
  message_id: string;
}
export interface MessageIn {
  text: string;
}
/**
 * `POST /api/owner/policy/{desk_id}/money_cap`: the money cap to draft the active rules at, the most an auto rule
 * may take or pay out in one action without asking, in cents: from 0 (every payment asks) to the $10,000 platform
 * ceiling. Above the ceiling, 422 `above_platform_ceiling`; anything but a whole number of cents from 0, 422
 * `invalid`.
 */
export interface MoneyCapIn {
  auto_money_cap_cents: number;
}
/**
 * `GET /api/owner/desks/{desk_id}/needs_you`: a held request (`decision`, as the kernel signed it when read, which
 * applies expiry, with `held_by`, the reason of the rule card that held it, and `held_at`, when it was decided) or
 * an open handoff (`handoff`: a call-back request or the handoff card's), never both; who it came from; what they
 * wrote last (`from_the_visitor`: their previous and last messages, each a one-line glimpse of at most 200
 * characters, joined with " · "; their own untrusted words); and, on a handoff only, the conversation's newest
 * AI-written triage summary (`claude_summary`: what the person asked for and what the Desk did, for the owner alone,
 * shown as "Claude's note on what the Desk stopped: {summary}" and never quoted as the visitor's), else None. A held
 * request asks the owner for a decision, so neither it nor a handoff in a session with one awaiting the owner carries
 * AI-written text: a visitor could steer a summary to sway an approval.
 */
export interface NeedsYouItem {
  decision: Decision | null;
  held_by: string | null;
  held_at: string | null;
  handoff: Handoff | null;
  session: NeedsYouSession;
  from_the_visitor: string | null;
  claude_summary: string | null;
}
/**
 * Who a held request or a callback request came from. `display_name` is the verified person's, else the name
 * the session's lead gave (untrusted text), else a demo visitor's persona's first name, else None. `demo_visitor`
 * is true for a demo visitor's chat (`owner_reads.demo_visitors`), so Needs you never passes it off as a real
 * customer's.
 */
export interface NeedsYouSession {
  session_id: string;
  kind: "visitor" | "agent" | "owner";
  display_name: string | null;
  verified: boolean;
  assurance: "none" | "demo_code" | "owner_session";
  demo_visitor?: boolean;
}
/**
 * `POST /api/owner/conversations/{session_id}/messages`: the owner's words, said to the visitor once the owner has
 * taken the conversation over (`say`), or a private note for Claude (`whisper`).
 */
export interface OwnerMessageIn {
  text: string;
  kind: "say" | "whisper";
}
/**
 * `GET /api/owner/conversations/{session_id}?after=n`: the session's state and its transcript after the cursor, as
 * the owner sees it (agent text, whispers, translations and triage included; model, note and context rows never).
 * `typing_until` is when the visitor's typing dots stop, while the visitor is typing, else null (Plan 02b): presence,
 * kept in the API's memory and shown to the owner alone.
 */
export interface OwnerTranscript {
  state: SessionState;
  items: OwnerTranscriptItem[];
  typing_until: string | null;
  replayed?: boolean;
  demo_visitor?: boolean;
  demo_visitor_run_id?: string | null;
}
/**
 * The owner's view adds the AI-written translation and triage (Plan 02b), which never reach a visitor, and each
 * draft of Claude's the reply check stopped.
 * `owner_plain` is always present: the owner-only reason for this exact execution refusal, or null.
 *
 * `cursor` is where the item stands for `after`: its own `n`, or later once a translation or triage was written onto
 * it, when the item comes again with the same `n` (replace it) and the later cursor (advance `after` to the largest
 * one read). Items come in transcript order (`n`), each once per read.
 *
 * A `stopped_draft` item (Plan 02b) stands where the check stopped the draft, before the rewrite or the handoff that
 * followed: its `stopped_draft` holds the draft and why it was stopped, and it has no `text` or `event`. Every other
 * item's `stopped_draft` is null.
 */
export interface OwnerTranscriptItem {
  n: number;
  kind:
    | "visitor_text"
    | "agent_text"
    | "delivered"
    | "status"
    | "whisper"
    | "owner_joined"
    | "owner_left"
    | "stopped_draft";
  created_at: string;
  text: string | null;
  event: (EvMessage | EvReceipt | EvHeld | EvResolved | EvOwnerJoined | EvOwnerLeft) | null;
  cursor: number;
  owner_translation: string | null;
  triage: Triage | null;
  stopped_draft: StoppedDraft | null;
  /**
   * Owner-only execution refusal reason for this exact status, fetched with the owner's credential; never part of the stored or signed visitor event.
   */
  owner_plain: string | null;
}
/**
 * A reply of Claude's the kernel's reply check stopped (Plan 02b): the draft as the check had it, and each
 * violation the check found, with the span of the draft it matched (a canary's is "document text", never the canary),
 * the facts it concerns and the rule that matched. It is the owner's alone: no visitor read or event, no model
 * context, no reply check, no job and no log line carries it.
 */
export interface StoppedDraft {
  draft: CheckedDraft;
  violations: Violation[];
}
/**
 * 409 from the checkout's complete or cancel: the link is no longer `issued`. `state` is how it reads now and
 * `cancel_reason` why it was cancelled, `rules_changed` when a rule change cancelled it, so the checkout page can say
 * so (master plan, "Payment links").
 */
export interface PaymentConflict {
  error?: "kernel";
  code?: "conflict";
  state: "issued" | "paid" | "expired" | "cancelled" | "unknown";
  cancel_reason: "rules_changed" | null;
}
/**
 * `GET /api/owner/desks/{desk_id}/people`: the people on record, in the order they were added, and the leads,
 * newest first.
 */
export interface PeopleOut {
  people: PersonOnRecord[];
  leads: Lead[];
}
/**
 * Someone on record on the Desk. Verification codes go only to their contact, which leaves the kernel masked.
 */
export interface PersonOnRecord {
  person_id: string;
  display_name: string;
  masked_contact: string;
}
/**
 * `POST /api/owner/policy/{desk_id}/preset`: "Ask me first for everything" (`ask_first`) or "Recommended rules"
 * (`auto`).
 */
export interface PresetIn {
  preset: "ask_first" | "auto";
}
export interface ProposalCard {
  proposal_id: string;
  kind: "job" | "connector";
  state: "proposed" | "accepted" | "declined" | "changed";
  superseded_by?: string | null;
  job: JobProposal | null;
  connector: ConnectorProposal | null;
}
/**
 * 202: the rules are still being drafted or checked. Send `retry` again in a few seconds: it picks up the same
 * work, or its answer once done.
 */
export interface ProvingPending {
  retry: ProvingRetry;
}
/**
 * The request to send again, unchanged: its path and its JSON body (None when it has none).
 */
export interface ProvingRetry {
  path: string;
  body: Record<string, unknown> | null;
}
/**
 * Which of Today's sections count recorded history: the night the kernel replayed into the copy when it was made
 * (Plan 01d), which the owner's screens label "Includes recorded history". A replay holds only finished things, so
 * `needs_you` stays false; it keeps the shape the web reads.
 */
export interface RecordedHistory {
  needs_you: boolean;
  briefing: boolean;
  this_week: boolean;
}
/**
 * `GET /api/owner/desks/{desk_id}/reports?days=n`: the last `n` local dates in the business's time zone, today
 * included, counted as Today's "Last 7 days" is. `bookings` are the bookings made; `paid_cents` the money paid,
 * through payment links and agents' spending limits; `handled_by_claude` and `needed_you` split the conversations
 * into those Claude handled alone and those the owner stepped into. `recorded_history` is true when any of these
 * counts includes the night the kernel replayed into the copy (as `RecordedHistory` is for Today).
 */
export interface Reports {
  bookings: number;
  paid_cents: number;
  handled_by_claude: number;
  needed_you: number;
  recorded_history: boolean;
}
/**
 * `POST /api/owner/policy/{desk_id}/chat`: what the owner asks Claude about the rules, in their own words.
 */
export interface RuleChatIn {
  text: string;
}
/**
 * Claude's reply to the owner (AI-written, owner-facing) and, when they asked for a change, the draft the kernel
 * compiled and proved; None for a question, with nothing drafted.
 */
export interface RuleChatOut {
  answer: string;
  draft: RulesDraft | null;
}
/**
 * A rules version the kernel compiled and proved, for the owner to read and confirm: its owner cards (default
 * asks left out), how they differ from the active version's (None in setup), the money cap its money cards are held
 * to, the kernel's proof, and a summary.
 */
export interface RulesDraft {
  version: number;
  cards: RuleCard[];
  diff: CardDiff | null;
  auto_money_cap_cents: number;
  proof: ProofReport;
  summary: RulesSummary;
}
/**
 * A draft's cards in the owner's words: each card's reason, by what it does (once each).
 */
export interface RulesSummary {
  on_its_own: string[];
  asks_you: string[];
  never: string[];
}
/**
 * 409 from a confirm: the rules changed after the draft was made, so the same cards were drafted again on the
 * rules now in force, and `draft` is the new version to read and confirm.
 */
export interface RulesChanged {
  error?: "rules_changed_since_draft";
  draft: RulesDraft;
}
/**
 * `GET /api/owner/desks/{desk_id}/rules`: the active rules version, each tool of the Desk with the cards that
 * cover it, and the preset the active owner cards are, if they are exactly one (else None: there is no "custom"
 * state).
 */
export interface RulesView {
  active: PolicyVersion;
  tools: ToolRow[];
  preset: ("ask_first" | "auto") | null;
}
/**
 * A tool of the Desk as the kernel lists it (`kernel_ro.tools`): its effects, whether it can be undone, its
 * status (`needs_review` until the owner confirms a connected tool), the description Claude sees and, for a
 * connected tool, the hash of the definition it is pinned to and a changed definition waiting for review; and the
 * active rules' cards that cover it, default asks included, in card order (Plan 02b, Task 9).
 */
export interface ToolRow {
  tool: string;
  source: "native" | "mcp" | "business";
  effects: string[];
  reversible: boolean;
  status: "enabled" | "needs_review" | "disabled";
  description_confirmed: string;
  definition_sha256: string | null;
  pending_definition_text: string | null;
  pending_sha256: string | null;
  cards: CoveringCard[];
  business?: BusinessToolDef | null;
  review_reason?: ("new" | "changed" | "delisted") | null;
}
/**
 * `POST /api/owner/policy/setup/{id}/safety_check`: what a bad actor would try against the drafted rules,
 * run nowhere. `total` counts the rows tried (one lacking a stand-in price is left out), `blocked` those stopped, and
 * `seconds` how long the kernel took.
 */
export interface SafetyCheck {
  rows: SafetyRow[];
  blocked: number;
  total: number;
  seconds: number;
}
/**
 * One thing a bad actor would try (`label`, and `tries`, what they'd say), the kernel's verdict on it against
 * the drafted rules (its outcome and `reason_plain`, shown verbatim), and whether it was stopped: refused, or held
 * for the owner where that stops it, and never when it depends on the reviewer agreeing.
 */
export interface SafetyRow {
  label: string;
  tries: string;
  result: ProbeResult;
  blocked: boolean;
}
export interface SendAgentIn {
  task: "book_visit" | "ask_question" | "quote_and_deposit" | "push_the_limit";
  idempotency_key: string;
}
/**
 * `POST /api/owner/setup/{id}/answer`: the owner's text and exactly one waiting question or card id.
 * Naming the ask prevents a repeated answer from answering the next one.
 */
export interface SetupAnswerIn {
  question?:
    | (
        | "what_you_do"
        | "hours_and_area"
        | "quote_limit"
        | "discounts"
        | "documents_and_payments"
        | "money_limit"
        | "contact_and_after_hours"
        | "test_client"
      )
    | null;
  card?: string | null;
  text: string;
}
/**
 * `POST /api/owner/setup/{id}/consent`: whether Claude may read the owner's Claude memory and website.
 */
export interface SetupConsentIn {
  allow: boolean;
}
/**
 * One line of the setup conversation, owner-facing: Claude's, the owner's, or an inline label for a read of the
 * owner's memory or website (`tool_label`). Choices belong only to a Claude question with choices; a card belongs
 * only to a card message, with role `claude` and empty text. `owner_decided` marks a card the owner decided
 * themselves, by a click or a typed answer; a card setup settled for them (as "Use your suggestions" does) stays
 * false. Read-only: it only says what happened.
 */
export interface SetupMessage {
  role: "claude" | "owner" | "tool_label";
  text: string;
  choices?: Choice[];
  card?: ProposalCard | null;
  owner_decided?: boolean;
}
/**
 * The owner's decision on a setup proposal, with optional changes when accepting it.
 */
export interface SetupProposalIn {
  accept: boolean;
  title?: string | null;
  amount_cents?: number | null;
  autonomy?: ("auto" | "ask") | null;
}
export interface SetupPublicHours {
  source: "owner" | "suggested";
  windows: HoursWindow[];
}
/**
 * A nonblank setup charter line and whether the owner has confirmed its text. `held` marks a line the kernel's
 * public-text checks held back (the setup state's `held_policy_keys`, the contact included): its stored words stay
 * off the charter until the owner rewords it.
 */
export interface SetupPublicLine {
  key: string;
  text: string;
  source: "owner" | "suggested";
  editable: boolean;
  held: boolean;
}
export interface SetupPublicLineError {
  error: "line_refused" | "not_editable" | "not_suggested";
  key?: string | null;
  reason?: string[] | null;
}
export interface SetupPublicLineIn {
  key: string;
  text: string;
}
export interface SetupPublicLines {
  revision: string;
  lines: SetupPublicLine[];
  hours: SetupPublicHours | null;
  prices: SetupPublicPrices | null;
}
export interface SetupPublicPrices {
  source: "owner" | "suggested";
  items: SetupPublicPriceItem[];
}
export interface SetupPublicPriceItem {
  item_id: string;
  title: string;
  unit_cents: number;
}
export interface SetupPublicLinesConfirmIn {
  /**
   * @minItems 1
   */
  keys: [string, ...string[]];
  revision: string;
}
/**
 * `POST /api/owner/setup/{id}/reopen`: "Change something", the owner's message to Claude from a step after the
 * questions, which takes setup back to its chat. The `idempotency_key`, one per send and required (422 without one),
 * makes a repeat answer the interview as the first left it instead of sending the message twice.
 */
export interface SetupReopenIn {
  text: string;
  idempotency_key: string;
}
/**
 * `POST /api/owner/setup`: the owner's own words about the business, the business's time zone (an IANA name)
 * and, if they give it, the name customers should see for them, which wins over one taken from the words. A name
 * the owner types is used as typed (extra spaces aside), so it must fit the kernel's owner name pattern (letters,
 * spaces, apostrophes and hyphens, up to 40), else 422 before Claude is asked. The `idempotency_key`, one per click
 * and required (422 without one), makes a repeat answer the interview the first made instead of making another.
 */
export interface SetupStartIn {
  description: string;
  timezone: string;
  owner_display_name?: string | null;
  idempotency_key: string;
}
/**
 * A setup interview as it stands: its Desk, made at the start with Answering off, the step it is at, whether the
 * owner let Claude read their memory and website (None until asked), the question waiting for an answer (None
 * before consent, while busy and after the last one; `test_client` while the test-client offer at the plan's end
 * waits), whether an owner turn is pending (`busy`), and the conversation so far. Its messages start at Claude's
 * consent question: the owner's opening description isn't shown back to them.
 */
export interface SetupState {
  interview_id: string;
  desk_id: string;
  slug: string;
  step: "questions" | "tools" | "rules" | "situations" | "safety_check" | "preview" | "live";
  consent: boolean | null;
  question:
    | (
        | "what_you_do"
        | "hours_and_area"
        | "quote_limit"
        | "discounts"
        | "documents_and_payments"
        | "money_limit"
        | "contact_and_after_hours"
        | "test_client"
      )
    | null;
  pending_card?: string | null;
  busy?: boolean;
  /**
   * Charter claim keys, such as a policy line or the public contact, withheld by the kernel's public-text checks; empty when nothing was held at the latest charter write.
   */
  held_policy_keys: string[];
  messages: SetupMessage[];
}
/**
 * Finish setup questions with the current suggestions; no additional answers are supplied.
 */
export interface SetupSuggestionsIn {}
/**
 * `GET /api/owner/setup/{id}/tools`: the new Desk's tools, and the connection it can still add (the
 * mock payments server, until it is connected).
 */
export interface SetupTools {
  tools: ToolRow[];
  connectable: "mock_payments"[];
}
/**
 * `POST /api/owner/desks/{desk_id}/tools/simulate_change`: the connected tool whose definition the demo changes.
 */
export interface SimulateChangeIn {
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
/**
 * A situation Claude wrote to try against the drafted rules: who brings it, the probe code built for it (a
 * hypothetical caller and request, run nowhere) and what the owner's answers say should happen.
 */
export interface Situation {
  title: string;
  who: "public" | "verified" | "agent" | "after_hours";
  probe: Probe;
  expected: "allow" | "allow_if_reviewed" | "hold" | "refuse";
}
/**
 * What the drafted rules do with a situation (`result`, the kernel's), and whether that matches what was
 * planned: a plan of `allow_if_reviewed` matches a result that depends on the reviewer, decided by an auto rule
 * with `review`; any other plan matches the same outcome when it doesn't depend on the reviewer.
 */
export interface SituationResult {
  situation: Situation;
  result: ProbeResult;
  matches: boolean;
}
/**
 * A rule the owner's own approvals suggest: they approved `count` requests of `tool` in the last 30 days and no
 * auto card covers it, so `card` would let Claude handle them. `text` is the owner-facing line; on a money tool the
 * card allows no more than the largest amount approved, and never more than the money cap.
 */
export interface Suggestion {
  tool: string;
  count: number;
  text: string;
  card: RuleCard;
}
/**
 * "Last 7 days": the seven local dates ending today, in `timezone`. Totals run from 00:00 on `start` to now;
 * `booked_cents` adds, for each booking, the newest quote of its conversation made at or before it that no earlier
 * booking took (none: 0); `handled + stepped_in == conversations`; `days` holds all seven, oldest first, the last
 * one `end`. `stopped` counts refused requests from visitors and agents (owner decision, 2026-10-31).
 * Safety lists Claude's stopped drafts too, without counting them; the briefing omits them.
 */
export interface ThisWeek {
  timezone: string;
  start: string;
  end: string;
  bookings: number;
  booked_cents: number;
  conversations: number;
  handled: number;
  stepped_in: number;
  stopped: number;
  days: WeekDay[];
}
/**
 * One date of "Last 7 days", counted as `ThisWeek` counts: `stopped` counts refused requests that day
 * (owner decision, 2026-10-31). Claude's stopped drafts are listed on Safety but not counted.
 */
export interface WeekDay {
  date: string;
  conversations: number;
  bookings: number;
  stopped: number;
}
/**
 * `GET /api/owner/desks/{desk_id}/today`, computed from the rows on each read. `live` holds the conversations with
 * activity in the last 5 minutes; `recorded_history` says which sections count replayed rows.
 */
export interface Today {
  greeting_name: string;
  needs_you_count: number;
  live: ConversationSummary[];
  briefing: Briefing;
  this_week: ThisWeek;
  recorded_history: RecordedHistory;
}
/**
 * One decision on a tool, as its page lists it: whose session asked (`display_name` as `NeedsYouSession`'s,
 * untrusted when a visitor typed it), the outcome and where the request stands, the kernel's owner text, when it was
 * decided and its ledger entry. `replayed` is true for a decision from the night the kernel replayed into the copy
 * (recorded history), and for one whose ledger entry can't be read, which is never shown as live.
 */
export interface ToolDecisionRow {
  decision_id: string;
  session_id: string;
  display_name: string | null;
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
  reason_plain: string;
  /**
   * Owner-only kernel reason for an execution refusal, fetched with the owner's credential; null otherwise.
   */
  owner_plain: string | null;
  created_at: string;
  ledger_seq: number;
  replayed: boolean;
}
/**
 * `GET /api/owner/desks/{desk_id}/tools/{tool}/decisions`: a page of the tool's decisions on the Desk, newest
 * first; `next_before` is the cursor for the next page, None on the last.
 */
export interface ToolDecisions {
  items: ToolDecisionRow[];
  next_before: string | null;
}
/**
 * The shared batch review body; the checked Desk ID comes from the route.
 */
export interface ToolsConfirmIn {
  /**
   * @minItems 1
   * @maxItems 22
   */
  tools: [ToolPin, ...ToolPin[]];
  enable: boolean;
}
/**
 * One transcript entry as the visitor sees it: their own words, or an event the API delivered or emitted.
 *
 * `owner_joined` and `owner_left` (Plan 02b) are where the owner took the conversation over and handed it back, each
 * with the event the visitor's stream got then (`EvOwnerJoined` names the owner as the kernel had them), at that
 * moment; a resume after a breaker pause has none. A client that doesn't know a kind skips the item.
 */
export interface TranscriptItem {
  n: number;
  kind: "visitor_text" | "agent_text" | "delivered" | "status" | "whisper" | "owner_joined" | "owner_left";
  created_at: string;
  text: string | null;
  event: (EvMessage | EvReceipt | EvHeld | EvResolved | EvOwnerJoined | EvOwnerLeft) | null;
}
export interface VerifyCheckIn {
  code: string;
}
/**
 * `POST /api/public/desks/{slug}/verify/check`: the session as the kernel has it once the code was right, verified
 * as the contact on record (assurance `demo_code`).
 */
export interface VerifyChecked {
  state: SessionState;
}
export interface VerifyStartIn {
  contact: string;
}
/**
 * `POST /api/public/desks/{slug}/sessions`: the session the visitor cookie now holds, and whether it is the one
 * the cookie already held (a returning visitor) or a new one.
 */
export interface VisitorSession {
  state: SessionState;
  resumed: boolean;
}
/**
 * `GET /api/public/desks/{slug}/session`: the session's state, its transcript as the visitor sees it, and the
 * highest event `seq` read in the same snapshot, which the event stream continues after.
 */
export interface VisitorTranscript {
  state: SessionState;
  items: TranscriptItem[];
  last_seq: number;
}
/**
 * The Desk answers the public now, at `public_url`.
 */
export interface WentLive {
  public_url: string;
  slug: string;
}

/**
 * Every operation the API serves, as "METHOD /path", with the schema each 2xx answer carries by
 * status code: `Name[]` for a list, null for an answer with no JSON body. routes.typecheck.ts
 * checks the route table against it.
 */
export const API_OPERATIONS = {
  "GET /api/health": { 200: "HealthOut" },
  "POST /api/owner/copies": { 201: "CopyOut" },
  "POST /api/owner/start_over": { 200: "CopyOut" },
  "GET /api/owner/me": { 200: "CopyOut" },
  "GET /api/owner/desks": { 200: "BusinessOut[]" },
  "POST /api/owner/desks": { 201: "DeskCreated" },
  "DELETE /api/owner/desks/{desk_id}": { 204: null },
  "PUT /api/owner/desks/{desk_id}/answering": { 200: "DeskUpdated" },
  "PUT /api/owner/desks/{desk_id}/business": { 200: "DeskUpdated" },
  "PUT /api/owner/desks/{desk_id}/charter": { 200: "DeskUpdated" },
  "PUT /api/owner/desks/{desk_id}/hours": { 200: "DeskUpdated" },
  "PUT /api/owner/desks/{desk_id}/prices": { 200: "DeskUpdated" },
  "PUT /api/owner/desks/{desk_id}/calendar": { 200: "DeskUpdated" },
  "PUT /api/owner/desks/{desk_id}/people": { 200: "DeskUpdated" },
  "GET /api/owner/desks/{desk_id}/people": { 200: "PeopleOut" },
  "PUT /api/owner/desks/{desk_id}/notifications": { 200: "DeskUpdated" },
  "POST /api/owner/desks/{desk_id}/preview_session": { 200: "VisitorSession" },
  "GET /api/owner/desks/{desk_id}/today": { 200: "Today" },
  "GET /api/owner/desks/{desk_id}/briefing": { 200: "BriefingList" },
  "GET /api/owner/desks/{desk_id}/reports": { 200: "Reports" },
  "GET /api/owner/desks/{desk_id}/conversations": { 200: "ConversationSummary[]" },
  "GET /api/owner/conversations/{session_id}": { 200: "OwnerTranscript" },
  "GET /api/owner/desks/{desk_id}/safety": { 200: "Attempt[]" },
  "GET /api/owner/demo_inbox": { 200: "DemoInboxEntry[]" },
  "GET /api/owner/desks/{desk_id}/ledger": { 200: "LedgerPage" },
  "GET /api/owner/desks/{desk_id}/needs_you": { 200: "NeedsYouItem[]" },
  "POST /api/owner/handoffs/{handoff_id}/done": { 200: "DeskUpdated" },
  "GET /api/owner/decisions/{decision_id}": { 200: "Decision" },
  "POST /api/owner/approvals/{decision_id}/answer": { 200: "ApprovalAnswerOut" },
  "POST /api/owner/conversations/{session_id}/takeover": { 200: "SessionState" },
  "POST /api/owner/conversations/{session_id}/handback": { 200: "SessionState" },
  "POST /api/owner/conversations/{session_id}/resume": { 200: "SessionState" },
  "POST /api/owner/conversations/{session_id}/messages": { 200: "OwnerMessageResult" },
  "POST /api/owner/conversations/{session_id}/typing": { 204: null },
  "POST /api/owner/desks/{desk_id}/demo_visitor": { 202: "DemoVisitorStarted" },
  "GET /api/owner/desks/{desk_id}/demo_visitor": { 200: "DemoVisitorRun" },
  "GET /api/owner/desks/{desk_id}/demo_visitor/{run_id}": { 200: "DemoVisitorRun" },
  "POST /api/owner/desks/{desk_id}/demo_visitor/{run_id}/stop": { 200: "DemoVisitorRun" },
  "POST /api/owner/setup": { 201: "SetupState" },
  "GET /api/owner/setup/{id}": { 200: "SetupState" },
  "GET /api/owner/setup/{id}/events": { 200: null },
  "POST /api/owner/setup/{id}/consent": { 200: "SetupState", 202: "SetupState" },
  "POST /api/owner/setup/{id}/answer": { 200: "SetupState", 202: "SetupState" },
  "POST /api/owner/setup/{id}/proposals/{proposal_id}": { 200: "SetupState", 202: "SetupState" },
  "POST /api/owner/setup/{id}/reopen": { 200: "SetupState", 202: "SetupState" },
  "POST /api/owner/setup/{id}/suggestions": { 200: "SetupState", 202: "SetupState" },
  "GET /api/owner/setup/{id}/tools": { 200: "SetupTools" },
  "POST /api/owner/setup/{id}/tools/connect": { 200: "ToolRow[]" },
  "GET /api/owner/setup/{id}/public_lines": { 200: "SetupPublicLines" },
  "PUT /api/owner/setup/{id}/public_lines": { 200: "SetupPublicLines" },
  "POST /api/owner/setup/{id}/public_lines/confirm": { 200: "SetupPublicLines" },
  "DELETE /api/owner/setup/{id}/public_lines/{key}": { 200: "SetupPublicLines" },
  "DELETE /api/owner/setup/{id}/public_lines/prices/{item_id}": { 200: "SetupPublicLines" },
  "GET /api/public/{slug}": { 200: "PublicDesk" },
  "GET /api/public/desks/{slug}/agent_card": { 200: "AgentCardOut" },
  "POST /api/public/desks/{slug}/sessions": { 200: "VisitorSession" },
  "GET /api/public/desks/{slug}/session": { 200: "VisitorTranscript" },
  "POST /api/public/desks/{slug}/messages": { 202: "MessageAccepted" },
  "POST /api/public/desks/{slug}/typing": { 204: null },
  "GET /api/public/desks/{slug}/events": { 200: null },
  "POST /api/public/desks/{slug}/decisions/{decision_id}/cancel": { 202: "CancelAccepted" },
  "POST /api/public/desks/{slug}/verify/start": { 200: "VerifyStarted" },
  "POST /api/public/desks/{slug}/verify/check": { 200: "VerifyChecked" },
  "GET /api/public/desks/{slug}/demo_inbox": { 200: "DemoInboxEntry[]" },
  "POST /api/public/desks/{slug}/agents/key": { 200: "DemoAgentIssued" },
  "GET /api/public/desks/{slug}/agent_tasks": { 200: "AgentTasks" },
  "POST /api/public/desks/{slug}/send_agent": { 202: "AgentRunStarted" },
  "GET /api/public/desks/{slug}/send_agent/{run_id}": { 200: "DemoAgentRun" },
  "GET /api/d/{token}": { 200: null },
  "GET /api/pay/{token}": { 200: "PaymentLinkView" },
  "POST /api/pay/{token}/complete": { 200: "PaymentLinkStateResult" },
  "POST /api/pay/{token}/cancel": { 200: "PaymentLinkStateResult" },
  "POST /api/a2a/{slug}": { 200: "A2AResponse" },
  "POST /api/owner/policy/setup/{id}/rules": { 200: "RulesDraft", 202: "ProvingPending" },
  "POST /api/owner/policy/setup/{id}/situations": { 200: "SituationResult[]", 202: "ProvingPending" },
  "POST /api/owner/policy/setup/{id}/safety_check": { 200: "SafetyCheck", 202: "ProvingPending" },
  "POST /api/owner/policy/setup/{id}/confirm": { 200: "PolicyVersion", 202: "ProvingPending" },
  "POST /api/owner/policy/setup/{id}/go_live": { 200: "WentLive", 202: "ProvingPending" },
  "GET /api/owner/desks/{desk_id}/rules": { 200: "RulesView" },
  "GET /api/owner/desks/{desk_id}/rules/drafts/{version}": { 200: "RulesDraft" },
  "GET /api/owner/desks/{desk_id}/suggestions": { 200: "Suggestion[]" },
  "GET /api/owner/desks/{desk_id}/tools/{tool}/decisions": { 200: "ToolDecisions" },
  "POST /api/owner/desks/{desk_id}/tools/connect": { 200: "ToolRow[]" },
  "POST /api/owner/desks/{desk_id}/tools/simulate_change": { 200: "ToolProfile" },
  "GET /api/owner/desks/{desk_id}/knowledge": { 200: "KnowledgeRow[]" },
  "POST /api/owner/desks/{desk_id}/knowledge": { 200: "KnowledgeItem" },
  "POST /api/owner/desks/{desk_id}/documents": { 201: "DocumentCreated" },
  "POST /api/owner/policy/{desk_id}/chat": { 200: "RuleChatOut", 202: "ProvingPending" },
  "POST /api/owner/policy/{desk_id}/draft": { 200: "RulesDraft", 202: "ProvingPending" },
  "POST /api/owner/policy/{desk_id}/preset": { 200: "RulesDraft", 202: "ProvingPending" },
  "POST /api/owner/policy/{desk_id}/suggestions/{tool}": { 200: "RulesDraft", 202: "ProvingPending" },
  "POST /api/owner/policy/{desk_id}/money_cap": { 200: "RulesDraft", 202: "ProvingPending" },
  "POST /api/owner/policy/{desk_id}/tools/confirm": { 200: "ToolConfirmed", 202: "ProvingPending" },
  "POST /api/owner/policy/{desk_id}/confirm": { 200: "PolicyVersion", 202: "ProvingPending" },
} as const;
