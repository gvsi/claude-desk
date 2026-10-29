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
  EvReceipt,
  EvResolved,
  ExecResult,
  Health,
  HoursWindow,
  KnowledgeItem,
  PolicyVersion,
  ProbeResult,
  ProofReport,
  RenderedBlock,
  RuleCard,
  SessionMode,
  SessionState,
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
}

export interface Briefing {
  /** The owner's previous read of Today; null on the first ("So far"). */
  since: string | null;
  conversations: number;
  bookings: number;
  leads: number;
  held: number;
  blocked: number;
  paid_cents: number;
}

export interface Today {
  /** The first word of the owner's display name. */
  greeting_name: string;
  needs_you_count: number;
  /** Conversations with activity in the last 5 minutes. */
  live: ConversationSummary[];
  briefing: Briefing;
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

/** One held request or one open callback that waits for the owner. */
export type NeedsYouItem =
  | (NeedsYouBase & {
      decision: Decision;
      handoff?: undefined;
      /** The reason of the rule card that held it. */
      held_by: string | null;
      held_at: string;
    })
  | (NeedsYouBase & { handoff: Handoff; decision?: undefined; held_by?: undefined; held_at?: undefined });

export interface ApprovalAnswerOut {
  decision: Decision;
  execution_state: ExecResult['state'] | null;
  /** The rule cards an "always" answer proposes; drafted through `draftRules`. */
  card_diff: RuleCard[] | null;
}

// Conversations

export type TranscriptKind = 'visitor_text' | 'agent_text' | 'delivered' | 'status' | 'whisper';

export interface TranscriptItem {
  /** The transcript cursor (`after`). */
  n: number;
  /** An owner's say is a `delivered` item whose `EvMessage.author` is `owner`. */
  kind: TranscriptKind;
  created_at: string;
  /** Someone's own words; null for `delivered` and `status`. Untrusted. */
  text: string | null;
  /** The stored signed event, or null. */
  event: EvMessage | EvReceipt | EvHeld | EvResolved | null;
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
}

// Safety

export interface Attempt {
  ref_id: string;
  kind: 'refused' | 'held' | 'reply_blocked';
  reason_plain: string;
  card_ids: string[];
  origin: string;
  created_at: string;
  triage: string | null;
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
  leads: { lead_id: string; display_name: string; note: string; created_at: string }[];
}

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
}

export type RulesPreset = 'ask_first' | 'auto' | 'custom';

export interface RulesView {
  active: PolicyVersion;
  tools: ToolRow[];
  preset: RulesPreset;
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
}

export interface SetupTools {
  tools: ToolRow[];
  connectable: 'mock_payments'[];
}

export interface SituationResult {
  situation: string;
  result: ProbeResult;
  /** False on another outcome or when the outcome depends on the reviewer. */
  matches: boolean;
}

export interface SafetyCheckRow {
  label: string;
  tries: number;
  result: ProbeResult;
  blocked: number;
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
  example_request: Record<string, unknown>;
}

export interface AgentRunStarted {
  run_id: string;
}

/** One turn of a demo agent run. The agent's own words are never returned: its turns are empty. */
export interface AgentTurn {
  author: 'agent' | 'desk';
  n: number;
  blocks: RenderedBlock[];
  receipts: EvReceipt[];
}

export interface DemoAgentRun {
  run_id: string;
  launcher_session_id: string;
  slug: string;
  task: string;
  state: 'running' | 'done' | 'failed';
  turns: AgentTurn[];
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

export interface ResumeBody {
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
  preset: Exclude<RulesPreset, 'custom'>;
}

export interface ConfirmRulesBody {
  version: number;
}

export interface ConfirmToolBody {
  tool: ToolName;
  enable: boolean;
  definition_sha256: string;
}

export interface StartSetupBody {
  description: string;
  timezone: string;
  owner_display_name?: string;
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
