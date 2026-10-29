/**
 * Renders the whole app at `path`, as a screen test sees it: a memory router over the app's
 * routes, a fresh query client (the app makes one per mount), polling at a twentieth of real time,
 * the desktop or phone viewport, and the mock API (a fresh copy of `seed` when one is named). One
 * app at a time: a second call unmounts the first.
 */
import { createMemoryRouter, type DataRouter } from 'react-router';
import { page } from 'vitest/browser';
import { cleanup, render, type RenderResult } from 'vitest-browser-react';

import { App } from '../app/App.tsx';
import { setPollScale } from '../app/poll.ts';
import { routes } from '../app/routes.tsx';
import type { MockSeed } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

export type Viewport = keyof typeof VIEWPORTS;

export interface RenderRouteOptions {
  viewport?: Viewport;
  /** The browser's first language, as `navigator.languages[0]` reports it ("es-MX"). */
  language?: string;
  /**
   * Starts the mock API over from this seed before rendering. Without it the test keeps the copy
   * it has (each test starts with `rivera`), so a second render sees what the first one changed.
   */
  seed?: MockSeed;
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
  const { width, height } = VIEWPORTS[opts.viewport ?? 'desktop'];
  await page.viewport(width, height);
  resetBrowserLanguage();
  if (opts.language !== undefined) setBrowserLanguage(opts.language);
  setPollScale(0.05);
  if (opts.seed !== undefined) mockStore.reset(opts.seed);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const screen = await render(<App router={router} />);
  return { screen, router };
}
