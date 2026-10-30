import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, runnerImport, type PluginOption } from 'vite';

/**
 * The mock API's dev server plugin (src/mocks/devServer.ts), loaded through Vite's module runner
 * rather than this config's own bundle, so no other mode's config holds any mock code.
 */
async function mockApiPlugins(): Promise<PluginOption[]> {
  const devServer = fileURLToPath(new URL('./src/mocks/devServer.ts', import.meta.url));
  const { module } = await runnerImport<typeof import('./src/mocks/devServer.ts')>(devServer);
  return [module.mockApiPlugin()];
}

/**
 * Mode `mock` (`npm run dev:mock`) serves the mock API from the dev server's own process, so every
 * tab of a browser shares one demo copy: its plugin is loaded in that mode only and applies only to
 * `vite dev`, never to a build. Mode `test` (the screen tests) serves the mock's service worker
 * from `mock-public/` instead.
 */
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), ...(mode === 'mock' ? await mockApiPlugins() : [])],
  publicDir: mode === 'test' ? 'mock-public' : 'public',
  // `npm run dev` talks to the API process on its own port; the browser sees one origin. In mode
  // `mock` the dev server answers `/api/` itself and forwards nothing.
  server: mode === 'mock' ? {} : { proxy: { '/api': 'http://127.0.0.1:8700' } },
}));
