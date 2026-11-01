/**
 * Ask Claude's answer as a stream, with a stubbed `fetch`: the growing text from whole-text deltas
 * and resets, the answer from `final` only, an error event or a JSON refusal shown as the JSON
 * route's would be, keepalives dropped, and today's JSON request whenever the stream can't be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, PROVING_GIVE_UP_MS, observeRequests, type RequestOutcome } from './http.ts';
import { askRuleChat, canStream } from './ruleChatStream.ts';
import type { RuleChatOut } from './views.ts';

type FetchArgs = Parameters<typeof fetch>;

const DESK = 'desk-rivera';
const FINAL: RuleChatOut = { answer: 'Yes. Right now every payment asks you first.', draft: null };

const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();

/** A body that sends `pieces` one after another, and then ends unless `hang`. */
function body(pieces: readonly string[], { hang = false } = {}): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const encoder = new TextEncoder();
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[index];
      index += 1;
      if (piece !== undefined) controller.enqueue(encoder.encode(piece));
      else if (!hang) controller.close();
      else return new Promise<void>(() => {});
      return undefined;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

function events(pieces: readonly string[], opts?: { hang?: boolean }) {
  const made = body(pieces, opts);
  return { response: new Response(made.stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }), cancelled: made.cancelled };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function headersOf(n: number): Headers {
  return new Headers(fetchMock.mock.calls[n]?.[1]?.headers);
}

let outcomes: RequestOutcome[] = [];
let stopObserving: () => void = () => {};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  outcomes = [];
  stopObserving = observeRequests((outcome) => outcomes.push(outcome));
});

afterEach(() => {
  stopObserving();
  vi.unstubAllGlobals();
});

describe('askRuleChat', () => {
  it('shows_each_whole_text_delta_then_answers_with_the_final', async () => {
    fetchMock.mockResolvedValueOnce(
      events([frame('delta', { text: 'Yes' }), frame('delta', { text: 'Yes. Right now' }), frame('final', FINAL)]).response,
    );
    const texts: string[] = [];
    const out = await askRuleChat(DESK, 'Can I take deposits?', { onText: (text) => texts.push(text) });
    expect(out).toEqual(FINAL);
    expect(texts).toEqual(['Yes', 'Yes. Right now']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('/api/owner/policy/desk-rivera/chat');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBe(JSON.stringify({ text: 'Can I take deposits?' }));
    expect(headersOf(0).get('accept')).toBe('text/event-stream');
    expect(headersOf(0).get('content-type')).toBe('application/json');
    expect(outcomes).toEqual([{ key: 'ruleChat', ok: true }]);
  });

  it('clears_the_text_on_reset', async () => {
    fetchMock.mockResolvedValueOnce(
      events([frame('delta', { text: "Here's what I'd" }), frame('reset', {}), frame('delta', { text: "Here's the plan" }), frame('final', FINAL)]).response,
    );
    const texts: string[] = [];
    await askRuleChat(DESK, 'Plan?', { onText: (text) => texts.push(text) });
    expect(texts).toEqual(["Here's what I'd", '', "Here's the plan"]);
  });

  it('drops_keepalives_and_reads_events_split_between_pieces', async () => {
    const whole = `: ping\n\n${frame('delta', { text: 'Yes' })}: ping\n\n${frame('final', FINAL)}`;
    fetchMock.mockResolvedValueOnce(events([whole.slice(0, 13), whole.slice(13, 40), whole.slice(40)]).response);
    const texts: string[] = [];
    expect(await askRuleChat(DESK, 'Deposits?', { onText: (text) => texts.push(text) })).toEqual(FINAL);
    expect(texts).toEqual(['Yes']);
  });

  it('takes_the_draft_only_from_the_final', async () => {
    const draft = { version: 4, cards: [], diff: null, proof: { ok: true } };
    fetchMock.mockResolvedValueOnce(
      events([frame('delta', { text: 'Here it is', draft }), frame('final', { answer: 'Here it is.', draft })]).response,
    );
    const texts: string[] = [];
    const out = await askRuleChat(DESK, 'Draft it', { onText: (text) => texts.push(text) });
    expect(texts).toEqual(['Here it is']);
    expect(out).toEqual({ answer: 'Here it is.', draft });
  });

  it('ignores_a_delta_without_text_and_events_it_does_not_know', async () => {
    fetchMock.mockResolvedValueOnce(
      events([frame('delta', { words: 'no' }), 'event: delta\ndata: not json\n\n', frame('surprise', { text: 'no' }), frame('final', FINAL)]).response,
    );
    const texts: string[] = [];
    expect(await askRuleChat(DESK, 'Hi', { onText: (text) => texts.push(text) })).toEqual(FINAL);
    expect(texts).toEqual([]);
  });

  it('fails_with_the_error_event_as_the_json_route_would', async () => {
    fetchMock.mockResolvedValueOnce(events([frame('delta', { text: 'Let me' }), frame('error', { status: 409, error: 'rules_cannot_be_checked' })]).response);
    const err = await askRuleChat(DESK, 'Weekends', { onText: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: 'conflict', status: 409, code: 'rules_cannot_be_checked', route: 'ruleChat' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([{ key: 'ruleChat', ok: false, error: err }]);
  });

  it('keeps_the_money_limit_an_error_event_names', async () => {
    fetchMock.mockResolvedValueOnce(events([frame('error', { status: 422, error: 'above_money_cap', cap_cents: 50_000 })]).response);
    const err = await askRuleChat(DESK, 'Refunds', { onText: () => {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unprocessable', code: 'above_money_cap', capCents: 50_000 });
  });

  it('reads_an_error_event_as_the_json_routes_own_error_body', async () => {
    // The event is the JSON route's error body plus its status: a 422 with no limit set yet.
    fetchMock.mockResolvedValueOnce(events([frame('error', { status: 422, error: 'above_money_cap', cap_cents: 0 })]).response);
    expect(await askRuleChat(DESK, 'Refunds', { onText: () => {} }).catch((e: unknown) => e)).toMatchObject({
      kind: 'unprocessable',
      status: 422,
      code: 'above_money_cap',
      capCents: 0,
    });
    // An unexpected failure is the JSON route's 500.
    fetchMock.mockResolvedValueOnce(events([frame('delta', { text: 'Let me' }), frame('error', { status: 500, error: 'internal' })]).response);
    expect(await askRuleChat(DESK, 'Refunds', { onText: () => {} }).catch((e: unknown) => e)).toMatchObject({ kind: 'unavailable', status: 500, code: 'internal' });
    // A kernel refusal names its code, as the JSON body does.
    fetchMock.mockResolvedValueOnce(events([frame('error', { status: 503, error: 'kernel', code: 'kernel_unavailable' })]).response);
    expect(await askRuleChat(DESK, 'Refunds', { onText: () => {} }).catch((e: unknown) => e)).toMatchObject({ kind: 'unavailable', code: 'kernel_unavailable', kernel: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails_with_a_json_refusal_before_any_stream_and_sends_nothing_again', async () => {
    fetchMock.mockResolvedValueOnce(json(429, { error: 'rate_limited', retry_after: 5 }));
    const err = await askRuleChat(DESK, 'Hi', { onText: () => {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', status: 429, retryAfter: 5 });
    fetchMock.mockResolvedValueOnce(json(503, { error: 'demo_budget' }));
    expect(await askRuleChat(DESK, 'Hi', { onText: () => {} }).catch((e: unknown) => e)).toMatchObject({ kind: 'unavailable', code: 'demo_budget' });
    fetchMock.mockResolvedValueOnce(json(401, { error: 'no_owner_session' }));
    expect(await askRuleChat(DESK, 'Hi', { onText: () => {} }).catch((e: unknown) => e)).toMatchObject({ kind: 'unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, false, false]);
  });

  it('takes_a_json_answer_when_the_server_sends_no_stream', async () => {
    fetchMock.mockResolvedValueOnce(json(200, FINAL));
    const texts: string[] = [];
    expect(await askRuleChat(DESK, 'Hi', { onText: (text) => texts.push(text) })).toEqual(FINAL);
    expect(texts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks_again_without_streaming_when_the_stream_ends_before_its_final', async () => {
    fetchMock.mockResolvedValueOnce(events([frame('delta', { text: 'Yes' })]).response).mockResolvedValueOnce(json(200, FINAL));
    const texts: string[] = [];
    expect(await askRuleChat(DESK, 'Hi', { onText: (text) => texts.push(text) })).toEqual(FINAL);
    // The growing text goes back to Claude writing while the JSON answer is on its way.
    expect(texts).toEqual(['Yes', '']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(1).get('accept')).toBe('application/json');
  });

  it('asks_again_without_streaming_when_the_stream_cannot_open', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json(200, FINAL));
    expect(await askRuleChat(DESK, 'Hi', { onText: () => {} })).toEqual(FINAL);
    expect(headersOf(1).get('accept')).toBe('application/json');
  });

  it('fails_as_today_when_the_json_request_fails_too', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await askRuleChat(DESK, 'Hi', { onText: () => {} }).catch((e: unknown) => e)).toMatchObject({ kind: 'network' });
  });

  it('asks_without_streaming_where_the_browser_cannot_read_a_stream', async () => {
    fetchMock.mockResolvedValueOnce(json(200, FINAL));
    // A browser with no way to decode a body's bytes as they arrive.
    vi.stubGlobal('TextDecoder', undefined);
    expect(canStream()).toBe(false);
    expect(await askRuleChat(DESK, 'Hi', { onText: () => {} })).toEqual(FINAL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOf(0).get('accept')).toBe('application/json');
  });

  it('closes_the_stream_when_asked_and_asks_nothing_again', async () => {
    const open = events([frame('delta', { text: 'Yes' })], { hang: true });
    fetchMock.mockImplementationOnce((_input, init) => {
      init?.signal?.addEventListener('abort', () => undefined);
      return Promise.resolve(open.response);
    });
    const controller = new AbortController();
    const texts: string[] = [];
    const asked = askRuleChat(DESK, 'Hi', { onText: (text) => texts.push(text), signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(texts).toEqual(['Yes']));
    controller.abort();
    const err = await asked;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(open.cancelled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks_again_without_streaming_when_the_stream_goes_quiet_past_its_keepalives', async () => {
    vi.useFakeTimers();
    try {
      const open = events([': ping\n\n', frame('delta', { text: 'Yes' })], { hang: true });
      fetchMock.mockResolvedValueOnce(open.response).mockResolvedValueOnce(json(200, FINAL));
      const texts: string[] = [];
      const asked = askRuleChat(DESK, 'Hi', { onText: (text) => texts.push(text) });
      await vi.advanceTimersByTimeAsync(44_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await asked).toEqual(FINAL);
      expect(texts).toEqual(['Yes', '']);
      expect(open.cancelled()).toBe(true);
      expect(headersOf(1).get('accept')).toBe('application/json');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes_the_json_request_it_fell_back_to_when_asked', async () => {
    let fallback: AbortSignal | undefined;
    fetchMock.mockResolvedValueOnce(events([frame('delta', { text: 'Yes' })]).response).mockImplementationOnce((_input, init) => {
      fallback = init?.signal ?? undefined;
      // The JSON answer never comes until the request is closed.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    });
    const controller = new AbortController();
    const asked = askRuleChat(DESK, 'Hi', { onText: () => {}, signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort();
    const err = await asked;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(fallback?.aborted).toBe(true);
    // Closed is not a failure: nothing is reported as one.
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
  });

  it('closes_the_json_fallback_while_it_waits_to_check_the_rules_again', async () => {
    vi.useFakeTimers();
    try {
      const retry = { retry: { path: `/api/owner/policy/${DESK}/chat`, body: { text: 'Hi' } } };
      fetchMock.mockResolvedValueOnce(events([frame('delta', { text: 'Yes' })]).response).mockResolvedValueOnce(json(202, retry));
      const controller = new AbortController();
      const asked = askRuleChat(DESK, 'Hi', { onText: () => {}, signal: controller.signal }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      controller.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await asked;
      expect((err as DOMException).name).toBe('AbortError');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks_again_without_streaming_when_only_keepalives_come_past_the_deadline', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      const pinging = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame('delta', { text: 'Yes' })));
          timer = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 15_000);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      fetchMock
        .mockResolvedValueOnce(new Response(pinging, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
        .mockResolvedValueOnce(json(200, FINAL));
      const texts: string[] = [];
      const asked = askRuleChat(DESK, 'Hi', { onText: (text) => texts.push(text) });
      await vi.advanceTimersByTimeAsync(PROVING_GIVE_UP_MS - 1_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await asked).toEqual(FINAL);
      expect(texts).toEqual(['Yes', '']);
      expect(headersOf(1).get('accept')).toBe('application/json');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails_closed_on_a_final_it_cannot_read', async () => {
    fetchMock.mockResolvedValueOnce(events([frame('final', { answer: 3 })]).response);
    expect(await askRuleChat(DESK, 'Hi', { onText: () => {} }).catch((e: unknown) => e)).toMatchObject({ kind: 'unavailable', route: 'ruleChat' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
