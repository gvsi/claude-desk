/**
 * Renders the whole app at `path`, as a screen test sees it: a memory router over the app's
 * routes (or a test's own copy of them), a fresh query client (the app makes one per mount),
 * polling at a twentieth of real time unless the test asks for another pace, the Connectors pages
 * as the app has them unless the test asks otherwise, the desktop or phone viewport, and the mock API (a fresh copy of `seed` when one is named). One app at a time: a
 * second call unmounts the first.
 */
import { StrictMode } from 'react';
import { createMemoryRouter, type DataRouter, type Location, type RouteObject } from 'react-router';
import { page } from 'vitest/browser';
import { cleanup, render, type RenderResult } from 'vitest-browser-react';

import { App } from '../app/App.tsx';
import { setPollScale, setRetryScale } from '../app/poll.ts';
import { routes } from '../app/routes.tsx';
import type { MockSeed } from '../mocks/seed.ts';
import { mockStore, type ResetOptions } from '../mocks/store.ts';
import { CONNECTOR_PAGES_BUILT, setConnectorPagesBuilt } from '../owner/connectors/pages.ts';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

export type Viewport = keyof typeof VIEWPORTS;

/** A seed by name, and whether this browser holds the new copy's owner cookie (default true). */
export interface SeedOption extends ResetOptions {
  name: MockSeed;
}

export interface RenderRouteOptions {
  /** Existing history entries, for a reload that keeps history but starts a fresh router. */
  initialEntries?: (string | Partial<Location>)[];
  /** The desktop or phone viewport by name, or a window of its own size, such as a phone on its side. */
  viewport?: Viewport | { width: number; height: number };
  /** The browser's first language, as `navigator.languages[0]` reports it ("es-MX"). */
  language?: string;
  /**
   * Starts the mock API over from this seed before rendering: by name for a copy this browser is
   * signed in to, or `{ name, signedIn: false }` for one it hasn't opened yet. It also starts a new
   * epoch, as a new test does, so a request the page it unmounted sent late reaches nothing. Without
   * it the test keeps the copy it has (each test starts with `rivera`, signed in), so a second render
   * sees what the first one changed.
   */
  seed?: MockSeed | SeedOption;
  /** The app's routes with a test's change, such as a page swapped for one that throws. */
  routes?: RouteObject[];
  /**
   * Polling at this fraction of real time (default 0.05). A test that counts reads passes a large
   * one, such as 100, so no poll lands while it counts.
   */
  pollScale?: number;
  /** A failed read's retry delay at this fraction of real time (default 1); 0 retries at once. */
  retryScale?: number;
  /** Renders the app inside React's StrictMode, as `main.tsx` does: on mount, renders and effects run twice. */
  strict?: boolean;
  /** Called with the router before the app renders, so a test can watch it from the first navigation. */
  beforeRender?: (router: DataRouter) => void;
  /**
   * Draws the owner app as if the Connectors pages were built (true) or not, so their rows link to
   * them or don't; the app's own `CONNECTOR_PAGES_BUILT` by default.
   */
  connectorPages?: boolean;
}

export interface RenderedRoute {
  screen: RenderResult;
  router: DataRouter;
}

/** Makes `navigator.languages` and `navigator.language` report `language` until the reset. */
function setBrowserLanguage(language: string): void {
  const languages = Object.freeze([language]);
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => languages });
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => language });
}

/** Back to the browser's own languages (the prototype's getters). */
export function resetBrowserLanguage(): void {
  Reflect.deleteProperty(navigator, 'languages');
  Reflect.deleteProperty(navigator, 'language');
}

export async function renderRoute(path: string, opts: RenderRouteOptions = {}): Promise<RenderedRoute> {
  await cleanup();
  const { width, height } = typeof opts.viewport === 'object' ? opts.viewport : VIEWPORTS[opts.viewport ?? 'desktop'];
  await page.viewport(width, height);
  resetBrowserLanguage();
  if (opts.language !== undefined) setBrowserLanguage(opts.language);
  setPollScale(opts.pollScale ?? 0.05);
  setRetryScale(opts.retryScale ?? 1);
  setConnectorPagesBuilt(opts.connectorPages ?? CONNECTOR_PAGES_BUILT);
  if (opts.seed !== undefined) {
    const { name, signedIn = true } = typeof opts.seed === 'string' ? { name: opts.seed } : opts.seed;
    mockStore.nextEpoch();
    mockStore.reset(name, { signedIn });
  }
  const router = createMemoryRouter(opts.routes ?? routes, { initialEntries: opts.initialEntries ?? [path] });
  opts.beforeRender?.(router);
  const app = <App router={router} />;
  const screen = await render(opts.strict === true ? <StrictMode>{app}</StrictMode> : app);
  return { screen, router };
}
