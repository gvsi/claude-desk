import { Navigate, type RouteObject } from 'react-router';

import { Arrival } from '../owner/Arrival.tsx';
import { OwnerLayout } from '../owner/OwnerLayout.tsx';
import { SafetyPage } from '../owner/safety/SafetyPage.tsx';
import { BriefingPage } from '../owner/today/BriefingPage.tsx';
import { TodayPage } from '../owner/today/TodayPage.tsx';
import { PublicPage } from '../public/PublicPage.tsx';
import { NotFound } from './NotFound.tsx';

/**
 * The app's routes. Screens join as they are built: `/` (the first visit's intro dialog),
 * `/app/:deskId/*` (owner), `/app/setup/*`, `/d/:slug` (public page), `/d/:slug/agents`,
 * `/pay/:token` and `/vision/*`.
 */
export const routes: RouteObject[] = [
  { path: '/', element: <Arrival /> },
  {
    path: '/app/:deskId',
    element: <OwnerLayout />,
    children: [
      { index: true, element: <Navigate to="today" replace /> },
      { path: 'today', element: <TodayPage /> },
      { path: 'today/briefing', element: <BriefingPage /> },
      // One route for the list and an attempt open beside it, so the page stays as it is (its filter
      // included) while the owner moves between attempts.
      { path: 'safety/:refId?', element: <SafetyPage /> },
    ],
  },
  { path: '/d/:slug', element: <PublicPage /> },
  { path: '*', element: <NotFound /> },
];
