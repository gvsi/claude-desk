/**
 * The API's read models and request bodies (Plan 02's "Read models" table, by its names), typed by
 * hand until the generated client replaces them. Kernel shapes come from contracts.ts. Request
 * bodies carry no copy, session or Desk ID: the API takes identity from its cookies.
 *
 * Text a visitor typed (`TranscriptItem.text`, `display_name`, `Handoff.reason`,
 * `from_the_visitor`) is untrusted and renders as text only.
 */
import type {
  ActorKind,
  ApprovalAnswer,
  Assurance,
  Decision,
  DecisionState,
  EvHeld,
  EvMessage,
  EvOwnerJoined,
  EvOwnerLeft,
  EvReceipt,
  EvResolved,
  ExecResult,
  Health,
  HoursWindow,
  KnowledgeItem,
  Outcome,
  PaymentLinkView,
  PolicyVersion,
  Probe,
  ProbeResult,
  ProofReport,
  RenderedBlock,
  RuleCard,
  SessionMode,
  SessionState,
  ToolConfirmed,
  ToolName,
  ToolProfile,
} from './contracts.ts';

// Copy and Desks

export interface DeskSummary {
  desk_id: string;
  slug: string;
  name: string;
  business_name: string;
  hours: HoursWindow[];
  answering: boolean;
}

/** The demo copy this browser's owner cookie names (copies, `me`, `start_over`). */
export interface CopyOut {
  copy_id: string;
  desks: DeskSummary[];
}

export interface BusinessOut {
  business_id: string;
  name: string;
  owner_display_name: string;
  /** IANA time zone; owner times are formatted in it. */
  timezone: string;
  desks: DeskSummary[];
}

// Today

export interface ConversationSummary {
  session_id: string;
  kind: ActorKind;
  /** The verified person's name, else the session's lead's, else null. Untrusted. */
  display_name: string | null;
  verified: boolean;
  mode: SessionMode;
  last_activity: string;
  outcome_counts: Partial<Record<DecisionState, number>>;
  /** The owner's own preview chat (`kernel_ro.sessions.preview`, a boolean). */
  owner_preview: boolean;
  /** Replayed from the recorded history into this copy (plan 02b); absent is false. */
  replayed?: boolean;
}

export type BriefingKind = 'blocked' | 'booking' | 'lead' | 'answer';

/** One thing that happened since last night, as the API core's briefing lists it. */
export interface BriefingItem {
  kind: BriefingKind;
  /** When it happened (a replayed row's recorded time). */
  at: string;
  /** The conversation it happened in, or null. */
  session_id: string | null;
  /** As `ConversationSummary.display_name`. Untrusted. */
  display_name: string | null;
  /** The `Attempt.ref_id` for `blocked`; the decision for a booking; the `lead_id`; the session for an answer. */
  ref_id: string;
  /**
   * A refusal's or a booking's `reason_plain` (the kernel's owner text); a lead's note (untrusted, and
   * it may hold the contact as typed); null for a blocked reply and for an answer.
   */
  line: string | null;
}

/** "Since last night": from 18:00 yesterday in the business's time zone, to now. */
export interface Briefing {
  /** The window's start, 18:00 yesterday, local. */
  since: string;
  conversations: number;
  bookings: number;
  leads: number;
  blocked: number;
  /** The full list's length (`BriefingList.items`). */
  total: number;
  newest: {
    blocked: BriefingItem | null;
    booking: BriefingItem | null;
    /** The newer of the newest lead and the newest answer. */
    lead_or_answer: BriefingItem | null;
  };
}

/** `GET …/briefing`: every item since last night, newest first. */
export interface BriefingList {
  since: string;
  items: BriefingItem[];
}

/** One local date of the last seven. */
export interface ThisWeekDay {
  /** Local `YYYY-MM-DD`. */
  date: string;
  conversations: number;
  bookings: number;
  stopped: number;
}

/**
 * "Last 7 days": the seven local dates in the business's time zone ending today, today included,
 * totals from the first of them at 00:00 to now. `handled + stepped_in = conversations`.
 */
export interface ThisWeek {
  timezone: string;
  /** Six days before `end`, local `YYYY-MM-DD`. */
  start: string;
  /** Today, local `YYYY-MM-DD`. */
  end: string;
  bookings: number;
  /** Absent (never 0) until the API core's second pass sends it. */
  booked_cents?: number;
  conversations: number;
  handled: number;
  stepped_in: number;
  stopped: number;
  /** Always seven, oldest first, ending with `end`. */
  days: ThisWeekDay[];
}

/** Which of Today's figures count replayed history (from plan 02b); a missing object or key is false. */
export interface RecordedHistory {
  needs_you?: boolean;
  briefing?: boolean;
  this_week?: boolean;
}

export interface Today {
  /** The first word of the owner's display name. */
  greeting_name: string;
  needs_you_count: number;
  /** Conversations with activity in the last 5 minutes. */
  live: ConversationSummary[];
  briefing: Briefing;
  this_week: ThisWeek;
  /** Optional until plan 02b sends it. */
  recorded_history?: RecordedHistory;
}

export interface Reports {
  bookings: number;
  paid_cents: number;
  handled_by_claude: number;
  needed_you: number;
}

export interface Handoff {
  handoff_id: string;
  session_id: string;
  /** `<name> · <contact> · <reason>` as the visitor typed them. Untrusted. */
  reason: string;
  /** `<start>/<end>`, or null when the visitor named no open hour. */
  callback_window: string | null;
  status: string;
}

export interface NeedsYouSession {
  session_id: string;
  kind: ActorKind;
  display_name: string | null;
  verified: boolean;
  assurance: Assurance;
}

interface NeedsYouBase {
  session: NeedsYouSession;
  /** The last thing the visitor wrote, labelled. Untrusted. */
  from_the_visitor: string | null;
}

/**
 * One held request or one open callback that waits for the owner. The API sends every field, the
 * other alternative's as null (openapi.json), so code tells them apart with `!= null`.
 */
export type NeedsYouItem =
  | (NeedsYouBase & {
      decision: Decision;
      handoff: null;
      /** The reason of the rule card that held it. */
      held_by: string | null;
      held_at: string;
    })
  | (NeedsYouBase & { handoff: Handoff; decision: null; held_by: null; held_at: null });

export interface ApprovalAnswerOut {
  decision: Decision;
  execution_state: ExecResult['state'] | null;
  /** The rule cards an "always" answer proposes; drafted through `draftRules`. */
  card_diff: RuleCard[] | null;
}

// Conversations

export type TranscriptKind = 'visitor_text' | 'agent_text' | 'delivered' | 'status' | 'whisper' | 'owner_joined' | 'owner_left';

export interface TranscriptItem {
  /** The transcript cursor (`after`). */
  n: number;
  /**
   * An owner's say is a `delivered` item whose `EvMessage.author` is `owner`. `owner_joined` and
   * `owner_left` are where the owner took the chat over and handed it back (plan 02b).
   */
  kind: TranscriptKind;
  created_at: string;
  /** Someone's own words; null for the items that carry an event. Untrusted. */
  text: string | null;
  /**
   * The stored event, or null: a delivered message's or a status's signed event, or the
   * `EvOwnerJoined` or `EvOwnerLeft` the visitor's stream got when the owner joined or left.
   */
  event: EvMessage | EvReceipt | EvHeld | EvResolved | EvOwnerJoined | EvOwnerLeft | null;
  /** Owner view only. */
  owner_translation?: string | null;
  /** Owner view only, AI-written. */
  triage?: string | null;
}

export interface VisitorTranscript {
  state: SessionState;
  items: TranscriptItem[];
  /** The highest event `seq` when the transcript was read. */
  last_seq: number;
}

export interface OwnerTranscript {
  state: SessionState;
  items: TranscriptItem[];
  /**
   * Until when the visitor is typing, while that is in the future, else null (plan 02b Task 1,
   * owner view only). Optional until the API sends it.
   */
  typing_until?: string | null;
  /** Replayed from the recorded history into this copy (plan 02b); absent is false. */
  replayed?: boolean;
}

// Safety

/** What a stopped attempt was about, as the API owner plan's triage task sorts it (plan 02b, Task 10). */
export type TriageCategory =
  | 'impersonation'
  | 'discount_push'
  | 'private_data'
  | 'code_redirect'
  | 'injection'
  | 'over_limit'
  | 'other';

/** An attempt's AI-written summary and category: owner-facing only, and labelled as written by Claude. */
export interface Triage {
  summary: string;
  category: TriageCategory;
}

export interface Attempt {
  ref_id: string;
  kind: 'refused' | 'held' | 'reply_blocked';
  reason_plain: string;
  card_ids: string[];
  origin: string;
  created_at: string;
  /** Null until the API owner plan's triage task (plan 02b) writes one; screens check its shape before using it. */
  triage: Triage | null;
  ledger_seq: number;
}

/** `GET /api/health`. */
export interface HealthOut {
  ok: boolean;
  kernel: Health | null;
}

// Rules, tools, knowledge, people

export interface PeopleOut {
  people: { person_id: string; display_name: string; masked_contact: string }[];
  /**
   * The name and note as the visitor typed them (untrusted; the API types either as missing);
   * `replayed`: replayed from the recorded history into this copy (plan 02b), absent is false.
   */
  leads: { lead_id: string; display_name: string | null; note: string | null; created_at: string; replayed?: boolean }[];
}

/**
 * Why a tool waits for the owner's review (kernel payments, plan 01c Task 4): connected and never
 * confirmed (`new`), its definition changed (`changed`), or no longer listed by its connector (`delisted`).
 */
export type ToolReviewReason = 'new' | 'changed' | 'delisted';

/** A tool as the owner reviews it: the kernel's tool row (`ToolProfile`'s columns). */
export interface ToolRow {
  tool: ToolName;
  source: ToolProfile['source'];
  effects: ToolProfile['effects'];
  reversible: boolean;
  status: ToolProfile['status'];
  /** The description the owner confirmed. Untrusted text from the tool's server. */
  description_confirmed: string;
  definition_sha256: string | null;
  /** A changed definition waiting for review. Untrusted. */
  pending_definition_text: string | null;
  pending_sha256: string | null;
  /**
   * Why it waits for review, set by the kernel and null unless `status` is `needs_review`. Typed
   * here, and optional, until the regenerated contract types have it: a row without it gives no reason.
   */
  review_reason?: ToolReviewReason | null;
  /**
   * The active version's cards that cover the tool, in card order, `shared` for a rule on an effect
   * group (plan 02b Task 9; pending, typed here and optional until the API sends it). Screens read
   * which rules govern a tool from the active version's cards (`rulesForTool`), which say the same.
   */
  cards?: ToolRowCard[];
}

/** A card that covers a tool, as `ToolRow.cards` lists it (pending, plan 02b Task 9). */
export interface ToolRowCard {
  card_id: string;
  mode: RuleCard['mode'];
  reason: string;
  shared: boolean;
}

/**
 * A rules version with its money cap, `auto_money_cap_cents`: the most an auto rule takes or pays
 * out in one action without asking (kernel verification plan 01b Task 3b; master "Money cap"). The
 * active version's is the Desk's. Typed here, and optional, until the regenerated contract types
 * have it; a missing cap is 0, the kernel's default, under which every payment asks.
 */
export interface PolicyVersionOut extends PolicyVersion {
  auto_money_cap_cents?: number;
}

/** The presets the owner can start from (the master plan's `desk.presets.PRESETS`); there is no "custom". */
export type RulesPreset = 'ask_first' | 'auto';

export interface RulesView {
  active: PolicyVersionOut;
  tools: ToolRow[];
  /**
   * The preset the active owner cards came from, provenance only; null when they match neither
   * (plan 02b Task 9, typed here until the API sends it).
   */
  preset: RulesPreset | null;
}

export interface CardDiff {
  added: RuleCard[];
  removed: RuleCard[];
  /** Before, after. */
  changed: [RuleCard, RuleCard][];
}

export interface RulesDraft {
  version: number;
  /** The draft version's cards, default cards left out. */
  cards: RuleCard[];
  diff: CardDiff | null;
  /** The draft's money cap (plan 02b; typed here, and optional, until the API sends it): missing is 0. */
  auto_money_cap_cents?: number;
  proof: ProofReport;
  /** Each a card's `reason`. */
  summary: { on_its_own: string[]; asks_you: string[]; never: string[] };
}

export interface Suggestion {
  tool: ToolName;
  count: number;
  text: string;
  card: RuleCard;
}

/** 202 from a proving route that passed 25 s: post `body` to `path` until it answers. */
export interface ProvingPending {
  retry: { path: string; body: unknown };
}

export interface RuleChatOut {
  answer: string;
  /** Null when the owner asked a question rather than a change. */
  draft: RulesDraft | null;
}

// Setup

export type SetupStep = 'questions' | 'tools' | 'rules' | 'situations' | 'safety_check' | 'preview' | 'live';

/** The setup interview's seven questions (plan 02b Task 6, `QUESTION_KEYS`). */
export type QuestionKey =
  | 'what_you_do'
  | 'hours_and_area'
  | 'quote_limit'
  | 'discounts'
  | 'documents_and_payments'
  | 'money_limit'
  | 'contact_and_after_hours';

export interface SetupMessage {
  role: 'claude' | 'owner' | 'tool_label';
  text: string;
}

export interface SetupState {
  interview_id: string;
  desk_id: string;
  slug: string;
  step: SetupStep;
  messages: SetupMessage[];
  /** Whether the owner let Claude read their memory and website; null until asked. */
  consent: boolean | null;
  /** The question waiting for an answer; null before consent and after the last one. */
  question: QuestionKey | null;
}

export interface SetupTools {
  tools: ToolRow[];
  connectable: 'mock_payments'[];
}

/** A situation Claude wrote from the owner's answers to try on the draft rules (plan 02b Task 7). */
export interface Situation {
  /** Claude's words, from the owner's answers. */
  title: string;
  who: 'public' | 'verified' | 'agent' | 'after_hours';
  probe: Probe;
  /** What the answers planned; `allow_if_reviewed` is "does it if Claude's second look agrees". */
  expected: Outcome | 'allow_if_reviewed';
}

export interface SituationResult {
  situation: Situation;
  result: ProbeResult;
  /**
   * Whether the result is what was planned: a plan to do it after Claude's second look matches a
   * result that depends on the reviewer; any other plan, the same outcome without the reviewer.
   */
  matches: boolean;
}

export interface SafetyCheckRow {
  /** The kind of trick: "Pretends to be you". */
  label: string;
  /** What a bad actor would say, as they'd type it. Shown quoted, as their words. */
  tries: string;
  result: ProbeResult;
  /** Refused, or held where that stops it; never when it depends on the reviewer. */
  blocked: boolean;
}

export interface SafetyCheck {
  rows: SafetyCheckRow[];
  blocked: number;
  total: number;
  seconds: number;
}

export interface WentLive {
  public_url: string;
  slug: string;
}

// Public

export interface VisitorSession {
  state: SessionState;
  resumed: boolean;
}

export interface MessageAccepted {
  message_id: string;
}

export interface CancelAccepted {
  decision_id: string;
}

export interface VerifyChecked {
  state: SessionState;
}

/** The static, code-built half of the Agent Card (skills and disclosure are `PublicDesk`'s). */
export interface AgentCardOut {
  endpoint: string;
  signing: {
    headers: string[];
    payload_fields: string[];
    canonical: string;
    algorithm: string;
    encoding: string;
    ts_window_s: number;
  };
  /** The request line, its headers and its body, as text (the API's `AgentCardOut.example_request`). */
  example_request: string;
}

export interface AgentRunStarted {
  run_id: string;
}

/** One turn of a demo agent run. The agent's own words are never returned: its turns are empty. */
export interface AgentTurn {
  author: 'agent' | 'desk';
  n: number;
  blocks: RenderedBlock[];
  /** A Desk turn's status events, as its `A2AResponse` carries them. */
  receipts: (EvReceipt | EvHeld | EvResolved)[];
}

export interface DemoAgentRun {
  run_id: string;
  launcher_session_id: string;
  slug: string;
  task: string;
  state: 'running' | 'done' | 'failed';
  turns: AgentTurn[];
}

// Tokens

/** Why a payment link was cancelled: only a change to the business's rules gives a reason. */
export type CancelReason = 'rules_changed';

/**
 * `GET /api/pay/{token}`: the kernel's `PaymentLinkView` with the fields the kernel payments,
 * agents and setup plan (plan 01c) adds to it, typed here and optional until plan 01c's
 * regenerated types have them. `business_name` is the Desk's business as the kernel names it; the
 * live API doesn't send it yet, and the checkout leaves the business's name out when it's missing,
 * never naming one of its own. `cancel_reason` is `rules_changed` for a link a rule change
 * cancelled, else null; `customer_name` is the kernel's first name and last initial for a link from
 * a verified session ("Dana W."), present only while the link is open. Names are someone's own
 * words and render as text.
 */
export interface PaymentLinkOut extends PaymentLinkView {
  business_name?: string;
  cancel_reason?: CancelReason | null;
  customer_name?: string | null;
}

// Request bodies

export interface PasscodeBody {
  passcode: string;
}

export interface AnsweringBody {
  on: boolean;
}

export interface AnswerBody {
  answer: ApprovalAnswer;
}

/** Take-over, hand-back and resume: the session's generation as last read, which fences a stale act. */
export interface GenerationBody {
  generation: number;
}

export interface OwnerMessageBody {
  text: string;
  kind: 'say' | 'whisper';
}

export interface ToolBody {
  tool: ToolName;
}

export interface KnowledgeBody {
  item: KnowledgeItem;
}

export interface TextBody {
  text: string;
}

export interface DraftAddBody {
  /** An approval's `card_diff`, merged by `card_id`. */
  add: RuleCard[];
}

export interface PresetBody {
  preset: RulesPreset;
}

/**
 * `draftMoneyCap`'s body (plan 02b; typed here until the regenerated types have it): the payment
 * limit a draft changes to, in cents, from 0 to the $10,000 platform ceiling. The draft keeps the
 * active rules, and nothing changes until the owner confirms it.
 */
export interface MoneyCapBody {
  auto_money_cap_cents: number;
}

export interface ConfirmRulesBody {
  version: number;
}

/** One tool of a `confirmTool` batch, with the hash of the definition the owner confirms. */
export interface ToolConfirmEntry {
  tool: ToolName;
  /**
   * The row's `definition_sha256`, the hash it was listed at; only the changed-tool review sends its
   * `pending_sha256`, the hash of the definition the owner just read.
   */
  definition_sha256: string;
}

/**
 * `confirmTool`'s batch body (plan 02b Task 7, with kernel payments Task 4, plan 01c; typed here
 * until the regenerated types have it): a whole connector in one action, one tool a list of one.
 * Turning on drafts one version for the listed tools, confirmed like any rules draft; turning off
 * applies at once, with no draft.
 */
export interface ConfirmToolBody {
  tools: ToolConfirmEntry[];
  enable: boolean;
}

/** `confirmTool`'s answer: the kernel's `ToolConfirmed`, its draft carrying the draft's money cap. */
export interface ToolConfirmedOut extends Omit<ToolConfirmed, 'draft'> {
  draft: PolicyVersionOut | null;
}

export interface StartSetupBody {
  description: string;
  timezone: string;
  owner_display_name?: string;
}

/**
 * A setup answer and the question it answers (`SetupState.question` when it was asked): the API
 * refuses it with 409 `conflict` once the interview has moved past that question, so an answer
 * sent twice never answers the next one (plan 02b Task 6, as amended).
 */
export interface SetupAnswerBody {
  question: QuestionKey;
  text: string;
}

export interface ConsentBody {
  allow: boolean;
}

export interface ConnectBody {
  server: 'mock_payments';
}

export interface VerifyCodeBody {
  code: string;
}

export interface AgentTaskBody {
  task: string;
}
