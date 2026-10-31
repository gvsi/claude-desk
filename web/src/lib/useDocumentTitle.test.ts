/**
 * `useDocumentTitle` with more than one page naming the tab at once, in strict mode as the app runs:
 * the tab shows the newest one's title, a title that changes keeps its place, and as each closes the
 * tab shows the one under it, then what it said before any of them.
 */
import { Fragment, StrictMode, act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useDocumentTitle } from './useDocumentTitle.ts';

/** A page that names the tab `title`, around what it holds. */
function Titled({ title, children }: { title: string | null; children?: ReactNode }) {
  useDocumentTitle(title);
  return createElement(Fragment, null, children);
}

/** `outer` naming the tab, with `inner` inside it when given. */
const nested = (outer: string, inner?: string | null) => createElement(Titled, { title: outer }, inner === undefined ? null : createElement(Titled, { title: inner }));

/** Pages side by side, each keyed by its title. */
const sideBySide = (...titles: string[]) => titles.map((title) => createElement(Titled, { key: title, title }));

let root: Root | null = null;

function render(node: ReactNode): void {
  act(() => {
    root ??= createRoot(document.createElement('div'));
    root.render(createElement(StrictMode, null, node));
  });
}

function closeAll(): void {
  act(() => root?.unmount());
  root = null;
}

beforeAll(() => {
  // React's own flag that this is a test environment where updates run inside act().
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(closeAll);

describe('useDocumentTitle', () => {
  it('nested_pages_each_keep_their_title', () => {
    document.title = 'Before';
    render(nested('Outer'));
    expect(document.title).toBe('Outer');
    // The inner page opens later: its title shows.
    render(nested('Outer', 'Inner'));
    expect(document.title).toBe('Inner');
    // The outer page's title changes under it: the inner one's still shows.
    render(nested('Outer again', 'Inner'));
    expect(document.title).toBe('Inner');
    // The inner page closes: the outer one's title as it is now, not as it was.
    render(nested('Outer again'));
    expect(document.title).toBe('Outer again');
    // A page that names nothing changes nothing.
    render(nested('Outer again', null));
    expect(document.title).toBe('Outer again');
    closeAll();
    expect(document.title).toBe('Before');
  });

  it('a_page_closing_under_a_newer_one_leaves_the_newer_title', () => {
    document.title = 'Before';
    render(sideBySide('First'));
    render(sideBySide('First', 'Second'));
    expect(document.title).toBe('Second');
    // The older page closes first: the newer one's title stays.
    render(sideBySide('Second'));
    expect(document.title).toBe('Second');
    closeAll();
    expect(document.title).toBe('Before');
  });
});
