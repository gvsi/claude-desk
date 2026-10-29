import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Modes that serve the mock API: its service worker lives in `mock-public/`, never in a build. */
const MOCK_MODES = new Set(['mock', 'test']);

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  publicDir: MOCK_MODES.has(mode) ? 'mock-public' : 'public',
  server: {
    // `npm run dev` talks to the API process on its own port; the browser sees one origin.
    proxy: { '/api': 'http://127.0.0.1:8700' },
  },
}));
