import { useLayoutEffect, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { AppShell, ClaudeMessage, Sidebar, VisionBar, type CopyLanguage } from '../ds/index.ts';
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

/** Whether `link` would ask the API for something, such as a document card's download. */
function callsTheApi(link: HTMLAnchorElement): boolean {
  try {
    const url = new URL(link.href, window.location.href);
    return url.origin === window.location.origin && (url.pathname === '/api' || url.pathname.startsWith('/api/'));
  } catch {
    return false;
  }
}

/**
 * Every vision page's frame: the vision bar ("Vision, not in the prototype. Nothing here is live.",
 * with "Back to your Desk") handed to the page to put first, and the tab named while it is open.
 * Nothing here is live, so a link that would reach the API goes nowhere, and a link to a page of
 * the app goes through the router, as the owner's pages do.
 */
export function VisionFrame({ title, children }: VisionFrameProps) {
  const navigate = useNavigate();
  const follow = followInAppLinks(navigate);

  // As every page that names the tab does: in a layout effect, handing the title back on leaving.
  useLayoutEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);

  const onClick = (event: MouseEvent<HTMLElement>) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link instanceof HTMLAnchorElement && callsTheApi(link)) {
      event.preventDefault();
      return;
    }
    follow(event);
  };
  // A middle click opens a link in a new tab without a click event: the same rule for the API.
  const onAuxClick = (event: MouseEvent<HTMLElement>) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link instanceof HTMLAnchorElement && callsTheApi(link)) event.preventDefault();
  };

  return (
    <div className="cd-vision-frame" onClick={onClick} onAuxClick={onAuxClick}>
      {children(<VisionBar backHref={VISION_BACK_HREF} />)}
    </div>
  );
}

const noop = () => undefined;

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

/** Claude's words in a conversation, in serif, as a checked reply's prose block. */
export function ClaudeWords({ text, language = 'en', ownerName }: { text: string; language?: CopyLanguage; ownerName: string }) {
  return <ClaudeMessage blocks={proseOf(text)} language={language} ownerName={ownerName} />;
}
