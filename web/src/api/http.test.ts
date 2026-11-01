/**
 * The request layer with a stubbed `fetch` and fake timers: error kinds, what a body may carry
 * into the app, headers, timeouts and the proving routes' 202 retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UNREACHABLE_COPY, errorCopy } from '../ds/index.ts';
import { rivera } from '../ds/fixtures/index.ts';
import type { RulesDraft } from './views.ts';
import {
  ApiError,
  OWNER_ERROR_COPY,
  RULES_UNAVAILABLE_COPY,
  isUncertain,
  newIdempotencyKey,
  ownerErrorCopy,
  request,
  type ApiErrorKind,
} from './http.ts';

type FetchArgs = Parameters<typeof fetch>;

/** A fetch answer: a status and JSON body after `delayMs`, or a rejection; aborting rejects. */
interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
  throws?: Error;
  hang?: boolean;
}

const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
let replies: Reply[] = [];

function reply(r: Reply): void {
  replies.push(r);
}

function fakeFetch(_input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> {
  const r = replies.length > 1 ? replies.shift()! : (replies[0] ?? { status: 200, body: {} });
  return new Promise<Response>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (init?.signal?.aborted) return abort();
    init?.signal?.addEventListener('abort', abort);
    if (r.hang) return;
    const settle = () => {
      if (r.throws) return reject(r.throws);
      const text = r.raw ?? (r.body === undefined ? null : JSON.stringify(r.body));
      resolve(new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } }));
    };
    if (r.delayMs) timer = setTimeout(settle, r.delayMs);
    else settle();
  });
}

/** Settles `promise` while timers advance; returns the ApiError it rejected with. */
async function failure(promise: Promise<unknown>, advanceMs = 0): Promise<ApiError> {
  const settled = promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  const err = await settled;
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

function call(n: number): { url: string; init: RequestInit } {
  const args = fetchMock.mock.calls[n];
  if (!args) throw new Error(`no fetch call ${n}`);
  return { url: String(args[0]), init: args[1] ?? {} };
}

it('carries only a refused public line key, never its internal reason', async () => {
  reply({ status: 422, body: { error: 'line_refused', key: 'policy:pricing', reason: 'internal untrusted text' } });
  const err = await failure(request('setupPublicLinesConfirm', { params: { id: 'i1' }, body: { keys: ['policy:pricing'], revision: 'revision-1' } }));
  expect(err.lineKey).toBe('policy:pricing');
  expect(JSON.stringify(err)).not.toContain('internal untrusted text');
  replies = [{ status: 500, body: { error: 'line_refused', key: 'policy:pricing' } }];
  expect((await failure(request('setupPublicLines', { params: { id: 'i1' } }))).lineKey).toBeNull();
  replies = [{ status: 422, body: { error: 'line_refused', key: { bad: true } } }];
  expect((await failure(request('setupPublicLines', { params: { id: 'i1' } }))).lineKey).toBeNull();
});

const draft: RulesDraft = {
  version: 8,
  cards: [rivera.ruleCards['rv-quote']],
  diff: null,
  proof: { ok: true, method: 'symcc', checks: [] },
  summary: { on_its_own: [], asks_you: [], never: [] },
};

beforeEach(() => {
  vi.useFakeTimers();
  replies = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(fakeFetch);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('async_answers_and_decisions_require_a_state_body_without_a_proving_retry', async () => {
    for (const key of ['setupAnswer', 'setupProposal'] as const) {
      const sendTurn = () => key === 'setupAnswer'
        ? request('setupAnswer', { params: { id: 's1' }, body: { question: 'what_you_do', text: 'Yes' } })
        : request('setupProposal', { params: { id: 's1', proposal_id: 'p1' }, body: { accept: true } });
      const state = { interview_id: 's1', busy: true, pending_card: 'p1', question: null };
      replies = [{ status: 202, body: state }];
      await expect(sendTurn()).resolves.toEqual(state);
      replies = [{ status: 202 }];
      await expect(sendTurn()).rejects.toMatchObject({ kind: 'unavailable' });
    }
  });

  it('consent_202_requires_and_returns_the_interview_without_a_proving_retry', async () => {
    const state = { interview_id: 's1', step: 'questions', consent: true, question: null, busy: true, messages: [] };
    reply({ status: 202, body: state });
    await expect(request('setupConsent', { params: { id: 's1' }, body: { allow: true } })).resolves.toEqual(state);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    replies = [{ status: 202 }];
    await expect(request('setupConsent', { params: { id: 's1' }, body: { allow: true } })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('opts_into_cards_on_all_five_setup_reads_and_mutations_but_not_start', async () => {
    const requests = [
      () => request('setup', { params: { id: 'i1' }, query: { after: 'marker', cards: '0' } }),
      () => request('setupConsent', { params: { id: 'i1' }, body: { allow: true } }),
      () => request('setupAnswer', { params: { id: 'i1' }, body: { question: 'what_you_do', text: 'Tax returns' } }),
      () => request('setupProposal', { params: { id: 'i1', proposal_id: 'p1' }, body: { accept: true } }),
      () => request('setupSuggestions', { params: { id: 'i1' }, body: {} }),
      () => request('startSetup', { body: { description: 'CPA firm', timezone: 'UTC', idempotency_key: 'cards' } }),
      () => request('setupTools', { params: { id: 'i1' } }),
      () => request('me'),
    ];
    reply({ status: 200, body: {} });
    for (const send of requests) await send();
    for (let index = 0; index < requests.length; index += 1) {
      const query = new URL(call(index).url, 'https://example.test').searchParams;
      expect(query.get('cards'), call(index).url).toBe(index < 5 ? '1' : null);
      if (index === 0) expect(query.get('after')).toBe('marker');
    }
  });

  it('sends_setup_suggestions_as_an_empty_object', async () => {
    reply({ status: 200, body: { step: 'tools' } });
    await request('setupSuggestions', { params: { id: 'i1' }, body: {} });
    expect(call(0).url).toBe('/api/owner/setup/i1/suggestions?cards=1');
    expect(call(0).init.method).toBe('POST');
    expect(call(0).init.body).toBe('{}');
  });

  it('sends_setup_decisions_with_both_encoded_path_parameters', async () => {
    reply({ status: 200, body: { step: 'questions' } });
    await request('setupProposal', {
      params: { id: 'interview /1', proposal_id: 'p/2' },
      body: { accept: true, title: 'Intro consult' },
    });
    expect(call(0).url).toBe('/api/owner/setup/interview%20%2F1/proposals/p%2F2?cards=1');
    expect(call(0).init.method).toBe('POST');
    expect(call(0).init.credentials).toBe('same-origin');
    expect(JSON.parse(String(call(0).init.body))).toEqual({ accept: true, title: 'Intro consult' });
  });

  it('maps_status_to_error_kind', async () => {
    const cases: [number, ApiErrorKind][] = [
      [401, 'unauthorized'],
      [404, 'not_found'],
      [409, 'conflict'],
      [422, 'unprocessable'],
      [500, 'unavailable'],
      [502, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      replies = [{ status, body: { error: 'x' } }];
      const err = await failure(request('me'));
      expect([status, err.kind, err.status]).toEqual([status, kind, status]);
    }

    replies = [{ status: 429, body: { error: 'rate_limited', retry_after: 7 } }];
    const limited = await failure(request('sendMessage', { params: { slug: 'rivera' }, body: { text: 'hi' } }));
    expect([limited.kind, limited.retryAfter]).toEqual(['rate_limited', 7]);

    replies = [{ throws: new TypeError('Failed to fetch') }];
    expect((await failure(request('me'))).kind).toBe('network');

    replies = [{ hang: true }];
    const timedOut = await failure(request('me'), 10_000);
    expect([timedOut.kind, timedOut.status]).toEqual(['network', null]);

    // A 2xx whose body isn't JSON is not trusted as an answer.
    replies = [{ status: 200, raw: 'not json' }];
    expect((await failure(request('me'))).kind).toBe('unavailable');
    // Nor is an empty one, unless its status says there is nothing to send.
    replies = [{ status: 200 }];
    expect((await failure(request('me'))).kind).toBe('unavailable');
    replies = [{ status: 204 }];
    await expect(request('deleteDesk', { params: { desk_id: 'd1' } })).resolves.toBeUndefined();
  });

  it('client_never_sets_auth_headers', async () => {
    replies = [{ status: 200, body: {} }];
    await request('me');
    await request('copies', { body: { passcode: 'demo' } });
    await request('sendMessage', { params: { slug: 'rivera' }, body: { text: 'hi' } });
    await request('answer', { params: { decision_id: 'd1' }, body: { answer: 'allow_once' } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (let n = 0; n < 4; n += 1) {
      const { init } = call(n);
      expect(init.credentials).toBe('same-origin');
      const names = [...new Headers(init.headers).keys()];
      for (const forbidden of ['x-owner-session', 'x-session-token', 'authorization', 'cookie']) {
        expect(names).not.toContain(forbidden);
      }
    }
    expect(call(1).init.body).toBe(JSON.stringify({ passcode: 'demo' }));
    expect(new Headers(call(1).init.headers).get('content-type')).toBe('application/json');
  });

  it('errors_carry_no_server_text', async () => {
    replies = [{ status: 500, body: { error: 'kernel exploded' } }];
    const exploded = await failure(request('me'));
    expect(exploded.message).toBe('unavailable');
    expect(exploded.code).toBeNull();
    expect(JSON.stringify({ ...exploded, message: exploded.message, stack: '' })).not.toContain('exploded');
    expect(ownerErrorCopy(exploded)).toBe('Something went wrong on our side. Try again in a moment.');

    replies = [{ status: 503, body: { error: 'kernel', code: 'seed_unproved' } }];
    const unproved = await failure(request('today', { params: { desk_id: 'd1' } }));
    expect([unproved.kind, unproved.code, unproved.message]).toEqual(['unavailable', 'seed_unproved', 'unavailable']);
    expect(ownerErrorCopy(unproved)).toBe(errorCopy('seed_unproved'));

    replies = [{ status: 409, body: { error: 'already_resolved', decision: rivera.decisions.approved } }];
    const resolved = await failure(request('answer', { params: { decision_id: 'd1' }, body: { answer: 'allow_once' } }));
    expect([resolved.kind, resolved.code, resolved.message]).toEqual(['conflict', 'already_resolved', 'conflict']);

    expect(OWNER_ERROR_COPY.unavailable).toBe(UNREACHABLE_COPY.en);
    expect(OWNER_ERROR_COPY.rate_limited).toBe("That's a lot of requests at once. Wait a moment, then try again.");
    expect(ownerErrorCopy(new Error('boom'))).toBe(OWNER_ERROR_COPY.unavailable);
  });

  it('conflict_keeps_the_decision', async () => {
    replies = [{ status: 409, body: { error: 'already_resolved', decision: rivera.decisions.approved } }];
    const resolved = await failure(request('answer', { params: { decision_id: 'd1' }, body: { answer: 'allow_once' } }));
    expect(resolved.decision).toEqual(rivera.decisions.approved);
    expect([resolved.state, resolved.draft]).toEqual([null, null]);

    replies = [{ status: 409, body: { error: 'rules_changed_since_draft', draft } }];
    const changed = await failure(request('setupConfirm', { params: { id: 'i1' } }));
    expect(changed.draft).toEqual(draft);

    replies = [{ status: 409, body: { error: 'conflict', state: 'paid' } }];
    const paid = await failure(request('completePayment', { params: { token: 'k7Hq2vX9' } }));
    expect([paid.state, paid.cancelReason]).toEqual(['paid', null]);

    // A link a rule change cancelled says so, as the API reads it back on a 409 (plan 02b).
    replies = [{ status: 409, body: { error: 'kernel', code: 'conflict', state: 'cancelled', cancel_reason: 'rules_changed' } }];
    const cancelled = await failure(request('completePayment', { params: { token: 'k7Hq2vX9' } }));
    expect([cancelled.code, cancelled.state, cancelled.cancelReason]).toEqual(['conflict', 'cancelled', 'rules_changed']);
    replies = [{ status: 409, body: { error: 'kernel', code: 'conflict', state: 'cancelled', cancel_reason: 'because' } }];
    expect((await failure(request('cancelPayment', { params: { token: 'k7Hq2vX9' } }))).cancelReason).toBeNull();

    // Only a 409 carries them, and only in shape.
    replies = [{ status: 500, body: { error: 'x', decision: rivera.decisions.approved, state: 'paid', cancel_reason: 'rules_changed', draft } }];
    const other = await failure(request('me'));
    expect([other.decision, other.state, other.cancelReason, other.draft]).toEqual([null, null, null, null]);
    replies = [{ status: 409, body: { error: 'x', decision: { decision_id: 7 }, state: 'gone', draft: { version: '8' } } }];
    const malformed = await failure(request('me'));
    expect([malformed.decision, malformed.state, malformed.draft]).toEqual([null, null, null]);

    // A write whose answer was lost may have been applied; a read or a clear answer is certain.
    replies = [{ throws: new TypeError('Failed to fetch') }];
    expect(isUncertain(await failure(request('answer', { params: { decision_id: 'd1' }, body: { answer: 'deny_once' } })))).toBe(true);
    replies = [{ status: 502 }];
    expect(isUncertain(await failure(request('sendMessage', { params: { slug: 'r' }, body: { text: 'hi' } })))).toBe(true);
    replies = [{ throws: new TypeError('Failed to fetch') }];
    expect(isUncertain(await failure(request('me')))).toBe(false);
    expect(isUncertain(resolved)).toBe(false);
  });

  it('proving_202_follows_retry', async () => {
    const B = { cards: ['rv-quote'], expected_parent: 7 };
    replies = [
      { status: 202, body: { retry: { path: '/api/owner/policy/d1/draft', body: B } }, delayMs: 25_000 },
      { status: 200, body: draft },
    ];
    const pending = request('draftRules', { params: { desk_id: 'd1' }, body: { add: [] } });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual(draft);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).url).toBe('/api/owner/policy/d1/draft');
    expect(call(1).init.method).toBe('POST');
    expect(call(1).init.body).toBe(JSON.stringify(B));
  });

  it('proving_gives_up_as_rules_cannot_be_checked', async () => {
    replies = [{ status: 202, body: { retry: { path: '/api/owner/policy/d1/draft', body: {} } } }];
    const err = await failure(request('draftRules', { params: { desk_id: 'd1' }, body: { add: [] } }), 60_000);
    expect([err.kind, err.code]).toEqual(['unavailable', 'rules_cannot_be_checked']);
    expect(ownerErrorCopy(err)).toBe(RULES_UNAVAILABLE_COPY);
    expect(RULES_UNAVAILABLE_COPY).toBe(
      "Rules can't be checked right now, so this change can't be applied yet. Your current rules stay in place.",
    );
    // The first send, then one retry every 3 s until the minute is up.
    expect(fetchMock).toHaveBeenCalledTimes(20);
    for (let n = 1; n < 20; n += 1) expect(call(n).url).toBe('/api/owner/policy/d1/draft');
  });

  it('rules_cannot_be_checked_is_uncertain_only_when_the_app_gave_up', async () => {
    const confirm = () => request('confirmRules', { params: { desk_id: 'd1' }, body: { version: 8 } });
    const shape = (err: ApiError) => [err.kind, err.status, err.code, isUncertain(err)];

    // The API's own answer that the rules couldn't be checked: nothing applied, and it says so.
    replies = [{ status: 409, body: { error: 'rules_cannot_be_checked' } }];
    const answered = await failure(confirm());
    expect(shape(answered)).toEqual(['conflict', 409, 'rules_cannot_be_checked', false]);
    expect(ownerErrorCopy(answered)).toBe(RULES_UNAVAILABLE_COPY);

    // The app stopped waiting a minute after the first send, while the API was still checking: the
    // change may still apply, so a screen reads the rules before it says anything.
    const stillChecking = { status: 202, body: { retry: { path: '/api/owner/policy/d1/confirm', body: { version: 8 } } } };
    replies = [stillChecking];
    expect(shape(await failure(confirm(), 60_000))).toEqual(['unavailable', null, 'rules_cannot_be_checked', true]);

    // The same when the last retry got no answer by the end of the minute.
    fetchMock.mockClear();
    replies = [...Array<Reply>(19).fill(stillChecking), { hang: true }];
    expect(shape(await failure(confirm(), 60_000))).toEqual(['unavailable', null, 'rules_cannot_be_checked', true]);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('proving_request_waits_past_25_s', async () => {
    replies = [{ status: 200, body: draft, delayMs: 26_000 }];
    const proving = request('confirmRules', { params: { desk_id: 'd1' }, body: { version: 8 } });
    await vi.advanceTimersByTimeAsync(26_000);
    await expect(proving).resolves.toEqual(draft);

    replies = [{ hang: true }];
    const plain = request('today', { params: { desk_id: 'd1' } });
    const plainFailed = plain.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await Promise.race([plainFailed, Promise.resolve('waiting')])).toBe('waiting');
    expect((await failure(plain, 1)).kind).toBe('network');

    const model = request('setupAnswer', { params: { id: 'i1' }, body: { question: 'what_you_do', text: 'Plumbing in Portland' } });
    const modelFailed = model.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(await Promise.race([modelFailed, Promise.resolve('waiting')])).toBe('waiting');
    expect((await failure(model, 1)).kind).toBe('network');

    const proof = request('draftRules', { params: { desk_id: 'd1' }, body: { add: [] } });
    const proofFailed = proof.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await Promise.race([proofFailed, Promise.resolve('waiting')])).toBe('waiting');
    expect((await failure(proof, 1)).kind).toBe('network');
  });

  it('retry_outside_policy_is_refused', async () => {
    for (const path of ['/api/owner/copies', '/api/owner/policy/../copies', '//evil.example/api/owner/policy/x', 'https://evil.example/api/owner/policy/x', 42]) {
      fetchMock.mockClear();
      replies = [{ status: 202, body: { retry: { path, body: {} } } }, { status: 200, body: draft }];
      const err = await failure(request('draftRules', { params: { desk_id: 'd1' }, body: { add: [] } }), 3_000);
      expect([String(path), err.kind]).toEqual([String(path), 'unavailable']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe('newIdempotencyKey', () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('makes_a_random_uuid_with_or_without_random_uuid', () => {
    // The browser's own `randomUUID` where it has one; it exists only on a secure page (https or
    // localhost), so elsewhere the key is a version 4 UUID built from `getRandomValues`.
    expect(newIdempotencyKey({ randomUUID: () => '00000000-0000-4000-8000-000000000000', getRandomValues: crypto.getRandomValues.bind(crypto) })).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
    const insecure = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const keys = Array.from({ length: 50 }, () => newIdempotencyKey(insecure));
    for (const key of keys) expect(key).toMatch(V4);
    expect(new Set(keys).size).toBe(keys.length);
    expect(newIdempotencyKey()).toMatch(V4);
  });
});
