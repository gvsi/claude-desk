/**
 * An owner who gave no name, in a real browser against the mock API: the Desk carries setup's
 * fallback, "Owner", which is no one's name, so Share, Profile and a conversation never show it
 * (owner, 2026-11-02). Share's card asks for a person, as the public page does, and its ready-made
 * words, Profile and the owner's own messages in a conversation go by the business.
 */
import { describe, expect, it } from 'vitest';

import type { BusinessOut } from '../api/views.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { OWNER_NAME_FALLBACK } from '../public/brand.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;
const BUSINESS = 'Turner Plumbing';
/** Dana's chat, live in the seed. */
const DANA_LIVE = 'ses-dana-web';

/** The seed's copy as the Desks read answers it, with the owner's name left out, as setup leaves it. */
async function withNoOwnerName(): Promise<void> {
  const reply = await mockStore.dispatch('desks', {});
  if ('network' in reply || reply.status !== 200) throw new Error('the mock reads the Desks');
  const businesses = (reply.body as BusinessOut[]).map((business) => ({ ...business, owner_display_name: OWNER_NAME_FALLBACK }));
  mockStore.inject({ route: 'desks', status: 200, times: 10_000, body: businesses });
}

describe('An owner who gave no name', () => {
  it.each(['desktop', 'phone'] as const)('share_asks_for_a_person_and_names_the_business_on_%s', async (viewport) => {
    await withNoOwnerName();
    const { screen } = await renderRoute(`${DESK}/share`, { viewport });
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Share' })).toBeVisible();
    // The printed card asks for a person, in the app's words, not as a name of the owner's.
    const answered = document.querySelector('.cd-share-card__answered');
    expect(answered?.textContent).toBe('Answered by Claude, an AI. Ask for a person any time.');
    expect(answered?.querySelector('[data-copy="user"]')).toBeNull();
    // The ready-made words name the business.
    await expect.element(screen.getByText(new RegExp(`under ${BUSINESS}’s rules\\.$`))).toBeVisible();
    expect(screen.getByRole('main').element().textContent).not.toMatch(/\bOwner\b/);
    expectNoHorizontalScroll();
  });

  it('profile_says_customers_see_the_business', async () => {
    await withNoOwnerName();
    const { screen } = await renderRoute(`${DESK}/profile`);
    const label = screen.getByText('Customers see you as', { exact: true });
    await expect.element(label).toBeVisible();
    expect(label.element().nextElementSibling?.textContent).toBe(BUSINESS);
    expect(screen.getByRole('main').element().textContent).not.toMatch(/\bOwner\b/);
  });

  it('a_conversation_shows_the_owner_by_the_business', async () => {
    await withNoOwnerName();
    const { screen } = await renderRoute(`${DESK}/conversations/${DANA_LIVE}`);
    // The owner takes over and writes: their own message is "You", beside the business's initials,
    // as the sidebar's owner row shows them.
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    await box.fill('Yes, we can come on Tuesday.');
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    const mine = screen.getByRole('log').getByText('Yes, we can come on Tuesday.', { exact: true });
    await expect.element(mine).toBeVisible();
    const message = mine.element().closest('.cd-person-message');
    expect(message?.querySelector('.cd-person-message__avatar')?.textContent).toBe('TP');
    expect(document.querySelector('.cd-sidebar__owner .cd-sidebar__avatar')?.textContent).toBe('TP');
    expect(screen.getByRole('main').element().textContent).not.toMatch(/\bOwner\b/);
  });
});
