/**
 * The Vision article when it can't be drawn, in the whole app against the mock API: its words module throws
 * here. The article's route shows the About pages' error page, which calls it a page (the reading pages call
 * theirs a document), with the link into the prototype, and never the error itself.
 */
import { describe, expect, it, vi } from 'vitest';

import { writeLocal } from '../../lib/storage.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

/** What the words module throws, which must never reach the page. */
const BROKEN = 'the article text could not be read';

// The article's words as they are when they can't be read: reading them throws. (A factory that throws itself
// fails the browser's module mocker, outside the test.)
vi.mock('./text.ts', () => {
  const unreadable = (): never => {
    throw new Error(BROKEN);
  };
  return {
    get ARTICLE() {
      return unreadable();
    },
    get READ_MINUTES() {
      return unreadable();
    },
    get SCREENS() {
      return unreadable();
    },
    get SECTIONS() {
      return unreadable();
    },
  };
});

const ERROR_LINE = 'This page can’t be shown right now. You can go back and try again later.';

describe('The Vision article when it cannot be drawn', () => {
  it('the_article_error_calls_it_a_page', async () => {
    for (const viewport of ['desktop', 'phone'] as const) {
      writeLocal('lastDesk', null);
      const { screen, router } = await renderRoute('/about/vision', { viewport });
      await expect.element(screen.getByText(ERROR_LINE, { exact: true }), { message: viewport }).toBeVisible();
      expect(router.state.location.pathname, viewport).toBe('/about/vision');
      const text = document.body.textContent ?? '';
      expect(text, viewport).not.toContain('This document');
      expect(text, viewport).not.toContain(BROKEN);
      expect(text, viewport).not.toContain('Unexpected Application Error');
      await expect.element(screen.getByRole('link', { name: 'Try Desk prototype', exact: true })).toHaveAttribute('href', '/');
      await expectScreenBasics(screen.container, { owner: true });
      expectNoHorizontalScroll();
    }
  });
});
