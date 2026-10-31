/**
 * The tab's title while a page is open, so tabs can be told apart and a screen reader names the page
 * it lands on (WCAG 2.4.2). Every page that names the tab does it here. A layout effect, so the title
 * changes in the same commit as the page. The page hands back what the tab said before when it
 * closes, so a page that names nothing (the first visit, the not-found screen) shows the app's own
 * name from `index.html`, never the last page's. Null names nothing: a page still reading what it
 * is called, or one drawn inside another page that names the tab.
 */
import { useLayoutEffect } from 'react';

/** The app's name, after an owner or About page's own: "Today · Claude Desk". */
export function inApp(page: string): string {
  return `${page} · Claude Desk`;
}

export function useDocumentTitle(title: string | null): void {
  useLayoutEffect(() => {
    if (title === null) return undefined;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}
