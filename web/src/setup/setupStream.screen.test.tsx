/**
 * `useSetupStream` in a real browser, over inline MSW `sse()` handlers on the screens' worker: it
 * follows the running turn while watched, reads the interview once the turn is saved, closes its
 * one stream when watching ends and on unmount, looks again only while the turn's request is out,
 * and leaves the step's own reads of the interview to carry on when it can't follow the turn.
 */
import { http, HttpResponse, sse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';

import type { SetupState } from '../api/views.ts';
import { worker } from '../mocks/browser.ts';
import { REOPEN_MS, REOPENS_MAX, useSetupStream } from './setupStream.ts';

const ID = 'setup-streamed';
const EVENTS_URL = `/api/owner/setup/${ID}/events`;

type Named = { delta: unknown; reset: unknown; reading: unknown; label: unknown; done: unknown; error: unknown };

/** Every `EventSource` the page opens in a test, to check none is left open and never two at once. */
let sources: EventSource[] = [];
let openAtOnce = 0;
const PageEventSource = window.EventSource;

beforeEach(() => {
  sources = [];
  openAtOnce = 0;
  window.EventSource = class extends PageEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      sources.push(this);
      openAtOnce = Math.max(openAtOnce, sources.filter((source) => source.readyState !== EventSource.CLOSED).length);
    }
  };
});

afterEach(() => {
  window.EventSource = PageEventSource;
});

const allClosed = () => sources.every((source) => source.readyState === EventSource.CLOSED);

interface Props {
  watching: boolean;
  inFlight: boolean;
  /** How many messages the interview holds as the page has it. */
  saved?: number;
}

async function follow(initialProps: Props, reread: () => Promise<SetupState | null> = () => Promise.resolve(null)) {
  return renderHook((props?: Props) => useSetupStream(ID, props?.watching ?? false, props?.inFlight ?? false, reread, props?.saved ?? 1), { initialProps });
}

describe('useSetupStream', () => {
  it('shows_the_growing_reply_and_reads_the_interview_once_saved', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ event: 'delta', data: { run: 'r_1', text: 'Got' } });
        client.send({ event: 'delta', data: { run: 'r_1', text: 'Got it: leaks and blocked drains.' } });
        // MSW answers once the resolver returns, so the turn ends later, not in it.
        void held.then(() => client.send({ event: 'done', data: { run: 'r_1' } }));
      }),
    );
    // Read again, the interview holds the saved turn and is no longer busy.
    const reread = vi.fn(() => Promise.resolve({ busy: false } as SetupState));
    const hook = await follow({ watching: true, inFlight: false }, reread);
    await vi.waitFor(() => expect(hook.result.current.growing).toEqual({ labels: [], text: 'Got it: leaks and blocked drains.', final: false }));
    expect(reread).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1));
    expect(allClosed()).toBe(true);
    await hook.rerender({ watching: false, inFlight: false });
    expect(hook.result.current).toMatchObject({ growing: null, fellBack: false });
  });

  it('keeps_the_words_till_the_saved_turn_is_read_and_drops_them_once_it_is', async () => {
    let answer: (state: SetupState) => void = () => {};
    const read = new Promise<SetupState>((resolve) => {
      answer = resolve;
    });
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ event: 'delta', data: { run: 'r_8', text: 'Got it.' } });
        client.send({ event: 'done', data: { run: 'r_8' } });
      }),
    );
    const reread = vi.fn(() => read);
    const hook = await follow({ watching: true, inFlight: false, saved: 3 }, reread);
    await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1));
    // Till the saved turn is read, the words it wrote stay, whole.
    expect(hook.result.current.growing).toEqual({ labels: [], text: 'Got it.', final: true });
    answer({ busy: true } as SetupState);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hook.result.current.growing?.text).toBe('Got it.');
    // The interview holds the saved turn, though it may still read busy for a moment: in that same
    // render the words go, so they never show twice.
    await hook.rerender({ watching: true, inFlight: false, saved: 5 });
    expect(hook.result.current.growing).toBeNull();
    expect(hook.result.current.fellBack).toBe(false);
  });

  it('shows_the_reply_whole_once_done_while_its_request_is_out', async () => {
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ event: 'delta', data: { run: 'r_9', text: 'Got it. Weekdays' } });
        client.send({ event: 'done', data: { run: 'r_9' } });
      }),
    );
    const reread = vi.fn(() => Promise.resolve(null));
    const hook = await follow({ watching: true, inFlight: true, saved: 2 }, reread);
    await vi.waitFor(() => expect(hook.result.current.growing).toEqual({ labels: [], text: 'Got it. Weekdays', final: true }));
    expect(reread).not.toHaveBeenCalled();
    // The request answers with the saved turn: the words go in the same render.
    await hook.rerender({ watching: false, inFlight: false, saved: 4 });
    expect(hook.result.current.growing).toBeNull();
  });

  it('counts_what_the_stream_brings_as_progress', async () => {
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ event: 'reading', data: { run: 'r_10', read: 'memory', host: null } });
        client.send({ event: 'label', data: { run: 'r_10', read: 'memory', text: 'Searched your Claude memory' } });
        client.send({ event: 'delta', data: { run: 'r_10', text: 'Thanks.' } });
      }),
    );
    const hook = await follow({ watching: true, inFlight: false });
    await vi.waitFor(() => expect(hook.result.current.progress).toBe(3));
  });

  it('shows_each_read_once_after_the_stream_reconnects', async () => {
    let connections = 0;
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        connections += 1;
        if (connections === 1) client.send({ retry: 50 });
        client.send({ event: 'reading', data: { run: 'r_11', read: 'memory', host: null } });
        client.send({ event: 'label', data: { run: 'r_11', read: 'memory', text: 'Searched your Claude memory' } });
        // The connection drops; the browser reconnects, and the API replays the turn so far.
        if (connections === 1) client.close();
        else client.send({ event: 'delta', data: { run: 'r_11', text: 'Thanks. From your' } });
      }),
    );
    const hook = await follow({ watching: true, inFlight: false });
    await vi.waitFor(() => expect(hook.result.current.growing?.text).toBe('Thanks. From your'));
    expect(connections).toBe(2);
    expect(hook.result.current.growing?.labels).toEqual([{ read: 'memory', text: 'Searched your Claude memory' }]);
  });

  it('shows_the_reads_labels_and_clears_the_text_on_reset', async () => {
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ event: 'reading', data: { run: 'r_2', read: 'memory', host: null } });
        client.send({ event: 'label', data: { run: 'r_2', read: 'memory', text: 'Searched your Claude memory' } });
        client.send({ event: 'delta', data: { run: 'r_2', text: "Here's what I'd" } });
        client.send({ event: 'reset', data: { run: 'r_2' } });
      }),
    );
    const hook = await follow({ watching: true, inFlight: false });
    await vi.waitFor(() => expect(hook.result.current.growing).toEqual({ labels: [{ read: 'memory', text: 'Searched your Claude memory' }], text: '', final: false }));
  });

  it('closes_its_stream_when_watching_ends_and_on_unmount', async () => {
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ event: 'delta', data: { run: 'r_3', text: 'Got' } });
      }),
    );
    const hook = await follow({ watching: true, inFlight: true });
    await vi.waitFor(() => expect(hook.result.current.growing?.text).toBe('Got'));
    await hook.rerender({ watching: false, inFlight: false });
    expect(allClosed()).toBe(true);
    expect(hook.result.current.growing).toBeNull();
    await hook.rerender({ watching: true, inFlight: true });
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await hook.unmount();
    expect(allClosed()).toBe(true);
    expect(openAtOnce).toBe(1);
  });

  it('looks_again_while_its_request_is_out_and_never_opens_two', async () => {
    let connections = 0;
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        connections += 1;
        // The stream reached the API before the answer's turn started.
        if (connections === 1) client.send({ event: 'done', data: { run: null } });
        else client.send({ event: 'delta', data: { run: 'r_4', text: 'Got it.' } });
      }),
    );
    const reread = vi.fn(() => Promise.resolve(null));
    const hook = await follow({ watching: true, inFlight: true }, reread);
    await vi.waitFor(() => expect(hook.result.current.growing?.text).toBe('Got it.'), { timeout: REOPEN_MS * 5 });
    expect(connections).toBe(2);
    expect(reread).not.toHaveBeenCalled();
    expect(openAtOnce).toBe(1);
  });

  it('stops_looking_again_after_a_few_tries', async () => {
    let connections = 0;
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        connections += 1;
        client.send({ event: 'done', data: { run: null } });
      }),
    );
    const hook = await follow({ watching: true, inFlight: true });
    await vi.waitFor(() => expect(hook.result.current.fellBack).toBe(true), { timeout: REOPEN_MS * (REOPENS_MAX + 4) });
    expect(connections).toBe(REOPENS_MAX + 1);
    expect(allClosed()).toBe(true);
  });

  it('leaves_the_reads_of_a_busy_interview_alone_when_no_turn_shows_here', async () => {
    let connections = 0;
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        connections += 1;
        client.send({ event: 'done', data: { run: null } });
      }),
    );
    // Read again, the interview is still busy: its turn runs where this stream can't see it.
    const reread = vi.fn(() => Promise.resolve({ busy: true } as SetupState));
    const hook = await follow({ watching: true, inFlight: false }, reread);
    await vi.waitFor(() => expect(hook.result.current.fellBack).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, REOPEN_MS * 2));
    expect(connections).toBe(1);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(allClosed()).toBe(true);
  });

  it('looks_again_once_the_request_out_answers_busy', async () => {
    let connections = 0;
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        connections += 1;
        if (connections === 1) {
          client.send({ event: 'delta', data: { run: 'r_5', text: 'Got it.' } });
          client.send({ event: 'done', data: { run: 'r_5' } });
        } else {
          client.send({ event: 'delta', data: { run: 'r_6', text: 'Next, the money.' } });
        }
      }),
    );
    const reread = vi.fn(() => Promise.resolve(null));
    const hook = await follow({ watching: true, inFlight: true }, reread);
    await vi.waitFor(() => expect(allClosed()).toBe(true));
    expect(connections).toBe(1);
    // The answer came back 202, busy: the stream opens again for what runs now.
    await hook.rerender({ watching: true, inFlight: false });
    await vi.waitFor(() => expect(hook.result.current.growing?.text).toBe('Next, the money.'));
    expect(reread).not.toHaveBeenCalled();
    expect(openAtOnce).toBe(1);
  });

  it('falls_back_when_the_stream_is_refused', async () => {
    let requests = 0;
    worker.use(
      http.get(EVENTS_URL, () => {
        requests += 1;
        return HttpResponse.json({ error: 'not_found' }, { status: 404 });
      }),
    );
    const hook = await follow({ watching: true, inFlight: true });
    await vi.waitFor(() => expect(hook.result.current).toMatchObject({ growing: null, fellBack: true }));
    await new Promise((resolve) => setTimeout(resolve, REOPEN_MS * 2));
    expect(requests).toBe(1);
    expect(allClosed()).toBe(true);
  });

  it('clears_and_reads_the_interview_on_error', async () => {
    worker.use(
      sse<Named>(EVENTS_URL, ({ client }) => {
        client.send({ event: 'delta', data: { run: 'r_7', text: 'Got' } });
        client.send({ event: 'error', data: { run: 'r_7', error: 'model_unavailable' } });
      }),
    );
    const reread = vi.fn(() => Promise.resolve(null));
    const hook = await follow({ watching: true, inFlight: false }, reread);
    await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1));
    expect(hook.result.current.growing).toBeNull();
  });
});
