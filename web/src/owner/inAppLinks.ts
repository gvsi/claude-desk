/**
 * Links inside an owner page that lead elsewhere in the app (a design system `TextLink`, a
 * conversation row, a briefing row) are plain `<a href>`s. A plain left click on one goes through
 * the router, so the app stays loaded and keeps its state; anything else (a modified click, a link
 * that opens a new tab, one another handler already took) is left to the browser.
 */
import type { MouseEvent } from 'react';
import type { NavigateFunction, NavigateOptions } from 'react-router';

/** A back link uses its remembered history entry, or an optional routed arrival after a reload. */
export function returnThroughHistory(navigate: NavigateFunction, href: string, remembered: boolean, fallback?: NavigateOptions) {
  return (event: MouseEvent<HTMLElement>) => {
    if (!remembered && fallback === undefined) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.target !== '' || link.getAttribute('href') !== href) return;
    event.preventDefault();
    if (remembered) void navigate(-1);
    else void navigate(href, fallback);
  };
}

/** A click handler for a page's container that routes its in-app links. */
export function followInAppLinks(navigate: NavigateFunction) {
  return (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || !event.currentTarget.contains(link)) return;
    if (link.target !== '' || link.hasAttribute('download')) return;
    const href = link.getAttribute('href') ?? '';
    // Only a path on this origin. A browser reads `\` as `/` here, so `/\host` leaves the site as
    // `//host` does: the href is read as the browser would, against this page, and its origin
    // compared. One that can't be read is left to the browser.
    if (!href.startsWith('/')) return;
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    // A path on this site that reads as starting with "//" (from "/.//host", say) would look like
    // another site's address to the router, which refuses it: the browser follows it instead.
    if (url.pathname.startsWith('//')) return;
    event.preventDefault();
    void navigate(`${url.pathname}${url.search}${url.hash}`);
  };
}
