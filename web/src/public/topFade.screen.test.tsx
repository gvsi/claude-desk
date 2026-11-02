/**
 * The public chat's conversation fades softly where its messages scroll under the top edge of its
 * scroll region: marked while the region is scrolled away from its top, and never at the top,
 * where the first message shows whole. Only while the region itself scrolls: on a short shell,
 * where the shell scrolls and the chat's head sticks over the conversation, nothing is faded.
 */
import { expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { proseBlock, rivera } from '../ds/fixtures/index.ts';
import { mockStore } from '../mocks/store.ts';
import { RIVERA } from '../mocks/seed.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { watchReveal } from '../test/reveal.ts';

/** Sends `text` and waits for the stream and the visible reply, including its cards, to settle. */
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
  // turn_end is already in the mock store while the page may still be receiving the reply or
  // revealing its words and cards. The follow can pin the end again until that reveal settles.
  const messages = mockStore.visitorSession(RIVERA.slug)?.events.filter(({ ev }) => ev.type === 'message').length ?? 0;
  await vi.waitFor(
    () => {
      expect(document.querySelectorAll('.cd-claude-message, .cd-person-message')).toHaveLength(messages);
      expect(document.querySelector('.cd-writing-indicator')).toBeNull();
      expect(document.querySelector('.cd-claude-message--revealing, .cd-claude-message--following')).toBeNull();
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

  // A control inside the conversation that has keyboard focus shows whole, its ring too: nothing fades.
  await screen.getByRole('textbox', { name: /^Message / }).click();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  const focused = document.activeElement;
  expect(focused !== area && area.contains(focused), `focus on a control in the conversation: ${focused?.outerHTML.slice(0, 120)}`).toBe(true);
  expect(area.hasAttribute('data-scrolled')).toBe(true);
  expect(getComputedStyle(area).maskImage).toBe('none');
  (focused as HTMLElement).blur();
  expect(getComputedStyle(area).maskImage).toMatch(/^linear-gradient\(/);

  // Back at the top, the first message shows whole.
  area.scrollTop = 0;
  await expect.poll(() => area.hasAttribute('data-scrolled')).toBe(false);
  expect(getComputedStyle(area).maskImage).toBe('none');
});

it('scrolling_up_with_the_wheel_during_a_reply_keeps_the_top_in_view', async () => {
  const { screen } = await renderRoute(`/d/${RIVERA.slug}`, { viewport: 'phone' });
  await say(screen, 'How much is drain clearing?');
  const area = document.querySelector<HTMLElement>('.cd-public-shell__scroll');
  if (area === null) throw new Error('the shell has its scroll region');
  await expect.poll(() => area.scrollTop).toBeGreaterThan(0);

  const chat = mockStore.visitorSession(RIVERA.slug);
  if (!chat) throw new Error('this browser has a chat');
  const reply = watchReveal();
  const words = Array.from({ length: 12 }, () => 'Mike Turner at Turner Plumbing can help with the sink. Tell me where the water is collecting.').join(' ');
  mockStore.world.emit(chat, mockStore.world.context(chat, 'en', '').reply([proseBlock(words), rivera.blocks.quote.en]));
  await expect.poll(() => document.querySelector('.cd-claude-message--revealing')).not.toBeNull();

  // A real wheel scroll while the words arrive stops following the end.
  await page.elementLocator(area).wheel({ delta: { y: -10_000 } });
  await expect.poll(() => area.scrollTop).toBe(0);
  expect(document.querySelector('.cd-claude-message--revealing'), 'the visitor scrolled during the reveal').not.toBeNull();
  await reply;
  expect(area.scrollTop, 'the reply and its card settled without taking the visitor back down').toBe(0);
  expect(area.hasAttribute('data-scrolled')).toBe(false);
  expect(getComputedStyle(area).maskImage).toBe('none');
});
