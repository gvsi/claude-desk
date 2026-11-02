/**
 * The memory question in a real browser against the mock API at 1440 and 390 px: Claude's ask
 * docks with its two answers like every setup question, above the message box; a press puts the
 * answer in the conversation at once with Claude's writing dots; then the reads' labels and Claude's
 * opening arrive through the turn's stream, and the first question docks once the turn is saved.
 */
import { http } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';
import { userEvent } from 'vitest/browser';

import { newIdempotencyKey } from '../api/http.ts';
import type { RouteKey } from '../api/routes.ts';
import type { SetupState } from '../api/views.ts';
import { worker } from '../mocks/browser.ts';
import { growingWords } from '../mocks/ownerStreams.ts';
import { CPA_COPY, MEMORY_LABEL } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { SETUP_COPY, START_EXAMPLES } from './copy.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

const CPA_DESCRIPTION = START_EXAMPLES.en.examples[3]!.description;
const TITLE = "Let's set up your Desk";
const YES = 'Yes, use it';
const NO = "No, I'll type it";

const requests = (key: RouteKey) => mockStore.requests.filter((r) => r.key === key);

/** A new CPA interview, its memory question waiting; resolves to it and Claude's ask. */
async function waitingInterview(): Promise<{ state: SetupState; ask: string }> {
  const started = await mockStore.dispatch('startSetup', { body: { description: CPA_DESCRIPTION, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() } });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  return { state, ask: state.messages.at(-1)?.text ?? '' };
}

/** A gate a request or stream waits at, and the function that lets it go. */
function gate(): { until: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  return { until, release };
}

const growing = () => document.querySelector<HTMLElement>('.cd-setup-growing');

describe.each(['desktop', 'phone'] as const)('the memory question at %s', (viewport: Viewport) => {
  it('docks_the_ask_with_its_two_answers_above_the_message_box', async () => {
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    await expect.element(screen.getByRole('heading', { level: 1, name: TITLE, exact: true })).toBeVisible();
    const panel = screen.getByRole('region', { name: ask, exact: true });
    await expect.element(panel).toBeVisible();
    expect(panel.getByRole('button').elements().map((button) => button.getAttribute('aria-label'))).toEqual([YES, NO]);
    expect([...panel.element().querySelectorAll('.cd-setup-q3__row kbd')].map((key) => key.textContent)).toEqual(['1', '2']);
    expect([...panel.element().querySelectorAll('.cd-setup-q3__hint kbd')].map((key) => key.textContent)).toEqual(['1–2', 'Enter', 'Esc']);
    // Its two answers are all it offers: no dismiss and no "Something else…", since the message box stays.
    expect(panel.getByRole('textbox').elements()).toHaveLength(0);
    const box = screen.getByRole('textbox', { name: 'Your answer', exact: true });
    await expect.element(box).toBeEnabled();
    expect(box.element().getAttribute('placeholder')).toBe('Answer in your own words');
    // The ask lives in the panel, not twice; the two big buttons are gone.
    expect(screen.getByRole('log', { name: 'Setup questions' }).getByText(ask, { exact: true }).elements()).toHaveLength(0);
    expect(screen.container.querySelector('.cd-setup-step__actions')).toBeNull();
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('puts_the_answer_in_the_conversation_at_once_with_the_writing_dots', async () => {
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    // The consent request waits on its way to the API until the gate opens.
    const held = gate();
    worker.use(
      http.post(`/api/owner/setup/${state.interview_id}/consent`, async () => {
        await held.until;
        return undefined;
      }),
    );
    await screen.getByRole('button', { name: YES, exact: true }).click();
    // While the request is still out: the ask back in the conversation, the answer under it, the dots.
    const log = screen.getByRole('log', { name: 'Setup questions' });
    await expect.element(log.getByText(YES, { exact: true })).toBeVisible();
    await expect.element(log.getByText(ask, { exact: true })).toBeVisible();
    await expect.element(log.getByRole('status').filter({ hasText: 'Claude is writing' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: ask, exact: true }).elements()).toHaveLength(0);
    // Nothing spins: the press is answered in the conversation.
    expect(screen.container.querySelector('[aria-busy="true"].cd-button, .cd-button__spinner')).toBeNull();
    // The message box takes typing meanwhile; Send waits for the turn.
    await expect.element(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toBeEnabled();
    expect(log.element().querySelectorAll('.cd-visitor-message')).toHaveLength(1);
    expectNoHorizontalScroll();
    held.release();
    await expect.element(screen.getByRole('region', { name: CPA_COPY.first, exact: true })).toBeVisible();
    expect(log.element().querySelectorAll('.cd-visitor-message')).toHaveLength(1);
  });

  it('streams_the_reads_then_the_opening_and_docks_the_first_question_once_saved', async () => {
    const { state } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    const held = gate();
    mockStore.planStream('setup', { pauseAfter: 3, until: held.until });
    await screen.getByRole('button', { name: YES, exact: true }).click();
    await expect.element(screen.getByText(MEMORY_LABEL, { exact: true })).toBeVisible();
    await expect.poll(() => growing()?.textContent).toBe(growingWords(CPA_COPY.opening.join('\n\n'))[1]);
    expect(screen.getByRole('region', { name: CPA_COPY.first, exact: true }).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });
    held.release();
    await expect.element(screen.getByRole('region', { name: CPA_COPY.first, exact: true })).toBeVisible();
    expect(growing()).toBeNull();
    expect(screen.getByText(MEMORY_LABEL, { exact: true }).elements()).toHaveLength(1);
    expect(requests('setupConsent').map((r) => r.body)).toEqual([{ allow: true }]);
  });

  it('keeps_use_your_suggestions_out_of_the_dock_until_the_opening_is_saved', async () => {
    const { state } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    const held = gate();
    mockStore.planStream('setup', { pauseAfter: 3, until: held.until });
    const suggestions = () => screen.getByRole('button', { name: 'Use your suggestions', exact: true }).elements();
    const line = () => screen.getByText(SETUP_COPY.questions.suggestionsLine, { exact: true }).elements();
    await screen.getByRole('button', { name: YES, exact: true }).click();
    // While the reads and the opening stream, the dock holds only the message box.
    await expect.element(screen.getByText(MEMORY_LABEL, { exact: true })).toBeVisible();
    await expect.poll(() => growing()?.textContent).toBe(growingWords(CPA_COPY.opening.join('\n\n'))[1]);
    expect(suggestions()).toHaveLength(0);
    expect(line()).toHaveLength(0);
    held.release();
    await expect.element(screen.getByRole('region', { name: CPA_COPY.first, exact: true })).toBeVisible();
    // The opening is saved: the row is back, as before.
    await expect.element(screen.getByRole('button', { name: 'Use your suggestions', exact: true })).toBeVisible();
    expect(line()).toHaveLength(1);
  });

  it('writes_the_opening_with_no_reads_after_no', async () => {
    const { state } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.streamSetupTurns();
    await screen.getByRole('button', { name: NO, exact: true }).click();
    await expect.element(screen.getByRole('region', { name: CPA_COPY.first, exact: true })).toBeVisible();
    expect(screen.getByText(MEMORY_LABEL, { exact: true }).elements()).toHaveLength(0);
    expect(requests('setupConsent').map((r) => r.body)).toEqual([{ allow: false }]);
  });

  it('answers_by_keys_as_the_other_questions_do', async () => {
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    await expect.element(screen.getByRole('region', { name: ask, exact: true })).toBeVisible();
    // Esc goes to the message box; the ask stays docked, as it is the only way to answer it.
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveFocus();
    await expect.element(screen.getByRole('region', { name: ask, exact: true })).toBeVisible();
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('2');
    await expect.element(screen.getByRole('button', { name: NO, exact: true })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('region', { name: CPA_COPY.first, exact: true })).toBeVisible();
    expect(requests('setupConsent').map((r) => r.body)).toEqual([{ allow: false }]);
  });

  it.each([
    [YES, 'sure', '1'],
    [YES, 'no thanks', '2'],
    [NO, 'no thanks', '2'],
  ])('typing_on_%s_picks_nothing_until_an_answer_is_picked: %s', async (answer, words, pick) => {
    // Its answers are the only way to answer it: words typed with one highlighted go nowhere, and neither a
    // space among them nor Enter after them, pressed again or after any key that doesn't move, picks an answer.
    // A number key does.
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    const panel = screen.getByRole('region', { name: ask, exact: true });
    await expect.poll(() => panel.element().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard(answer === YES ? '1' : '2');
    const row = screen.getByRole('button', { name: answer, exact: true });
    await expect.element(row).toHaveFocus();
    await userEvent.keyboard(`${words}{Enter}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Nor after a typo is erased, or a key that neither moves nor picks, or with a modifier.
    await userEvent.keyboard('s{Backspace}{Enter}{Home}{Enter}{End}{Enter}{ArrowRight}{Enter}{Alt>}{Enter}{/Alt}{Control>} {/Control}{Alt>} {/Alt}');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.element(row).toHaveFocus();
    await expect.element(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveValue('');
    expect(requests('setupConsent')).toHaveLength(0);
    await userEvent.keyboard(`${pick}{Enter}`);
    await expect.poll(() => requests('setupConsent').map((r) => r.body)).toEqual([{ allow: pick === '1' }]);
  });

  it('takes_focus_on_its_panel_as_it_docks_so_its_keys_work_at_once', async () => {
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    const panel = screen.getByRole('region', { name: ask, exact: true });
    await expect.element(panel).toBeVisible();
    await expect.poll(() => panel.element().contains(document.activeElement)).toBe(true);
    // No Tab: 1 picks "Yes, use it", and Enter sends it.
    await userEvent.keyboard('1');
    await expect.element(screen.getByRole('button', { name: YES, exact: true })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => requests('setupConsent').map((r) => r.body)).toEqual([{ allow: true }]);
  });

  it('never_takes_focus_back_from_the_message_box', async () => {
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    const panel = screen.getByRole('region', { name: ask, exact: true });
    await expect.poll(() => panel.element().contains(document.activeElement)).toBe(true);
    // The owner goes to the message box and types: the page redraws, and focus stays there.
    const box = screen.getByRole('textbox', { name: 'Your answer', exact: true });
    await box.click();
    await userEvent.keyboard('We do tax');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.element(box).toHaveFocus();
    await expect.element(box).toHaveValue('We do tax');
    // Nor once focus has left everything: the panel took it only as it docked.
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('s');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(panel.element().contains(document.activeElement)).toBe(false);
  });

  it('never_consents_on_enter_from_the_page', async () => {
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    await expect.element(screen.getByRole('region', { name: ask, exact: true })).toBeVisible();
    // "Yes, use it" is the active row, but Enter reads nothing until focus is in the panel.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await userEvent.keyboard('{Enter}');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests('setupConsent')).toHaveLength(0);
    await expect.element(screen.getByRole('region', { name: ask, exact: true })).toBeVisible();
    // A number key moves into the panel; then Enter answers.
    await userEvent.keyboard('1');
    await expect.element(screen.getByRole('button', { name: YES, exact: true })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => requests('setupConsent').map((r) => r.body)).toEqual([{ allow: true }]);
  });

  it('puts_focus_back_on_its_answer_when_the_consent_fails', async () => {
    const { state, ask } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    mockStore.inject({ route: 'setupConsent', status: 503 });
    await screen.getByRole('button', { name: YES, exact: true }).click();
    await expect.element(screen.getByRole('alert')).toBeVisible();
    await expect.element(screen.getByRole('region', { name: ask, exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: YES, exact: true })).toHaveFocus();
  });

  it('keeps_typed_words_for_the_first_question_and_reads_nothing', async () => {
    const { state } = await waitingInterview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    const box = screen.getByRole('textbox', { name: 'Your answer', exact: true });
    await box.fill('Mostly individuals, some small businesses.');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('region', { name: CPA_COPY.first, exact: true })).toBeVisible();
    // Typing is "No, I'll type it": nothing is read, and the words wait for the question they answer.
    expect(requests('setupConsent').map((r) => r.body)).toEqual([{ allow: false }]);
    await expect.element(box).toHaveValue('Mostly individuals, some small businesses.');
    expect(requests('setupAnswer')).toHaveLength(0);
    // The owner was typing, so the box kept focus through the turn, and the question docking under
    // it doesn't take it.
    await expect.element(box).toHaveFocus();
  });
});
