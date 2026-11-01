/**
 * The mock's owner-chat streams, as a model would write them: the reply's words one by one at the
 * store's pace, each delta the whole text so far, with the pauses, retries, failures and broken
 * connections a test plans.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { growingWords, playReply, type PlayedEvent } from './ownerStreams.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('growingWords', () => {
  it('grows_word_by_word_keeping_the_spacing', () => {
    expect(growingWords('Got it: leaks and\n\nblocked drains.')).toEqual(['Got', 'Got it:', 'Got it: leaks', 'Got it: leaks and', 'Got it: leaks and\n\nblocked', 'Got it: leaks and\n\nblocked drains.']);
    expect(growingWords('')).toEqual([]);
    expect(growingWords('  Yes.')).toEqual(['  Yes.']);
  });
});

describe('playReply', () => {
  function record() {
    const played: PlayedEvent[] = [];
    let ended: string | null = null;
    return {
      played,
      ended: () => ended,
      sink: { event: (ev: PlayedEvent) => played.push(ev), end: (how: 'done' | 'error' | 'drop') => void (ended = how) },
    };
  }

  it('sends_each_word_then_ends', async () => {
    const out = record();
    playReply({ text: 'Yes. Right now', wordMs: 40 }, out.sink);
    expect(out.played).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(out.played).toEqual([{ name: 'delta', text: 'Yes.' }]);
    await vi.advanceTimersByTimeAsync(80);
    expect(out.played).toEqual([
      { name: 'delta', text: 'Yes.' },
      { name: 'delta', text: 'Yes. Right' },
      { name: 'delta', text: 'Yes. Right now' },
    ]);
    expect(out.ended()).toBeNull();
    await vi.advanceTimersByTimeAsync(40);
    expect(out.ended()).toBe('done');
  });

  it('reads_first_then_writes', async () => {
    const out = record();
    playReply({ text: 'Thanks.', wordMs: 10, reads: [{ read: 'memory', host: null, text: 'Searched your Claude memory' }] }, out.sink);
    await vi.runAllTimersAsync();
    expect(out.played).toEqual([
      { name: 'reading', read: 'memory', host: null },
      { name: 'label', read: 'memory', text: 'Searched your Claude memory' },
      { name: 'delta', text: 'Thanks.' },
    ]);
    expect(out.ended()).toBe('done');
  });

  it('pauses_where_a_test_plans_until_it_lets_go', async () => {
    const out = record();
    let release: () => void = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    playReply({ text: 'one two three', wordMs: 10, plan: { pauseAfter: 2, until } }, out.sink);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.played.map((ev) => ('text' in ev ? ev.text : ev.name))).toEqual(['one', 'one two']);
    release();
    await vi.runAllTimersAsync();
    expect(out.played.at(-1)).toEqual({ name: 'delta', text: 'one two three' });
    expect(out.ended()).toBe('done');
  });

  it('sends_no_words_for_a_quiet_reply_and_can_hold_before_its_end', async () => {
    const out = record();
    let release: () => void = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    playReply({ text: 'one two', wordMs: 10, plan: { quiet: true, pauseAfter: 0, until } }, out.sink);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.played).toEqual([]);
    expect(out.ended()).toBeNull();
    release();
    await vi.runAllTimersAsync();
    expect(out.played).toEqual([]);
    expect(out.ended()).toBe('done');
  });

  it('fails_with_the_whole_error_body_planned', async () => {
    const out = record();
    playReply({ text: 'one', wordMs: 10, plan: { fail: { status: 422, error: 'above_money_cap', cap_cents: 0 }, failAfter: 0 } }, out.sink);
    await vi.runAllTimersAsync();
    expect(out.played).toEqual([{ name: 'error', status: 422, error: 'above_money_cap', cap_cents: 0 }]);
  });

  it('holds_wherever_a_test_plans', async () => {
    const out = record();
    let first: () => void = () => {};
    let second: () => void = () => {};
    const holds = [
      { after: 1, until: new Promise<void>((resolve) => (first = resolve)) },
      { after: 2, until: new Promise<void>((resolve) => (second = resolve)) },
    ];
    playReply({ text: 'one two three', wordMs: 10, plan: { holds } }, out.sink);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.played).toHaveLength(1);
    first();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.played).toHaveLength(2);
    second();
    await vi.runAllTimersAsync();
    expect(out.played).toHaveLength(3);
    expect(out.ended()).toBe('done');
  });

  it('starts_again_after_a_reset', async () => {
    const out = record();
    playReply({ text: 'one two', wordMs: 10, plan: { resetAfter: 1 } }, out.sink);
    await vi.runAllTimersAsync();
    expect(out.played).toEqual([
      { name: 'delta', text: 'one' },
      { name: 'reset' },
      { name: 'delta', text: 'one' },
      { name: 'delta', text: 'one two' },
    ]);
  });

  it('fails_or_breaks_off_where_planned', async () => {
    const failed = record();
    playReply({ text: 'one two', wordMs: 10, plan: { fail: { status: 503, error: 'model_unavailable' }, failAfter: 1 } }, failed.sink);
    await vi.runAllTimersAsync();
    expect(failed.played).toEqual([{ name: 'delta', text: 'one' }, { name: 'error', status: 503, error: 'model_unavailable' }]);
    expect(failed.ended()).toBe('error');
    const broken = record();
    playReply({ text: 'one two', wordMs: 10, plan: { dropAfter: 1 } }, broken.sink);
    await vi.runAllTimersAsync();
    expect(broken.played).toEqual([{ name: 'delta', text: 'one' }]);
    expect(broken.ended()).toBe('drop');
  });

  it('stops_when_told', async () => {
    const out = record();
    const stop = playReply({ text: 'one two three', wordMs: 10 }, out.sink);
    await vi.advanceTimersByTimeAsync(10);
    stop();
    await vi.runAllTimersAsync();
    expect(out.played).toEqual([{ name: 'delta', text: 'one' }]);
    expect(out.ended()).toBeNull();
  });
});

describe('a rule chat refused for the payment limit', () => {
  it('keeps_its_answer_only_for_the_stream_of_that_chat', async () => {
    mockStore.reset('rivera');
    const params = { desk_id: RIVERA.deskId };
    // Asked as JSON, the refusal comes back at once; the answer it kept must not outlive that chat.
    expect(await mockStore.dispatch('ruleChat', { params, body: { text: 'Send payment links on your own up to $800' } })).toMatchObject({ status: 422 });
    expect(await mockStore.dispatch('ruleChat', { params, body: { text: 'x'.repeat(2001) } })).toMatchObject({ status: 422, body: { error: 'invalid' } });
    expect(mockStore.ruleChatStream().refusedAnswer).toBeNull();
  });
});
