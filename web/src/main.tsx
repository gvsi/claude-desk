import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';

import { App } from './app/App.tsx';
import { routes } from './app/routes.tsx';

import './ds/tokens.css';
import './ds/base.css';

/**
 * In mode `mock` (`npm run dev:mock`) the mock API's service worker answers `/api/*` before the
 * app renders. The mode is fixed at build time, so a build carries no mock code.
 */
async function startMockApi(): Promise<void> {
  if (import.meta.env.MODE !== 'mock') return;
  const { startMockApi: start } = await import('./mocks/browser.ts');
  await start();
}

async function main(): Promise<void> {
  await startMockApi();
  const root = document.getElementById('root');
  if (!root) throw new Error('index.html has no #root element');
  createRoot(root).render(
    <StrictMode>
      <App router={createBrowserRouter(routes)} />
    </StrictMode>,
  );
}

void main();
