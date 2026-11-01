import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SetupState } from '../api/views.ts';
import { SETUP_WORK_GIVE_UP_MS, useSetupWork } from './useSetupWork.ts';

const busy: SetupState = {
  interview_id: 's1', desk_id: 'd1', slug: 'rivera', step: 'questions',
  consent: true, question: null, messages: [{ role: 'owner', text: 'Yes, use it', choices: [], card: null }], busy: true,
};
const landed: SetupState = { ...busy, busy: false, question: 'what_you_do' };
let root: Root | null = null;
let work: ReturnType<typeof useSetupWork>;
const reread = vi.fn<() => Promise<SetupState | null>>();

function Probe({ state, progress }: { state: SetupState; progress: number }) {
  work = useSetupWork(state, reread, progress);
  return null;
}

function show(state: SetupState, progress = 0) {
  act(() => {
    root ??= createRoot(document.createElement('div'));
    root.render(createElement(
      StrictMode,
      null,
      createElement(MemoryRouter, { initialEntries: ['/app/setup/s1'] }, createElement(Probe, { state, progress })),
    ));
  });
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  reread.mockReset().mockResolvedValue(busy);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

it('polls_busy_questions_every_two_seconds_and_stops_when_the_question_lands', async () => {
  show(busy);
  await advance(1999);
  expect(reread).not.toHaveBeenCalled();
  await advance(1);
  expect(reread).toHaveBeenCalledTimes(1);
  // A state update while work is ongoing must not restart the clock.
  show({ ...busy, messages: [...busy.messages, { role: 'tool_label', text: 'Searched your Claude memory', choices: [], card: null }] });
  reread.mockResolvedValueOnce(landed);
  await advance(2000);
  expect(reread).toHaveBeenCalledTimes(2);
  await advance(10000);
  expect(reread).toHaveBeenCalledTimes(2);
});

it('gives_up_only_after_a_turn_can_no_longer_be_running_including_failed_reads_and_retry_reads_before_a_fresh_wait', async () => {
  // At least one 2 s poll past the API's `TURN_ABANDONED_S` (130 s, backend/desk/api/setup.py), by when a busy
  // interview has landed, rolled back or been recovered: polling never gives up on a turn that can still be running.
  expect(SETUP_WORK_GIVE_UP_MS).toBeGreaterThanOrEqual((130 + 2) * 1000);
  expect(SETUP_WORK_GIVE_UP_MS).toBe(140_000);
  const polls = SETUP_WORK_GIVE_UP_MS / 2000 - 1;   // the deadline wins over the tick at the limit itself
  show(busy);
  await advance(44000);
  show({ ...busy, messages: [...busy.messages, { role: 'tool_label', text: 'Searched your Claude memory', choices: [], card: null }] });
  reread.mockResolvedValue(null);
  await advance(SETUP_WORK_GIVE_UP_MS - 44000 - 1);
  expect(reread).toHaveBeenCalledTimes(polls);
  expect(work.gaveUp).toBe(false);
  await advance(1);
  expect(work.gaveUp).toBe(true);
  await advance(10000);
  expect(reread).toHaveBeenCalledTimes(polls);
  await act(async () => { await work.retry(); });
  expect(work.gaveUp).toBe(true);
  expect(reread).toHaveBeenCalledTimes(polls + 1);
  reread.mockResolvedValue(busy);
  await act(async () => { await work.retry(); });
  expect(work.gaveUp).toBe(false);
  expect(reread).toHaveBeenCalledTimes(polls + 2);
  await advance(SETUP_WORK_GIVE_UP_MS - 1);
  expect(work.gaveUp).toBe(false);
  await advance(1);
  expect(work.gaveUp).toBe(true);
});

it('picks_up_a_turn_that_lands_at_the_apis_110_second_run_deadline_without_giving_up', async () => {
  show(busy);
  await advance(108000);
  expect(work.gaveUp).toBe(false);
  expect(reread).toHaveBeenCalledTimes(54);
  reread.mockResolvedValue(landed);
  await advance(2000);
  expect(reread).toHaveBeenCalledTimes(55);
  await advance(SETUP_WORK_GIVE_UP_MS);
  expect(reread).toHaveBeenCalledTimes(55);
  expect(work.gaveUp).toBe(false);
});

it('ignores_absent_busy_and_other_steps_and_cleans_up_on_unmount_even_with_a_read_in_flight', async () => {
  show({ ...busy, busy: undefined });
  await advance(4000);
  show({ ...busy, step: 'tools' });
  await advance(4000);
  expect(reread).not.toHaveBeenCalled();
  let finish!: (state: SetupState) => void;
  reread.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  show(busy);
  await advance(6000);
  expect(reread).toHaveBeenCalledTimes(1);
  act(() => root?.unmount());
  root = null;
  await act(async () => { finish(busy); });
  await advance(100000);
  expect(reread).toHaveBeenCalledTimes(1);
});

it('retries_a_rejected_read_and_stops_when_the_step_moves_on_even_if_busy_stays_true', async () => {
  reread.mockRejectedValueOnce(new Error('read failed'));
  show(busy);
  await advance(2000);
  expect(reread).toHaveBeenCalledTimes(1);
  reread.mockResolvedValueOnce({ ...busy, step: 'tools' });
  await advance(2000);
  expect(reread).toHaveBeenCalledTimes(2);
  await advance(100000);
  expect(reread).toHaveBeenCalledTimes(2);
  expect(work.gaveUp).toBe(false);
});

it('gives_up_a_whole_wait_after_the_turn_last_streamed_anything', async () => {
  // How long the step waits on a busy turn that streams nothing, read from the step itself.
  show(busy, 0);
  let wait = 0;
  while (!work.gaveUp && wait < 600_000) {
    await advance(1000);
    wait += 1000;
  }
  expect(work.gaveUp).toBe(true);
  // Something more streams after all: the notice goes, and the whole wait starts again from there.
  show(busy, 1);
  expect(work.gaveUp).toBe(false);
  await advance(wait - 2000);
  show(busy, 2);
  await advance(wait - 1000);
  expect(work.gaveUp).toBe(false);
  await advance(1000);
  expect(work.gaveUp).toBe(true);
});
