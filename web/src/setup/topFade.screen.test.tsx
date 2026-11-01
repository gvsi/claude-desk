/**
 * Setup's conversation fades softly where its messages scroll under the top edge of its scroll
 * area: marked while it is scrolled away from its top, and never at the top, where the first
 * message shows whole. Kept at its end, it leaves room under its last message, above the composer.
 */
import { expect, it } from 'vitest';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';

const DESCRIPTION =
  "Turner Plumbing. I'm Mike, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters for homes and small shops.";

/** An interview at its questions, every one but the last answered, so the conversation is long. */
async function interviewMidQuestions(): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: { description: DESCRIPTION, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() } });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS.slice(0, -1)) {
    const text = question.key === 'money_limit' ? '$500 is fine. Anything bigger, ask me.' : 'Yes, that works.';
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text } });
  }
  return state;
}

it('the_conversation_fades_at_its_top_edge_only_once_scrolled_from_the_top', async () => {
  const state = await interviewMidQuestions();
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: { width: 1440, height: 600 } });
  await expect.element(screen.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  const area = document.querySelector<HTMLElement>('.cd-setup-chat__scroll');
  if (area === null) throw new Error('the questions step has its scroll area');
  expect(area.scrollHeight, 'the conversation overflows its area').toBeGreaterThan(area.clientHeight);

  // Kept at its end, it is scrolled from the top: the fade shows, as a mask, never a colour.
  await expect.poll(() => area.scrollTop).toBeGreaterThan(0);
  await expect.poll(() => area.hasAttribute('data-scrolled')).toBe(true);
  expect(getComputedStyle(area).maskImage).toMatch(/^linear-gradient\(/);

  // Back at the top, the first message shows whole.
  area.scrollTop = 0;
  await expect.poll(() => area.hasAttribute('data-scrolled')).toBe(false);
  expect(getComputedStyle(area).maskImage).toBe('none');

  // And down again, it fades again.
  area.scrollTop = 40;
  await expect.poll(() => area.hasAttribute('data-scrolled')).toBe(true);
});

/** Pixels between the conversation's last line (its last row, or a notice under it) and the top of the dock with the composer. */
function roomAboveTheDock(): number {
  const column = document.querySelector('.cd-setup-chat__column');
  const dock = document.querySelector('.cd-setup-dock');
  if (column === null || dock === null) throw new Error('the questions step has its conversation and its dock');
  const shown = [...column.children].filter((part) => part.getBoundingClientRect().height > 0);
  return dock.getBoundingClientRect().top - Math.max(...shown.map((part) => part.getBoundingClientRect().bottom));
}

it('the_conversation_kept_at_its_end_leaves_room_above_the_composer', async () => {
  // As the visitor chat does: 24 px between the last message and the composer's area, at the end,
  // and still once the composer grows with a long answer.
  const state = await interviewMidQuestions();
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport: { width: 1440, height: 600 } });
  const box = screen.getByRole('textbox', { name: 'Your answer' });
  await expect.element(box).toBeVisible();
  const area = document.querySelector<HTMLElement>('.cd-setup-chat__scroll');
  if (area === null) throw new Error('the questions step has its scroll area');
  await expect.poll(() => area.scrollTop).toBeGreaterThan(0);
  await expect.poll(() => Math.abs(roomAboveTheDock() - 24)).toBeLessThanOrEqual(2);

  const before = document.querySelector('.cd-setup-dock')!.getBoundingClientRect().height;
  await box.fill('one\ntwo\nthree\nfour\nfive');
  await expect.poll(() => document.querySelector('.cd-setup-dock')!.getBoundingClientRect().height).toBeGreaterThan(before + 40);
  await expect.poll(() => Math.abs(roomAboveTheDock() - 24)).toBeLessThanOrEqual(2);
});
