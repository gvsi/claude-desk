import { Navigate, type RouteObject } from 'react-router';

import { ReaderError } from '../about/ReaderError.tsx';
import { ABOUT_PAGES, type AboutId } from '../about/links.ts';
import { Arrival } from '../owner/Arrival.tsx';
import { ConversationsPage } from '../owner/conversations/ConversationsPage.tsx';
import { OwnerLayout } from '../owner/OwnerLayout.tsx';
import { SafetyPage } from '../owner/safety/SafetyPage.tsx';
import { BriefingPage } from '../owner/today/BriefingPage.tsx';
import { TodayPage } from '../owner/today/TodayPage.tsx';
import { CheckoutPage } from '../public/checkout/CheckoutPage.tsx';
import { PublicPage } from '../public/PublicPage.tsx';
import { CityOfficePage } from '../vision/CityOfficePage.tsx';
import { ClaudeAccountPage } from '../vision/ClaudeAccountPage.tsx';
import { VISION_PATHS } from '../vision/data.ts';
import { PhonePage } from '../vision/PhonePage.tsx';
import { TeamDeskPage } from '../vision/TeamDeskPage.tsx';
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
    ],
  },
  { path: '/d/:slug', element: <PublicPage />, errorElement: <RouteError visitor /> },
  { path: '/pay/:token', element: <CheckoutPage />, errorElement: <RouteError visitor /> },
  // The vision pages: static pictures of where a Desk is going, each under the vision bar. They read
  // nothing, so they open the same for anyone with the link.
  { path: VISION_PATHS.cityOffice, element: <CityOfficePage />, errorElement: <RouteError /> },
  { path: VISION_PATHS.teamDesk, element: <TeamDeskPage />, errorElement: <RouteError /> },
  { path: VISION_PATHS.claudeAccount, element: <ClaudeAccountPage />, errorElement: <RouteError visitor /> },
  { path: VISION_PATHS.phone, element: <PhonePage />, errorElement: <RouteError /> },
  aboutRoute('proposal'),
  aboutRoute('prediction'),
  { path: '*', element: <NotFound /> },
];
