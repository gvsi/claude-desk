/** The wait between tries that ends with the page: it ends at its time, or at once when the page goes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sleep } from './poll.ts';

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Whether `waiting` has ended once the microtasks queued now have run. */
  async function endedNow(waiting: Promise<void>): Promise<boolean> {
    let ended = false;
    void waiting.then(() => {
      ended = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    return ended;
  }

  it('ends_at_its_time', async () => {
    const waiting = sleep(1_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(await endedNow(waiting)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await endedNow(waiting)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends_at_once_when_its_signal_aborts', async () => {
    const controller = new AbortController();
    const waiting = sleep(30_000, controller.signal);
    controller.abort();
    expect(await endedNow(waiting)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends_at_once_on_a_signal_already_aborted', async () => {
    // Its abort has already fired and won't again: the wait mustn't sit out its whole time.
    const controller = new AbortController();
    controller.abort();
    expect(await endedNow(sleep(30_000, controller.signal))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
