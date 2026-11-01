/**
 * What the screen shows of a running setup turn, and what it does next, event by event: the
 * growing reply from whole-text deltas and resets, the reads' labels in order, and on `done` or
 * `error` the saved interview, read again or brought by the request still out.
 */
import { describe, expect, it } from 'vitest';

import { NOTHING_YET, stepSetupStream, type Growing } from './setupStream.ts';

const run = 'r_7f3a';

/** Steps through `events` from nothing, with no request out, and returns the last step. */
function through(events: Parameters<typeof stepSetupStream>[1][], inFlight = false) {
  let growing: Growing = NOTHING_YET;
  let step = { growing, next: 'read_on' as ReturnType<typeof stepSetupStream>['next'] };
  for (const event of events) {
    step = stepSetupStream(growing, event, inFlight);
    growing = step.growing;
  }
  return step;
}

describe('stepSetupStream', () => {
  it('shows_each_delta_whole', () => {
    expect(through([{ type: 'delta', run, text: 'Got' }])).toEqual({ growing: { labels: [], text: 'Got' }, next: 'read_on' });
    expect(
      through([
        { type: 'delta', run, text: 'Got' },
        { type: 'delta', run, text: 'Got it: leaks and blocked' },
      ]),
    ).toEqual({ growing: { labels: [], text: 'Got it: leaks and blocked' }, next: 'read_on' });
  });

  it('clears_the_text_on_reset_and_keeps_the_reads', () => {
    expect(
      through([
        { type: 'label', run, read: 'memory', text: 'Searched your Claude memory' },
        { type: 'delta', run, text: "Here's what I'd" },
        { type: 'reset', run },
      ]),
    ).toEqual({ growing: { labels: ['Searched your Claude memory'], text: '' }, next: 'read_on' });
  });

  it('shows_nothing_new_while_a_read_runs_and_each_label_once_it_ends', () => {
    expect(through([{ type: 'reading', run, read: 'memory', host: null }])).toEqual({ growing: NOTHING_YET, next: 'read_on' });
    expect(
      through([
        { type: 'reading', run, read: 'memory', host: null },
        { type: 'reading', run, read: 'website', host: 'chenco-cpa.example' },
        { type: 'label', run, read: 'memory', text: 'Searched your Claude memory' },
        { type: 'label', run, read: 'website', text: 'Read chenco-cpa.example' },
      ]).growing,
    ).toEqual({ labels: ['Searched your Claude memory', 'Read chenco-cpa.example'], text: '' });
  });

  it('reads_the_saved_turn_on_done_and_keeps_the_text_till_it_comes', () => {
    expect(
      through([
        { type: 'delta', run, text: 'Got it.' },
        { type: 'done', run },
      ]),
    ).toEqual({ growing: { labels: [], text: 'Got it.' }, next: 'refetch' });
  });

  it('waits_for_the_request_still_out_on_done', () => {
    expect(
      through(
        [
          { type: 'delta', run, text: 'Got it.' },
          { type: 'done', run },
        ],
        true,
      ),
    ).toEqual({ growing: { labels: [], text: 'Got it.' }, next: 'wait' });
  });

  it('looks_again_when_no_turn_runs_yet_while_its_request_is_out', () => {
    expect(through([{ type: 'done', run: null }], true)).toEqual({ growing: NOTHING_YET, next: 'reopen' });
  });

  it('reads_the_interview_when_no_turn_runs_and_no_request_is_out', () => {
    expect(through([{ type: 'done', run: null }])).toEqual({ growing: NOTHING_YET, next: 'refetch_idle' });
  });

  it('clears_on_error_and_reads_what_the_screen_shows', () => {
    const events = [
      { type: 'delta', run, text: 'Got it.' },
      { type: 'error', run, error: 'model_unavailable' },
    ] as const;
    expect(through([...events])).toEqual({ growing: NOTHING_YET, next: 'refetch' });
    expect(through([...events], true)).toEqual({ growing: NOTHING_YET, next: 'wait' });
  });

  it('falls_back_to_reading_the_interview_when_the_stream_fails', () => {
    expect(through([{ type: 'delta', run, text: 'Got it.' }, { type: 'failed' }])).toEqual({ growing: NOTHING_YET, next: 'fall_back' });
  });
});
