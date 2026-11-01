/**
 * The owner app with a document that can't be parsed, in the whole app against the mock API: `documents.ts`
 * throws here, as it does when a document fails to parse. The owner shell links the About pages but never loads
 * the documents, so the first visit, Today and the public page open as they always do, and only the About page
 * shows its error, with the link back to the Desk. (The About pages' own error checks are in
 * `about/about-error.screen.test.tsx`; this file holds the mock apart from the owner shell's other tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RIVERA } from '../mocks/seed.ts';
import { renderRoute } from '../test/renderRoute.tsx';

/** What the registry throws: a parse error's message, which must never reach the page. */
const PARSE_ERROR = 'docs/product-proposal.md line 12: raw HTML';

// The registry as it is when a document can't be parsed: reading it throws. A factory that throws itself fails
// the browser's module mocker, outside the test. The screens setup loads the routes, and what they import
// statically, before this file's mocks apply, so the mock reaches only code loaded later through `import()`, as
// the reader is. A static import of the registry from the owner shell would load the real one here; the import
// guard in `about/guards.test.ts` is what catches that.
vi.mock('../about/documents.ts', () => {
  const unreadable = (): never => {
    throw new Error(PARSE_ERROR);
  };
  return {
    get ABOUT_DOCUMENTS() {
      return unreadable();
    },
    get readingMinutes() {
      return unreadable();
    },
    get documentText() {
      return unreadable();
    },
    get inlineText() {
      return unreadable();
    },
  };
});

const TODAY = `/app/${RIVERA.deskId}/today`;
const GREETING = /^Good (morning|afternoon|evening), Mike$/;
const ERROR_LINE = 'This document can’t be shown right now. You can go back and try again later.';

// The last Desk lives in this browser's storage, which outlives a test.
beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('A document that cannot be parsed, from the owner app', () => {
  it('a_bad_document_leaves_the_app_up', async () => {
    // The first visit: the intro dialog over its preview.
    const first = await renderRoute('/', { seed: { name: 'rivera', signedIn: false } });
    await expect.element(first.screen.getByRole('dialog', { name: 'A Claude front desk for your business' })).toBeVisible();

    // Today, in the owner shell, with the sidebar's About group.
    const { screen, router } = await renderRoute(TODAY, { seed: 'rivera' });
    await expect.element(screen.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    const about = screen.getByRole('navigation', { name: 'About this prototype' });
    await expect.element(about.getByRole('link', { name: 'Product proposal', exact: true })).toHaveAttribute('href', '/about/proposal');
    await expect.element(about.getByRole('link', { name: 'Capability prediction', exact: true })).toHaveAttribute('href', '/about/prediction');

    // Its link opens the page's error, never the error itself, and the link returns to Today.
    await about.getByRole('link', { name: 'Product proposal', exact: true }).click();
    await expect.element(screen.getByText(ERROR_LINE, { exact: true })).toBeVisible();
    expect(router.state.location.pathname).toBe('/about/proposal');
    const text = document.body.textContent ?? '';
    expect(text).not.toContain(PARSE_ERROR);
    expect(text).not.toContain('Unexpected Application Error');
    const back = screen.getByRole('link', { name: 'Try Desk prototype', exact: true });
    await expect.element(back).toHaveAttribute('href', TODAY);
    await back.click();
    await expect.poll(() => router.state.location.pathname).toBe(TODAY);
    await expect.element(screen.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();

    // The public page, with its chat and the AI disclosure.
    const publicPage = await renderRoute(`/d/${RIVERA.slug}`);
    await expect.element(publicPage.screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeVisible();
    await expect
      .element(publicPage.screen.getByText("You're chatting with Claude, an AI answering for Turner Plumbing. Ask for Mike Turner anytime."))
      .toBeVisible();

    // Opened at its own address, the About page shows its error too.
    const direct = await renderRoute('/about/proposal');
    await expect.element(direct.screen.getByText(ERROR_LINE, { exact: true })).toBeVisible();
    expect(document.body.textContent ?? '').not.toContain(PARSE_ERROR);
  });
});
