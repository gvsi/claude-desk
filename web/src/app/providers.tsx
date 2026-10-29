import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DataRouter } from 'react-router';

import { ApiError, observeRequests } from '../api/http.ts';
import { ROUTES, type RouteKey } from '../api/routes.ts';
import { PublicChatProvider } from '../public/PublicChatProvider.tsx';

/**
 * Owner routes whose 401 doesn't end a session: creating a copy (a wrong passcode), asking whether
 * there is one, and the owner's preview of a public page, which anyone may follow a link to and
 * which falls back to a visitor's chat, so its failure never leaves the public page.
 */
const SESSION_PROBES: ReadonlySet<RouteKey> = new Set<RouteKey>(['copies', 'me', 'openPreview']);

/** What the passcode screen receives in `location.state` when the demo session ended. */
export interface SessionEndedState {
  /** True once an owner request has succeeded in this tab: the session ended rather than never began. */
  ended: boolean;
}

function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500;
}

/**
 * The app's one query client. A failed read is retried once, never on a 4xx; a write is never
 * retried, since a lost answer may mean it was applied.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: (failures, error) => failures < 1 && !isClientError(error) },
      mutations: { retry: false },
    },
  });
}

export interface ProvidersProps {
  router: DataRouter;
  children: ReactNode;
}

/**
 * The query client, the visitor's chats (kept per Desk while the app runs), and the end of an
 * owner's demo session: an owner request answered 401 (other than the probes above) sends the tab
 * back to the passcode screen.
 */
export function Providers({ router, children }: ProvidersProps) {
  const [queryClient] = useState(createQueryClient);
  const ownerSucceeded = useRef(false);

  useEffect(
    () =>
      observeRequests((outcome) => {
        if (!ROUTES[outcome.key].owner) return;
        if (outcome.ok) {
          ownerSucceeded.current = true;
          return;
        }
        if (outcome.error.kind !== 'unauthorized' || SESSION_PROBES.has(outcome.key)) return;
        if (router.state.location.pathname === '/') return;
        const state: SessionEndedState = { ended: ownerSucceeded.current };
        // Replace, so Back doesn't return to a page that would only answer 401 again.
        void router.navigate('/', { state, replace: true });
      }),
    [router],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <PublicChatProvider>{children}</PublicChatProvider>
    </QueryClientProvider>
  );
}
