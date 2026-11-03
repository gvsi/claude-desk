/**
 * What the screen shows of a running setup turn, and what it does next, event by event: the
 * growing reply from whole-text deltas and resets, the reads' labels in order, and on `done` or
 * `error` the saved interview, read again or brought by the request still out.
 */
import { describe, expect, it } from 'vitest';

import { NOTHING_YET, hasWords, shownLabels, stepSetupStream, type Growing } from './setupStream.ts';

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
    expect(through([{ type: 'delta', run, text: 'Got' }])).toEqual({ growing: { labels: [], text: 'Got', final: false }, next: 'read_on' });
    expect(
      through([
        { type: 'delta', run, text: 'Got' },
        { type: 'delta', run, text: 'Got it: leaks and blocked' },
      ]),
    ).toEqual({ growing: { labels: [], text: 'Got it: leaks and blocked', final: false }, next: 'read_on' });
  });

  it('clears_the_text_on_reset_and_keeps_the_reads', () => {
    expect(
      through([
        { type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' },
        { type: 'delta', run, text: "Here's what I'd" },
        { type: 'reset', run },
      ]),
    ).toEqual({ growing: { labels: [{ read: 'memory', text: 'Searched your sample Claude memory' }], text: '', final: false }, next: 'read_on' });
    expect(shownLabels(through([{ type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' }, { type: 'reset', run }]).growing)).toEqual([
      'Searched your sample Claude memory',
    ]);
  });

  it('shows_nothing_new_while_a_read_runs_and_each_label_once_it_ends', () => {
    const reading = through([{ type: 'reading', run, read: 'memory', host: null }]).growing;
    expect(shownLabels(reading)).toEqual([]);
    expect(reading.text).toBe('');
    const ended = through([
      { type: 'reading', run, read: 'memory', host: null },
      { type: 'reading', run, read: 'website', host: 'chenco-cpa.example' },
      { type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' },
      { type: 'label', run, read: 'website', text: 'Read chenco-cpa.example' },
    ]).growing;
    expect(shownLabels(ended)).toEqual(['Searched your sample Claude memory', 'Read chenco-cpa.example']);
  });

  it('shows_each_label_in_the_order_its_read_started_whichever_ends_first', () => {
    // The reads run at once: the website's can end first, and its label still shows under the memory's.
    const ended = through([
      { type: 'reading', run, read: 'memory', host: null },
      { type: 'reading', run, read: 'website', host: 'chenco-cpa.example' },
      { type: 'label', run, read: 'website', text: 'Read chenco-cpa.example' },
    ]).growing;
    expect(shownLabels(ended)).toEqual(['Read chenco-cpa.example']);
    expect(shownLabels(stepSetupStream(ended, { type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' }, false).growing)).toEqual([
      'Searched your sample Claude memory',
      'Read chenco-cpa.example',
    ]);
  });

  it('gives_each_web_search_its_own_label', () => {
    const searches = [
      { type: 'reading', run, read: 'memory', host: null },
      { type: 'reading', run, read: 'web_search', host: null },
      { type: 'reading', run, read: 'web_search', host: null },
    ] as const;
    expect(
      shownLabels(
        through([
          ...searches,
          { type: 'label', run, read: 'web_search', text: 'Searched the web: hair salon color appointment deposits' },
          { type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' },
          { type: 'label', run, read: 'web_search', text: 'Searched the web: salon new client consultation form' },
        ]).growing,
      ),
    ).toEqual(['Searched your sample Claude memory', 'Searched the web: hair salon color appointment deposits', 'Searched the web: salon new client consultation form']);
    // Each failed search says so while the turn runs; the saved turn read back shows the one line it keeps.
    expect(
      shownLabels(
        through([
          ...searches,
          { type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' },
          { type: 'label', run, read: 'web_search', text: "Couldn't search the web just now" },
          { type: 'label', run, read: 'web_search', text: "Couldn't search the web just now" },
        ]).growing,
      ),
    ).toEqual(['Searched your sample Claude memory', "Couldn't search the web just now", "Couldn't search the web just now"]);
  });

  it('rebuilds_the_reads_from_what_a_reconnected_stream_replays', () => {
    const reads = [
      { type: 'reading', run, read: 'memory', host: null },
      { type: 'reading', run, read: 'web_search', host: null },
      { type: 'reading', run, read: 'web_search', host: null },
      { type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' },
      { type: 'label', run, read: 'web_search', text: "Couldn't search the web just now" },
      { type: 'label', run, read: 'web_search', text: "Couldn't search the web just now" },
    ] as const;
    const replayed = through([...reads, { type: 'delta', run, text: 'Thanks. From' }, { type: 'reconnected' }, ...reads, { type: 'delta', run, text: 'Thanks. From your' }]).growing;
    // Each read once, and the two searches still two rows.
    expect(shownLabels(replayed)).toEqual(['Searched your sample Claude memory', "Couldn't search the web just now", "Couldn't search the web just now"]);
    expect(replayed.text).toBe('Thanks. From your');
    // A reconnected stream that replays no reads keeps those it showed.
    expect(shownLabels(through([...reads, { type: 'reconnected' }, { type: 'delta', run, text: 'Thanks.' }]).growing)).toHaveLength(3);
  });

  it('shows_a_label_whose_read_it_never_heard_start', () => {
    // A stream that came in late: the label still shows, after those it knows.
    expect(shownLabels(through([{ type: 'label', run, read: 'memory', text: 'Searched your sample Claude memory' }]).growing)).toEqual(['Searched your sample Claude memory']);
  });

  it('reads_an_unexpected_failure_and_a_deadline_alike', () => {
    for (const error of ['internal', 'model_unavailable']) {
      expect(through([{ type: 'delta', run, text: 'Got it.' }, { type: 'error', run, error }])).toEqual({ growing: NOTHING_YET, next: 'refetch' });
    }
  });

  it('reads_the_saved_turn_on_done_and_keeps_the_text_till_it_comes', () => {
    expect(
      through([
        { type: 'delta', run, text: 'Got it.' },
        { type: 'done', run },
      ]),
    // The reply is whole now: its last word shows too.
    ).toEqual({ growing: { labels: [], text: 'Got it.', final: true }, next: 'refetch' });
  });

  it('clears_a_reply_reset_right_before_done_so_the_saved_turn_wins', () => {
    // The model moved on to a limit question after its reply had streamed: that reply is never saved.
    expect(
      through([
        { type: 'delta', run, text: 'Got it. Weekdays 8 to 6.' },
        { type: 'reset', run },
        { type: 'done', run },
      ]),
    ).toEqual({ growing: { ...NOTHING_YET, final: true }, next: 'refetch' });
  });

  it('keeps_the_writing_state_through_a_turn_that_streams_only_done', () => {
    expect(through([{ type: 'done', run }])).toEqual({ growing: { ...NOTHING_YET, final: true }, next: 'refetch' });
  });

  it('shows_a_whole_reply_only_once_done_says_it_is_whole', () => {
    expect(hasWords({ labels: [], text: 'Yes', final: false })).toBe(false);
    expect(hasWords({ labels: [], text: 'Yes', final: true })).toBe(true);
    expect(hasWords({ labels: [], text: 'Yes. Right', final: false })).toBe(true);
    expect(hasWords({ labels: [], text: ' ', final: true })).toBe(false);
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
    ).toEqual({ growing: { labels: [], text: 'Got it.', final: true }, next: 'wait' });
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
