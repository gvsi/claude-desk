/**
 * Setup's text boxes take focus when they first appear, so the owner can type at once: the start
 * step's description box, and the composer of the public chat in the owner's preview. Never by
 * taking focus from somewhere else: not from a control that has it, not from under an open dialog,
 * and not on a touch-first screen, where the keyboard would jump up over the page.
 */
import { expect, it, onTestFinished } from 'vitest';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { coarsePointer } from '../ds/test/touch.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';

const DESCRIPTION =
  "Turner Plumbing. I'm Mike, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters for homes and small shops.";

/** An interview whose rules are confirmed, at the owner's preview, made as the API makes one. */
async function interviewAtPreview(): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: { description: DESCRIPTION, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() } });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS) {
    const text = question.key === 'money_limit' ? '$500 is fine. Anything bigger, ask me.' : 'Yes, that works.';
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text } });
  }
  await mockStore.dispatch('setupRules', { params });
  await mockStore.dispatch('setupSituations', { params });
  await mockStore.dispatch('setupSafetyCheck', { params });
  await mockStore.dispatch('setupConfirm', { params });
  return state;
}

/** Something outside the app, added for the rest of the test. */
function outside<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  document.body.append(el);
  onTestFinished(() => el.remove());
  return el;
}

/** Lets the page's effects and a few frames run, so a focus that was going to move has moved. */
async function frames(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

it('the_start_box_has_focus_when_it_appears', async () => {
  const { screen } = await renderRoute('/app/setup');
  const box = screen.getByRole('textbox', { name: 'Your business' });
  await expect.element(box).toBeVisible();
  await expect.poll(() => document.activeElement).toBe(box.element());
});

it('the_preview_composer_has_focus_once_the_chat_can_be_written_in', async () => {
  const state = await interviewAtPreview();
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Try it as a customer before anyone else can' })).toBeVisible();
  const box = screen.getByRole('textbox', { name: /^Message / });
  await expect.element(box).toBeEnabled();
  await expect.poll(() => document.activeElement).toBe(box.element());
});

it('a_control_that_has_focus_keeps_it', async () => {
  const elsewhere = outside('button');
  elsewhere.textContent = 'Elsewhere';
  elsewhere.focus();
  const { screen } = await renderRoute('/app/setup');
  await expect.element(screen.getByRole('textbox', { name: 'Your business' })).toBeVisible();
  await frames();
  expect(document.activeElement).toBe(elsewhere);
});

it('an_open_dialog_keeps_the_focus_where_it_is', async () => {
  // A dialog over the page, with nothing in it focused yet: the box behind it doesn't take focus.
  outside('div', { role: 'dialog', 'aria-label': 'Probe' });
  const { screen } = await renderRoute('/app/setup');
  await expect.element(screen.getByRole('textbox', { name: 'Your business' })).toBeVisible();
  await frames();
  expect(document.activeElement).toBe(document.body);
});

it('a_touch_first_screen_leaves_focus_alone', async () => {
  await coarsePointer();
  const { screen } = await renderRoute('/app/setup', { viewport: 'phone' });
  await expect.element(screen.getByRole('textbox', { name: 'Your business' })).toBeVisible();
  await frames();
  expect(document.activeElement).toBe(document.body);

  const state = await interviewAtPreview();
  const preview = (await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' })).screen;
  await expect.element(preview.getByRole('textbox', { name: /^Message / })).toBeEnabled();
  await frames();
  expect(document.activeElement).toBe(document.body);
});
