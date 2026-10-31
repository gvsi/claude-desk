/**
 * Asks search engines not to list an About this prototype page while it is open. A best effort: the app serves
 * one index.html for every address, so the tag exists only once the page has drawn. It is set and taken back in
 * the commit that draws or leaves the page, as the tab's title is (`useDocumentTitle`), so the next page never
 * inherits it.
 */
import { useLayoutEffect } from 'react';

export function useNoIndex(): void {
  useLayoutEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.append(robots);
    return () => robots.remove();
  }, []);
}
