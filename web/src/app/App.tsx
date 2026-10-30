import type { DataRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { Providers } from './providers.tsx';

export interface AppProps {
  /** A browser router in the app, a memory router in tests; both built from `routes`. */
  router: DataRouter;
}

export function App({ router }: AppProps) {
  return (
    <Providers router={router}>
      <RouterProvider router={router} />
    </Providers>
  );
}
