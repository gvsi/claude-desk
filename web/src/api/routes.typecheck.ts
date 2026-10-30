// Compile-time checks of the route table against the API's own OpenAPI document, run by
// `npm run typecheck`: every `ROUTES[k]` method and path is an operation in `API_OPERATIONS`
// (openapi.gen.ts, from `npm run gen:api`), and each of its 2xx answers names the model in
// `ROUTE_MODELS`, apart from the routes in `NOT_YET_SERVED`, which must still be missing from the
// document; and every operation in `API_OPERATIONS` is some route's, apart from those on
// `NEVER_CALLED`. routes.contract.test.ts makes the same checks at run time from openapi.json, and
// is the only importer of this file.

import type { API_OPERATIONS } from './openapi.gen.ts';
import type { ROUTES, RouteKey } from './routes.ts';

/**
 * The schema each route's 2xx answer carries, by its name in the API's OpenAPI document (Plan 02's
 * read model names; `Name[]` for a list; null for a 204 or the event stream). A route the document
 * doesn't serve yet names the model the web expects, checked once it is served.
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
  people: 'PeopleOut',

  // Proving
  ruleChat: 'RuleChatOut',
  draftRules: 'RulesDraft',
  draftPreset: 'RulesDraft',
  draftSuggestion: 'RulesDraft',
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
  setupTools: 'SetupTools',
  setupConnect: 'ToolRow[]',

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
export const NOT_YET_SERVED = [
  // Copy and Desks
  'deleteDesk',
  'openPreview',
  // Today
  'reports',
  // Conversations
  'takeover',
  'handback',
  'resume',
  'ownerMessage',
  'ownerTyping',
  // Rules, tools, knowledge, people
  'rules',
  'ruleDraft',
  'suggestions',
  'simulateToolChange',
  'addKnowledge',
  'people',
  // Proving
  'ruleChat',
  'draftRules',
  'draftPreset',
  'draftSuggestion',
  'confirmRules',
  'confirmTool',
  'setupRules',
  'setupSituations',
  'setupSafetyCheck',
  'setupConfirm',
  'goLive',
  // Setup
  'startSetup',
  'setup',
  'setupConsent',
  'setupAnswer',
  'setupTools',
  'setupConnect',
  // Public
  'visitorTyping',
  'verifyCheck',
  'visitorInbox',
  'agentKey',
  'sendAgent',
  'agentRun',
  // Tokens
  'paymentLink',
  'completePayment',
  'cancelPayment',
] as const satisfies readonly RouteKey[];

/**
 * Operations the API serves that the web deliberately never calls, as "METHOD /path": one served
 * for another caller (the load balancer, a visiting agent) that no screen needs. None today.
 * Every other operation in the document must be some route's, so a route the API serves under
 * another path or method fails both checks rather than waiting on `NOT_YET_SERVED` forever. Each
 * entry must be served and called by no route.
 */
export const NEVER_CALLED = [] as const satisfies readonly string[];

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Operations = typeof API_OPERATIONS;
type NotYetServed = (typeof NOT_YET_SERVED)[number];

/** A route's operation key in `API_OPERATIONS`: "METHOD /path". */
type OperationOf<K extends RouteKey> = `${(typeof ROUTES)[K]['method']} ${(typeof ROUTES)[K]['path']}`;

/** The schema names of an operation's 2xx answers, without a proving route's 202 retry. */
type AnswerNames<K extends RouteKey, Answers> = {
  [Status in keyof Answers]: Status extends 202
    ? (typeof ROUTES)[K] extends { proving: true }
      ? Answers[Status] extends 'ProvingPending'
        ? never
        : Answers[Status]
      : Answers[Status]
    : Answers[Status];
}[keyof Answers];

type Assert<T extends true> = T;

/** The answer names on their own, since the document serves no proving route yet. */
export type AnswerNameChecks = [
  // A proving route's 202 retry isn't its model,
  Assert<Equal<AnswerNames<'draftRules', { 200: 'RulesDraft'; 202: 'ProvingPending' }>, 'RulesDraft'>>,
  // but any other route's 202 is, as each of its 2xx answers is.
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
    ? Equal<AnswerNames<K, Operations[OperationOf<K>]>, (typeof ROUTE_MODELS)[K]> extends true
      ? never
      : `${K}: the 2xx answers of ${OperationOf<K>} don't name ROUTE_MODELS.${K}`
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
