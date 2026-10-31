import { Navigate, type RouteObject } from 'react-router';

import { ReaderError } from '../about/ReaderError.tsx';
import { ABOUT_PAGES, type AboutId } from '../about/links.ts';
import { Arrival } from '../owner/Arrival.tsx';
import { ConversationsPage } from '../owner/conversations/ConversationsPage.tsx';
import { OwnerLayout } from '../owner/OwnerLayout.tsx';
import { RuleDraftPage } from '../owner/rules/RuleDraftReview.tsx';
import { SafetyPage } from '../owner/safety/SafetyPage.tsx';
import { BriefingPage } from '../owner/today/BriefingPage.tsx';
import { TodayPage } from '../owner/today/TodayPage.tsx';
import { AgentCardPage } from '../public/agents/AgentCardPage.tsx';
import { CheckoutPage } from '../public/checkout/CheckoutPage.tsx';
import { PublicPage } from '../public/PublicPage.tsx';
import { SetupPage } from '../setup/SetupPage.tsx';
import { NotFound } from './NotFound.tsx';
import { RouteError } from './RouteError.tsx';

/** What an About page shows while its code loads on a first visit: the page's own background, briefly. */
function ReaderLoading() {
  return null;
}

/**
 * An About this prototype reading page. Its code, the two documents and their parser load only when the
 * page opens (`import()`), so a document that can't be parsed fails here and nowhere else: `ReaderError`,
 * which loads with the app, says so and points the way back.
 */
function aboutRoute(id: AboutId): RouteObject {
  return {
    path: ABOUT_PAGES[id].route,
    errorElement: <ReaderError />,
    HydrateFallback: ReaderLoading,
    lazy: async () => {
      const { ReaderPage } = await import('../about/ReaderPage.tsx');
      return { element: <ReaderPage id={id} /> };
    },
  };
}

/**
 * The app's routes. Screens join as they are built: `/` (the first visit's intro dialog),
 * `/app/:deskId/*` (owner), `/app/setup/*`, `/d/:slug` (public page), `/d/:slug/agents`,
 * `/pay/:token`, `/vision/*` and `/about/*` (the About this prototype reading pages). Each screen's
 * route carries an error element, so a page that throws while it draws shows a kind line and never
 * React Router's own error page.
 */
export const routes: RouteObject[] = [
  { path: '/', element: <Arrival />, errorElement: <RouteError /> },
  // Setup, before the owner's Desk routes so "setup" is never read as a Desk.
  { path: '/app/setup/:setupId?', element: <SetupPage />, errorElement: <RouteError /> },
  {
    path: '/app/:deskId',
    element: <OwnerLayout />,
    // Catches what the owner's pages below throw too.
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="today" replace /> },
      { path: 'today', element: <TodayPage /> },
      { path: 'today/briefing', element: <BriefingPage /> },
      // One route for the list and a conversation open beside it, so the list stays as it is while
      // the owner moves between conversations.
      { path: 'conversations/:sessionId?', element: <ConversationsPage /> },
      // One route for the list and an attempt open beside it, so the page stays as it is (its filter
      // included) while the owner moves between attempts.
      { path: 'safety/:refId?', element: <SafetyPage /> },
      // A card draft's review, from router state or read again by its version after a reload.
      { path: 'rules/drafts/:version', element: <RuleDraftPage /> },
    ],
  },
  { path: '/d/:slug', element: <PublicPage />, errorElement: <RouteError visitor /> },
  { path: '/d/:slug/agents', element: <AgentCardPage />, errorElement: <RouteError visitor /> },
  { path: '/pay/:token', element: <CheckoutPage />, errorElement: <RouteError visitor /> },
  aboutRoute('proposal'),
  aboutRoute('prediction'),
  { path: '*', element: <NotFound /> },
];
