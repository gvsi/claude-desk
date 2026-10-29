import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';

import { App } from './app/App.tsx';
import { routes } from './app/routes.tsx';

import './ds/tokens.css';
import './ds/base.css';

/**
 * The app. It starts no mock: under `npm run dev:mock` the dev server answers `/api/` itself, once
 * for every tab (src/mocks/devServer.ts), so a build carries no mock code.
 */
const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');
createRoot(root).render(
  <StrictMode>
    <App router={createBrowserRouter(routes)} />
  </StrictMode>,
);
