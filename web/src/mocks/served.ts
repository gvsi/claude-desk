/**
 * The routes the mock API answers, the way Plan 02's API does, from and into the copy: `Server`
 * holds the copy, this browser's cookies and the turns in progress, and `SERVED` answers each
 * route from it. Cookies are modelled, not set: the owner is signed in or not, and each Desk slug
 * may name one visitor session, as the API's HttpOnly cookies would. Nothing here is a credential.
 */
import type { ApprovalAnswer, Decision, DeskUpdated } from '../api/contracts.ts';
import { ROUTES, type RouteKey, type RouteResponse } from '../api/routes.ts';
import type { ApprovalAnswerOut, MessageAccepted, VisitorSession } from '../api/views.ts';
import {
  attempts,
  businessOut,
  conversationSummary,
  copyOut,
  HEALTH,
  ledgerPage,
  needsYou,
  ownerTranscript,
  publicDesk,
  reports,
  today,
  visitorTranscript,
} from './readModels.ts';
import { EVENT_GAP_MS, afterAnswer, allows, cardDiffFor, matchRule, turnEnd, type Language, type Step } from './script.ts';
import { seedWorld, type MockSeed } from './seed.ts';
import { MockWorld, isoTime, type DeskRecord, type SessionRecord } from './world.ts';

/** Plan 02's limit on a visitor's message. */
const MESSAGE_MAX = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A request as a route sees it: path params, query, the parsed JSON body. */
export interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** A body was sent but wasn't JSON. */
  malformed: boolean;
}

/** The statuses a route answers its model with. */
type OkStatus = 200 | 201 | 202;
/** The statuses a route refuses with. */
type FailStatus = 401 | 403 | 404 | 409 | 422 | 429 | 501 | 503;

/** A refusal's body, as the API writes it: `error`, with a kernel failure's `code` or a conflict's `decision`. */
export interface ErrorBody {
  error: string;
  code?: string;
  decision?: Decision;
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

/** The routes the mock answers, each one's answer checked against its route's model. */
type ServedRoutes = { [K in RouteKey]?: (sv: Server, req: Req) => Served<RouteResponse<K>> };

const ok = <T>(body: T, status: OkStatus = 200): { status: OkStatus; body: T } => ({ status, body });
export const failWith = (status: FailStatus, error: string, extra: Omit<ErrorBody, 'error'> = {}): Failure => ({
  status,
  body: { error, ...extra },
});
const NO_OWNER = failWith(401, 'no_owner_session');
const NO_SESSION = failWith(401, 'no_session');
const NOT_FOUND = failWith(404, 'not_found');
const INVALID = failWith(422, 'invalid');

const ANSWERS: ReadonlySet<string> = new Set<ApprovalAnswer>(['allow_once', 'deny_once', 'allow_person', 'deny_always']);

type Scheduled = { step: Step; language: Language; text: string };

/** The API's side: the copy, this browser's cookies, and the turns in progress. */
export class Server {
  world: MockWorld;
  copyNo = 1;
  signedIn: boolean;
  /** Desk slug → the session its visitor cookie names. */
  readonly cookies = new Map<string, string>();
  private readonly turns = new Map<string, { queue: Scheduled[]; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    readonly seed: MockSeed,
    signedIn: boolean,
  ) {
    this.signedIn = signedIn;
    this.world = this.freshWorld();
  }

  private freshWorld(): MockWorld {
    const world = new MockWorld(this.seed, this.copyNo);
    seedWorld(world);
    return world;
  }

  /** A new copy of the same seed, with new ids; the old copy's chats and turns are left behind. */
  startOver(): void {
    this.stopTurns();
    this.copyNo += 1;
    this.world = this.freshWorld();
    this.cookies.clear();
  }

  stopTurns(): void {
    for (const turn of this.turns.values()) if (turn.timer !== null) clearTimeout(turn.timer);
    this.turns.clear();
  }

  /** The session this browser's cookie names for `slug`, or why there is none. */
  visitor(slug: string | undefined): { desk: DeskRecord; session: SessionRecord } | Failure {
    const desk = this.world.deskBySlug(slug);
    if (!desk) return NOT_FOUND;
    const sessionId = slug === undefined ? undefined : this.cookies.get(slug);
    const session = sessionId === undefined ? undefined : this.world.sessions.get(sessionId);
    if (!session || session.deskId !== desk.summary.desk_id) return NO_SESSION;
    return { desk, session };
  }

  /** The owner's Desk named in the path, or why the owner can't have it. */
  ownerDesk(deskId: string | undefined): DeskRecord | Failure {
    if (!this.signedIn) return NO_OWNER;
    return this.world.desk(deskId) ?? NOT_FOUND;
  }

  /** Queues `steps` after whatever the session's turn is doing, one event every `EVENT_GAP_MS`, then `turn_end`. */
  runTurn(session: SessionRecord, steps: readonly Step[], language: Language, text: string): void {
    const sessionId = session.state.session_id;
    let turn = this.turns.get(sessionId);
    if (!turn) {
      turn = { queue: [], timer: null };
      this.turns.set(sessionId, turn);
    }
    for (const step of [...steps, turnEnd]) turn.queue.push({ step, language, text });
    if (turn.timer === null) this.tick(sessionId);
  }

  private tick(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const world = this.world;
    turn.timer = setTimeout(() => {
      turn.timer = null;
      const session = world.sessions.get(sessionId);
      const next = turn.queue.shift();
      if (world !== this.world || !session || !next) return;
      world.emit(session, next.step(world.context(session, next.language, next.text)));
      if (turn.queue.length > 0) this.tick(sessionId);
    }, EVENT_GAP_MS);
  }
}

export const isFailure = (value: Failure | object): value is Failure => 'status' in value;

/** Every route the mock answers. The rest fall through to the catch-all, which records them. */
const SERVED: ServedRoutes = {
  copies(sv, req) {
    const passcode = isRecord(req.body) ? req.body.passcode : undefined;
    if (req.malformed || typeof passcode !== 'string' || passcode === '') return INVALID;
    if (passcode === 'wrong') return failWith(401, 'wrong_passcode');
    sv.signedIn = true;
    return ok(copyOut(sv.world), 201);
  },
  startOver(sv) {
    if (!sv.signedIn) return NO_OWNER;
    sv.startOver();
    return ok(copyOut(sv.world));
  },
  me(sv) {
    return sv.signedIn ? ok(copyOut(sv.world)) : NO_OWNER;
  },
  desks(sv) {
    return sv.signedIn ? ok([businessOut(sv.world)]) : NO_OWNER;
  },
  setAnswering(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    if (isFailure(desk)) return desk;
    const on = isRecord(req.body) ? req.body.on : undefined;
    if (typeof on !== 'boolean') return INVALID;
    desk.summary.answering = on;
    return ok({ desk_id: desk.summary.desk_id, updated_at: isoTime(sv.world.now()) } satisfies DeskUpdated);
  },
  openPreview(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    if (isFailure(desk)) return desk;
    const slug = desk.summary.slug;
    const current = sv.visitor(slug);
    if (!isFailure(current) && current.session.ownerPreview) {
      return ok({ state: current.session.state, resumed: true } satisfies VisitorSession);
    }
    const session = sv.world.addSession(desk, { ownerPreview: true });
    sv.cookies.set(slug, session.state.session_id);
    return ok({ state: session.state, resumed: false } satisfies VisitorSession);
  },
  today(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isFailure(desk) ? desk : ok(today(sv.world, desk));
  },
  needsYou(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isFailure(desk) ? desk : ok(needsYou(sv.world, desk));
  },
  reports(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isFailure(desk) ? desk : ok(reports(sv.world, desk));
  },
  answer(sv, req) {
    if (!sv.signedIn) return NO_OWNER;
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
  conversations(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    if (isFailure(desk)) return desk;
    const sessions = sv.world.sessionsOf(desk.summary.desk_id).sort((a, b) => b.lastActivity - a.lastActivity);
    return ok(sessions.map((s) => conversationSummary(sv.world, s)));
  },
  conversation(sv, req) {
    if (!sv.signedIn) return NO_OWNER;
    const session = sv.world.sessions.get(req.params.session_id ?? '');
    if (!session) return NOT_FOUND;
    const after = Number(req.query.get('after') ?? '0');
    return ok(ownerTranscript(session, Number.isSafeInteger(after) ? after : 0));
  },
  safety(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isFailure(desk) ? desk : ok(attempts(sv.world, desk));
  },
  ledger(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isFailure(desk) ? desk : ok(ledgerPage(desk));
  },
  health() {
    return ok(HEALTH);
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
    const current = sv.visitor(slug);
    if (!isFailure(current)) return ok({ state: current.session.state, resumed: true } satisfies VisitorSession);
    const session = sv.world.addSession(desk);
    sv.cookies.set(slug, session.state.session_id);
    return ok({ state: session.state, resumed: false } satisfies VisitorSession);
  },
  visitorSession(sv, req) {
    const visitor = sv.visitor(req.params.slug);
    return isFailure(visitor) ? visitor : ok(visitorTranscript(visitor.session));
  },
  sendMessage(sv, req) {
    const visitor = sv.visitor(req.params.slug);
    if (isFailure(visitor)) return visitor;
    const text = isRecord(req.body) ? req.body.text : undefined;
    if (req.malformed || typeof text !== 'string' || text.length < 1 || text.length > MESSAGE_MAX) return INVALID;
    const { session } = visitor;
    sv.world.visitorText(session, text);
    if (session.state.mode === 'ai') sv.runTurn(session, matchRule(text).steps, session.language, text);
    return ok({ message_id: sv.world.id('vmsg') } satisfies MessageAccepted, 202);
  },
  events(sv, req) {
    // A 200 opens the stream (handlers.ts); `listen` replays and follows it.
    const visitor = sv.visitor(req.params.slug);
    return isFailure(visitor) ? visitor : { status: 200 };
  },
};

/** The routes the mock answers, in the route table's order. */
export const SERVED_KEYS = (Object.keys(ROUTES) as RouteKey[]).filter((key) => key in SERVED);

/** `key`'s answer from the copy, or null when the mock doesn't serve it. */
export function serve(server: Server, key: RouteKey, req: Req): AnyServed | null {
  const route = SERVED[key];
  return route ? route(server, req) : null;
}
