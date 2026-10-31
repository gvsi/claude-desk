/**
 * The tab's title while a page is open, so tabs can be told apart and a screen reader names the page
 * it lands on (WCAG 2.4.2). Every page that names the tab does it here, in layout effects, so the
 * title changes in the same commit as the page.
 *
 * The pages naming the tab are kept in one stack, newest last, and the tab shows the newest one's
 * title. A page whose title changes keeps its place; a page that closes leaves the stack, wherever it
 * is in it, and the tab shows the newest left, or, once none is, what the tab said before the first
 * one opened (the app's own name from `index.html`), so a page that names nothing (the first visit,
 * the not-found screen) never shows the last page's name. Null names nothing: a page still reading
 * what it is called, or one drawn inside another page that names the tab.
 */
import { useLayoutEffect, useRef } from 'react';

interface Entry {
  title: string;
}

/** The pages naming the tab now, newest last. */
const stack: Entry[] = [];
/** What the tab said before the first of them opened. */
let base = '';

function show(): void {
  document.title = stack[stack.length - 1]?.title ?? base;
}

/** The app's name, after an owner or About page's own: "Today · Claude Desk". */
export function inApp(page: string): string {
  return `${page} · Claude Desk`;
}

export function useDocumentTitle(title: string | null): void {
  const entry = useRef<Entry | null>(null);
  const naming = title !== null;

  // Joins the stack when the page starts naming the tab, and leaves it when it stops or closes. It
  // runs again only when that changes, so it reads the title of the render that started it.
  useLayoutEffect(() => {
    if (title === null) return undefined;
    if (stack.length === 0) base = document.title;
    const mine: Entry = { title };
    stack.push(mine);
    entry.current = mine;
    show();
    return () => {
      stack.splice(stack.indexOf(mine), 1);
      entry.current = null;
      show();
    };
  }, [naming]);

  // A new title changes this page's entry where it stands.
  useLayoutEffect(() => {
    if (entry.current === null || title === null) return;
    entry.current.title = title;
    show();
  }, [title]);
}
