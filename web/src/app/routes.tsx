import type { RouteObject } from 'react-router';

import { NotFound } from './NotFound.tsx';

/**
 * The app's routes. Screens join as they are built: `/` (passcode), `/app/:deskId/*` (owner),
 * `/app/setup/*`, `/d/:slug` (public page), `/d/:slug/agents`, `/pay/:token` and `/vision/*`.
 */
export const routes: RouteObject[] = [{ path: '*', element: <NotFound /> }];
