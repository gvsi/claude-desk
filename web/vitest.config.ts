import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** The About pages' tests that run with motion, in `about-motion` rather than `about`. */
const ABOUT_MOTION_TESTS = 'src/about/**/*.motion.browser.test.tsx';

export default defineConfig(async (env) =>
  mergeConfig(
    await viteConfig(env),
    defineConfig({
      test: {
        projects: [
          {
            extends: true,
            test: {
              name: 'unit',
              environment: 'jsdom',
              include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
            },
          },
          {
            extends: true,
            // Runs every story from .storybook/main.ts as a browser test; the a11y addon fails a
            // story with any axe violation (parameters.a11y.test).
            plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
            test: {
              name: 'storybook',
              browser: {
                enabled: true,
                headless: true,
                provider: playwright(),
                viewport: { width: 1280, height: 820 },
                instances: [{ browser: 'chromium' }],
              },
            },
          },
          {
            extends: true,
            // Browser tests of the design system itself: the story hooks fail a story, and nothing
            // moves under reduced motion (emulated for the whole browser context).
            test: {
              name: 'ds-browser',
              include: ['src/ds/**/*.browser.test.tsx'],
              setupFiles: ['src/ds/test/browser-setup.ts'],
              browser: {
                enabled: true,
                headless: true,
                provider: playwright({ contextOptions: { reducedMotion: 'reduce' } }),
                viewport: { width: 1280, height: 820 },
                instances: [{ browser: 'chromium' }],
              },
            },
          },
          {
            extends: true,
            // The About this prototype reading pages and their figures, in a real browser at the
            // desktop size, under the design system's browser setup (its styles, nothing moving).
            // The pages are static, so no mock API.
            test: {
              name: 'about',
              include: ['src/about/**/*.browser.test.tsx'],
              exclude: [...configDefaults.exclude, ABOUT_MOTION_TESTS],
              setupFiles: ['src/ds/test/browser-setup.ts'],
              browser: {
                enabled: true,
                headless: true,
                provider: playwright({ contextOptions: { reducedMotion: 'reduce' } }),
                viewport: { width: 1440, height: 900 },
                instances: [{ browser: 'chromium' }],
              },
            },
          },
          {
            extends: true,
            // The same pages with motion, as a reader who hasn't asked for less sees them: the
            // figures that play once and the scrolls that glide. Only these files, which `about`
            // leaves out.
            test: {
              name: 'about-motion',
              include: [ABOUT_MOTION_TESTS],
              setupFiles: ['src/ds/test/browser-setup.ts'],
              browser: {
                enabled: true,
                headless: true,
                provider: playwright({ contextOptions: { reducedMotion: 'no-preference' } }),
                viewport: { width: 1440, height: 900 },
                instances: [{ browser: 'chromium' }],
              },
            },
          },
          {
            extends: true,
            // Screens of the app in a real browser at the desktop size, served with the mock
            // API's service worker (mode `test` serves `mock-public/`).
            test: {
              name: 'screens',
              include: ['src/**/*.screen.test.tsx'],
              setupFiles: ['src/test/setup.screens.ts'],
              browser: {
                enabled: true,
                headless: true,
                provider: playwright(),
                viewport: { width: 1440, height: 900 },
                instances: [{ browser: 'chromium' }],
              },
            },
          },
        ],
      },
    }),
  ),
);
