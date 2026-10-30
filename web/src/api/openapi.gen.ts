// API types, generated, do not edit.
// Source: backend/desk/api/openapi.json. Run `npm run gen:api` after it changes.
// Only the API-owned schemas are here; contract types come from src/api/contracts.ts.

import type { Decision, EvHeld, EvMessage, EvReceipt, EvResolved, Health, HoursWindow, RuleCard, SessionState } from './contracts.ts';

/**
 * `GET /api/public/desks/{slug}/agent_card`: built by code from `PUBLIC_ORIGIN` and the slug, with no model
 * text; what agents may do here, and the AI disclosure, are the kernel's `PublicDesk.agent_card`.
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
 * `retry_after` is the seconds to wait, on a 429. Fields that don't apply are left out.
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
 * An attempt the checkpoint stopped (`GET /api/owner/desks/{desk_id}/safety`): a refused decision (`ref_id` its
 * `decision_id`) or a reply of Claude's it blocked (`ref_id` the reply entry's `seq`, as text). `reason_plain` is the
 * kernel's owner text for a decision, or a line the API composes for a reply; `origin` is the ledger entry's;
 * `ledger_seq` is the entry to show it with. `triage` is AI-written, when there is one.
 */
export interface Attempt {
  ref_id: string;
  kind: "refused" | "held" | "reply_blocked";
  reason_plain: string;
  card_ids: string[];
  origin: "kernel" | "api";
  created_at: string;
  triage: string | null;
  ledger_seq: number;
}
/**
 * "Since last night": from 18:00 yesterday in the business's time zone (`since`) to now. `total` is the length of
 * the full list (`BriefingList`).
 */
export interface Briefing {
  since: string;
  conversations: number;
  bookings: number;
  leads: number;
  blocked: number;
  total: number;
  newest: BriefingNewest;
}
/**
 * The newest blocked attempt, booking, and lead or answer (the lead when both share a time); None when none.
 */
export interface BriefingNewest {
  blocked: BriefingItem | null;
  booking: BriefingItem | null;
  lead_or_answer: BriefingItem | null;
}
/**
 * One thing that happened since last night. `ref_id` is what it links to: the attempt's `ref_id` for `blocked`,
 * the decision for a booking, the `lead_id`, the session for an answer. `line` is the kernel's owner text for a
 * refusal or a booking, a lead's note (untrusted, as the visitor or Claude wrote it), else None.
 */
export interface BriefingItem {
  kind: "blocked" | "booking" | "lead" | "answer";
  at: string;
  session_id: string | null;
  display_name: string | null;
  ref_id: string;
  line: string | null;
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
  desks: DeskSummary[];
}
export interface DeskSummary {
  desk_id: string;
  slug: string;
  name: string;
  business_name: string;
  hours: HoursWindow[];
  answering: boolean;
}
/**
 * 202: the held request is withdrawn; its outcome arrives on the event stream as `resolved`.
 */
export interface CancelAccepted {
  decision_id: string;
}
/**
 * A conversation on the Desk: who it is with (`display_name` as `NeedsYouSession`'s), who has it (`mode`), when
 * anything last happened in it, how its requests stand (decisions by state), and whether it is the owner's own
 * preview.
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
 * An open callback request (`kernel_ro.handoffs`). `reason` is "<name> · <contact> · <reason>" as the visitor
 * typed them (untrusted text); `callback_window` is "<start>/<end>" in ISO 8601, or None without one.
 */
export interface Handoff {
  handoff_id: string;
  session_id: string;
  reason: string;
  callback_window: string | null;
  status: "open" | "done";
}
/**
 * `GET /api/health`: 200 with the kernel's health, or 503 with `ok` false and no kernel field.
 */
export interface HealthOut {
  ok: boolean;
  kernel: Health | null;
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
 * `GET /api/owner/desks/{desk_id}/needs_you`: a held request (`decision`, as the kernel signed it when read, which
 * applies expiry, with `held_by`, the reason of the rule card that held it, and `held_at`, when it was decided) or
 * an open callback request (`handoff`), never both; who it came from, and the last thing they wrote (untrusted).
 */
export interface NeedsYouItem {
  decision: Decision | null;
  held_by: string | null;
  held_at: string | null;
  handoff: Handoff | null;
  session: NeedsYouSession;
  from_the_visitor: string | null;
}
/**
 * Who a held request or a callback request came from. `display_name` is the verified person's, else the name
 * the session's lead gave (untrusted text), else None.
 */
export interface NeedsYouSession {
  session_id: string;
  kind: "visitor" | "agent" | "owner";
  display_name: string | null;
  verified: boolean;
  assurance: "none" | "demo_code" | "owner_session";
}
/**
 * `GET /api/owner/conversations/{session_id}?after=n`: the session's state and its transcript after the cursor, as
 * the owner sees it (agent text, whispers, translations and triage included; model, note and context rows never).
 */
export interface OwnerTranscript {
  state: SessionState;
  items: OwnerTranscriptItem[];
}
/**
 * The owner's view adds the AI-written translation and triage, which never reach a visitor.
 */
export interface OwnerTranscriptItem {
  n: number;
  kind: "visitor_text" | "agent_text" | "delivered" | "status" | "whisper";
  created_at: string;
  text: string | null;
  event: (EvMessage | EvReceipt | EvHeld | EvResolved) | null;
  owner_translation: string | null;
  triage: string | null;
}
/**
 * "Last 7 days": the seven local dates ending today, in `timezone`. Totals run from 00:00 on `start` to now;
 * `booked_cents` adds, for each booking, the newest quote of its conversation made at or before it that no earlier
 * booking took (none: 0); `handled + stepped_in == conversations`; `days` holds all seven, oldest first, the last
 * one `end`.
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
export interface WeekDay {
  date: string;
  conversations: number;
  bookings: number;
  stopped: number;
}
/**
 * `GET /api/owner/desks/{desk_id}/today`, computed from the rows on each read. `live` holds the conversations with
 * activity in the last 5 minutes.
 */
export interface Today {
  greeting_name: string;
  needs_you_count: number;
  live: ConversationSummary[];
  briefing: Briefing;
  this_week: ThisWeek;
}
/**
 * One transcript entry as the visitor sees it: their own words, or an event the API delivered.
 */
export interface TranscriptItem {
  n: number;
  kind: "visitor_text" | "agent_text" | "delivered" | "status" | "whisper";
  created_at: string;
  text: string | null;
  event: (EvMessage | EvReceipt | EvHeld | EvResolved) | null;
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
  "PUT /api/owner/desks/{desk_id}/answering": { 200: "DeskUpdated" },
  "GET /api/owner/desks/{desk_id}/today": { 200: "Today" },
  "GET /api/owner/desks/{desk_id}/briefing": { 200: "BriefingList" },
  "GET /api/owner/desks/{desk_id}/conversations": { 200: "ConversationSummary[]" },
  "GET /api/owner/conversations/{session_id}": { 200: "OwnerTranscript" },
  "GET /api/owner/desks/{desk_id}/safety": { 200: "Attempt[]" },
  "GET /api/owner/demo_inbox": { 200: "DemoInboxEntry[]" },
  "GET /api/owner/desks/{desk_id}/ledger": { 200: "LedgerPage" },
  "GET /api/owner/desks/{desk_id}/needs_you": { 200: "NeedsYouItem[]" },
  "POST /api/owner/handoffs/{handoff_id}/done": { 200: "DeskUpdated" },
  "GET /api/owner/decisions/{decision_id}": { 200: "Decision" },
  "POST /api/owner/approvals/{decision_id}/answer": { 200: "ApprovalAnswerOut" },
  "GET /api/public/{slug}": { 200: "PublicDesk" },
  "GET /api/public/desks/{slug}/agent_card": { 200: "AgentCardOut" },
  "POST /api/public/desks/{slug}/sessions": { 200: "VisitorSession" },
  "GET /api/public/desks/{slug}/session": { 200: "VisitorTranscript" },
  "POST /api/public/desks/{slug}/messages": { 202: "MessageAccepted" },
  "GET /api/public/desks/{slug}/events": { 200: null },
  "POST /api/public/desks/{slug}/decisions/{decision_id}/cancel": { 202: "CancelAccepted" },
} as const;
