/**
 * An owner who gave no name, in a real browser against the mock API: the Desk carries setup's
 * fallback, "Owner", which is no one's name, so Share, Profile and a conversation never show it
 * (owner, 2026-11-02). Share's card asks for a person, as the public page does, and its ready-made
 * words, Profile and the conversation's lines name the business.
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

  it('a_conversation_names_the_business_where_it_would_name_the_owner', async () => {
    await withNoOwnerName();
    const { screen } = await renderRoute(`${DESK}/conversations/${DANA_LIVE}`);
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    // What the visitor would see as the owner takes over: the business joined the chat.
    expect(document.querySelector('.cd-take-over')?.textContent).toContain(`“${BUSINESS} joined the chat.”`);
    expect(screen.getByRole('main').element().textContent).not.toMatch(/\bOwner\b/);
  });
});
