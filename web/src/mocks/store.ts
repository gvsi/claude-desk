/**
 * The mock API: the copies the routes answer from (served.ts), the faults a test plants, the
 * requests it can read back and the `/api/` paths nobody mocked. `dispatch` answers a route the
 * way Plan 02's API does, from and into the copy the request reaches, so an answer on Today
 * changes what the visitor's chat streams. MSW's handlers (handlers.ts) are only its transport, and
 * unit tests call it directly. It keeps cookies one of two ways:
 *
 * - `simulated` (the screen tests' page and the unit tests, `mockStore`): one copy, and this
 *   browser's cookies kept here, signed in or not and a session per Desk slug. Requests' own
 *   cookies are ignored and answers set none, so nothing outlives a `reset`.
 * - `real` (the dev server, devServer.ts): a copy per owner cookie, as the API keys them, starting
 *   with none. Each request is answered from the cookies it carries, and answers set the API's
 *   HttpOnly cookies, so every tab of one browser shares its copy and another browser has its own.
 *
 * Requests also belong to an epoch. The screen tests start a new one before each test and stamp
 * every request with the epoch it was sent in, because the service worker hands a request to the
 * store a few milliseconds after the page sends it: one the last test's page sent just before it
 * ended would otherwise be recorded in the next test and applied to its copy. The store drops a
 * request from an earlier epoch like a lost connection, unrecorded and unapplied. A bare `reset`
 * keeps the epoch, so a page still on screen goes on reaching the new copy; a render from a seed
 * (renderRoute) unmounts the page first and starts a new epoch, as a new test does.
 *
 * The mock ships in no build: it runs under `npm run dev:mock` and in tests only.
 */
import type { SseEvent } from '../api/contracts.ts';
import { ROUTES, apiPath, type RouteKey, type RouteParams } from '../api/routes.ts';
import type { DemoVisitorRuns } from './demoVisitors.ts';
import { DOCUMENT_TOKEN, lookAtDocument, openDocument, type DocumentAnswer, type DocumentLink } from './documents.ts';
import { PAYMENT_TOKEN } from './script.ts';
import { MODEL_PACE, TEST_PACE, type OwnerStreamPlan, type StreamSettings } from './ownerStreams.ts';
import type { MockSeed } from './seed.ts';
import { followSetupTurn, type SetupFollower } from './setup.ts';
import {
  Server,
  failWith,
  isFailure,
  reachOf,
  serve,
  SERVED_KEYS,
  type AnyServed,
  type CopyNaming,
  type Cookies,
  type Failure,
  type OwnerStreamKind,
} from './served.ts';
import type { MockWorld, SessionRecord } from './world.ts';

export interface MockRequestInit {
  params?: Record<string, string>;
  query?: Record<string, string> | URLSearchParams;
  body?: unknown;
  /** The body wasn't JSON. */
  malformed?: boolean;
  /** The path as sent, with its query; worked out from the route when absent. */
  path?: string;
  /** The cookies the request carries, by name (read only by a `real` store). */
  cookies?: Record<string, string>;
  /** The epoch the page sent it in, when the page stamps its requests (the screen tests' page does). */
  epoch?: number;
}

/**
 * What a route answered: a status, a JSON body and the `Set-Cookie` lines to send with it, or a
 * connection dropped with no answer.
 */
export type MockAnswer = { status: number; body?: unknown; setCookie?: string[] } | { network: true };

export interface MockRequest {
  key: RouteKey;
  body: unknown;
  /** The path as sent, with its query. */
  path: string;
}

/** A fault a test plants on a route. */
export interface Injection {
  route: RouteKey;
  /** The answer's status, or `network` for a connection dropped with no answer. */
  status: number | 'network';
  /** How many requests it answers (default 1). */
  times?: number;
  /** The answer's body; a plain `{error}` for the status when absent. */
  body?: unknown;
  /** Waits this long before answering. */
  delayMs?: number;
  /** Holds the answer until this settles, so a test decides when a request in flight lands. */
  until?: Promise<unknown>;
  /** Lets the route apply its change first, then answers with the fault: a write whose answer was lost. */
  afterCommit?: boolean;
}

export interface ResetOptions {
  /** Whether this browser holds the copy's owner cookie (default true). */
  signedIn?: boolean;
}

export interface MockStoreOptions {
  /** How the store keeps cookies (default `simulated`); see the file's header. */
  cookies?: 'simulated' | 'real';
  /**
   * How its copies' owner-chat streams are written: a model's pace with every setup turn streamed
   * on the dev server (`real`), quick with setup's turns landing in their requests in tests.
   */
  streams?: StreamSettings;
}

/** The `{error}` body a planted status answers with when it names none. */
function faultBody(status: number, key: RouteKey): unknown {
  if (status < 400) return undefined;
  if (status === 401) return { error: ROUTES[key].owner ? 'no_owner_session' : 'no_session' };
  if (status === 404) return { error: 'not_found' };
  if (status === 409) return { error: 'conflict' };
  if (status === 429) return { error: 'rate_limited', retry_after: 5 };
  if (status === 503) return { error: 'kernel', code: 'kernel_unavailable' };
  if (status >= 500) return { error: 'internal' };
  return { error: 'invalid' };
}

function toQuery(query: MockRequestInit['query']): URLSearchParams {
  return query instanceof URLSearchParams ? query : new URLSearchParams(query ?? {});
}

/** The path a request would have had, for the request log when the caller gave none. */
function pathFor(key: RouteKey, params: Record<string, string>, query: URLSearchParams): string {
  try {
    const path = apiPath(key, params as RouteParams<typeof key>);
    const qs = query.toString();
    return qs === '' ? path : `${path}?${qs}`;
  } catch {
    return ROUTES[key].path;
  }
}

/** Where a visitor's stream resumes: past `?after=` or the browser's `Last-Event-ID`, whichever is later. */
export function streamAfter(query: URLSearchParams, lastEventId: string | null): number {
  const read = (value: string | null) => (value !== null && /^\d+$/.test(value) ? Number(value) : 0);
  return Math.max(read(query.get('after')), read(lastEventId));
}

/** Round-trips through JSON, as the wire would: no answer shares an object with the store. */
const wire = (body: unknown): unknown => (body === undefined ? undefined : JSON.parse(JSON.stringify(body)));

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A random token of `length` letters and digits, as unguessable as the runtime's crypto makes it. */
function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 248 is the largest multiple of 62 under 256: rejecting bytes above it keeps every letter equally likely.
  let out = '';
  for (const byte of bytes) if (byte < 248) out += TOKEN_ALPHABET.charAt(byte % TOKEN_ALPHABET.length);
  return out.length === length ? out : out + randomToken(length - out.length);
}

/** A token none of `taken` holds, which it then holds. */
function freshToken(taken: Set<string>, length: number): string {
  let token = randomToken(length);
  while (taken.has(token)) token = randomToken(length);
  taken.add(token);
  return token;
}

/** The fixtures' `token` the first time, then a random token of its length; each once only. */
function fixtureFirst(taken: Set<string>, token: string): string {
  if (taken.has(token)) return freshToken(taken, token.length);
  taken.add(token);
  return token;
}

/**
 * The screen tests' naming: copies numbered from 1, so the first is the seed's (`RIVERA`), and
 * the first payment and document links are the fixtures' `k7Hq2vX9` and `9fK2mQ`; later links
 * get random tokens of their own.
 */
function seedNaming(): CopyNaming {
  let copyNo = 0;
  const tokens = new Set<string>();
  return {
    copyNo: () => (copyNo += 1),
    linkToken: () => fixtureFirst(tokens, PAYMENT_TOKEN),
    documentToken: () => fixtureFirst(tokens, DOCUMENT_TOKEN),
  };
}

/** Copy numbers with six base-36 digits, so every copy's slugs are the same length and none is the seed's. */
const RANDOM_COPY_NO = { from: 36 ** 5, to: 36 ** 6 };

/**
 * The dev server's naming: each copy numbered at random, so its ids and slugs are its own and a
 * link from before a restart names nothing, and every payment and document link with a random token.
 */
function randomNaming(): CopyNaming {
  const numbers = new Set<number>();
  const tokens = new Set<string>();
  return {
    copyNo: () => {
      const span = RANDOM_COPY_NO.to - RANDOM_COPY_NO.from;
      let copyNo = 0;
      while (copyNo === 0 || numbers.has(copyNo)) {
        copyNo = RANDOM_COPY_NO.from + (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % span;
      }
      numbers.add(copyNo);
      return copyNo;
    },
    linkToken: () => freshToken(tokens, PAYMENT_TOKEN.length),
    documentToken: () => freshToken(tokens, DOCUMENT_TOKEN.length),
  };
}

/** The one browser of the screen tests: its cookies, kept here across requests. */
class SimulatedCookies implements Cookies {
  /** Desk slug → the session its visitor cookie names. */
  private readonly sessions = new Map<string, string>();

  constructor(public owner: boolean) {}

  visitor(slug: string): string | undefined {
    return this.sessions.get(slug);
  }

  setOwner(): void {
    this.owner = true;
  }

  renewOwner(): void {
    this.owner = true;
  }

  setVisitor(slug: string, sessionId: string): void {
    this.sessions.set(slug, sessionId);
  }

  dropVisitor(slug: string): void {
    this.sessions.delete(slug);
  }
}

/** The owner cookie, as Plan 02a sets it (`Secure` left off: the dev server is plain http). */
const OWNER_COOKIE = { name: 'desk_owner', path: '/api/owner', maxAge: 604_800 } as const;
/** The visitor cookie, one per Desk slug. */
const VISITOR_COOKIE = { name: 'desk_visitor', maxAge: 86_400 } as const;

function setCookieLine(name: string, value: string, path: string, maxAge: number): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;
}

/** The dev server's copies, and what each owner and visitor cookie names. */
class CookieCopies {
  readonly naming = randomNaming();
  readonly copies: Server[] = [];
  /** Owner cookie value → its copy. */
  readonly owners = new Map<string, Server>();
  /** Visitor cookie value → the session it names, in which copy, for which Desk slug. */
  readonly visitors = new Map<string, { server: Server; slug: string; sessionId: string }>();
  private readonly cookieValues = new Set<string>();

  cookieValue(): string {
    return freshToken(this.cookieValues, 32);
  }

  bySlug(slug: string | undefined): Server | undefined {
    return this.copies.find((server) => server.world.deskBySlug(slug) !== undefined);
  }

  byLinkToken(token: string | undefined): Server | undefined {
    return token === undefined ? undefined : this.copies.find((server) => server.world.links.has(token));
  }

  /** The document link `token` names, in the one copy whose card handed it out. */
  documentLink(token: string): DocumentLink | undefined {
    return this.copies.find((server) => server.world.documentLinks.has(token))?.world.documentLinks.get(token);
  }
}

/** One request's cookies on the dev server: the ones it carries, and the `Set-Cookie` lines its answer sends. */
class RequestCookies implements Cookies {
  readonly setCookie: string[] = [];

  constructor(
    private readonly all: CookieCopies,
    private readonly server: Server,
    private readonly sent: Record<string, string>,
  ) {}

  get owner(): boolean {
    const value = this.sent[OWNER_COOKIE.name];
    return value !== undefined && this.all.owners.get(value) === this.server;
  }

  visitor(slug: string): string | undefined {
    const value = this.sent[VISITOR_COOKIE.name];
    const named = value === undefined ? undefined : this.all.visitors.get(value);
    return named && named.server === this.server && named.slug === slug ? named.sessionId : undefined;
  }

  /** A passcode's new copy becomes this browser's, and the store keeps it from now on. */
  setOwner(): void {
    const value = this.all.cookieValue();
    this.all.owners.set(value, this.server);
    if (!this.all.copies.includes(this.server)) this.all.copies.push(this.server);
    this.setCookie.push(setCookieLine(OWNER_COOKIE.name, value, OWNER_COOKIE.path, OWNER_COOKIE.maxAge));
  }

  /** A start over's new copy gets a new cookie; the one this request carried names nothing from now on. */
  renewOwner(): void {
    const sent = this.sent[OWNER_COOKIE.name];
    if (sent !== undefined && this.all.owners.get(sent) === this.server) this.all.owners.delete(sent);
    this.setOwner();
  }

  setVisitor(slug: string, sessionId: string): void {
    const value = this.all.cookieValue();
    this.all.visitors.set(value, { server: this.server, slug, sessionId });
    const path = `/api/public/desks/${encodeURIComponent(slug)}`;
    this.setCookie.push(setCookieLine(VISITOR_COOKIE.name, value, path, VISITOR_COOKIE.maxAge));
  }
}

/** The copy a request reached (null for a route that needs none), and the cookies it is answered with. */
interface Reached {
  server: Server | null;
  cookies: Cookies;
  setCookie: readonly string[];
}

const NO_OWNER = failWith(401, 'no_owner_session');
const NOT_FOUND = failWith(404, 'not_found');
const NO_COOKIES: Cookies = {
  owner: false,
  visitor: () => undefined,
  setOwner: () => undefined,
  renewOwner: () => undefined,
  setVisitor: () => undefined,
};

export class MockStore {
  private readonly mode: 'simulated' | 'real';
  private readonly streams: StreamSettings;
  private one: { server: Server; cookies: SimulatedCookies } | null = null;
  private readonly many = new CookieCopies();
  private injections: (Injection & { left: number })[] = [];
  private readonly log: MockRequest[] = [];
  private readonly unhandledPaths: string[] = [];
  private epochNo = 0;

  constructor(opts: MockStoreOptions = {}) {
    this.mode = opts.cookies ?? 'simulated';
    this.streams = opts.streams ?? (this.mode === 'real' ? MODEL_PACE : TEST_PACE);
    if (this.mode === 'simulated') this.one = { server: new Server('rivera', seedNaming(), this.streams), cookies: new SimulatedCookies(true) };
  }

  /** The one copy and this browser's cookies; only a `simulated` store has them. */
  private oneCopy(): { server: Server; cookies: SimulatedCookies } {
    if (this.one === null) throw new Error('the dev server keeps a copy per browser: there is no one copy to read');
    return this.one;
  }

  /** The copy as it stands, for tests that check what a route changed. */
  get world(): MockWorld {
    return this.oneCopy().server.world;
  }

  /** The copy's demo visitor runs, for tests that end one as the API's run can end. */
  get demoVisitors(): DemoVisitorRuns {
    return this.oneCopy().server.demoVisitors;
  }

  /**
   * Every request a route answered (or a fault answered for it), in order. Only a `simulated`
   * store keeps them, as it keeps `unhandled`: on the dev server nothing reads them, and they would
   * grow for as long as it runs.
   */
  get requests(): readonly MockRequest[] {
    return this.log;
  }

  /** Paths under `/api/` that no mocked route answers, in order. */
  get unhandled(): readonly string[] {
    return this.unhandledPaths;
  }

  /** The epoch requests are sent in now; see the file's header. */
  get epoch(): number {
    return this.epochNo;
  }

  /** Starts a new epoch: from now on, a request sent before this call is dropped when it arrives. */
  nextEpoch(): void {
    this.epochNo += 1;
  }

  /** Whether a request sent in `epoch` is still answered: one from this epoch, or one with none. */
  admits(epoch: number | undefined): boolean {
    return epoch === undefined || epoch === this.epochNo;
  }

  /** A fresh copy of `seed`: no visitor cookies, no faults, nothing recorded, no turn in flight. */
  reset(seed: MockSeed, opts: ResetOptions = {}): void {
    this.oneCopy().server.stopTurns();
    this.one = { server: new Server(seed, seedNaming(), this.streams), cookies: new SimulatedCookies(opts.signedIn ?? true) };
    this.injections = [];
    this.log.length = 0;
    this.unhandledPaths.length = 0;
  }

  inject(injection: Injection): void {
    this.injections.push({ ...injection, left: injection.times ?? 1 });
  }

  /** Faults still waiting for a request; lets a test prove its refresh actually consumed them. */
  get pendingInjections(): readonly Injection[] {
    return this.injections.filter((injection) => injection.left > 0);
  }

  recordUnhandled(path: string): void {
    if (this.mode === 'simulated') this.unhandledPaths.push(path);
  }

  /** Removes one recorded unhandled request to `path`; throws if there is none. */
  takeUnhandled(path: string): void {
    const index = this.unhandledPaths.indexOf(path);
    if (index === -1) {
      throw new Error(`expected an unhandled request to ${path}; recorded: ${JSON.stringify(this.unhandledPaths)}`);
    }
    this.unhandledPaths.splice(index, 1);
  }

  private takeInjection(key: RouteKey): Injection | null {
    const injection = this.injections.find((i) => i.route === key && i.left > 0);
    if (!injection) return null;
    injection.left -= 1;
    return injection;
  }

  /**
   * The copy a request to `key` reaches and its cookies, as the API finds them (served.ts
   * `reachOf`), or why it reaches none. A `simulated` store has one copy, which every request reaches.
   */
  private reach(key: RouteKey, params: Record<string, string>, sent: Record<string, string>): Reached | Failure {
    if (this.one !== null) return { ...this.one, setCookie: [] };
    const reached = (server: Server): Reached => {
      const cookies = new RequestCookies(this.many, server, sent);
      return { server, cookies, setCookie: cookies.setCookie };
    };
    switch (reachOf(key)) {
      case 'none':
        return { server: null, cookies: NO_COOKIES, setCookie: [] };
      case 'passcode':
        // A new copy, kept only if the passcode opens it (`setOwner`).
        return reached(new Server('rivera', this.many.naming, this.streams));
      case 'owner_cookie': {
        const value = sent[OWNER_COOKIE.name];
        const server = value === undefined ? undefined : this.many.owners.get(value);
        return server ? reached(server) : NO_OWNER;
      }
      case 'slug': {
        const server = this.many.bySlug(params.slug);
        return server ? reached(server) : NOT_FOUND;
      }
      case 'token': {
        const server = this.many.byLinkToken(params.token);
        return server ? reached(server) : NOT_FOUND;
      }
    }
  }

  /**
   * Answers `key` as the API would: a planted fault first, else the route, from and into the copy it
   * reaches. A request from an earlier epoch, or one still waiting on a planted delay when its epoch
   * ends, is dropped instead.
   */
  async dispatch(key: RouteKey, init: MockRequestInit = {}): Promise<MockAnswer> {
    if (!this.admits(init.epoch)) return { network: true };
    const epoch = this.epochNo;
    const params = init.params ?? {};
    const query = toQuery(init.query);
    if (this.mode === 'simulated') this.log.push({ key, body: init.body, path: init.path ?? pathFor(key, params, query) });
    const injection = this.takeInjection(key);
    if (injection?.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, injection.delayMs));
      if (!this.admits(epoch)) return { network: true };
    }
    if (injection?.until !== undefined) {
      await injection.until.catch(() => {});
      if (!this.admits(epoch)) return { network: true };
    }
    // A planted fault answers in the route's place, unless it lets the route commit first.
    let served: AnyServed = { status: 0 };
    let setCookie: readonly string[] = [];
    if (injection === null || injection.afterCommit === true) {
      const reached = SERVED_KEYS.includes(key) ? this.reach(key, params, init.cookies ?? {}) : null;
      const answered =
        reached === null || isFailure(reached)
          ? reached
          : serve(reached.server, key, { params, query, body: init.body, malformed: init.malformed ?? false, cookies: reached.cookies });
      if (answered === null) this.recordUnhandled(ROUTES[key].path);
      served = answered ?? failWith(501, 'not_mocked');
      if (reached !== null && !isFailure(reached)) setCookie = reached.setCookie;
      // A route that holds its answer (a streamed setup turn) answers once its turn lands.
      const later = (served as { later?: Promise<AnyServed> }).later;
      if (later !== undefined && injection === null) {
        served = await later;
        if (!this.admits(epoch)) return { network: true };
      }
    }
    if (injection !== null) {
      if (injection.status === 'network') return { network: true };
      return { status: injection.status, body: wire(injection.body === undefined ? faultBody(injection.status, key) : injection.body) };
    }
    return { status: served.status, body: wire(served.body), ...(setCookie.length > 0 ? { setCookie: [...setCookie] } : {}) };
  }

  /**
   * A document card's link (`/api/d/{token}`, documents.ts), which the visitor's browser opens in a
   * tab rather than the app calling it: a GET opens the document the copy's card handed out, once,
   * and a HEAD only looks. A request from an earlier epoch is dropped.
   */
  document(method: 'GET' | 'HEAD', token: string, init: { headers?: HeadersInit; epoch?: number } = {}): DocumentAnswer | { network: true } {
    if (!this.admits(init.epoch)) return { network: true };
    if (method === 'HEAD') return lookAtDocument();
    const link = this.one === null ? this.many.documentLink(token) : this.one.server.world.documentLinks.get(token);
    return openDocument(link, new Headers(init.headers));
  }

  /** For tests: this browser's visitor cookie for `slug` is gone, as when its chat's session has ended. */
  dropVisitorCookie(slug: string): void {
    this.oneCopy().cookies.dropVisitor(slug);
  }

  /** The visitor session this browser's cookie names for `slug`, or null when there is none. */
  visitorSession(slug: string): SessionRecord | null {
    const { server, cookies } = this.oneCopy();
    const visitor = server.visitor(slug, cookies);
    return isFailure(visitor) ? null : visitor.session;
  }

  /**
   * Sends `ev` on the stream of the session this browser's cookie names for `slug`, as the API
   * would outside a scripted turn: the owner joining, a session error. Returns its seq.
   */
  emit(slug: string, ev: SseEvent): number {
    const session = this.visitorSession(slug);
    if (!session) throw new Error(`this browser has no session for ${slug}`);
    return this.world.emit(session, ev);
  }

  /**
   * For tests: the next stream of `kind` goes as planned (paused, started again, failed or broken
   * off). Ask Claude's answers always stream when asked to; setup's turns only once `streamSetupTurns`.
   */
  planStream(kind: OwnerStreamKind, plan: OwnerStreamPlan): void {
    this.oneCopy().server.planStream(kind, plan);
  }

  /**
   * For tests: setup's answers, decisions, consent and suggestions run as streamed turns, or land in
   * their requests again. An answer's or a decision's request waits for its turn and answers 200,
   * unless `answersAtOnce` has it answer 202 busy at once, as consent's does.
   */
  streamSetupTurns(on = true, { answersAtOnce = false } = {}): void {
    const { streams } = this.oneCopy().server;
    streams.setupTurns = on;
    streams.answersAtOnce = answersAtOnce;
  }

  /**
   * The pace and any planned stream for Ask Claude's answer in the copy the owner cookie names, and
   * the answer written before its change was refused for the payment limit, if it was.
   */
  ruleChatStream(cookies: Record<string, string> = {}): { wordMs: number; plan: OwnerStreamPlan | null; refusedAnswer: string | null } {
    const reached = this.reach('ruleChat', {}, cookies);
    if (isFailure(reached) || reached.server === null) return { wordMs: this.streams.wordMs, plan: null, refusedAnswer: null };
    const { server } = reached;
    const refusedAnswer = server.refusedAnswer;
    server.refusedAnswer = null;
    return { wordMs: server.streams.wordMs, plan: server.takePlan('ruleChat'), refusedAnswer };
  }

  /**
   * Follows setup interview `id`'s running turn in the copy the owner cookie names (this browser's,
   * for a `simulated` store). Returns the function that stops it.
   */
  followSetup(id: string, follower: SetupFollower, cookies: Record<string, string> = {}): () => void {
    const reached = this.reach('setupEvents', { id }, cookies);
    if (isFailure(reached) || reached.server === null) {
      follower.close();
      return () => {};
    }
    return followSetupTurn(reached.server.world, id, follower);
  }

  /**
   * Follows the stream of the session the request's visitor cookie names for `slug` (this
   * browser's, for a `simulated` store): every event after `after` at once, then each new one as it
   * happens. Returns the function that stops it.
   */
  listen(slug: string, after: number, send: (seq: number, ev: SseEvent) => void, cookies: Record<string, string> = {}): () => void {
    const reached = this.reach('events', { slug }, cookies);
    if (isFailure(reached) || reached.server === null) return () => {};
    const visitor = reached.server.visitor(slug, reached.cookies);
    if (isFailure(visitor)) return () => {};
    const { session } = visitor;
    for (const { seq, ev } of session.events) if (seq > after) send(seq, ev);
    session.listeners.add(send);
    return () => {
      session.listeners.delete(send);
    };
  }
}

/** The screen tests' and unit tests' mock API: one copy, its cookies simulated. */
export const mockStore = new MockStore();
