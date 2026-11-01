/**
 * The public chat's conversation fades softly where its messages scroll under the top edge of its
 * scroll region: marked while the region is scrolled away from its top, and never at the top,
 * where the first message shows whole. Only while the region itself scrolls: on a short shell,
 * where the shell scrolls and the chat's head sticks over the conversation, nothing is faded.
 */
import { expect, it, vi } from 'vitest';

import { mockStore } from '../mocks/store.ts';
import { RIVERA } from '../mocks/seed.ts';
import { renderRoute } from '../test/renderRoute.tsx';

/** Sends `text` and waits for the turn to end on the chat's stream. */
async function say(screen: Awaited<ReturnType<typeof renderRoute>>['screen'], text: string): Promise<void> {
  const before = mockStore.visitorSession(RIVERA.slug)?.events.length ?? 0;
  await screen.getByRole('textbox', { name: /^Message / }).fill(text);
  await screen.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(
    () => {
      const events = mockStore.visitorSession(RIVERA.slug)?.events ?? [];
      expect(events.length).toBeGreaterThan(before);
      expect(events.at(-1)?.ev.type).toBe('turn_end');
    },
    { timeout: 5_000 },
  );
}

it('the_conversation_fades_at_its_top_edge_only_once_scrolled_from_the_top', async () => {
  const { screen } = await renderRoute(`/d/${RIVERA.slug}`, { viewport: 'phone' });
  await expect.element(screen.getByRole('textbox', { name: /^Message / })).toBeEnabled();
  const area = document.querySelector<HTMLElement>('.cd-public-shell__scroll');
  if (area === null) throw new Error('the shell has its scroll region');
  // Nothing scrolled yet: nothing faded.
  expect(area.hasAttribute('data-scrolled')).toBe(false);
  expect(getComputedStyle(area).maskImage).toBe('none');

  for (const question of ['How much is drain clearing?', 'Do you work on Saturdays?', 'Can you fix a water heater?']) {
    await say(screen, question);
    if (area.scrollHeight > area.clientHeight) break;
  }
  expect(document.querySelector('.cd-public-shell--short'), 'a tall shell, its region scrolling').toBeNull();
  expect(area.scrollHeight, 'the conversation overflows its region').toBeGreaterThan(area.clientHeight);

  // Kept at its end, it is scrolled from the top: the fade shows, as a mask, never a colour.
  await expect.poll(() => area.scrollTop).toBeGreaterThan(0);
  await expect.poll(() => area.hasAttribute('data-scrolled')).toBe(true);
  expect(getComputedStyle(area).maskImage).toMatch(/^linear-gradient\(/);

  // Back at the top, the first message shows whole.
  area.scrollTop = 0;
  await expect.poll(() => area.hasAttribute('data-scrolled')).toBe(false);
  expect(getComputedStyle(area).maskImage).toBe('none');
});
