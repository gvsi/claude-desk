/**
 * A setup turn as it is written, in a real browser against the mock API at 1440 and 390 px: Claude's
 * reply grows in its serif where the writing dots were, and its question panel, choices and cards
 * show only once the turn is saved, when the saved message takes the growing one's place. A stream
 * the API refuses leaves the step reading the interview while it is busy, as before.
 */
import { describe, expect, it } from 'vitest';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
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
    // Claude's words take the writing dots' place, and its question waits for the saved turn.
    expect(document.querySelector('.cd-writing-indicator')).toBeNull();
    expect(screen.getByRole('region', { name: FIRST_QUESTION, exact: true }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Both, about evenly', exact: true }).elements()).toHaveLength(0);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    held.release();
    await expect.element(screen.getByRole('region', { name: FIRST_QUESTION, exact: true })).toBeVisible();
    expect(growing()).toBeNull();
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
    mockStore.streamSetupTurns();
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
