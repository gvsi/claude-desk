/**
 * Every API route the web app calls, by key: method and path exactly as Plan 02 writes them, so
 * one table is checked against the API's contract (routes.test.ts) and every request goes
 * through `request()` in http.ts.
 *
 * - `owner`: under `/api/owner/`, sent with the owner's cookie.
 * - `proving`: under `/api/owner/policy/`; the API may answer 202 with a retry while rules are checked.
 * - `model`: waits on a Claude turn, so it gets a longer timeout.
 */
import type {
  Decision,
  DeskUpdated,
  DeskBusinessRequest,
  DemoAgentIssued,
  DemoInboxEntry,
  KnowledgeItem,
  LedgerPage,
  OwnerMessageResult,
  PaymentLinkStateResult,
  PolicyVersion,
  PublicDesk,
  SessionState,
  ToolProfile,
} from './contracts.ts';
import type {
  AgentCardOut,
  AgentRunStarted,
  AgentTaskBody,
  AgentTasks,
  AnswerBody,
  AnsweringBody,
  ApprovalAnswerOut,
  Attempt,
  BriefingList,
  BusinessOut,
  CancelAccepted,
  ConfirmRulesBody,
  ConfirmToolBody,
  ConnectBody,
  ConsentBody,
  ConversationSummary,
  CopyOut,
  DemoAgentRun,
  DraftAddBody,
  GenerationBody,
  HealthOut,
  KnowledgeBody,
  KnowledgeRow,
  MessageAccepted,
  MoneyCapIn,
  NeedsYouItem,
  OwnerMessageBody,
  OwnerTranscript,
  PasscodeBody,
  PaymentLinkOut,
  PeopleOut,
  SetupPublicLines,
  SetupPublicLineIn,
  SetupPublicLinesConfirmIn,
  PolicyVersionOut,
  PresetBody,
  Reports,
  RuleChatOut,
  RulesDraft,
  RulesView,
  SafetyCheck,
  SetupAnswerBody,
  SetupProposalBody,
  SetupSuggestionsBody,
  SetupState,
  SetupTools,
  SituationResult,
  StartSetupBody,
  Suggestion,
  TextBody,
  Today,
  ToolBody,
  ToolConfirmedOut,
  ToolRow,
  VerifyChecked,
  VerifyCodeBody,
  VisitorSession,
  VisitorTranscript,
  WentLive,
} from './views.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  owner: boolean;
  proving?: true;
  model?: true;
}

export const ROUTES = {
  // Copy and Desks
  copies: { method: 'POST', path: '/api/owner/copies', owner: true },
  startOver: { method: 'POST', path: '/api/owner/start_over', owner: true },
  me: { method: 'GET', path: '/api/owner/me', owner: true },
  desks: { method: 'GET', path: '/api/owner/desks', owner: true },
  setAnswering: { method: 'PUT', path: '/api/owner/desks/{desk_id}/answering', owner: true },
  setBusiness: { method: 'PUT', path: '/api/owner/desks/{desk_id}/business', owner: true },
  deleteDesk: { method: 'DELETE', path: '/api/owner/desks/{desk_id}', owner: true },
  openPreview: { method: 'POST', path: '/api/owner/desks/{desk_id}/preview_session', owner: true },

  // Today
  today: { method: 'GET', path: '/api/owner/desks/{desk_id}/today', owner: true },
  briefing: { method: 'GET', path: '/api/owner/desks/{desk_id}/briefing', owner: true },
  needsYou: { method: 'GET', path: '/api/owner/desks/{desk_id}/needs_you', owner: true },
  reports: { method: 'GET', path: '/api/owner/desks/{desk_id}/reports', owner: true },
  answer: { method: 'POST', path: '/api/owner/approvals/{decision_id}/answer', owner: true },
  handoffDone: { method: 'POST', path: '/api/owner/handoffs/{handoff_id}/done', owner: true },

  // Conversations
  conversations: { method: 'GET', path: '/api/owner/desks/{desk_id}/conversations', owner: true },
  conversation: { method: 'GET', path: '/api/owner/conversations/{session_id}', owner: true },
  takeover: { method: 'POST', path: '/api/owner/conversations/{session_id}/takeover', owner: true },
  handback: { method: 'POST', path: '/api/owner/conversations/{session_id}/handback', owner: true },
  resume: { method: 'POST', path: '/api/owner/conversations/{session_id}/resume', owner: true },
  ownerMessage: { method: 'POST', path: '/api/owner/conversations/{session_id}/messages', owner: true },
  ownerTyping: { method: 'POST', path: '/api/owner/conversations/{session_id}/typing', owner: true },
  decision: { method: 'GET', path: '/api/owner/decisions/{decision_id}', owner: true },

  // Safety
  safety: { method: 'GET', path: '/api/owner/desks/{desk_id}/safety', owner: true },
  ledger: { method: 'GET', path: '/api/owner/desks/{desk_id}/ledger', owner: true },
  ownerInbox: { method: 'GET', path: '/api/owner/demo_inbox', owner: true },
  health: { method: 'GET', path: '/api/health', owner: false },

  // Rules, tools, knowledge, people
  rules: { method: 'GET', path: '/api/owner/desks/{desk_id}/rules', owner: true },
  ruleDraft: { method: 'GET', path: '/api/owner/desks/{desk_id}/rules/drafts/{version}', owner: true },
  suggestions: { method: 'GET', path: '/api/owner/desks/{desk_id}/suggestions', owner: true },
  simulateToolChange: { method: 'POST', path: '/api/owner/desks/{desk_id}/tools/simulate_change', owner: true },
  addKnowledge: { method: 'POST', path: '/api/owner/desks/{desk_id}/knowledge', owner: true },
  knowledge: { method: 'GET', path: '/api/owner/desks/{desk_id}/knowledge', owner: true },
  people: { method: 'GET', path: '/api/owner/desks/{desk_id}/people', owner: true },

  // Proving: every route under /api/owner/policy/
  ruleChat: { method: 'POST', path: '/api/owner/policy/{desk_id}/chat', owner: true, proving: true },
  draftRules: { method: 'POST', path: '/api/owner/policy/{desk_id}/draft', owner: true, proving: true },
  draftPreset: { method: 'POST', path: '/api/owner/policy/{desk_id}/preset', owner: true, proving: true },
  draftSuggestion: { method: 'POST', path: '/api/owner/policy/{desk_id}/suggestions/{tool}', owner: true, proving: true },
  draftMoneyCap: { method: 'POST', path: '/api/owner/policy/{desk_id}/money_cap', owner: true, proving: true },
  confirmRules: { method: 'POST', path: '/api/owner/policy/{desk_id}/confirm', owner: true, proving: true },
  confirmTool: { method: 'POST', path: '/api/owner/policy/{desk_id}/tools/confirm', owner: true, proving: true },
  setupRules: { method: 'POST', path: '/api/owner/policy/setup/{id}/rules', owner: true, proving: true },
  setupSituations: { method: 'POST', path: '/api/owner/policy/setup/{id}/situations', owner: true, proving: true },
  setupSafetyCheck: { method: 'POST', path: '/api/owner/policy/setup/{id}/safety_check', owner: true, proving: true },
  setupConfirm: { method: 'POST', path: '/api/owner/policy/setup/{id}/confirm', owner: true, proving: true },
  goLive: { method: 'POST', path: '/api/owner/policy/setup/{id}/go_live', owner: true, proving: true },

  // Setup
  startSetup: { method: 'POST', path: '/api/owner/setup', owner: true, model: true },
  setup: { method: 'GET', path: '/api/owner/setup/{id}', owner: true },
  setupConsent: { method: 'POST', path: '/api/owner/setup/{id}/consent', owner: true, model: true },
  setupAnswer: { method: 'POST', path: '/api/owner/setup/{id}/answer', owner: true, model: true },
  setupProposal: { method: 'POST', path: '/api/owner/setup/{id}/proposals/{proposal_id}', owner: true, model: true },
  setupSuggestions: { method: 'POST', path: '/api/owner/setup/{id}/suggestions', owner: true, model: true },
  setupEvents: { method: 'GET', path: '/api/owner/setup/{id}/events', owner: true },
  setupTools: { method: 'GET', path: '/api/owner/setup/{id}/tools', owner: true },
  setupConnect: { method: 'POST', path: '/api/owner/setup/{id}/tools/connect', owner: true },
  setupPublicLines: { method: 'GET', path: '/api/owner/setup/{id}/public_lines', owner: true },
  setupPublicLine: { method: 'PUT', path: '/api/owner/setup/{id}/public_lines', owner: true },
  setupPublicLinesConfirm: { method: 'POST', path: '/api/owner/setup/{id}/public_lines/confirm', owner: true },
  removePublicLine: { method: 'DELETE', path: '/api/owner/setup/{id}/public_lines/{key}', owner: true },
  removePublicPrice: { method: 'DELETE', path: '/api/owner/setup/{id}/public_lines/prices/{item_id}', owner: true },

  // Public: the visitor cookie (set by openSession) on all but publicDesk, openSession and agentCard
  publicDesk: { method: 'GET', path: '/api/public/{slug}', owner: false },
  openSession: { method: 'POST', path: '/api/public/desks/{slug}/sessions', owner: false },
  visitorSession: { method: 'GET', path: '/api/public/desks/{slug}/session', owner: false },
  sendMessage: { method: 'POST', path: '/api/public/desks/{slug}/messages', owner: false },
  visitorTyping: { method: 'POST', path: '/api/public/desks/{slug}/typing', owner: false },
  events: { method: 'GET', path: '/api/public/desks/{slug}/events', owner: false },
  cancelRequest: { method: 'POST', path: '/api/public/desks/{slug}/decisions/{decision_id}/cancel', owner: false },
  verifyCheck: { method: 'POST', path: '/api/public/desks/{slug}/verify/check', owner: false },
  visitorInbox: { method: 'GET', path: '/api/public/desks/{slug}/demo_inbox', owner: false },
  agentCard: { method: 'GET', path: '/api/public/desks/{slug}/agent_card', owner: false },
  agentKey: { method: 'POST', path: '/api/public/desks/{slug}/agents/key', owner: false },
  agentTasks: { method: 'GET', path: '/api/public/desks/{slug}/agent_tasks', owner: false },
  sendAgent: { method: 'POST', path: '/api/public/desks/{slug}/send_agent', owner: false },
  agentRun: { method: 'GET', path: '/api/public/desks/{slug}/send_agent/{run_id}', owner: false },

  // Tokens
  paymentLink: { method: 'GET', path: '/api/pay/{token}', owner: false },
  completePayment: { method: 'POST', path: '/api/pay/{token}/complete', owner: false },
  cancelPayment: { method: 'POST', path: '/api/pay/{token}/cancel', owner: false },
} as const satisfies Record<string, RouteSpec>;

export type RouteKey = keyof typeof ROUTES;

/** What each route takes and answers. `body: undefined` sends no body; `response: undefined` is a 204. */
interface RouteShapes {
  copies: { body: PasscodeBody; response: CopyOut };
  startOver: { body: undefined; response: CopyOut };
  me: { body: undefined; response: CopyOut };
  desks: { body: undefined; response: BusinessOut[] };
  setAnswering: { body: AnsweringBody; response: DeskUpdated };
  setBusiness: { body: DeskBusinessRequest; response: DeskUpdated };
  deleteDesk: { body: undefined; response: undefined };
  openPreview: { body: undefined; response: VisitorSession };

  today: { body: undefined; response: Today };
  briefing: { body: undefined; response: BriefingList };
  needsYou: { body: undefined; response: NeedsYouItem[] };
  reports: { body: undefined; response: Reports };
  answer: { body: AnswerBody; response: ApprovalAnswerOut };
  handoffDone: { body: undefined; response: DeskUpdated };

  conversations: { body: undefined; response: ConversationSummary[] };
  conversation: { body: undefined; response: OwnerTranscript };
  takeover: { body: GenerationBody; response: SessionState };
  handback: { body: GenerationBody; response: SessionState };
  resume: { body: GenerationBody; response: SessionState };
  ownerMessage: { body: OwnerMessageBody; response: OwnerMessageResult };
  ownerTyping: { body: GenerationBody; response: undefined };
  decision: { body: undefined; response: Decision };

  safety: { body: undefined; response: Attempt[] };
  ledger: { body: undefined; response: LedgerPage };
  ownerInbox: { body: undefined; response: DemoInboxEntry[] };
  health: { body: undefined; response: HealthOut };

  rules: { body: undefined; response: RulesView };
  ruleDraft: { body: undefined; response: RulesDraft };
  suggestions: { body: undefined; response: Suggestion[] };
  simulateToolChange: { body: ToolBody; response: ToolProfile };
  addKnowledge: { body: KnowledgeBody; response: KnowledgeItem };
  knowledge: { body: undefined; response: KnowledgeRow[] };
  people: { body: undefined; response: PeopleOut };

  ruleChat: { body: TextBody; response: RuleChatOut };
  draftRules: { body: DraftAddBody; response: RulesDraft };
  draftPreset: { body: PresetBody; response: RulesDraft };
  draftSuggestion: { body: undefined; response: RulesDraft };
  draftMoneyCap: { body: MoneyCapIn; response: RulesDraft };
  confirmRules: { body: ConfirmRulesBody; response: PolicyVersionOut };
  confirmTool: { body: ConfirmToolBody; response: ToolConfirmedOut };
  setupRules: { body: undefined; response: RulesDraft };
  setupSituations: { body: undefined; response: SituationResult[] };
  setupSafetyCheck: { body: undefined; response: SafetyCheck };
  setupConfirm: { body: undefined; response: PolicyVersion };
  goLive: { body: undefined; response: WentLive };

  startSetup: { body: StartSetupBody; response: SetupState };
  setup: { body: undefined; response: SetupState };
  setupConsent: { body: ConsentBody; response: SetupState };
  setupAnswer: { body: SetupAnswerBody; response: SetupState };
  setupProposal: { body: SetupProposalBody; response: SetupState };
  setupSuggestions: { body: SetupSuggestionsBody; response: SetupState };
  /** Read with `openSetupEvents`, never with `request`. */
  setupEvents: { body: undefined; response: never };
  setupTools: { body: undefined; response: SetupTools };
  setupConnect: { body: ConnectBody; response: ToolRow[] };
  setupPublicLines: { body: undefined; response: SetupPublicLines };
  setupPublicLine: { body: SetupPublicLineIn; response: SetupPublicLines };
  setupPublicLinesConfirm: { body: SetupPublicLinesConfirmIn; response: SetupPublicLines };
  removePublicLine: { body: undefined; response: SetupPublicLines };
  removePublicPrice: { query: { title: string; unit_cents: number }; body: undefined; response: SetupPublicLines };

  publicDesk: { body: undefined; response: PublicDesk };
  openSession: { body: undefined; response: VisitorSession };
  visitorSession: { body: undefined; response: VisitorTranscript };
  sendMessage: { body: TextBody; response: MessageAccepted };
  visitorTyping: { body: undefined; response: undefined };
  /** Read with `openStream`, never with `request`. */
  events: { body: undefined; response: never };
  cancelRequest: { body: undefined; response: CancelAccepted };
  verifyCheck: { body: VerifyCodeBody; response: VerifyChecked };
  visitorInbox: { body: undefined; response: DemoInboxEntry[] };
  agentCard: { body: undefined; response: AgentCardOut };
  agentKey: { body: undefined; response: DemoAgentIssued };
  agentTasks: { body: undefined; response: AgentTasks };
  sendAgent: { body: AgentTaskBody; response: AgentRunStarted };
  agentRun: { body: undefined; response: DemoAgentRun };

  paymentLink: { body: undefined; response: PaymentLinkOut };
  completePayment: { body: undefined; response: PaymentLinkStateResult };
  cancelPayment: { body: undefined; response: PaymentLinkStateResult };
}

// Compile-time check that RouteShapes names every route and nothing else.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const shapesNameEveryRoute: Exact<keyof RouteShapes, RouteKey> = true;
void shapesNameEveryRoute;

export type RouteBody<K extends RouteKey> = RouteShapes[K]['body'];
export type RouteResponse<K extends RouteKey> = RouteShapes[K]['response'];

/** The `{name}` placeholders in a path, as a union of names. */
type ParamNames<P extends string> = P extends `${string}{${infer Name}}${infer Rest}` ? Name | ParamNames<Rest> : never;

/** The path parameters a route needs, each a string. */
export type RouteParams<K extends RouteKey> = { [Name in ParamNames<(typeof ROUTES)[K]['path']>]: string };

/** Required query values where declared; otherwise `undefined` leaves a parameter out. */
export type RouteQuery<K extends RouteKey = RouteKey> = RouteShapes[K] extends { query: infer Query }
  ? Query
  : Record<string, string | number | boolean | undefined>;

/**
 * The path for `key` with each `{name}` filled from `params` through `encodeURIComponent`, and
 * `query` appended. A missing parameter throws: a request never goes out with a placeholder.
 */
export function apiPath<K extends RouteKey>(key: K, params: RouteParams<K>, query?: RouteQuery): string {
  const values = params as Record<string, string | undefined>;
  const path = ROUTES[key].path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (typeof value !== 'string' || value === '') throw new Error(`apiPath: ${key} needs ${name}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(name, String(value));
  }
  const qs = search.toString();
  return qs === '' ? path : `${path}?${qs}`;
}
