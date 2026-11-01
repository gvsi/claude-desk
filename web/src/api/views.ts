/**
 * The API's read models and request bodies (Plan 02's "Read models" table, by its names), typed by
 * hand until the generated client replaces them. Kernel shapes come from contracts.ts. Request
 * bodies carry no copy, session or Desk ID: the API takes identity from its cookies.
 *
 * Text a visitor typed (`TranscriptItem.text`, `display_name`, `Handoff.reason`,
 * `from_the_visitor`) is untrusted and renders as text only, as does AI-written text a visitor
 * could steer (`claude_summary`, triage).
 */
import type {
  ActorKind,
  ApprovalAnswer,
  Assurance,
  BusinessToolDef,
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
import type { Attempt as ApiAttempt, DeskSetup, DeskSummary, Triage } from './openapi.gen.ts';

// Copy and Desks

/**
 * One of the copy's Desks (`DeskSummary`), with its setup interview while that hasn't gone live
 * (`DeskSetup`), or null: the API's own models, from its document. Answering is separate from
 * setup: an owner can turn it on before setup finishes, and the Desk still names its setup.
 */
export type { DeskSetup, DeskSummary };

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
  /**
   * The newest message the visitor typed in this chat, its whitespace collapsed to single spaces
   * and cut to 199 characters and "…" past 200; null for an agent's or the owner's chat, the
   * owner's preview, and before the visitor writes. Untrusted. The API always sends it; a reply
   * without it draws the row as before.
   */
  latest_visitor_text?: string | null;
}

export type BriefingKind = 'turned_down' | 'booking' | 'lead' | 'answer';

/** One thing that happened since last night, as the API core's briefing lists it. */
export interface BriefingItem {
  kind: BriefingKind;
  /** When it happened (a replayed row's recorded time). */
  at: string;
  /** The conversation it happened in, or null. */
  session_id: string | null;
  /** As `ConversationSummary.display_name`. Untrusted. */
  display_name: string | null;
  /** The refused decision for `turned_down` (its `Attempt.ref_id`); the decision for a booking; the `lead_id`; the session for an answer. */
  ref_id: string;
  /**
   * A refusal's or a booking's `reason_plain` (the kernel's owner text); a lead's note (untrusted, and
   * it may hold the contact as typed); null for an answer.
   */
  line: string | null;
  /** Why a `turned_down` request was refused, as a closed code; null for the other kinds and for a refusal the API can't place. */
  cause: RefusalCause | null;
}

/** "Since last night": from 18:00 yesterday in the business's time zone, to now. */
export interface Briefing {
  /** The window's start, 18:00 yesterday, local. */
  since: string;
  conversations: number;
  bookings: number;
  leads: number;
  /**
   * The conversations Claude answered on its own: the `answer` items in the window. The API always
   * sends it; without it, Today's one line waits rather than say less.
   */
  answers?: number;
  /** The requests the kernel refused. Claude's drafts the reply check stopped stay on Safety, out of the briefing. */
  turned_down: number;
  /** The full list's length (`BriefingList.items`). */
  total: number;
  newest: {
    turned_down: BriefingItem | null;
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

/**
 * A conversation handed to the owner: a visitor's call-back request (`callback`), or one the
 * handoff card handed over in a chat (`card`), which promises no call back.
 */
export interface Handoff {
  handoff_id: string;
  session_id: string;
  /**
   * A call-back request's `<name> · <contact> · <reason>` as the visitor typed them; a card's, the
   * Desk's own words ("The Desk handed this to you."). Untrusted.
   */
  reason: string;
  /** `<start>/<end>`, or null when the visitor named no open hour. Always null for a card. */
  callback_window: string | null;
  status: string;
  /** Optional until the API sends it (plan 02b); a handoff without one is a call-back request. */
  kind?: 'callback' | 'card';
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
  /**
   * What the visitor (or visiting agent) wrote most recently, labelled: their previous and last
   * messages, oldest first, each with whitespace collapsed and, past 200 characters, cut to 199 and "…",
   * joined with " · "; just the last when there's one. Untrusted.
   */
  from_the_visitor: string | null;
  /**
   * On a handoff, the conversation's newest AI-written triage summary (what the person asked for
   * and what the Desk did, at most 400 characters), for the owner alone and never quoted as the
   * visitor's; null when it has none. A held request never carries one: a visitor could steer a
   * summary to sway an approval. Optional until the API sends it; an item without it draws as before.
   */
  claude_summary?: string | null;
}

/**
 * One held request or one open handoff that waits for the owner. The API sends every field, the
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
  items: OwnerTranscriptItem[];
  /**
   * Until when the visitor is typing, while that is in the future, else null (plan 02b Task 1,
   * owner view only). Optional until the API sends it.
   */
  typing_until?: string | null;
  /** Replayed from the recorded history into this copy (plan 02b); absent is false. */
  replayed?: boolean;
}

/** An item of the owner's transcript: a visitor's kinds, and where the reply check stopped a draft of Claude's. */
export interface OwnerTranscriptItem extends Omit<TranscriptItem, 'kind'> {
  /**
   * A `stopped_draft` item stands where the check stopped Claude's draft, before the rewrite or the
   * handoff that followed in the same turn; it has no `text` or `event` (openapi.json).
   */
  kind: TranscriptKind | 'stopped_draft';
  /** Owner-only annotation beside the signed event, absent on older API responses. */
  owner_plain?: import('./openapi.gen.ts').OwnerTranscriptItem['owner_plain'];
}

// Safety

/** A checkpoint event's subject, as the API's descriptive triage names it. */
export type TriageCategory = Triage['category'];

/** The API's AI-written summary and category, for the owner alone. */
export type { Triage };

/**
 * Why the kernel refused a request: a closed code from the API's own document, which the web holds
 * the words for. A value the document adds is a compile error until the words are written.
 */
export type RefusalCause = NonNullable<ApiAttempt['cause']>;

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
  /**
   * Why a refused request was refused, or null: for a held request, a stopped draft, and a
   * refusal the API can't place. The API sends it on every entry, and only a refused one may have one.
   */
  cause: RefusalCause | null;
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

/** Owner configuration is untrusted text, with its shape from the kernel's generated contract. */
export type { BusinessToolDef, IntakeConfig, TypedBookingConfig, PurposePaymentConfig, UrgentConfig } from './contracts.ts';

/** A catalog tool or a Desk's own tool, whose title comes from its business definition. */
export type AnyToolName = ToolName | `desk.${string}`;

/** A tool as the owner reviews it: the kernel's tool row (`ToolProfile`'s columns). */
export interface ToolRow {
  tool: AnyToolName;
  source: ToolProfile['source'] | 'business';
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
  /** Typed here and optional until the regenerated contract types carry business definitions. */
  business?: BusinessToolDef | null;
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

/** Setup's steps, in the order an interview goes through them: it only ever moves forward, and `live` is the last. */
export const SETUP_STEPS = ['questions', 'tools', 'rules', 'situations', 'safety_check', 'preview', 'live'] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/** The steps a setup that hasn't gone live can be at, as the API's `DeskSetup` names them: every step but `live`. */
export type UnfinishedSetupStep = DeskSetup['step'];

/** The setup interview's seven questions (plan 02b Task 6, `QUESTION_KEYS`). */
export type QuestionKey =
  | 'what_you_do'
  | 'hours_and_area'
  | 'quote_limit'
  | 'discounts'
  | 'documents_and_payments'
  | 'money_limit'
  | 'contact_and_after_hours';

/**
 * What setup can wait on: one of its questions, then, once its plan is closed, whether to add the
 * owner as a test client (`test_client`), which the API asks and reads by code alone.
 */
export type SetupQuestion = QuestionKey | 'test_client';

/** 2..4 choices per question, text ≤ 80; at most one recommended choice, listed first. */
export type Choice = { text: string; recommended: boolean };

/** One proposal per Claude card message; stable id `p-` + 12 hex for the interview. */
export type ProposalCard = {
  proposal_id: string;
  kind: 'job' | 'connector';
  state: 'proposed' | 'accepted' | 'declined' | 'changed';
  superseded_by: string | null;
  job: JobProposal | null;
  connector: ConnectorProposal | null;
};

/** The closed catalog of jobs setup can propose. */
export type JobKind = 'answer' | 'intake' | 'schedule' | 'price' | 'documents' | 'status' | 'payment' | 'urgent';

/** Title and who ≤ 60, why ≤ 200, how ≤ 300; model text is untrusted. */
export type JobProposal = {
  job: JobKind;
  title: string;
  why: string;
  how: string;
  who?: string | null;
  can_do_today: boolean;
  autonomy: 'auto' | 'ask';
  config: BlockConfig | null;
};

/**
 * Intake: 1..5 questions, each ≤ 120. Booking: appointment type ≤ 60, minutes 15..60 (one slot).
 * Payment: purpose ≤ 60, amount_cents null until the owner enters integer cents 0..1_000_000.
 * Urgent: urgent_when ≤ 300.
 */
export type BlockConfig =
  | { block: 'intake'; questions: string[] }
  | { block: 'typed_booking'; appointment_type: string; minutes: number }
  | { block: 'purpose_payment'; purpose: string; amount_cents: number | null }
  | { block: 'urgent'; urgent_when: string };

/** Setup's closed connector catalog. */
export type ConnectorKey = 'google_calendar' | 'gmail' | 'google_drive' | 'quickbooks' | 'stripe' | 'square' | 'calendly';

/** Why ≤ 200; catalog apps connect in simulation. False remains an unavailable-app fallback. */
export type ConnectorProposal = {
  app: ConnectorKey;
  label: string;
  why: string;
  connectable: boolean;
  /** True only once the connection succeeded; older responses omit it (false). */
  connected?: boolean;
};

/** Card messages have role Claude, empty text and no choices; ordinary messages have card null. */
export interface SetupMessage {
  role: 'claude' | 'owner' | 'tool_label';
  text: string;
  choices: Choice[];
  card: ProposalCard | null;
}

export interface SetupState {
  interview_id: string;
  desk_id: string;
  slug: string;
  step: SetupStep;
  messages: SetupMessage[];
  /** Whether the owner let Claude read their memory and website; null until asked. */
  consent: boolean | null;
  /**
   * Derived from the stored transcript: Claude is working on the owner's last message with no
   * reply yet. Absent means false on older APIs.
   */
  busy?: boolean;
  /**
   * The question waiting for an answer, `test_client` while the test-client offer at the plan's
   * end waits; null before consent and after the last one.
   */
  question: SetupQuestion | null;
  /** The proposal awaiting an answer; when set, question is null. Absent on older APIs. */
  pending_card?: string | null;
}

export interface SetupTools {
  tools: ToolRow[];
  connectable: 'mock_payments'[];
}

/** Line keys understood by setup's public-lines review, shared without importing UI code. */
export const SETUP_PUBLIC_LINE_KEYS = ['policy:about', 'contact', 'policy:pricing', 'policy:intake', 'policy:after_hours', 'policy:urgent', 'policy:service_area', 'policy:how_we_help'] as const;

/** The public charter lines the owner reviews before the safety check. */
export interface SetupPublicLine {
  key: string;
  text: string;
  source: 'owner' | 'suggested';
  editable: boolean;
  /** Stored owner words held from publication; absent on older answers means false. */
  held?: boolean;
}

export type PublicHoursWindow = HoursWindow;

export interface SetupPublicHours {
  source: 'owner' | 'suggested';
  windows: HoursWindow[];
}

export type PublicPriceItem = SetupPublicPriceItem;

export interface SetupPublicPriceItem {
  item_id: string;
  title: string;
  unit_cents: number;
}

export interface SetupPublicPrices {
  source: 'owner' | 'suggested';
  items: SetupPublicPriceItem[];
}

export interface SetupPublicLines {
  lines: SetupPublicLine[];
  hours: SetupPublicHours | null;
  prices: SetupPublicPrices | null;
  revision: string;
}

export interface SetupPublicLinesConfirmIn {
  keys: string[];
  revision: string;
}

export interface SetupPublicLineIn {
  key: string;
  text: string;
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

/**
 * One turn of a demo agent run: the agent's request, with the words it sent (`text`), or the Desk's
 * checked answer to it, with its blocks and receipts.
 */
export interface AgentTurn {
  author: 'agent' | 'desk';
  n: number;
  blocks: RenderedBlock[];
  /** A Desk turn's status events, as its `A2AResponse` carries them. */
  receipts: (EvReceipt | EvHeld | EvResolved)[];
  /**
   * An agent turn's request, as the agent sent it to the Desk; null for a Desk turn. Untrusted: on
   * the hosted site these are a model's own words, at most 2,000 characters. The API always sends
   * it; without it, the request draws as before.
   */
  text?: string | null;
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
export type CancelReason = NonNullable<PaymentLinkView['cancel_reason']>;

/**
 * `GET /api/pay/{token}`: the kernel's `PaymentLinkView` as it is. `business_name` is the Desk's
 * business as the kernel names it; if one ever arrives missing or empty, the checkout leaves the
 * name out, never naming one of its own. `cancel_reason` is `rules_changed` for a link a rule change
 * cancelled, else null; `customer_name` is the kernel's first name and last initial for a link from
 * a verified session ("Dana W."), present only while the link is open. Names are someone's own
 * words and render as text.
 */
export type PaymentLinkOut = PaymentLinkView;

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

export type { KnowledgeRow } from './openapi.gen.ts';

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

/** `draftMoneyCap`'s body, the payment limit a draft changes to: the API's own model, from its document. */
export type { MoneyCapIn } from './openapi.gen.ts';

export interface ConfirmRulesBody {
  version: number;
}

/** One tool of a `confirmTool` batch, with the hash of the definition the owner confirms. */
export interface ToolConfirmEntry {
  tool: AnyToolName;
  /**
   * The row's `definition_sha256`, the hash it was listed at; only the changed-tool review sends its
   * `pending_sha256`, the hash of the definition the owner just read.
   */
  definition_sha256: string;
}

/**
 * `confirmTool`'s batch body (plan 02b Task 7, with kernel payments Task 4, plan 01c): the kernel's
 * `ToolsConfirmRequest` without its `desk_id`, which the API takes from the path, and with `tools`
 * as a plain list. A whole connector in one action, one tool a list of one. Turning on drafts one
 * version for the listed tools, confirmed like any rules draft; turning off applies at once, with
 * no draft. The answer lists every tool of the batch as it stands now, in the request's order.
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
  /**
   * One per "Start" click (1 to 128 characters, no control characters): a repeat with the same key
   * and body answers the interview the first made instead of making another (plan 02b).
   */
  idempotency_key: string;
}

/**
 * A setup answer and the question it answers (`SetupState.question` when it was asked): the API
 * refuses it with 409 `conflict` once the interview has moved past that question, so an answer
 * sent twice never answers the next one (plan 02b Task 6, as amended).
 */
export type SetupAnswerBody = { text: string } & (
  | { question: SetupQuestion; card?: never }
  | { question: null; card: string }
);

/** Changes always accept: title 1..60, job autonomy, payment-only integer cents 0..1_000_000. */
export type SetupProposalBody = { accept: boolean; title?: string; amount_cents?: number; autonomy?: 'auto' | 'ask' };

/** Sent as an empty JSON object. */
export type SetupSuggestionsBody = Record<string, never>;

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
  /**
   * One per task click (1 to 128 characters, no control characters): a repeat with the same key,
   * task, session and Desk answers the run the first started and starts nothing (plan 02b).
   */
  idempotency_key: string;
}
