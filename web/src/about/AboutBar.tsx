/**
 * The bar across the top of each About this prototype page, the same on all three (owner, 2026-11-01), so going
 * from one to another moves nothing but the page the switch marks: the app's lockup, the set's switch and the
 * link into the prototype. It stays at the top of the window while the page scrolls (AboutBar.css).
 *
 * Below the set's breakpoint it takes the phone's top bar: the link into the prototype on the left, the lockup on
 * the right and the switch on its own row under the bar, which scrolls away with the page. The page under it
 * carries `cd-about-set` on its root, which gives the page the bar's height, so what scrolls into view stops below
 * it. It loads nothing but the bar: no document, so any About page can draw it.
 */
import { useSyncExternalStore } from 'react';

import { Mark, Wordmark } from '../ds/index.ts';
import { AboutSwitch } from './AboutSwitch.tsx';
import type { AboutPageId } from './links.ts';
import { PrototypeLink } from './PrototypeLink.tsx';

import './AboutBar.css';

/**
 * Below this width the bar takes the phone's top bar, and the reading pages their phone layout. AboutBar.css
 * changes the bar's height and sides at the same width.
 */
const ABOUT_NARROW = '(max-width: 1099.98px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(ABOUT_NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(ABOUT_NARROW).matches;
}

/** Whether the window is below the About set's breakpoint, where the bar and the reading pages take their phone layout. */
export function useAboutNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}

/**
 * The app's lockup (owner, 2026-10-30): the bell with no tile and the wordmark, 36 px with the Preview
 * badge on the desktop bar. A phone's top bar carries no badge, so the phone bar shows a 32 px bell
 * and the name alone, on one line at a phone's width. The white tile is the reading pages' app icon. The
 * bell is on the page's paper, so it keeps the drawing's dark ink.
 */
function Brand({ compact }: { compact: boolean }) {
  return (
    <span className="cd-about-brand">
      <Mark size={compact ? 32 : 36} ground="light" />
      <Wordmark preview={!compact} />
    </span>
  );
}

/** The About set's three pages as links, the one on show marked as the current page. */
function DocumentSwitch({ current, compact }: { current: AboutPageId; compact: boolean }) {
  return (
    <AboutSwitch
      current={current}
      className={`cd-about-switch${compact ? ' cd-about-switch--compact' : ''}`}
      linkClassName="cd-about-switch__link cd-type-control"
    />
  );
}

export interface AboutBarProps {
  /** The page on show, which the switch marks. */
  current: AboutPageId;
}

/** The bar across the top: the product's name, the About set's switch and the link into the prototype. */
export function AboutBar({ current }: AboutBarProps) {
  const compact = useAboutNarrow();
  if (compact) {
    return (
      <>
        <header className="cd-about-top cd-about-top--compact">
          <PrototypeLink compact />
          <Brand compact />
        </header>
        <DocumentSwitch current={current} compact />
      </>
    );
  }
  return (
    <header className="cd-about-top">
      <Brand compact={false} />
      <DocumentSwitch current={current} compact={false} />
      <PrototypeLink />
    </header>
  );
}
