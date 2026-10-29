/**
 * The mock API a test drives: the copy the routes answer from (served.ts), the faults a test plants,
 * the requests it can read back and the `/api/` paths nobody mocked. `dispatch` answers a route the
 * way Plan 02's API does, from and into that copy, so an answer on Today changes what the visitor's
 * chat streams. MSW's handlers (handlers.ts) are only its transport, and unit tests call it
 * directly. The mock ships in no build: it runs in modes `mock` and `test` only.
 */
import type { SseEvent } from '../api/contracts.ts';
import { ROUTES, apiPath, type RouteKey, type RouteParams } from '../api/routes.ts';
import type { MockSeed } from './seed.ts';
import { Server, failWith, isFailure, serve, type AnyServed } from './served.ts';
import type { MockWorld, SessionRecord } from './world.ts';

export interface MockRequestInit {
  params?: Record<string, string>;
  query?: Record<string, string> | URLSearchParams;
  body?: unknown;
  /** The body wasn't JSON. */
  malformed?: boolean;
  /** The path as sent, with its query; worked out from the route when absent. */
  path?: string;
}

/** What a route answered: a status and JSON body, or a connection dropped with no answer. */
export type MockAnswer = { status: number; body?: unknown } | { network: true };

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
  /** Lets the route apply its change first, then answers with the fault: a write whose answer was lost. */
  afterCommit?: boolean;
}

export interface ResetOptions {
  /** Whether this browser holds the copy's owner cookie (default true; the dev server starts signed out). */
  signedIn?: boolean;
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

export class MockStore {
  private server = new Server('rivera', true);
  private injections: (Injection & { left: number })[] = [];
  private readonly log: MockRequest[] = [];
  private readonly unhandledPaths: string[] = [];

  /** The copy as it stands, for tests that check what a route changed. */
  get world(): MockWorld {
    return this.server.world;
  }

  /** Every request a route answered (or a fault answered for it), in order. */
  get requests(): readonly MockRequest[] {
    return this.log;
  }

  /** Paths under `/api/` that no mocked route answers, in order. */
  get unhandled(): readonly string[] {
    return this.unhandledPaths;
  }

  /** A fresh copy of `seed`: no visitor cookies, no faults, nothing recorded, no turn in flight. */
  reset(seed: MockSeed, opts: ResetOptions = {}): void {
    this.server.stopTurns();
    this.server = new Server(seed, opts.signedIn ?? true);
    this.injections = [];
    this.log.length = 0;
    this.unhandledPaths.length = 0;
  }

  inject(injection: Injection): void {
    this.injections.push({ ...injection, left: injection.times ?? 1 });
  }

  recordUnhandled(path: string): void {
    this.unhandledPaths.push(path);
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

  /** Answers `key` as the API would: a planted fault first, else the route, from and into the copy. */
  async dispatch(key: RouteKey, init: MockRequestInit = {}): Promise<MockAnswer> {
    const params = init.params ?? {};
    const query = toQuery(init.query);
    this.log.push({ key, body: init.body, path: init.path ?? pathFor(key, params, query) });
    const injection = this.takeInjection(key);
    if (injection?.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, injection.delayMs));
    // A planted fault answers in the route's place, unless it lets the route commit first.
    let served: AnyServed = { status: 0 };
    if (injection === null || injection.afterCommit === true) {
      const answered = serve(this.server, key, { params, query, body: init.body, malformed: init.malformed ?? false });
      if (answered === null) this.recordUnhandled(ROUTES[key].path);
      served = answered ?? failWith(501, 'not_mocked');
    }
    if (injection !== null) {
      if (injection.status === 'network') return { network: true };
      return { status: injection.status, body: wire(injection.body ?? faultBody(injection.status, key)) };
    }
    return { status: served.status, body: wire(served.body) };
  }

  /** The visitor session this browser's cookie names for `slug`, or null when there is none. */
  visitorSession(slug: string): SessionRecord | null {
    const visitor = this.server.visitor(slug);
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
   * Follows the stream of the session this browser's cookie names for `slug`: every event after
   * `after` at once, then each new one as it happens. Returns the function that stops it.
   */
  listen(slug: string, after: number, send: (seq: number, ev: SseEvent) => void): () => void {
    const visitor = this.server.visitor(slug);
    if (isFailure(visitor)) return () => {};
    const { session } = visitor;
    for (const { seq, ev } of session.events) if (seq > after) send(seq, ev);
    session.listeners.add(send);
    return () => {
      session.listeners.delete(send);
    };
  }
}

/** The one mock API, shared by the handlers, the screen tests and the dev server. */
export const mockStore = new MockStore();
