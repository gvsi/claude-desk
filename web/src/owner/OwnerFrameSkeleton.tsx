import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';

import type { BusinessOut } from '../api/views.ts';
import { DESKS_KEY } from './useDesks.ts';
import { isStartingSampleDesk } from './knowledge/sampleDesk.ts';
import { SIDEBAR_ABOUT } from './sidebarAbout.ts';
import { AppShell, ConceptFooter, ReviewerBarSkeleton, SidebarSkeleton, type NavKey } from '../ds/index.ts';
import { ConversationsSkeleton } from './conversations/ConversationsSkeleton.tsx';
import { CENTERED_PAGES, FILL_PAGES } from './OwnerLayout.tsx';
import { PeopleSkeleton } from './people/PeopleSkeleton.tsx';
import { ProfileSkeleton } from './profile/ProfileSkeleton.tsx';
import { KnowledgeSkeleton } from './knowledge/KnowledgeSkeleton.tsx';
import { RulesSkeleton } from './rules/RulesSkeleton.tsx';
import { SafetySkeleton } from './safety/SafetySkeleton.tsx';
import { TodaySkeleton, type SkeletonSetup } from './today/TodaySkeleton.tsx';

/** The page's shapes at an exact route; detail pages (a customer, All rules, a draft) keep an empty area. */
function pageShapes(
  page: string,
  rest: readonly string[],
  search: string,
  showSampleContent: boolean,
  setup: SkeletonSetup | undefined,
): ReactNode | null {
  const exact = rest.every((part) => part === '');
  if ((page === '' || page === 'today') && exact) return <TodaySkeleton setup={setup} />;
  if (page === 'rules' && exact) return <RulesSkeleton withHeader />;
  // Attempts may open at a detail route too; Entries keeps its existing record loader.
  const safetyRoute = exact || (rest[0] !== '' && rest.slice(1).every((part) => part === ''));
  if (page === 'safety' && safetyRoute && new URLSearchParams(search).get('view') !== 'entries') return <SafetySkeleton withHeader />;
  if (page === 'people' && exact) return <PeopleSkeleton withHeader />;
  if (page === 'profile' && exact) return <ProfileSkeleton />;
  if (page === 'knowledge' && exact) return <KnowledgeSkeleton showSampleQuestions={showSampleContent} />;
  if (page === 'conversations' && exact) return <ConversationsSkeleton withHeader open={false} recordedHistory={showSampleContent} />;
  // One conversation open beside the list: `/conversations/:id`.
  const [conversation = '', ...after] = rest;
  if (page === 'conversations' && conversation !== '' && after.every((part) => part === '')) return <ConversationsSkeleton withHeader open recordedHistory={showSampleContent} />;
  return null;
}

/**
 * Exact routes only: later tasks add their pages here, while detail pages keep an empty area.
 * `setup` is the Desk's unfinished setup once the copy's Desks say so, which Today draws first.
 */
export function pageSkeletonFor(
  pathname: string,
  search: string,
  showSampleContent = true,
  setup?: SkeletonSetup,
): { page: ReactNode | null; fill: boolean; centered: boolean } {
  const [page = '', ...rest] = pathname.split('/').slice(3);
  return {
    page: pageShapes(page, rest, search, showSampleContent, setup),
    fill: FILL_PAGES.has(page as NavKey),
    centered: CENTERED_PAGES.has(page as NavKey),
  };
}

/**
 * The owner's frame at the current address, with the same gutters and footer as the landed frame.
 * `setup`: the Desk's unfinished setup, once the copy's Desks are read and say it isn't live.
 */
export function OwnerFrameSkeleton({ pathname, setup }: { pathname: string; setup?: SkeletonSetup }) {
  const { search } = useLocation();
  const queryClient = useQueryClient();
  const businesses = queryClient.getQueryData<BusinessOut[]>(DESKS_KEY);
  const deskId = decodeURIComponent(pathname.split('/')[2] ?? '');
  const showSampleContent = businesses === undefined || isStartingSampleDesk(queryClient, businesses, deskId);
  const { page, fill, centered } = pageSkeletonFor(pathname, search, showSampleContent, setup);
  return (
    <AppShell
      todayHref={`/app/${encodeURIComponent(deskId)}/today`}
      skeleton
      business=""
      banner={<ReviewerBarSkeleton inbox />}
      sidebar={<SidebarSkeleton rows={9} about={SIDEBAR_ABOUT.links.length} />}
      fill={fill}
    >
      <div className={`cd-owner-layout${fill ? ' cd-owner-layout--fill' : ''}${centered ? ' cd-owner-layout--centered' : ''}`}>
        {page}
        {/* A fill page draws the footer in its own columns, as the landed frame leaves it to the page. */}
        {fill && page !== null ? null : (
          <footer className="cd-owner-layout__footer" data-skeleton-anchor="owner-footer">
            <ConceptFooter skeleton />
          </footer>
        )}
      </div>
    </AppShell>
  );
}
