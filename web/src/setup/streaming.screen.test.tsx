/**
 * A setup turn as it is written, in a real browser against the mock API at 1440 and 390 px: Claude's
 * reply grows in its serif where the writing dots were, and its question panel, choices and cards
 * show only once the turn is saved, when the saved message takes the growing one's place. A stream
 * the API refuses leaves the step reading the interview while it is busy, as before.
 */
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { worker } from '../mocks/browser.ts';
import { growingWords } from '../mocks/ownerStreams.ts';
import { CPA_COPY, MEMORY_LABEL } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

const CPA_DESCRIPTION =
  "I'm Linda Chen. Chen & Co. is a two-person CPA firm in San Jose doing tax returns and bookkeeping for individuals and small businesses. New clients start with a free 20-minute consult, and we price each engagement after it.";

const OPENING = CPA_COPY.opening.join('\n\n');
const FIRST_QUESTION = CPA_COPY.first;

/** A new CPA interview, with consent given (landing in its request) unless `consent` is null. */
async function cpaInterview(consent: boolean | null): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: { description: CPA_DESCRIPTION, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() } });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  if (consent !== null) await mockStore.dispatch('setupConsent', { params: { id: state.interview_id }, query: { cards: '1' }, body: { allow: consent } });
  return state;
}

/** A gate a planned stream waits at, and the function that lets it go. */
function gate(): { until: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { until, release };
}

/** The reply growing in the transcript, or null. */
const growing = () => document.querySelector<HTMLElement>('.cd-setup-growing');

describe.each(['desktop', 'phone'] as const)('setup streaming at %s', (viewport: Viewport) => {
  it('streams_the_opening_and_docks_its_question_once_saved', async () => {
    const state = await cpaInterview(null);
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    const held = gate();
    mockStore.planStream('setup', { pauseAfter: 5, until: held.until });
    await screen.getByRole('button', { name: 'Yes, use it', exact: true }).click();

    // Five words sent: the fifth waits for what follows it.
    await expect.poll(() => growing()?.textContent).toBe(growingWords(OPENING)[3]);
    // The read's label came first, as the saved interview will hold it.
    await expect.element(screen.getByText(MEMORY_LABEL, { exact: true })).toBeVisible();
    // Claude's words take the writing dots' place on screen, and its question waits for the saved turn.
    // A screen reader hears "Claude is writing" until the saved turn, which it hears once: never
    // the words as they grow, nor the read's label twice.
    const writing = screen.getByRole('status').filter({ hasText: 'Claude is writing' });
    await expect.element(writing).toBeInTheDocument();
    expect(writing.element().getBoundingClientRect().width).toBeLessThanOrEqual(1);
    expect(growing()?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(MEMORY_LABEL, { exact: true }).element().closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('region', { name: FIRST_QUESTION, exact: true }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Both, about evenly', exact: true }).elements()).toHaveLength(0);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    held.release();
    await expect.element(screen.getByRole('region', { name: FIRST_QUESTION, exact: true })).toBeVisible();
    expect(growing()).toBeNull();
    expect(screen.getByText(MEMORY_LABEL, { exact: true }).element().closest('[aria-hidden="true"]')).toBeNull();
    // The saved message takes the growing one's place: each paragraph once.
    for (const paragraph of CPA_COPY.opening) expect(screen.getByText(paragraph, { exact: true }).elements()).toHaveLength(1);
    expect(screen.getByText(MEMORY_LABEL, { exact: true }).elements()).toHaveLength(1);
  });

  it('streams_an_answer_and_shows_its_card_only_once_saved', async () => {
    const state = await cpaInterview(true);
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    const held = gate();
    mockStore.planStream('setup', { pauseAfter: 3, until: held.until });
    await screen.getByRole('button', { name: 'Both, about evenly', exact: true }).click();

    await expect.poll(() => growing()?.textContent).toBe(growingWords(CPA_COPY.consult)[1]);
    await expect.element(screen.getByText('Both, about evenly', { exact: true })).toBeVisible();
    expect(screen.getByRole('region', { name: FIRST_QUESTION, exact: true }).elements()).toHaveLength(0);
    expect(screen.getByRole('article', { name: 'Google Calendar', exact: true }).elements()).toHaveLength(0);
    await expect.element(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toBeDisabled();

    held.release();
    await expect.element(screen.getByRole('article', { name: 'Google Calendar', exact: true })).toBeVisible();
    expect(growing()).toBeNull();
    expect(screen.getByText(CPA_COPY.consult, { exact: true }).elements()).toHaveLength(1);
  });

  it('follows_a_turn_already_running_when_the_step_opens', async () => {
    const state = await cpaInterview(true);
    // A turn that outlasted its request's wait: the request answered 202, busy.
    mockStore.streamSetupTurns(true, { answersAtOnce: true });
    const held = gate();
    mockStore.planStream('setup', { pauseAfter: 4, until: held.until });
    const sent = await mockStore.dispatch('setupAnswer', { params: { id: state.interview_id }, query: { cards: '1' }, body: { question: 'what_you_do', text: 'Mostly individuals' } });
    expect(sent).toMatchObject({ status: 202, body: { busy: true } });
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    await expect.poll(() => growing()?.textContent).toBe(growingWords(CPA_COPY.consult)[2]);
    held.release();
    await expect.element(screen.getByRole('article', { name: 'Google Calendar', exact: true })).toBeVisible();
    expect(growing()).toBeNull();
  });

  it('keeps_the_saved_turn_when_an_older_read_of_the_busy_interview_answers_after_it', async () => {
    const state = await cpaInterview(true);
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    // A turn that outlasts its request's wait: the request answers 202, and the step reads the busy interview.
    mockStore.streamSetupTurns(true, { answersAtOnce: true });
    const turn = gate();
    mockStore.planStream('setup', { pauseAfter: 3, until: turn.until });
    await screen.getByRole('button', { name: 'Both, about evenly', exact: true }).click();
    await expect.poll(() => growing()?.textContent).toBe(growingWords(CPA_COPY.consult)[1]);
    // The step's next read of the busy interview, 2 s on, is held, and answers with the interview
    // as it was when it was read: busy, the turn still running.
    const poll = gate();
    let polled = false;
    worker.use(
      http.get(
        `/api/owner/setup/${state.interview_id}`,
        async () => {
          const then = await mockStore.dispatch('setup', { params: { id: state.interview_id }, query: { cards: '1' } });
          polled = true;
          await poll.until;
          return HttpResponse.json('network' in then ? null : (then.body as SetupState));
        },
        { once: true },
      ),
    );
    await expect.poll(() => polled, { timeout: 5_000 }).toBe(true);
    // The turn lands: done, and its read of the saved interview answers first.
    turn.release();
    const card = screen.getByRole('article', { name: 'Google Calendar', exact: true });
    await expect.element(card).toBeVisible();
    const events = mockStore.requests.filter((r) => r.key === 'setupEvents').length;
    // Then the older read answers, busy: it changes nothing, and no stream opens again.
    poll.release();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect.element(card).toBeVisible();
    expect(screen.container.querySelector('.cd-writing-indicator')).toBeNull();
    await expect.element(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toBeEnabled();
    expect(mockStore.requests.filter((r) => r.key === 'setupEvents')).toHaveLength(events);
  });

  it('shows_the_whole_reply_then_the_saved_turn_once_with_no_bubble_twice', async () => {
    const state = await cpaInterview(true);
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    // As on the API, the answer's request waits while its turn streams, and answers with it after done.
    mockStore.streamSetupTurns();
    const writing = gate();
    const landing = gate();
    mockStore.planStream('setup', { pauseAfter: 3, until: writing.until, landAfter: landing.until });
    await screen.getByRole('button', { name: 'Both, about evenly', exact: true }).click();
    const log = screen.getByRole('log', { name: 'Setup questions' });
    const owner = () => log.getByText('Both, about evenly', { exact: true }).elements();
    await expect.poll(() => growing()?.textContent).toBe(growingWords(CPA_COPY.consult)[1]);
    writing.release();
    // Done, while the request is still out: the reply shows whole, its last word too.
    await expect.poll(() => growing()?.textContent).toBe(CPA_COPY.consult);
    expect(owner()).toHaveLength(1);
    await expect.element(log.getByRole('status').filter({ hasText: 'Claude is writing' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Google Calendar', exact: true }).elements()).toHaveLength(0);
    // The request answers with the saved turn: it takes the growing reply's place, each bubble once.
    landing.release();
    await expect.element(screen.getByRole('article', { name: 'Google Calendar', exact: true })).toBeVisible();
    expect(growing()).toBeNull();
    expect(owner()).toHaveLength(1);
    expect(log.getByText(CPA_COPY.consult, { exact: true }).elements()).toHaveLength(1);
    expect(log.element().querySelector('.cd-writing-indicator')).toBeNull();
  });

  it('keeps_the_writing_dots_through_a_turn_that_streams_no_words', async () => {
    const state = await cpaInterview(true);
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    // A reply the step hides (it read the owner's site, and a limit question follows) never streams.
    const held = gate();
    mockStore.planStream('setup', { quiet: true, pauseAfter: 0, until: held.until });
    await screen.getByRole('button', { name: 'Both, about evenly', exact: true }).click();
    const log = screen.getByRole('log', { name: 'Setup questions' });
    await expect.element(log.getByRole('status').filter({ hasText: 'Claude is writing' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(growing()).toBeNull();
    expect(log.element().querySelector('.cd-claude-message:empty, .cd-setup-growing')).toBeNull();
    held.release();
    await expect.element(screen.getByRole('article', { name: 'Google Calendar', exact: true })).toBeVisible();
    expect(log.element().querySelector('.cd-writing-indicator')).toBeNull();
  });

  it('keeps_an_answer_refused_right_after_done_in_the_message_box', async () => {
    const state = await cpaInterview(null);
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    await screen.getByRole('button', { name: 'Yes, use it', exact: true }).click();
    await expect.element(screen.getByRole('region', { name: FIRST_QUESTION, exact: true })).toBeVisible();
    // The API says done a moment before it unlocks the interview: an answer sent in that moment is
    // refused. The step reads the interview and keeps the words, and says nothing went wrong.
    mockStore.inject({ route: 'setupAnswer', status: 409 });
    await screen.getByRole('button', { name: 'Both, about evenly', exact: true }).click();
    const box = screen.getByRole('textbox', { name: 'Your answer', exact: true });
    await expect.element(box).toHaveValue('Both, about evenly');
    await expect.element(box).toBeEnabled();
    expect(screen.getByRole('alert').elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Try again', exact: true }).elements()).toHaveLength(0);
    expect(screen.getByRole('log', { name: 'Setup questions' }).getByText('Both, about evenly', { exact: true }).elements()).toHaveLength(0);
  });

  it('reads_the_interview_while_busy_when_the_stream_is_refused', async () => {
    const state = await cpaInterview(true);
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    mockStore.inject({ route: 'setupEvents', status: 503, times: 20 });
    await screen.getByRole('button', { name: 'Both, about evenly', exact: true }).click();
    await expect.element(screen.getByRole('status').filter({ hasText: 'Claude is writing' })).toBeInTheDocument();
    expect(growing()).toBeNull();
    // The step's own reads of the busy interview bring the saved turn.
    await expect.element(screen.getByRole('article', { name: 'Google Calendar', exact: true }), { timeout: 8_000 }).toBeVisible();
    expect(screen.getByText(CPA_COPY.consult, { exact: true }).elements()).toHaveLength(1);
    expect(growing()).toBeNull();
  });
});
