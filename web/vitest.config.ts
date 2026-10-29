import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

const dirname = path.dirname(fileURLToPath(import.meta.url));

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
