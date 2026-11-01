import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SetupState } from '../api/views.ts';
import { useSetupWork } from './useSetupWork.ts';

const busy: SetupState = {
  interview_id: 's1', desk_id: 'd1', slug: 'rivera', step: 'questions',
  consent: true, question: null, messages: [{ role: 'owner', text: 'Yes, use it', choices: [], card: null }], busy: true,
};
const landed: SetupState = { ...busy, busy: false, question: 'what_you_do' };
let root: Root | null = null;
let work: ReturnType<typeof useSetupWork>;
const reread = vi.fn<() => Promise<SetupState | null>>();

function Probe({ state }: { state: SetupState }) {
  work = useSetupWork(state, reread);
  return null;
}

function show(state: SetupState) {
  act(() => {
    root ??= createRoot(document.createElement('div'));
    root.render(createElement(
      StrictMode,
      null,
      createElement(MemoryRouter, { initialEntries: ['/app/setup/s1'] }, createElement(Probe, { state })),
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

it('gives_up_at_90_seconds_including_failed_reads_and_retry_reads_before_a_fresh_wait', async () => {
  show(busy);
  await advance(44000);
  show({ ...busy, messages: [...busy.messages, { role: 'tool_label', text: 'Searched your Claude memory', choices: [], card: null }] });
  reread.mockResolvedValue(null);
  await advance(45999);
  expect(reread).toHaveBeenCalledTimes(44);
  expect(work.gaveUp).toBe(false);
  await advance(1);
  expect(work.gaveUp).toBe(true);
  await advance(10000);
  expect(reread).toHaveBeenCalledTimes(44);
  await act(async () => { await work.retry(); });
  expect(work.gaveUp).toBe(true);
  expect(reread).toHaveBeenCalledTimes(45);
  reread.mockResolvedValue(busy);
  await act(async () => { await work.retry(); });
  expect(work.gaveUp).toBe(false);
  expect(reread).toHaveBeenCalledTimes(46);
  await advance(89999);
  expect(work.gaveUp).toBe(false);
  await advance(1);
  expect(work.gaveUp).toBe(true);
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
