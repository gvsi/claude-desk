/**
 * Links inside an owner page that lead elsewhere in the app (a design system `TextLink`, a
 * conversation row, a briefing row) are plain `<a href>`s. A plain left click on one goes through
 * the router, so the app stays loaded and keeps its state; anything else (a modified click, a link
 * that opens a new tab, one another handler already took) is left to the browser.
 */
import type { MouseEvent } from 'react';
import type { NavigateFunction } from 'react-router';

/** A click handler for a page's container that routes its in-app links. */
export function followInAppLinks(navigate: NavigateFunction) {
  return (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || !event.currentTarget.contains(link)) return;
    if (link.target !== '' || link.hasAttribute('download')) return;
    const href = link.getAttribute('href') ?? '';
    // Only a path on this origin: never another site, nor a protocol-relative one.
    if (!href.startsWith('/') || href.startsWith('//')) return;
    event.preventDefault();
    void navigate(href);
  };
}
