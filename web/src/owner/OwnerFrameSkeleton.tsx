import type { ReactNode } from 'react';
import { useLocation } from 'react-router';

import { ABOUT_LINKS } from '../about/links.ts';
import { AppShell, ConceptFooter, ReviewerBarSkeleton, SidebarSkeleton, type NavKey } from '../ds/index.ts';
import { ConversationsSkeleton } from './conversations/ConversationsSkeleton.tsx';
import { CENTERED_PAGES, FILL_PAGES } from './OwnerLayout.tsx';
import { PeopleSkeleton } from './people/PeopleSkeleton.tsx';
import { RulesSkeleton } from './rules/RulesSkeleton.tsx';
import { SafetySkeleton } from './safety/SafetySkeleton.tsx';
import { TodaySkeleton } from './today/TodaySkeleton.tsx';

/** The page's shapes at an exact route; detail pages (a customer, All rules, a draft) keep an empty area. */
function pageShapes(page: string, rest: readonly string[], search: string): ReactNode | null {
  const exact = rest.every((part) => part === '');
  if ((page === '' || page === 'today') && exact) return <TodaySkeleton />;
  if (page === 'rules' && exact) return <RulesSkeleton withHeader />;
  // Attempts may open at a detail route too; Entries keeps its existing record loader.
  const safetyRoute = exact || (rest[0] !== '' && rest.slice(1).every((part) => part === ''));
  if (page === 'safety' && safetyRoute && new URLSearchParams(search).get('view') !== 'entries') return <SafetySkeleton withHeader />;
  if (page === 'people' && exact) return <PeopleSkeleton withHeader />;
  if (page === 'conversations' && exact) return <ConversationsSkeleton withHeader open={false} />;
  // One conversation open beside the list: `/conversations/:id`.
  const [conversation = '', ...after] = rest;
  if (page === 'conversations' && conversation !== '' && after.every((part) => part === '')) return <ConversationsSkeleton withHeader open />;
  return null;
}

/** Exact routes only: later tasks add their pages here, while detail pages keep an empty area. */
export function pageSkeletonFor(pathname: string, search: string): { page: ReactNode | null; fill: boolean; centered: boolean } {
  const [page = '', ...rest] = pathname.split('/').slice(3);
  return { page: pageShapes(page, rest, search), fill: FILL_PAGES.has(page as NavKey), centered: CENTERED_PAGES.has(page as NavKey) };
}

/** The owner's frame at the current address, with the same gutters and footer as the landed frame. */
export function OwnerFrameSkeleton({ pathname }: { pathname: string }) {
  const { search } = useLocation();
  const { page, fill, centered } = pageSkeletonFor(pathname, search);
  return (
    <AppShell
      skeleton
      business=""
      banner={<ReviewerBarSkeleton />}
      sidebar={<SidebarSkeleton rows={7} about={ABOUT_LINKS.links.length} />}
      fill={fill}
    >
      <div className={`cd-owner-layout${fill ? ' cd-owner-layout--fill' : ''}${centered ? ' cd-owner-layout--centered' : ''}`}>
        {page}
        {/* A fill page draws the footer in its own columns, as the landed frame leaves it to the page. */}
        {fill && page !== null ? null : (
          <footer className="cd-owner-layout__footer" data-skeleton-anchor="owner-footer">
            <ConceptFooter />
          </footer>
        )}
      </div>
    </AppShell>
  );
}
