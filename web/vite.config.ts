import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, runnerImport, searchForWorkspaceRoot, type PluginOption } from 'vite';

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
 * The About pages embed the two documents from the repository's docs/ folder (`?raw`). Setting
 * `allow` replaces Vite's default of the workspace root, so that root is listed again. Every mode
 * keeps it.
 */
const fs = { allow: [searchForWorkspaceRoot(process.cwd()), '../docs'] };

/**
 * Mode `mock` (`npm run dev:mock`) serves the mock API from the dev server's own process, so every
 * tab of a browser shares one demo copy: its plugin is loaded in that mode only and applies only to
 * `vite dev`, never to a build. Mode `test` (the screen tests) serves the mock's service worker
 * from `mock-public/` instead.
 */
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), ...(mode === 'mock' ? await mockApiPlugins() : [])],
  publicDir: mode === 'test' ? 'mock-public' : 'public',
  // The screen tests run the design system's board checks (`src/test/boards.ts`), which import
  // `storybook/test`, the share kit draws its QR code with `qrcode`, and the knowledge tests check
  // answers against the contracts with Ajv, and component tests run axe, and Claude's replies render with Streamdown: all bundled up front, so a fresh cache doesn't reload
  // the page mid-run.
  optimizeDeps: mode === 'test' ? { include: ['storybook/test', 'qrcode', 'ajv/dist/2020.js', 'axe-core', 'streamdown'] } : {},
  // `npm run dev` talks to the API process on its own port; the browser sees one origin. In mode
  // `mock` the dev server answers `/api/` itself and forwards nothing.
  server: mode === 'mock' ? { fs } : { fs, proxy: { '/api': 'http://127.0.0.1:8700' } },
}));
