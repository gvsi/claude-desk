import type { RouteObject } from 'react-router';

import { PublicPage } from '../public/PublicPage.tsx';
import { NotFound } from './NotFound.tsx';

/**
 * The app's routes. Screens join as they are built: `/` (passcode), `/app/:deskId/*` (owner),
 * `/app/setup/*`, `/d/:slug` (public page), `/d/:slug/agents`, `/pay/:token` and `/vision/*`.
 */
export const routes: RouteObject[] = [
  { path: '/d/:slug', element: <PublicPage /> },
  { path: '*', element: <NotFound /> },
];
