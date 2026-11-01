// Compile-time checks of the route table against the API's own OpenAPI document, run by
// `npm run typecheck`: every `ROUTES[k]` method and path is an operation in `API_OPERATIONS`
// (openapi.gen.ts, from `npm run gen:api`), and each of its 2xx answers names the model in
// `ROUTE_MODELS` (but a proving route's 202, which must be the retry, `ProvingPending`), apart
// from the routes in `NOT_YET_SERVED`, which must still be missing from the document; and every
// operation in `API_OPERATIONS` is some route's, apart from those on `NEVER_CALLED`.
// routes.contract.test.ts makes the same checks at run time from openapi.json, and is the only
// importer of this file.

import type { API_OPERATIONS, SendAgentIn, SetupStartIn } from './openapi.gen.ts';
import type { ROUTES, RouteKey } from './routes.ts';
import type { AgentTaskBody, StartSetupBody } from './views.ts';

/**
 * The schema each route's 2xx answer carries, by its name in the API's OpenAPI document (Plan 02's
 * read model names; `Name[]` for a list; null for a 204 or the event stream). A route the document
 * doesn't serve yet names the model the web expects, checked once it is served.
 *
 * This list, like `ROUTES`, is the web's. It names the same answers that `RouteShapes` in
 * routes.ts types for `request()`, and nothing checks the two against each other yet. A served
 * route whose path, method or answer model differs from them is reconciled with the web app plan
 * (plan 04) together with `RouteShapes`, never by editing this list alone, which would make both
 * checks pass while screens keep the old type.
 */
export const ROUTE_MODELS = {
  // Copy and Desks
  copies: 'CopyOut',
  startOver: 'CopyOut',
  me: 'CopyOut',
  desks: 'BusinessOut[]',
  setAnswering: 'DeskUpdated',
  deleteDesk: null,
  openPreview: 'VisitorSession',

  // Today
  today: 'Today',
  briefing: 'BriefingList',
  needsYou: 'NeedsYouItem[]',
  reports: 'Reports',
  answer: 'ApprovalAnswerOut',
  handoffDone: 'DeskUpdated',

  // Conversations
  conversations: 'ConversationSummary[]',
  conversation: 'OwnerTranscript',
  takeover: 'SessionState',
  handback: 'SessionState',
  resume: 'SessionState',
  ownerMessage: 'OwnerMessageResult',
  ownerTyping: null,
  decision: 'Decision',

  // Safety
  safety: 'Attempt[]',
  ledger: 'LedgerPage',
  ownerInbox: 'DemoInboxEntry[]',
  health: 'HealthOut',

  // Rules, tools, knowledge, people
  rules: 'RulesView',
  ruleDraft: 'RulesDraft',
  suggestions: 'Suggestion[]',
  simulateToolChange: 'ToolProfile',
  addKnowledge: 'KnowledgeItem',
  knowledge: 'KnowledgeRow[]',
  people: 'PeopleOut',

  // Proving
  ruleChat: 'RuleChatOut',
  draftRules: 'RulesDraft',
  draftPreset: 'RulesDraft',
  draftSuggestion: 'RulesDraft',
  draftMoneyCap: 'RulesDraft',
  confirmRules: 'PolicyVersion',
  confirmTool: 'ToolConfirmed',
  setupRules: 'RulesDraft',
  setupSituations: 'SituationResult[]',
  setupSafetyCheck: 'SafetyCheck',
  setupConfirm: 'PolicyVersion',
  goLive: 'WentLive',

  // Setup
  startSetup: 'SetupState',
  setup: 'SetupState',
  setupConsent: 'SetupState',
  setupAnswer: 'SetupState',
  setupProposal: 'SetupState',
  setupSuggestions: 'SetupState',
  setupEvents: null,
  setupTools: 'SetupTools',
  setupConnect: 'ToolRow[]',
  setupPublicLines: 'SetupPublicLines',
  setupPublicLine: 'SetupPublicLines',
  setupPublicLinesConfirm: 'SetupPublicLines',
  removePublicLine: 'SetupPublicLines',
  removePublicPrice: 'SetupPublicLines',

  // Public
  publicDesk: 'PublicDesk',
  openSession: 'VisitorSession',
  visitorSession: 'VisitorTranscript',
  sendMessage: 'MessageAccepted',
  visitorTyping: null,
  events: null,
  cancelRequest: 'CancelAccepted',
  verifyCheck: 'VerifyChecked',
  visitorInbox: 'DemoInboxEntry[]',
  agentCard: 'AgentCardOut',
  agentKey: 'DemoAgentIssued',
  agentTasks: 'AgentTasks',
  sendAgent: 'AgentRunStarted',
  agentRun: 'DemoAgentRun',

  // Tokens
  paymentLink: 'PaymentLinkView',
  completePayment: 'PaymentLinkStateResult',
  cancelPayment: 'PaymentLinkStateResult',
} as const satisfies Record<RouteKey, string | null>;

/**
 * Routes the web calls that the API's document doesn't serve yet: the API core plan (02a) serves
 * the rest, and its owner, setup and agents plan (02b) adds most of these. Each must still be
 * missing from the document: once the API serves one, both checks fail until it comes off this
 * list and its answers match `ROUTE_MODELS`.
 */
export const NOT_YET_SERVED = [] as const satisfies readonly RouteKey[];

/**
 * Operations the API serves that the web deliberately never calls, as "METHOD /path": one served
 * for another caller (the load balancer, a visiting agent) that no screen needs, or one no plan 04
 * screen uses. Every other operation in the document must be some route's, so a route the API
 * serves under another path or method fails both checks rather than waiting on `NOT_YET_SERVED`
 * forever. Each entry must be served and called by no route.
 */
export const NEVER_CALLED = [
  // Served for other callers: the document link a visitor opens, and a visiting agent's turn.
  'GET /api/d/{token}',
  'POST /api/a2a/{slug}',
  // A new Desk goes through setup (`startSetup`).
  'POST /api/owner/desks',
  // Settings is read-only by the owner's ruling, and no plan 04 task edits these parts.
  'PUT /api/owner/desks/{desk_id}/people',
  'PUT /api/owner/desks/{desk_id}/business',
  'PUT /api/owner/desks/{desk_id}/charter',
  'PUT /api/owner/desks/{desk_id}/hours',
  'PUT /api/owner/desks/{desk_id}/prices',
  'PUT /api/owner/desks/{desk_id}/calendar',
  'PUT /api/owner/desks/{desk_id}/notifications',
  // Verification starts through Claude's tool in the chat; the page only checks the code (`verifyCheck`).
  'POST /api/public/desks/{slug}/verify/start',
  // No plan 04 task uploads a document.
  'POST /api/owner/desks/{desk_id}/documents',
  // Task 14 (Connectors) adds `connectTools` and `toolDecisions`.
  'POST /api/owner/desks/{desk_id}/tools/connect',
  'GET /api/owner/desks/{desk_id}/tools/{tool}/decisions',
] as const satisfies readonly string[];

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Operations = typeof API_OPERATIONS;
type NotYetServed = (typeof NOT_YET_SERVED)[number];

/** A route's operation key in `API_OPERATIONS`: "METHOD /path". */
type OperationOf<K extends RouteKey> = `${(typeof ROUTES)[K]['method']} ${(typeof ROUTES)[K]['path']}`;

/**
 * The schema names of an operation's final 2xx answers: every one but a proving route's 202, which
 * is the retry `request()` follows whatever it names (RetryProblem checks that it is the retry).
 */
type AnswerNames<K extends RouteKey, Answers> = {
  [Status in keyof Answers]: Status extends 202 ? ((typeof ROUTES)[K] extends { proving: true } ? never : Answers[Status]) : Answers[Status];
}[keyof Answers];

/** A proving route's 202 that isn't the retry, `ProvingPending`, as a sentence, or never. */
type RetryProblem<K extends RouteKey, Answers> = (typeof ROUTES)[K] extends { proving: true }
  ? Answers extends { 202: infer Name extends string | null }
    ? Equal<Name, 'ProvingPending'> extends true
      ? never
      : `${K}: ${OperationOf<K>} answers 202 with ${Name}, but a proving route's 202 is the retry request() follows, so it must be ProvingPending`
    : never
  : never;

/** A route whose 2xx answers are only a proving route's 202, as a sentence. */
type NoFinalAnswer<K extends RouteKey> =
  `${K}: ${OperationOf<K>} has no final answer besides its 202, so nothing names ${(typeof ROUTE_MODELS)[K]}`;

/**
 * What is wrong with a served route's 2xx `Answers`, as sentences, or never: a proving route's 202
 * that isn't the retry, no final answer at all, or final answers that aren't exactly its model.
 * Spelled out as `RouteProblems` is, so the compiler prints the sentences rather than this alias.
 */
type AnswerProblems<K extends RouteKey, Answers> =
  (
    | RetryProblem<K, Answers>
    | ([AnswerNames<K, Answers>] extends [never]
        ? NoFinalAnswer<K>
        : Equal<AnswerNames<K, Answers>, (typeof ROUTE_MODELS)[K]> extends true
          ? never
          : `${K}: the 2xx answers of ${OperationOf<K>} don't name ROUTE_MODELS.${K}`)
  ) extends infer P
    ? P extends string
      ? P
      : never
    : never;

type Assert<T extends true> = T;

/** RetryProblem's sentence for `draftRules` answering 202 with RulesDraft, for the checks below. */
type NotTheRetry =
  "draftRules: POST /api/owner/policy/{desk_id}/draft answers 202 with RulesDraft, but a proving route's 202 is the retry request() follows, so it must be ProvingPending";

/** The answer names and problems on their own, since the document serves no proving route yet. */
export type AnswerNameChecks = [
  // A proving route's 202 retry isn't its model,
  Assert<Equal<AnswerNames<'draftRules', { 200: 'RulesDraft'; 202: 'ProvingPending' }>, 'RulesDraft'>>,
  Assert<Equal<AnswerProblems<'draftRules', { 200: 'RulesDraft'; 202: 'ProvingPending' }>, never>>,
  // so a proving route that answers only with the retry names nothing, which no model equals,
  Assert<Equal<AnswerNames<'draftRules', { 202: 'ProvingPending' }>, never>>,
  Assert<Equal<AnswerProblems<'draftPreset', { 202: 'ProvingPending' }>, NoFinalAnswer<'draftPreset'>>>,
  // and since `request()` follows every proving 202 as the retry, a proving route's 202 must be
  // ProvingPending and is never its final answer, even when it names the model.
  Assert<Equal<AnswerProblems<'draftRules', { 200: 'RulesDraft'; 202: 'RulesDraft' }>, NotTheRetry>>,
  Assert<Equal<AnswerProblems<'draftRules', { 202: 'RulesDraft' }>, NotTheRetry | NoFinalAnswer<'draftRules'>>>,
  // but any other route's 202 is, as each of its 2xx answers is.
  Assert<Equal<AnswerProblems<'setupConsent', { 200: 'SetupState'; 202: 'SetupState' }>, never>>,
  Assert<Equal<AnswerNames<'me', { 200: 'CopyOut'; 202: 'ProvingPending' }>, 'CopyOut' | 'ProvingPending'>>,
  Assert<Equal<AnswerNames<'sendMessage', { 202: 'MessageAccepted' }>, 'MessageAccepted'>>,
  Assert<Equal<AnswerNames<'events', { 200: null }>, null>>,
];

/**
 * What is wrong with the `Served` operations against the `Called` ones and the `Listed` ones
 * (NEVER_CALLED), or never: an operation that no route calls and the list doesn't name, such as a
 * route the API serves under another path or method, and a listed operation that a route calls or
 * the document doesn't serve. Spelled out as `RouteProblems` is, so the compiler prints the
 * sentences rather than this alias.
 */
type OperationProblems<Served extends string, Called extends string, Listed extends string> =
  (
    | (Served extends Called | Listed ? never : `${Served} is in openapi.json, but no route calls it: match a route to it, or put it on NEVER_CALLED`)
    | (Listed extends Called
        ? `${Listed} is on NEVER_CALLED, but a route calls it`
        : Listed extends Served
          ? never
          : `${Listed} is on NEVER_CALLED, but openapi.json doesn't serve it`)
  ) extends infer P
    ? P extends string
      ? P
      : never
    : never;

/** The operation checks on their own, since every operation the document serves is called today. */
export type OperationProblemChecks = [
  // An operation a route calls, or one on NEVER_CALLED, is fine;
  Assert<Equal<OperationProblems<'GET /a' | 'GET /b', 'GET /a' | 'GET /c', 'GET /b'>, never>>,
  // one that no route calls isn't, such as a route the API serves under another path,
  Assert<
    Equal<
      OperationProblems<'GET /as', 'GET /a', never>,
      'GET /as is in openapi.json, but no route calls it: match a route to it, or put it on NEVER_CALLED'
    >
  >,
  // and nor is a listed one that a route calls or the document doesn't serve.
  Assert<
    Equal<
      OperationProblems<'GET /a', 'GET /a', 'GET /a' | 'GET /gone'>,
      'GET /a is on NEVER_CALLED, but a route calls it' | "GET /gone is on NEVER_CALLED, but openapi.json doesn't serve it"
    >
  >,
];

/** What is wrong with a route against the document, as a sentence, or never. */
type RouteProblem<K extends RouteKey> = K extends NotYetServed
  ? OperationOf<K> extends keyof Operations
    ? `${K} is served now: take it off NOT_YET_SERVED`
    : never
  : OperationOf<K> extends keyof Operations
    ? AnswerProblems<K, Operations[OperationOf<K>]>
    : `${K}: ${OperationOf<K>} is not in openapi.json`;

/** Every route's problem, spelled out (a distributive copy, so the compiler prints the sentences). */
type RouteProblems = { [K in RouteKey]: RouteProblem<K> }[RouteKey] extends infer P ? (P extends string ? P : never) : never;

/** Every route's operation, pending ones included. */
type CalledOperations = { [K in RouteKey]: OperationOf<K> }[RouteKey];

/** Every problem of the routes and of the document's operations, spelled out the same way. */
type Problems =
  (RouteProblems | OperationProblems<keyof Operations & string, CalledOperations, (typeof NEVER_CALLED)[number]>) extends infer P
    ? P extends string
      ? P
      : never
    : never;

/** `true` only when no route or operation has a problem; otherwise the compiler names each one. */
export const routesMatchTheApi: [Problems] extends [never] ? true : Problems = true;

/**
 * Whether `Body`, a body the web sends to start something, fits the API's model for it: no field the
 * model lacks, the client idempotency key among its fields (one per click, so a repeat finds what
 * the first started), and each typed as the model takes it, but `task`, which the web types as a
 * string and the mock checks.
 */
type KeyedBodyFits<Body, Model> = [Exclude<keyof Body, keyof Model>] extends [never]
  ? 'idempotency_key' extends keyof Body
    ? Body extends Omit<Model, 'task'>
      ? true
      : false
    : false
  : false;

/** The two start bodies that carry a key, against the API's `SendAgentIn` and `SetupStartIn`. */
export type KeyedBodyChecks = [
  Assert<KeyedBodyFits<AgentTaskBody, SendAgentIn>>,
  Assert<KeyedBodyFits<StartSetupBody, SetupStartIn>>,
  // A body with no key, or with a field the model lacks, doesn't fit.
  Assert<Equal<KeyedBodyFits<{ task: string }, SendAgentIn>, false>>,
  Assert<Equal<KeyedBodyFits<{ task: string; idempotency_key?: string; extra: 1 }, SendAgentIn>, false>>,
];
