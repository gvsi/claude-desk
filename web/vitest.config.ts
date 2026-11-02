import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** The About pages' tests that run with motion, in `about-motion` rather than `about`. */
const ABOUT_MOTION_TESTS = 'src/about/**/*.motion.browser.test.tsx';

/**
 * Every browser test sees the dark theme, the base the signed boards draw: a test browser prefers
 * light by default, which would turn on the light theme. A test of the light theme asks for it itself.
 */
const DARK = { colorScheme: 'dark' } as const;

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
              // Vitest gives Node and browser tests separate worker budgets that run at once. Running these
              // after the browser projects keeps a CI shard's --maxWorkers the ceiling for the whole run,
              // so the browser tests' timing isn't starved by Node tests beside them.
              sequence: { groupOrder: 1 },
            },
          },
          {
            extends: true,
            // Runs every story from .storybook/main.ts as a browser test; the a11y addon fails a
            // story with any axe violation (parameters.a11y.test).
            plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
            test: {
              name: 'storybook',
              // CI runners are slower than a laptop; each story's own waits must stay bounded well under this ceiling.
              testTimeout: 30_000,
              browser: {
                enabled: true,
                headless: true,
                provider: playwright({ contextOptions: DARK }),
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
                provider: playwright({ contextOptions: { ...DARK, reducedMotion: 'reduce' } }),
                viewport: { width: 1280, height: 820 },
                instances: [{ browser: 'chromium' }],
              },
            },
          },
          {
            extends: true,
            // The skeleton's sweep in WebKit, the engine of every browser on an iPhone, with motion
            // on: the band lines up across shapes by their measured offsets, which iOS Safari needs
            // since it ignores a fixed background, and its edge draws no step.
            test: {
              name: 'ds-webkit',
              include: ['src/ds/components/Skeleton/*.webkit.test.tsx'],
              setupFiles: ['src/ds/test/browser-setup.ts'],
              browser: {
                enabled: true,
                headless: true,
                provider: playwright({ contextOptions: { ...DARK, reducedMotion: 'no-preference' } }),
                viewport: { width: 1280, height: 820 },
                instances: [{ browser: 'webkit' }],
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
                provider: playwright({ contextOptions: { ...DARK, reducedMotion: 'reduce' } }),
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
                provider: playwright({ contextOptions: { ...DARK, reducedMotion: 'no-preference' } }),
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
                provider: playwright({ contextOptions: DARK }),
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
