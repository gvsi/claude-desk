/**
 * The routes the mock API answers, the way Plan 02's API does, from and into a copy: `Server`
 * holds one copy and its turns in progress, and `SERVED` answers each route from it and from the
 * request's cookies (`Cookies`), the owner cookie for the copy and a visitor cookie per Desk slug
 * naming a session. The store (store.ts) finds the copy a request reaches, by `reachOf`, and its
 * cookies: kept in the store for the screen tests' one page, real ones on the dev server. Nothing
 * here is a credential.
 */
import type { ApprovalAnswer, Decision, DeskUpdated, PaymentLinkState, PaymentLinkStateResult, RuleCard } from '../api/contracts.ts';
import { ROUTES, type RouteKey, type RouteResponse, type RouteSpec } from '../api/routes.ts';
import type {
  AgentRunStarted,
  ApprovalAnswerOut,
  CancelAccepted,
  CancelReason,
  MessageAccepted,
  ToolConfirmEntry,
  VerifyChecked,
  VisitorSession,
} from '../api/views.ts';
import { AgentRuns, agentCardOut, demoAgentIssued, isDemoAgentTask } from './agents.ts';
import {
  attempts,
  briefingList,
  businessOut,
  conversationSummary,
  copyOut,
  HEALTH,
  ledgerPage,
  needsYou,
  ownerTranscript,
  paymentLinkOut,
  peopleOut,
  publicDesk,
  reports,
  rulesView,
  today,
  visitorTranscript,
} from './readModels.ts';
import { AFTER_VERIFY, EVENT_GAP_MS, afterAnswer, allows, cardDiffFor, matchRule, turnEnd, type Language, type Step } from './script.ts';
import { seedWorld, type MockSeed } from './seed.ts';
import { MockWorld, isoTime, type DeskRecord, type LinkRecord, type SessionRecord } from './world.ts';

/** Plan 02's limit on a visitor's message and on the owner's words. */
const MESSAGE_MAX = 2000;

const OWNER_KINDS: ReadonlySet<unknown> = new Set(['say', 'whisper']);

/** A demo code as the API takes one: six digits. */
const DEMO_CODE_SHAPE = /^\d{6}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The cookies a request carries, as the API reads who is asking from them, and the ones its answer
 * sets: `desk_owner` for the copy the request reached, and `desk_visitor` for a Desk's slug,
 * naming one of its sessions.
 */
export interface Cookies {
  /** The request carries the owner cookie of the copy it reached. */
  readonly owner: boolean;
  /** The session the request's visitor cookie names for `slug`, if it names one. */
  visitor(slug: string): string | undefined;
  /** Answers with the owner cookie for the copy the request reached. */
  setOwner(): void;
  /**
   * Answers with a new owner cookie for the copy the request reached, which a start over has just
   * replaced, as the API issues one for a new copy: the cookie the request carried names nothing now.
   */
  renewOwner(): void;
  /** Answers with the visitor cookie for `slug`, naming `sessionId`. */
  setVisitor(slug: string, sessionId: string): void;
}

/** A request as a route sees it: path params, query, the parsed JSON body and its cookies. */
export interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** A body was sent but wasn't JSON. */
  malformed: boolean;
  cookies: Cookies;
}

/** The statuses a route answers its model with; a 204 has no body. */
type OkStatus = 200 | 201 | 202 | 204;
/** The statuses a route refuses with. */
type FailStatus = 401 | 403 | 404 | 409 | 422 | 429 | 501 | 503;

/** A refusal's body, as the API writes it: `error`, with a kernel failure's `code` or a conflict's `decision`. */
export interface ErrorBody {
  error: string;
  code?: string;
  decision?: Decision;
  /** An `above_money_cap` refusal's limit for taking money without asking. */
  cap_cents?: number;
  /** A payment link's state, when a 409 says why it can't be paid or cancelled now. */
  state?: PaymentLinkState;
  /** With that state: `rules_changed` when a change to the business's rules cancelled the link. */
  cancel_reason?: CancelReason | null;
}

/** A route's refusal: a 4xx or 5xx with an `{error}` body. */
export interface Failure {
  status: FailStatus;
  body: ErrorBody;
}

/**
 * What a route answers: its model `T` with a 2xx, or a refusal. The event stream's model is
 * `never`: its 200 has no body, and the events follow on the connection.
 */
export type Served<T> = ([T] extends [never] ? { status: 200; body?: undefined } : { status: OkStatus; body: T }) | Failure;

/** Any route's answer, as the store hands it to the transport. */
export type AnyServed = { status: number; body?: unknown };

/** The routes the mock answers from a copy, each one's answer checked against its route's model. */
type ServedRoutes = { [K in RouteKey]?: (sv: Server, req: Req) => Served<RouteResponse<K>> };

/** The routes that answer without a copy. */
type UnscopedRoutes = { [K in RouteKey]?: (req: Req) => Served<RouteResponse<K>> };

const ok = <T>(body: T, status: OkStatus = 200): { status: OkStatus; body: T } => ({ status, body });
/** A 204: done, nothing to say. */
const NO_CONTENT = { status: 204, body: undefined } as const;
export const failWith = (status: FailStatus, error: string, extra: Omit<ErrorBody, 'error'> = {}): Failure => ({
  status,
  body: { error, ...extra },
});
const NO_OWNER = failWith(401, 'no_owner_session');
const NO_SESSION = failWith(401, 'no_session');
const NOT_FOUND = failWith(404, 'not_found');
const INVALID = failWith(422, 'invalid');

const ANSWERS: ReadonlySet<string> = new Set<ApprovalAnswer>(['allow_once', 'deny_once', 'allow_person', 'deny_always']);

const CARD_MODES: ReadonlySet<unknown> = new Set<RuleCard['mode']>(['auto', 'ask', 'never']);
const CARD_WHO: ReadonlySet<unknown> = new Set<RuleCard['who']>(['anyone', 'verified', 'record_owner', 'person', 'agent']);

/** A rule card as a draft takes one: its id, tool, mode, who and reason, and a limit that is a whole number of cents or none. */
function isRuleCard(value: unknown): value is RuleCard {
  if (!isRecord(value)) return false;
  const cap = value.max_amount_cents;
  return (
    typeof value.card_id === 'string' &&
    value.card_id !== '' &&
    typeof value.applies_to === 'string' &&
    CARD_MODES.has(value.mode) &&
    CARD_WHO.has(value.who) &&
    typeof value.reason === 'string' &&
    (cap === undefined || cap === null || (Number.isSafeInteger(cap) && (cap as number) >= 0))
  );
}

/**
 * A `confirmTool` batch as the API takes one (plan 02b Task 7): one or more tools, each named once
 * with the hash of the definition the owner confirms, and whether to turn them on.
 */
function toolBatch(body: unknown): { entries: ToolConfirmEntry[]; enable: boolean } | null {
  if (!isRecord(body) || typeof body.enable !== 'boolean' || !Array.isArray(body.tools) || body.tools.length === 0) return null;
  const entries: ToolConfirmEntry[] = [];
  for (const entry of body.tools as unknown[]) {
    if (!isRecord(entry) || typeof entry.tool !== 'string' || typeof entry.definition_sha256 !== 'string' || entry.definition_sha256 === '') return null;
    if (entries.some((seen) => seen.tool === entry.tool)) return null;
    entries.push({ tool: entry.tool as ToolConfirmEntry['tool'], definition_sha256: entry.definition_sha256 });
  }
  return { entries, enable: body.enable };
}

/** A turn's step as queued, with the session's generation then: a take-over since fences it off (`Server.tick`). */
type Scheduled = { step: Step; language: Language; text: string; generation: number };

/**
 * How a store numbers its copies and names their payment links: the screen tests' one copy from
 * 1, so its ids are the seed's, and the dev server's at random, so each copy's are its own.
 */
export interface CopyNaming {
  /** A new copy's number, which its ids and slugs come from (seed.ts `copyIds`). */
  copyNo(): number;
  /** A new payment link's token, unique across the store's copies. */
  linkToken(): string;
}

/** The API's side of one copy: the copy itself and the turns in progress. */
export class Server {
  world: MockWorld;
  /** The built-in agent's runs in this copy. */
  readonly agents = new AgentRuns();
  private readonly turns = new Map<string, { queue: Scheduled[]; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    readonly seed: MockSeed,
    private readonly naming: CopyNaming,
  ) {
    this.world = this.freshWorld();
  }

  private freshWorld(): MockWorld {
    const world = new MockWorld(this.seed, this.naming.copyNo(), () => this.naming.linkToken());
    seedWorld(world);
    return world;
  }

  /** A new copy of the same seed, with new ids and slugs; the old copy's chats and turns are left behind. */
  startOver(): void {
    this.stopTurns();
    this.world = this.freshWorld();
  }

  stopTurns(): void {
    for (const turn of this.turns.values()) if (turn.timer !== null) clearTimeout(turn.timer);
    this.turns.clear();
    this.agents.stop();
  }

  /** Deletes `desk` from the copy: its chats close, and a turn one of them has in progress says nothing more. */
  deleteDesk(desk: DeskRecord): void {
    for (const session of this.world.sessionsOf(desk.summary.desk_id)) {
      const sessionId = session.state.session_id;
      const timer = this.turns.get(sessionId)?.timer;
      if (timer != null) clearTimeout(timer);
      this.turns.delete(sessionId);
    }
    this.world.deleteDesk(desk);
  }

  /** The session the request's visitor cookie names for `slug`, or why there is none. */
  visitor(slug: string | undefined, cookies: Cookies): { desk: DeskRecord; session: SessionRecord } | Failure {
    const desk = this.world.deskBySlug(slug);
    if (!desk || slug === undefined) return NOT_FOUND;
    const sessionId = cookies.visitor(slug);
    const session = sessionId === undefined ? undefined : this.world.sessions.get(sessionId);
    if (!session || session.deskId !== desk.summary.desk_id) return NO_SESSION;
    return { desk, session };
  }

  /** The owner's Desk named in the path, or why the request can't have it. */
  ownerDesk(deskId: string | undefined, cookies: Cookies): DeskRecord | Failure {
    if (!cookies.owner) return NO_OWNER;
    return this.world.desk(deskId) ?? NOT_FOUND;
  }

  /**
   * Queues `steps` after whatever the session's turn is doing, one event every `EVENT_GAP_MS`, then
   * `turn_end`, at the session's generation now.
   */
  runTurn(session: SessionRecord, steps: readonly Step[], language: Language, text: string): void {
    const sessionId = session.state.session_id;
    let turn = this.turns.get(sessionId);
    if (!turn) {
      turn = { queue: [], timer: null };
      this.turns.set(sessionId, turn);
    }
    const { generation } = session.state;
    for (const step of [...steps, turnEnd]) turn.queue.push({ step, language, text, generation });
    if (turn.timer === null) this.tick(sessionId);
  }

  private tick(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const world = this.world;
    turn.timer = setTimeout(() => {
      turn.timer = null;
      const session = world.sessions.get(sessionId);
      let next = turn.queue.shift();
      if (world !== this.world || !session) return;
      // The owner took over after these steps were queued: like the API at a stale generation, they
      // never decide, run or say anything. The turn still ends, so "Claude is writing" clears.
      while (next !== undefined && next.generation !== session.state.generation && next.step.unfenced !== true) next = turn.queue.shift();
      if (next === undefined) return;
      world.emit(session, next.step(world.context(session, next.language, next.text)));
      if (turn.queue.length > 0) this.tick(sessionId);
    }, EVENT_GAP_MS);
  }
}

export const isFailure = (value: Failure | object): value is Failure => 'status' in value;

/**
 * The chat an owner's take-over, hand-back or resume names, at the generation the owner last read,
 * or why it can't be acted on: a chat that has moved on since then is a stale generation.
 */
function ownerSession(sv: Server, req: Req): SessionRecord | Failure {
  if (!req.cookies.owner) return NO_OWNER;
  const session = sv.world.sessions.get(req.params.session_id ?? '');
  if (!session) return NOT_FOUND;
  const generation = isRecord(req.body) ? req.body.generation : undefined;
  if (req.malformed || !Number.isSafeInteger(generation)) return INVALID;
  if (generation !== session.state.generation) return failWith(409, 'kernel', { code: 'stale_generation' });
  return session;
}

/**
 * A payment link's refusal once it isn't `issued`, as the API answers a kernel 409 on the checkout
 * (plan 02b): the link's state now and, for a link a rule change cancelled, why.
 */
function linkClosed(link: LinkRecord): Failure {
  return failWith(409, 'kernel', { code: 'conflict', state: link.view.state, cancel_reason: link.cancelReason });
}

/** Every route the mock answers from a copy. Unserved ones fall through to the catch-all, which records them. */
const SERVED: ServedRoutes = {
  copies(sv, req) {
    const passcode = isRecord(req.body) ? req.body.passcode : undefined;
    if (req.malformed || typeof passcode !== 'string' || passcode === '') return INVALID;
    if (passcode === 'wrong') return failWith(401, 'wrong_passcode');
    req.cookies.setOwner();
    return ok(copyOut(sv.world), 201);
  },
  startOver(sv, req) {
    if (!req.cookies.owner) return NO_OWNER;
    sv.startOver();
    req.cookies.renewOwner();
    return ok(copyOut(sv.world));
  },
  me(sv, req) {
    return req.cookies.owner ? ok(copyOut(sv.world)) : NO_OWNER;
  },
  desks(sv, req) {
    return req.cookies.owner ? ok([businessOut(sv.world)]) : NO_OWNER;
  },
  setAnswering(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    const on = isRecord(req.body) ? req.body.on : undefined;
    if (typeof on !== 'boolean') return INVALID;
    desk.summary.answering = on;
    return ok({ desk_id: desk.summary.desk_id, updated_at: isoTime(sv.world.now()) } satisfies DeskUpdated);
  },
  deleteDesk(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    sv.deleteDesk(desk);
    return NO_CONTENT;
  },
  openPreview(sv, req) {
    // Always a new preview chat, as the API's is (plan 02b): its owner-path request never carries
    // the visitor cookie, which is scoped to the Desk's public path, so the page reads the chat it
    // has (`visitorSession`) before it asks for one.
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    const slug = desk.summary.slug;
    const session = sv.world.addSession(desk, { ownerPreview: true });
    req.cookies.setVisitor(slug, session.state.session_id);
    return ok({ state: session.state, resumed: false } satisfies VisitorSession);
  },
  today(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(today(sv.world, desk));
  },
  briefing(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(briefingList(sv.world, desk));
  },
  needsYou(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(needsYou(sv.world, desk));
  },
  reports(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(reports(sv.world, desk));
  },
  answer(sv, req) {
    if (!req.cookies.owner) return NO_OWNER;
    const record = sv.world.decisions.get(req.params.decision_id ?? '');
    if (!record) return NOT_FOUND;
    const answer = isRecord(req.body) ? req.body.answer : undefined;
    if (typeof answer !== 'string' || !ANSWERS.has(answer)) return failWith(422, 'kernel', { code: 'invalid' });
    if (record.decision.state !== 'held') return failWith(409, 'already_resolved', { decision: record.decision });
    const given = answer as ApprovalAnswer;
    if (!(record.decision.answers ?? []).includes(given)) return failWith(422, 'kernel', { code: 'invalid' });
    const session = sv.world.sessions.get(record.decision.session_id);
    const decision = sv.world.answer(record, given);
    if (session) sv.runTurn(session, afterAnswer(given, decision), session.language, '');
    const out: ApprovalAnswerOut = {
      decision,
      execution_state: allows(given) ? 'succeeded' : null,
      card_diff: cardDiffFor(given, decision, session?.person ?? null),
    };
    return ok(out);
  },
  handoffDone(sv, req) {
    if (!req.cookies.owner) return NO_OWNER;
    const record = sv.world.handoffs.get(req.params.handoff_id ?? '');
    if (!record) return NOT_FOUND;
    if (record.handoff.status !== 'open') return failWith(409, 'kernel', { code: 'conflict' });
    sv.world.closeHandoff(record);
    return ok({ desk_id: record.deskId, updated_at: isoTime(sv.world.now()) } satisfies DeskUpdated);
  },
  conversations(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    const sessions = sv.world.sessionsOf(desk.summary.desk_id).sort((a, b) => b.lastActivity - a.lastActivity);
    return ok(sessions.map((s) => conversationSummary(sv.world, s)));
  },
  conversation(sv, req) {
    if (!req.cookies.owner) return NO_OWNER;
    const session = sv.world.sessions.get(req.params.session_id ?? '');
    if (!session) return NOT_FOUND;
    const after = Number(req.query.get('after') ?? '0');
    return ok(ownerTranscript(session, Number.isSafeInteger(after) ? after : 0, sv.world.now()));
  },
  takeover(sv, req) {
    const session = ownerSession(sv, req);
    if (isFailure(session)) return session;
    if (session.state.mode === 'owner') return failWith(409, 'kernel', { code: 'mode_owner' });
    return ok(sv.world.takeOver(session));
  },
  handback(sv, req) {
    const session = ownerSession(sv, req);
    if (isFailure(session)) return session;
    if (session.state.mode !== 'owner') return failWith(409, 'kernel', { code: 'conflict' });
    return ok(sv.world.handBack(session));
  },
  resume(sv, req) {
    const session = ownerSession(sv, req);
    if (isFailure(session)) return session;
    if (session.state.mode !== 'paused') return failWith(409, 'kernel', { code: 'conflict' });
    return ok(sv.world.resume(session));
  },
  ownerMessage(sv, req) {
    if (!req.cookies.owner) return NO_OWNER;
    const session = sv.world.sessions.get(req.params.session_id ?? '');
    if (!session) return NOT_FOUND;
    const text = isRecord(req.body) ? req.body.text : undefined;
    const kind = isRecord(req.body) ? req.body.kind : undefined;
    if (req.malformed || typeof text !== 'string' || text.trim() === '' || text.length > MESSAGE_MAX || !OWNER_KINDS.has(kind)) return INVALID;
    if (kind === 'whisper') return ok(sv.world.whisper(session, text));
    // Her own words reach the visitor only once she is in the chat.
    if (session.state.mode !== 'owner') return failWith(409, 'take_over_first');
    return ok(sv.world.say(session, text));
  },
  ownerTyping(sv, req) {
    if (!req.cookies.owner) return NO_OWNER;
    const session = sv.world.sessions.get(req.params.session_id ?? '');
    if (!session) return NOT_FOUND;
    const generation = isRecord(req.body) ? req.body.generation : undefined;
    if (req.malformed || !Number.isSafeInteger(generation)) return INVALID;
    if (session.state.mode !== 'owner') return failWith(409, 'take_over_first');
    if (generation !== session.state.generation) return failWith(409, 'kernel', { code: 'stale_generation' });
    sv.world.ownerTyping(session);
    return NO_CONTENT;
  },
  decision(sv, req) {
    if (!req.cookies.owner) return NO_OWNER;
    const record = sv.world.decisions.get(req.params.decision_id ?? '');
    return record ? ok(record.decision) : NOT_FOUND;
  },
  ownerInbox(sv, req) {
    // Everything the copy's Demo inbox holds, as the kernel's owner form answers.
    return req.cookies.owner ? ok(sv.world.inbox.map((record) => record.entry)) : NO_OWNER;
  },
  safety(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(attempts(sv.world, desk));
  },
  ledger(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(ledgerPage(desk));
  },
  draftRules(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    const add = isRecord(req.body) ? req.body.add : undefined;
    if (req.malformed || !Array.isArray(add) || add.length === 0 || !add.every(isRuleCard)) return INVALID;
    // The kernel won't draft a card that takes more money on its own than the active version's limit allows.
    const cap = desk.policy.auto_money_cap_cents ?? 0;
    if (add.some((card) => card.mode === 'auto' && (card.max_amount_cents ?? 0) > cap)) {
      return failWith(422, 'above_money_cap', { cap_cents: cap });
    }
    return ok(sv.world.draft(desk, add));
  },
  rules(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(rulesView(desk));
  },
  ruleDraft(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    // Only an open draft of this Desk: an active, superseded or unknown version is not a draft.
    const version = req.params.version ?? '';
    const record = /^\d{1,9}$/.test(version) ? desk.drafts.get(Number(version)) : undefined;
    return record ? ok(record.draft) : NOT_FOUND;
  },
  people(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    return isFailure(desk) ? desk : ok(peopleOut(sv.world, desk));
  },
  confirmRules(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    const version = isRecord(req.body) ? req.body.version : undefined;
    if (req.malformed || !Number.isSafeInteger(version)) return INVALID;
    const confirmed = sv.world.confirmDraft(desk, version as number);
    if (confirmed === 'not_found') return NOT_FOUND;
    // Drafted from rules that have changed since, or a tool it turns on changed again since: the
    // kernel refuses and nothing changes. The API answers every kernel 409 on confirm the same way.
    if (confirmed === 'stale' || confirmed === 'conflict') return failWith(409, 'rules_changed_since_draft');
    return ok(confirmed);
  },
  confirmTool(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id, req.cookies);
    if (isFailure(desk)) return desk;
    const batch = req.malformed ? null : toolBatch(req.body);
    if (batch === null) return INVALID;
    const confirmed = sv.world.confirmTools(desk, batch.entries, batch.enable);
    if (confirmed === 'not_found') return NOT_FOUND;
    // Another hash than the one listed, or turning verification off: the kernel refuses, and nothing changes.
    if (confirmed === 'conflict') return failWith(409, 'kernel', { code: 'conflict' });
    return ok(confirmed);
  },
  publicDesk(sv, req) {
    const desk = sv.world.deskBySlug(req.params.slug);
    if (!desk) return NOT_FOUND;
    return ok(publicDesk(desk, req.query.get('lang') === 'es' ? 'es' : 'en'));
  },
  openSession(sv, req) {
    const slug = req.params.slug ?? '';
    const desk = sv.world.deskBySlug(slug);
    if (!desk) return NOT_FOUND;
    const current = sv.visitor(slug, req.cookies);
    if (!isFailure(current)) return ok({ state: current.session.state, resumed: true } satisfies VisitorSession);
    const session = sv.world.addSession(desk);
    req.cookies.setVisitor(slug, session.state.session_id);
    return ok({ state: session.state, resumed: false } satisfies VisitorSession);
  },
  visitorSession(sv, req) {
    const visitor = sv.visitor(req.params.slug, req.cookies);
    return isFailure(visitor) ? visitor : ok(visitorTranscript(visitor.session));
  },
  sendMessage(sv, req) {
    const visitor = sv.visitor(req.params.slug, req.cookies);
    if (isFailure(visitor)) return visitor;
    const text = isRecord(req.body) ? req.body.text : undefined;
    if (req.malformed || typeof text !== 'string' || text.length < 1 || text.length > MESSAGE_MAX) return INVALID;
    const { session } = visitor;
    sv.world.visitorText(session, text);
    if (session.state.mode === 'ai') sv.runTurn(session, matchRule(text).steps, session.language, text);
    return ok({ message_id: sv.world.id('vmsg') } satisfies MessageAccepted, 202);
  },
  visitorTyping(sv, req) {
    const visitor = sv.visitor(req.params.slug, req.cookies);
    if (isFailure(visitor)) return visitor;
    sv.world.visitorTyping(visitor.session);
    return NO_CONTENT;
  },
  cancelRequest(sv, req) {
    const visitor = sv.visitor(req.params.slug, req.cookies);
    if (isFailure(visitor)) return visitor;
    const record = sv.world.decisions.get(req.params.decision_id ?? '');
    // Only a decision of this browser's own session: anyone else's is not found.
    if (!record || record.decision.session_id !== visitor.session.state.session_id) return NOT_FOUND;
    if (record.decision.state !== 'held') return failWith(409, 'kernel', { code: 'conflict' });
    // The kernel cancels it; the outcome reaches the chat as the resolved receipt.
    sv.world.cancel(record);
    return ok({ decision_id: record.decision.decision_id } satisfies CancelAccepted, 202);
  },
  verifyCheck(sv, req) {
    const visitor = sv.visitor(req.params.slug, req.cookies);
    if (isFailure(visitor)) return visitor;
    const code = isRecord(req.body) ? req.body.code : undefined;
    if (req.malformed || typeof code !== 'string' || !DEMO_CODE_SHAPE.test(code)) return INVALID;
    const { session } = visitor;
    // One answer for a wrong, expired or used-up code, so a refusal never says which.
    if (!sv.world.checkCode(session, code)) return failWith(422, 'kernel', { code: 'invalid' });
    // The API wakes Claude, which goes on with what the visitor asked for.
    sv.runTurn(session, AFTER_VERIFY, session.language, '');
    return ok({ state: session.state } satisfies VerifyChecked);
  },
  visitorInbox(sv, req) {
    const visitor = sv.visitor(req.params.slug, req.cookies);
    if (isFailure(visitor)) return visitor;
    // Only the codes this chat started, as the kernel's session form answers: never the owner's alerts.
    const sessionId = visitor.session.state.session_id;
    return ok(sv.world.inbox.filter((record) => record.sessionId === sessionId && record.entry.kind === 'verification_code').map((record) => record.entry));
  },
  agentCard(sv, req) {
    // Built by code from the mock's public origin and the slug; no cookie is read.
    const desk = sv.world.deskBySlug(req.params.slug);
    return desk ? ok(agentCardOut(desk.summary.slug)) : NOT_FOUND;
  },
  agentKey(sv, req) {
    // A demo key for this browser's chat with the Desk, shown once and kept nowhere.
    const visitor = sv.visitor(req.params.slug, req.cookies);
    return isFailure(visitor) ? visitor : ok(demoAgentIssued(sv.world, visitor.desk));
  },
  sendAgent(sv, req) {
    const visitor = sv.visitor(req.params.slug, req.cookies);
    if (isFailure(visitor)) return visitor;
    const task = isRecord(req.body) ? req.body.task : undefined;
    if (req.malformed || !isDemoAgentTask(task)) return INVALID;
    const runId = sv.agents.start(sv.world, visitor.desk, visitor.session, task);
    return ok({ run_id: runId } satisfies AgentRunStarted, 202);
  },
  agentRun(sv, req) {
    // Only the chat that sent the agent reads its run; for anyone else there is none.
    const visitor = sv.visitor(req.params.slug, req.cookies);
    if (isFailure(visitor)) return visitor;
    const run = sv.agents.read(req.params.run_id, visitor.session.state.session_id);
    return run ? ok(run) : NOT_FOUND;
  },
  events(sv, req) {
    // A 200 opens the stream (handlers.ts); `listen` replays and follows it.
    const visitor = sv.visitor(req.params.slug, req.cookies);
    return isFailure(visitor) ? visitor : { status: 200 };
  },
  // The payment link's token is the only credential the checkout carries: no cookie is read.
  paymentLink(sv, req) {
    const link = sv.world.links.get(req.params.token ?? '');
    return link ? ok(paymentLinkOut(link)) : NOT_FOUND;
  },
  completePayment(sv, req) {
    const token = req.params.token ?? '';
    const link = sv.world.links.get(token);
    if (!link) return NOT_FOUND;
    // The kernel completes a link only while it is open, so a second payment is refused.
    if (link.view.state !== 'issued') return linkClosed(link);
    const verdict = sv.world.payLink(token, link);
    return ok({ state: link.view.state, session_id: link.sessionId, verdict } satisfies PaymentLinkStateResult);
  },
  cancelPayment(sv, req) {
    const token = req.params.token ?? '';
    const link = sv.world.links.get(token);
    if (!link) return NOT_FOUND;
    if (link.view.state !== 'issued') return linkClosed(link);
    sv.world.cancelLink(token, link, 'visitor');
    return ok({ state: link.view.state, session_id: link.sessionId, verdict: null } satisfies PaymentLinkStateResult);
  },
};

/** The routes that need no copy, which a request with no cookie reaches. */
const UNSCOPED: UnscopedRoutes = {
  health() {
    return ok(HEALTH);
  },
};

/** The routes the mock answers, in the route table's order. */
export const SERVED_KEYS = (Object.keys(ROUTES) as RouteKey[]).filter((key) => key in SERVED || key in UNSCOPED);

/**
 * How a request to `key` finds the copy it is about, as the API does: a passcode starts one, owner
 * routes go by the owner cookie, public routes by the Desk slug in the path (their session by the
 * visitor cookie), payment routes by the link's token in the path, and the rest need none.
 */
export type Reach = 'passcode' | 'owner_cookie' | 'slug' | 'token' | 'none';

export function reachOf(key: RouteKey): Reach {
  const route: RouteSpec = ROUTES[key];
  if (key === 'copies') return 'passcode';
  if (key in UNSCOPED) return 'none';
  if (route.owner) return 'owner_cookie';
  if (route.path.includes('{slug}')) return 'slug';
  if (route.path.includes('{token}')) return 'token';
  throw new Error(`the mock has no way to find the copy for ${key}`);
}

/**
 * `key`'s answer from `server`, the copy the request reached (null for a route that needs none),
 * or null when the mock doesn't serve it.
 */
export function serve(server: Server | null, key: RouteKey, req: Req): AnyServed | null {
  const unscoped = UNSCOPED[key];
  if (unscoped) return unscoped(req);
  const route = SERVED[key];
  if (!route) return null;
  if (server === null) throw new Error(`${key} needs a copy`);
  return route(server, req);
}
