import { expect, it } from 'vitest';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

it('shows one period after Chen & Co. when reaching Real situations on desktop and phone', async () => {
  const started = await mockStore.dispatch('startSetup', {
    body: {
      description: "Chen & Co. is a CPA firm in San Jose. I'm Lee, the owner.",
      timezone: 'America/Los_Angeles',
      idempotency_key: newIdempotencyKey(),
    },
  });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS) {
    await mockStore.dispatch('setupAnswer', {
      params,
      body: { question: question.key, text: question.key === 'money_limit' ? '$500 is fine.' : 'Yes, that works.' },
    });
  }
  const drafted = await mockStore.dispatch('setupRules', { params });
  if ('network' in drafted || drafted.status !== 200) throw new Error('the mock drafts setup rules');

  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Check real situations' }).click();
  await expect.element(screen.getByRole('heading', { name: 'Real situations', exact: true })).toBeVisible();
  const subtitle = screen.getByText('How your draft rules handle things that really happen at Chen & Co. Nothing here is real.', { exact: true });
  await expect.element(subtitle).toBeVisible();
  expect(subtitle.element().querySelector('[data-copy="user"]')?.textContent).toBe('Chen & Co.');
  expectNoHorizontalScroll();

  const phone = (await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' })).screen;
  await expect.element(phone.getByText('How your draft rules handle things that really happen at Chen & Co. Nothing here is real.', { exact: true })).toBeVisible();
  expectNoHorizontalScroll();
});
