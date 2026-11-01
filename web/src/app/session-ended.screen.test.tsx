/**
 * The end of an owner's demo session in a real browser against the mock API, across a reload: the
 * intro dialog says the session ended when this browser had a copy whose session is now gone, and
 * never to someone who never had one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';

const TITLE = 'A Claude front desk for your business';
const INTRO =
  'You’re Mike Turner today, owner of Turner Plumbing. His Desk answers customers and their agents under his rules. Try it, then try to break it.';
const ENDED = 'Your demo session ended. Enter the passcode to start a fresh copy.';
const TODAY = `/app/${RIVERA.deskId}/today`;

function introDialog(screen: RenderResult) {
  return screen.getByRole('dialog', { name: TITLE });
}

/**
 * Today has drawn what its first reads brought (its greeting, its held request and the Demo
 * inbox's count), and polls too slowly to read again: nothing of this page's is still out to
 * answer the page a reload opens, as nothing can be after a real reload.
 */
async function everyFirstReadIsIn(screen: RenderResult): Promise<void> {
  await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
  await expect.element(screen.getByRole('article', { name: /^Held for you: / })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: /^Demo inbox \d+ entr(?:y|ies)$/ })).toBeVisible();
}

// Whether this browser had a copy lives in its storage, which outlives a test.
beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Session ended', () => {
  it('ended_session_says_so_after_a_reload', async () => {
    // The owner's Today, opened with the copy this browser holds.
    const first = await renderRoute(TODAY, { pollScale: 100 });
    await everyFirstReadIsIn(first.screen);

    // The owner cookie is gone, then the page is reloaded (or opened in a new tab): a new app, with
    // nothing of the first one's, whose first owner read is a 401.
    const reloaded = await renderRoute(TODAY, { seed: { name: 'rivera', signedIn: false } });
    await expect.poll(() => reloaded.router.state.location.pathname).toBe('/');
    const dialog = introDialog(reloaded.screen);
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText(`${ENDED} ${INTRO}`, { exact: true })).toBeVisible();
  });

  it('no_copy_never_hears_its_session_ended', async () => {
    // Someone who never had a copy follows a link into the owner app: the intro, as on a first visit.
    const { screen, router } = await renderRoute(TODAY, { seed: { name: 'rivera', signedIn: false } });
    await expect.poll(() => router.state.location.pathname).toBe('/');
    const dialog = introDialog(screen);
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText(INTRO, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain(ENDED);
    expect(router.state.location.state).toEqual({ ended: false });
  });

  it('ended_session_without_storage_says_so_only_in_its_own_tab', async () => {
    // Storage that can't be read or written (a private window, blocked site data): the session that
    // ends while its page is open still says so, a reload can't know, and nothing breaks.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const first = await renderRoute(TODAY);
    await everyFirstReadIsIn(first.screen);
    mockStore.reset('rivera', { signedIn: false });
    await expect.poll(() => first.router.state.location.pathname).toBe('/');
    await expect.element(introDialog(first.screen).getByText(`${ENDED} ${INTRO}`, { exact: true })).toBeVisible();

    const reloaded = await renderRoute(TODAY, { seed: { name: 'rivera', signedIn: false } });
    await expect.poll(() => reloaded.router.state.location.pathname).toBe('/');
    await expect.element(introDialog(reloaded.screen).getByText(INTRO, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain(ENDED);
  });
});
