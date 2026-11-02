/**
 * The one way the app talks to the API. It sends JSON with the browser's own same-origin
 * credentials and nothing else: the API keeps identity in HttpOnly cookies, so no code here reads
 * or sets one. An answer body is read only into typed fields; server text never reaches a screen.
 * Errors fail closed: anything this layer can't read as a clear answer is an `ApiError`.
 */
import { UNREACHABLE_COPY, errorCopy } from '../ds/index.ts';
import { KERNEL_ERROR_CODES, type Decision, type KernelErrorCode, type PaymentLinkState } from './contracts.ts';
import {
  ROUTES,
  apiPath,
  type HttpMethod,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  type RouteSpec,
} from './routes.ts';
import { SseParser } from './sse.ts';
import type { CancelReason, RulesDraft } from './views.ts';

/** How long one request may take: a Claude turn longer, a proving route past the API's 25 s hold. */
export const TIMEOUT_MS = { default: 10_000, model: 45_000, proving: 30_000 } as const;

/** The consultant client opts in once for all setup state reads and mutations, including rereads. */
const SETUP_CARD_ROUTES: ReadonlySet<RouteKey> = new Set(['setup', 'setupConsent', 'setupAnswer', 'setupProposal', 'setupSuggestions', 'setupReopen']);

/** A proving route's 202 is retried this often, and given up this long after the first send. */
export const PROVING_RETRY_MS = 3_000;
export const PROVING_GIVE_UP_MS = 60_000;

/** Retries of a proving route may only go back to a proving route. */
const PROVING_PREFIX = '/api/owner/policy/';

export type ApiErrorKind =
  | 'unauthorized'
  | 'conflict'
  | 'unprocessable'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'network';

interface ApiErrorInit {
  route: RouteKey;
  method: HttpMethod;
  status: number | null;
  code?: string | null;
  kernel?: boolean;
  retryAfter?: number | null;
  decision?: Decision | null;
  state?: PaymentLinkState | null;
  cancelReason?: CancelReason | null;
  draft?: RulesDraft | null;
  capCents?: number | null;
  lineKey?: string | null;
}

/** A request that didn't come back as a clear answer. Its message is its kind, never server text. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly route: RouteKey;
  readonly method: HttpMethod;
  /** The HTTP status, or null when no answer arrived. */
  readonly status: number | null;
  /** The body's `code` when `error` is "kernel", else its `error`: a snake_case word, or null. */
  readonly code: string | null;
  /** Whether the body was the kernel's refusal (`{error: "kernel", code}`) rather than the API's own. */
  readonly kernel: boolean;
  /** Seconds, from a 429's `retry_after`. */
  readonly retryAfter: number | null;
  /** A 409's final decision (an answer that came too late). */
  readonly decision: Decision | null;
  /** A 409's current payment link state. */
  readonly state: PaymentLinkState | null;
  /** A 409's `cancel_reason`: `rules_changed` when a change to the business's rules cancelled the link. */
  readonly cancelReason: CancelReason | null;
  /** A 409's fresh rules draft (the rules changed since the draft). */
  readonly draft: RulesDraft | null;
  /** A 422's `cap_cents`: the limit for taking money without asking that a draft went over. */
  readonly capCents: number | null;
  /** A 422 line_refused's row key. The internal reason is deliberately discarded. */
  readonly lineKey: string | null;

  constructor(kind: ApiErrorKind, init: ApiErrorInit) {
    super(kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.route = init.route;
    this.method = init.method;
    this.status = init.status;
    this.code = init.code ?? null;
    this.kernel = init.kernel ?? false;
    this.retryAfter = init.retryAfter ?? null;
    this.decision = init.decision ?? null;
    this.state = init.state ?? null;
    this.cancelReason = init.cancelReason ?? null;
    this.draft = init.draft ?? null;
    this.capCents = init.capCents ?? null;
    this.lineKey = init.lineKey ?? null;
  }
}

/**
 * A write whose answer was lost (no answer, a timeout or a 5xx) may have been applied, so a screen
 * reads the current state before saying it wasn't done.
 */
export function isUncertain(err: unknown): boolean {
  return err instanceof ApiError && err.method !== 'GET' && (err.kind === 'network' || err.kind === 'unavailable');
}

/** What a key is made from: the browser's `crypto`, or a stand-in a test passes. */
type KeySource = Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string };

/**
 * A new client idempotency key for a start whose answer may be lost after it was applied
 * (`sendAgent`, `startSetup`): one per click, sent again with that click's retries, so the API
 * answers what the first started rather than starting it twice (plan 02b). A random UUID: the
 * browser's `randomUUID`, which exists only on a secure page (https or localhost), else a version 4
 * UUID from `getRandomValues`, which every page has.
 */
export function newIdempotencyKey(source: KeySource = crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What the owner reads when a request fails, by kind. */
export const OWNER_ERROR_COPY: Readonly<Record<ApiErrorKind, string>> = {
  unauthorized: 'Your demo session ended. Enter the passcode to start a fresh copy.',
  conflict: errorCopy('conflict'),
  unprocessable: errorCopy('invalid'),
  not_found: errorCopy('not_found'),
  rate_limited: "That's a lot of requests at once. Wait a moment, then try again.",
  unavailable: UNREACHABLE_COPY.en,
  network: "We couldn't reach Claude Desk. Check your connection, then try again.",
};

export const RULES_UNAVAILABLE_COPY =
  "Rules can't be checked right now, so this change can't be applied yet. Your current rules stay in place.";

const KERNEL_CODES: ReadonlySet<string> = new Set(KERNEL_ERROR_CODES);

/**
 * The owner's line for any failure: rules that can't be checked, a kernel code, else the kind.
 *
 * `RULES_UNAVAILABLE_COPY` says the change wasn't applied, which holds for a drafting route (nothing
 * applies until a confirm), whether the API answered 409 or the request layer gave up a minute in,
 * and for the API's own 409 on any route. On a route that applies a change (`confirmRules`,
 * `setupConfirm`, `goLive`, or `confirmTool` turning tools off), an uncertain failure
 * (`isUncertain`, the give-up included) may still apply: the screen reads where things stand first
 * and says so in its own words, never with this line.
 */
export function ownerErrorCopy(err: unknown): string {
  if (!(err instanceof ApiError)) return OWNER_ERROR_COPY.unavailable;
  if (err.code === 'rules_cannot_be_checked') return RULES_UNAVAILABLE_COPY;
  if (err.code !== null && KERNEL_CODES.has(err.code)) return errorCopy(err.code as KernelErrorCode);
  return OWNER_ERROR_COPY[err.kind];
}

// Seeing requests: the providers end the owner's session on a 401, once one has succeeded.

export type RequestOutcome = { key: RouteKey; ok: true } | { key: RouteKey; ok: false; error: ApiError };

const observers = new Set<(outcome: RequestOutcome) => void>();

/** Calls `listener` after every request settles. Returns the function that stops it. */
export function observeRequests(listener: (outcome: RequestOutcome) => void): () => void {
  observers.add(listener);
  return () => {
    observers.delete(listener);
  };
}

function notify(outcome: RequestOutcome): void {
  for (const listener of observers) {
    try {
      listener(outcome);
    } catch {
      // An observer never changes a request's result.
    }
  }
}

// Options

type HasKeys<T> = keyof T extends never ? false : true;

/** Path params, bodies and required query values are typed by the route; `signal` closes the request. */
export type RequestOptions<K extends RouteKey> = ({} extends RouteQuery<K>
  ? { query?: RouteQuery<K> }
  : { query: RouteQuery<K> }) & (HasKeys<RouteParams<K>> extends true
  ? { params: RouteParams<K> }
  : { params?: undefined }) &
  (RouteBody<K> extends undefined ? { body?: undefined } : { body: RouteBody<K> }) & {
    /** Closes the request, its retries included: it then rejects with an `AbortError`. */
    signal?: AbortSignal;
  };

type RequestArgs<K extends RouteKey> = Record<string, never> extends RequestOptions<K>
  ? [opts?: RequestOptions<K>]
  : [opts: RequestOptions<K>];

// Reading answers

interface Answer {
  status: number;
  /** The parsed JSON body, or undefined when there was none or it wasn't JSON. */
  body: unknown;
  /** True when a body was present but wasn't JSON. */
  unreadable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

function codeOf(body: Record<string, unknown>): string | null {
  const raw = body.error === 'kernel' ? body.code : body.error;
  return typeof raw === 'string' && CODE.test(raw) ? raw : null;
}

function retryAfterOf(body: Record<string, unknown>): number | null {
  const value = body.retry_after;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function decisionOf(value: unknown): Decision | null {
  return isRecord(value) && typeof value.decision_id === 'string' && typeof value.state === 'string'
    ? (value as unknown as Decision)
    : null;
}

/** Every `PaymentLinkState`; a state added to the contract fails to compile until it is listed. */
const paymentLinkStates = {
  issued: true,
  paid: true,
  expired: true,
  cancelled: true,
  unknown: true,
} as const satisfies Record<PaymentLinkState, true>;
const PAYMENT_LINK_STATES: ReadonlySet<string> = new Set(Object.keys(paymentLinkStates));

function stateOf(value: unknown): PaymentLinkState | null {
  return typeof value === 'string' && PAYMENT_LINK_STATES.has(value) ? (value as PaymentLinkState) : null;
}

/** Why a payment link was cancelled, as the kernel says it: only a rule change has a reason. */
function cancelReasonOf(value: unknown): CancelReason | null {
  return value === 'rules_changed' ? value : null;
}

function draftOf(value: unknown): RulesDraft | null {
  return isRecord(value) && typeof value.version === 'number' && Array.isArray(value.cards) ? (value as unknown as RulesDraft) : null;
}

function capCentsOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function kindOf(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  // 422 and any other client error: the request itself can't be done as sent.
  if (status >= 400 && status < 500) return 'unprocessable';
  return 'unavailable';
}

function errorFrom(key: RouteKey, method: HttpMethod, answer: Answer): ApiError {
  const body = isRecord(answer.body) ? answer.body : {};
  const conflict = answer.status === 409;
  return new ApiError(kindOf(answer.status), {
    route: key,
    method,
    status: answer.status,
    code: codeOf(body),
    kernel: body.error === 'kernel',
    retryAfter: retryAfterOf(body),
    decision: conflict ? decisionOf(body.decision) : null,
    state: conflict ? stateOf(body.state) : null,
    cancelReason: conflict ? cancelReasonOf(body.cancel_reason) : null,
    draft: conflict ? draftOf(body.draft) : null,
    capCents: answer.status === 422 ? capCentsOf(body.cap_cents) : null,
    lineKey: answer.status === 422 && body.error === 'line_refused' && typeof body.key === 'string' ? body.key : null,
  });
}

/** A response's status and its body read as JSON. */
async function readAnswer(res: Response): Promise<Answer> {
  const text = await res.text();
  if (text === '') return { status: res.status, body: undefined, unreadable: false };
  try {
    return { status: res.status, body: JSON.parse(text) as unknown, unreadable: false };
  } catch {
    return { status: res.status, body: undefined, unreadable: true };
  }
}

/** The headers of a request that may carry a JSON body, asking for `accept`. */
function headersFor(body: unknown, accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * One fetch with its own timeout; a failure to get any answer is `network`. Closed by `signal`, it
 * rejects with an `AbortError`.
 */
async function send(key: RouteKey, method: HttpMethod, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Answer> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  const close = () => controller.abort();
  signal?.addEventListener('abort', close);
  try {
    const res = await fetch(path, {
      method,
      headers: headersFor(body, 'application/json'),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    return await readAnswer(res);
  } catch {
    if (signal?.aborted) throw abortError();
    throw new ApiError('network', { route: key, method, status: null });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', close);
  }
}

function timeoutFor(route: RouteSpec): number {
  if (route.proving) return TIMEOUT_MS.proving;
  if (route.model) return TIMEOUT_MS.model;
  return TIMEOUT_MS.default;
}

/** The retry path, resolved and checked to stay a proving route on this origin, else null. */
function provingRetryPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  const base = 'http://desk.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== base || !url.pathname.startsWith(PROVING_PREFIX)) return null;
  return `${url.pathname}${url.search}`;
}

/** Waits `ms`, or rejects with an `AbortError` as soon as `signal` closes. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * A proving route answered 202: post the retry's body to its path every 3 s until something other
 * than a 202 comes back, and give up as `rules_cannot_be_checked` a minute after the first send.
 */
async function followRetry(key: RouteKey, first: Answer, startedAt: number, signal?: AbortSignal): Promise<Answer> {
  const deadline = startedAt + PROVING_GIVE_UP_MS;
  const giveUp = () => new ApiError('unavailable', { route: key, method: 'POST', status: null, code: 'rules_cannot_be_checked' });
  let answer = first;
  while (answer.status === 202) {
    const retry = isRecord(answer.body) && isRecord(answer.body.retry) ? answer.body.retry : null;
    const path = retry ? provingRetryPath(retry.path) : null;
    if (retry === null || path === null) throw new ApiError('unavailable', { route: key, method: 'POST', status: 202 });
    const wait = Math.min(PROVING_RETRY_MS, deadline - Date.now());
    if (wait > 0) await sleep(wait, signal);
    if (Date.now() >= deadline) throw giveUp();
    try {
      answer = await send(key, 'POST', path, retry.body, Math.min(TIMEOUT_MS.proving, deadline - Date.now()), signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (Date.now() >= deadline) throw giveUp();
      throw err;
    }
  }
  return answer;
}

/**
 * Sends `key`'s request and resolves to its answer: the JSON body, or undefined for an empty 202
 * or a 204. Rejects with an `ApiError` for anything else.
 */
export async function request<K extends RouteKey>(key: K, ...[opts]: RequestArgs<K>): Promise<RouteResponse<K>> {
  const route: RouteSpec = ROUTES[key];
  const options = (opts ?? {}) as { params?: RouteParams<K>; query?: RouteQuery; body?: unknown; signal?: AbortSignal };
  try {
    const query = SETUP_CARD_ROUTES.has(key) ? { ...options.query, cards: 1 } : options.query;
    const path = apiPath(key, options.params ?? ({} as RouteParams<K>), query);
    const startedAt = Date.now();
    return await settle(key, route, await send(key, route.method, path, options.body, timeoutFor(route), options.signal), startedAt, options.signal);
  } catch (err) {
    if (err instanceof ApiError) notify({ key, ok: false, error: err });
    throw err;
  }
}

/**
 * `key`'s answer as `request` reads it: a proving route's 202 followed, any other status but a 2xx
 * an `ApiError`, a body that isn't JSON (or an empty one where an answer must have one) unavailable.
 * Notifies the observers of a success; the caller notifies them of a failure.
 */
async function settle<K extends RouteKey>(key: K, route: RouteSpec, first: Answer, startedAt: number, signal?: AbortSignal): Promise<RouteResponse<K>> {
  let answer = first;
  if (answer.status === 202 && route.proving) answer = await followRetry(key, answer, startedAt, signal);
  if (answer.status < 200 || answer.status > 299) throw errorFrom(key, route.method, answer);
  // Setup turns always carry an interview, including background work answered 202.
  const empty = answer.body === undefined && (['setupConsent', 'setupAnswer', 'setupProposal', 'setupSuggestions'].includes(key) || (answer.status !== 202 && answer.status !== 204));
  if (answer.unreadable || empty) throw new ApiError('unavailable', { route: key, method: route.method, status: answer.status });
  notify({ key, ok: true });
  return answer.body as RouteResponse<K>;
}

// Event streams: an answer that grows, posted with `Accept: text/event-stream`.

/**
 * The stream couldn't be read to its end: it didn't open, broke off, ended before its last event
 * or went quiet past its keepalives. Nothing it said is an answer; the JSON request is the way round.
 */
export class StreamBroken extends Error {
  constructor() {
    super('stream_broken');
    this.name = 'StreamBroken';
  }
}

/** Whether this browser can read a response's body as it arrives. */
export function canReadStreams(): boolean {
  return typeof ReadableStream === 'function' && typeof TextDecoder === 'function' && typeof Response === 'function' && 'body' in Response.prototype;
}

/**
 * The `ApiError` an `error` event names: `{status, error}` and any field the JSON route's refusal
 * carries (a 422's `cap_cents`), read as that refusal would be. A status that isn't an HTTP error
 * reads as unavailable.
 */
export function streamedError(key: RouteKey, payload: Record<string, unknown>): ApiError {
  const { status } = payload;
  const known = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
  return errorFrom(key, ROUTES[key].method, { status: known ? status : 503, body: payload, unreadable: false });
}

/** What reads a stream's events: each event's name and data, with the stream's last answer once it comes. */
export interface EventsCall<T> {
  /** Returns the stream's answer to end it, or undefined to read on; throws an `ApiError` to end it failed. */
  onEvent(name: string, data: string): T | undefined;
  /** Closes the stream: the request rejects with an `AbortError`. */
  signal?: AbortSignal;
}

/**
 * Sends `key`'s request asking for an event stream and reads its events with `call` until one is
 * the answer. A refusal answered as JSON before any stream (a 401, 404, 422, 429 or 503) is read as
 * `request` reads it, as is a JSON answer from a server that streams nothing. Rejects with the
 * `ApiError` of a refusal or of the event that failed it, with `StreamBroken` when the stream can't
 * be read to its answer (the caller asks again as JSON), and with an `AbortError` once `signal`
 * closes it. Between pieces the stream may go quiet for `TIMEOUT_MS.model` (its keepalives come
 * every 15 seconds), and it may run `PROVING_GIVE_UP_MS` in all: keepalives alone never hold it open.
 */
export async function requestEvents<K extends RouteKey, T>(
  key: K,
  opts: RequestOptions<K>,
  call: EventsCall<T>,
): Promise<{ streamed: true; value: T } | { streamed: false; value: RouteResponse<K> }> {
  const route: RouteSpec = ROUTES[key];
  const options = opts as { params?: RouteParams<K>; query?: RouteQuery; body?: unknown };
  const path = apiPath(key, options.params ?? ({} as RouteParams<K>), options.query);
  const startedAt = Date.now();
  const controller = new AbortController();
  const closed = () => call.signal?.aborted === true;
  const close = () => controller.abort();
  if (closed()) throw abortError();
  call.signal?.addEventListener('abort', close);
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(close, TIMEOUT_MS.model);
  };
  heard();
  const deadline = setTimeout(close, PROVING_GIVE_UP_MS);
  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method: route.method,
        headers: headersFor(options.body, 'text/event-stream'),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch {
      if (closed()) throw abortError();
      throw new StreamBroken();
    }
    if (res.status !== 200 || !/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '') || res.body === null) {
      let answer: Answer;
      try {
        answer = await readAnswer(res);
      } catch {
        if (closed()) throw abortError();
        throw new ApiError('network', { route: key, method: route.method, status: null });
      }
      clearTimeout(quiet);
      return { streamed: false, value: await settle(key, route, answer, startedAt, call.signal) };
    }
    const reader = res.body.getReader();
    const stop = () => void reader.cancel().catch(() => undefined);
    controller.signal.addEventListener('abort', stop);
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        let piece: ReadableStreamReadResult<Uint8Array>;
        try {
          piece = await reader.read();
        } catch {
          if (closed()) throw abortError();
          throw new StreamBroken();
        }
        if (closed()) throw abortError();
        if (piece.done) throw new StreamBroken();
        heard();
        for (const message of parser.push(decoder.decode(piece.value, { stream: true }))) {
          const value = call.onEvent(message.event, message.data);
          if (value !== undefined) {
            notify({ key, ok: true });
            return { streamed: true, value };
          }
        }
      }
    } finally {
      controller.signal.removeEventListener('abort', stop);
      stop();
    }
  } catch (err) {
    if (err instanceof ApiError) notify({ key, ok: false, error: err });
    throw err;
  } finally {
    clearTimeout(quiet);
    clearTimeout(deadline);
    call.signal?.removeEventListener('abort', close);
  }
}
