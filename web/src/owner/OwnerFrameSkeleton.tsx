import type { ReactNode } from 'react';
import { useLocation } from 'react-router';

import { ABOUT_LINKS } from '../about/links.ts';
import { AppShell, ConceptFooter, ReviewerBarSkeleton, SidebarSkeleton, type NavKey } from '../ds/index.ts';
import { CENTERED_PAGES, FILL_PAGES } from './OwnerLayout.tsx';
import { PeopleSkeleton } from './people/PeopleSkeleton.tsx';
import { TodaySkeleton } from './today/TodaySkeleton.tsx';

/** The page's shapes at an exact route; detail pages (a customer, All rules, a draft) keep an empty area. */
function pageShapes(page: string, rest: readonly string[]): ReactNode | null {
  const exact = rest.every((part) => part === '');
  if ((page === '' || page === 'today') && exact) return <TodaySkeleton />;
  if (page === 'people' && exact) return <PeopleSkeleton withHeader />;
  return null;
}

/** Exact routes only: later tasks add their pages here, while detail pages keep an empty area. */
export function pageSkeletonFor(pathname: string, _search: string): { page: ReactNode | null; fill: boolean; centered: boolean } {
  const [page = '', ...rest] = pathname.split('/').slice(3);
  return { page: pageShapes(page, rest), fill: FILL_PAGES.has(page as NavKey), centered: CENTERED_PAGES.has(page as NavKey) };
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
        <footer className="cd-owner-layout__footer" data-skeleton-anchor="owner-footer">
          <ConceptFooter />
        </footer>
      </div>
    </AppShell>
  );
}
