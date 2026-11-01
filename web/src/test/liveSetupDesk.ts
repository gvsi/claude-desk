/**
 * A Desk the mock's setup made from the owner's description and took live, as an owner who answers
 * every question would: its public page's slug. A description that names no owner ("Fenster &
 * Fenster. Bespoke windows…") gives a Desk whose owner is setup's fallback, "Owner", as the API's
 * setup does.
 */
import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';

export async function liveSetupDesk(description: string): Promise<string> {
  return (await liveSetupDeskIds(description)).slug;
}

/** The same live Desk, by its public page's slug and its id, for its owner's screens. */
export async function liveSetupDeskIds(description: string): Promise<{ slug: string; deskId: string }> {
  const started = await mockStore.dispatch('startSetup', {
    body: { description, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() },
  });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const { interview_id: id, slug, desk_id: deskId } = started.body as SetupState;
  const answer = async (key: Parameters<typeof mockStore.dispatch>[0], body?: unknown) => {
    const answered = await mockStore.dispatch(key, { params: { id }, body });
    if ('network' in answered || answered.status !== 200) throw new Error(`the mock answers ${key}`);
  };
  await answer('setupConsent', { allow: false });
  for (const question of SETUP_QUESTIONS) await answer('setupAnswer', { question: question.key, text: 'Yes, that works.' });
  for (const key of ['setupRules', 'setupSituations', 'setupSafetyCheck', 'setupConfirm', 'goLive'] as const) await answer(key);
  return { slug, deskId };
}
