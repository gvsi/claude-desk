import { useContext, type ReactNode } from 'react';
import { UNSAFE_NavigationContext, useLocation, useNavigate } from 'react-router';

import { usePagePlace } from '../about/usePagePlace.ts';
import { openedVisionCard } from '../about/vision/cardReturn.ts';
import { AppShell, ClaudeMessage, Sidebar, VisionBar } from '../ds/index.ts';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { followInAppLinks } from '../owner/inAppLinks.ts';
import { proseOf, VISION_BACK_HREF, VISION_SIDEBAR_HREFS, type VisionOwner } from './data.ts';

import './Vision.css';

export interface VisionFrameProps {
  /** The tab's name while the page is open; the app's name comes back when it closes. */
  title: string;
  /**
   * The page, given the vision bar to put first: as the owner app's or the public page's banner, or
   * at the top of a page of its own. The bar can't be left out or reworded.
   */
  children: (bar: ReactNode) => ReactNode;
}

/**
 * Every vision page's frame: the vision bar ("Vision, not in the prototype. Nothing here is live.",
 * with "Back to Vision") handed to the page to put first, and the tab named while it is open.
 * A link to a page of the app goes through the router, as the owner's pages do. Nothing here is
 * live, so the pages name no API path: the design system draws their controls going nowhere.
 */
export function VisionFrame({ title, children }: VisionFrameProps) {
  const navigate = useNavigate();
  const { pathname, state } = useLocation();
  const { navigator } = useContext(UNSAFE_NavigationContext);
  usePagePlace(pathname);

  useDocumentTitle(title);

  return (
    <div className="cd-vision-frame" onClick={followInAppLinks(navigate)} onClickCapture={(event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target !== '' || link.getAttribute('href') !== VISION_BACK_HREF) return;
      event.preventDefault();
      if (typeof state?.fromVision === 'string' && openedVisionCard(navigator, state.fromVision) === pathname) {
        // This router still remembers the article entry and the reader's place there.
        void navigate(-1);
      } else {
        void navigate(VISION_BACK_HREF, { state: { visionCard: pathname } });
      }
    }}>
      {children(<VisionBar backHref={VISION_BACK_HREF} />)}
    </div>
  );
}

/** What a vision page's control does when used: nothing, since nothing here is live. */
export const noop = () => undefined;

export interface VisionOwnerShellProps extends VisionOwner {
  /** The vision bar, across the top of the app. */
  bar: ReactNode;
  children: ReactNode;
}

/**
 * The owner app on a vision Desk: the vision bar as the banner, the one sidebar with the Desk's own
 * people and Answering line, and a page that fills the main area and pads itself. The sidebar's
 * switches and switchers are drawn as the board draws them and change nothing.
 */
export function VisionOwnerShell({ bar, business, owner, desks, currentDeskId, current, peopleLabel, counts, answeringDescription, children }: VisionOwnerShellProps) {
  return (
    <AppShell
      business={business}
      fill
      banner={bar}
      sidebar={
        <Sidebar
          business={business}
          onSwitchBusiness={noop}
          desks={desks}
          currentDeskId={currentDeskId}
          onSwitchDesk={noop}
          current={current}
          hrefs={VISION_SIDEBAR_HREFS}
          peopleLabel={peopleLabel}
          counts={counts}
          answering
          onAnsweringChange={noop}
          answeringDescription={answeringDescription}
          owner={owner}
        />
      }
    >
      {children}
    </AppShell>
  );
}

/** Claude's words in a conversation, in serif, as a checked reply's prose block, in English. */
export function ClaudeWords({ text, ownerName }: { text: string; ownerName: string }) {
  return <ClaudeMessage plainProse blocks={proseOf(text)} language="en" ownerName={ownerName} />;
}
