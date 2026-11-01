/**
 * A document that can't be parsed, in the whole app against the mock API: `documents.ts` throws here, as it
 * does when a document fails to parse. The About pages, which load it on demand, show their error page with
 * the link into the prototype, and the rest of the app, which never loads it, still opens.
 */
import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { writeLocal } from '../lib/storage.ts';
import { RIVERA } from '../mocks/seed.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

/** What the registry throws: a parse error's message, which must never reach the page. */
const PARSE_ERROR = 'docs/product-proposal.md line 12: raw HTML';

// The registry as it is when a document can't be parsed: reading it throws. (A factory that throws itself
// fails the browser's module mocker, outside the test.)
vi.mock('./documents.ts', () => {
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

const ERROR_LINE = 'This document can’t be shown right now. You can go back and try again later.';

describe('A document that cannot be parsed', () => {
  it('a_parse_error_stays_on_the_about_page', async () => {
    for (const path of ['/about/proposal', '/about/prediction']) {
      for (const viewport of ['desktop', 'phone'] as const) {
        const where = `${path} at ${viewport}`;
        writeLocal('lastDesk', null);
        const { screen, router } = await renderRoute(path, { viewport });
        // The page's own error line and the link into the prototype, never the error or React Router's page.
        await expect.element(screen.getByText(ERROR_LINE, { exact: true }), { message: where }).toBeVisible();
        expect(router.state.location.pathname, where).toBe(path);
        const text = document.body.textContent ?? '';
        expect(text, where).not.toContain(PARSE_ERROR);
        expect(text, where).not.toContain('raw HTML');
        expect(text, where).not.toContain('Unexpected Application Error');
        expect(document.querySelector('h1')?.textContent, where).toBe('About this prototype');
        // Only the reader's own words are on the page, so the owner's jargon check applies too.
        await expectScreenBasics(screen.container, { owner: true });
        expectNoHorizontalScroll();

        const back = screen.getByRole('link', { name: 'Try Desk prototype', exact: true });
        await expect.element(back, { message: where }).toHaveAttribute('href', '/');
      }
    }

    // With a Desk in this browser, the link goes to it.
    writeLocal('lastDesk', RIVERA.deskId);
    const withDesk = await renderRoute('/about/proposal');
    const back = withDesk.screen.getByRole('link', { name: 'Try Desk prototype', exact: true });
    await expect.element(back).toHaveAttribute('href', `/app/${RIVERA.deskId}/today`);
    writeLocal('lastDesk', null);

    // The rest of the app never loads the documents, so it opens as it always does: the first visit's intro
    // dialog over its preview, and the public page with its chat.
    const first = await renderRoute('/', { seed: { name: 'rivera', signedIn: false } });
    await expect.element(first.screen.getByRole('dialog', { name: 'A Claude front desk for your business' })).toBeVisible();
    const publicPage = await renderRoute(`/d/${RIVERA.slug}`);
    await expect.element(publicPage.screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeVisible();
    await expect
      .element(publicPage.screen.getByText("You're chatting with Claude, an AI answering for Turner Plumbing. Ask for Mike Turner anytime."))
      .toBeVisible();

    // And from an About page that failed, the link opens it.
    const again = await renderRoute('/about/proposal', { seed: { name: 'rivera', signedIn: false } });
    await userEvent.click(again.screen.getByRole('link', { name: 'Try Desk prototype', exact: true }));
    await expect.poll(() => again.router.state.location.pathname).toBe('/');
    await expect.element(again.screen.getByRole('dialog', { name: 'A Claude front desk for your business' })).toBeVisible();
  });
});
