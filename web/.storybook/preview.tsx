import type { Preview } from '@storybook/react-vite';

import { BOARD_VIEWPORTS, assertCanvasParameter } from '../src/ds/reference/boards.ts';
import { assertCleanCopy } from '../src/ds/test/copy.ts';
import { webFontsLoaded } from '../src/ds/test/fonts.ts';

import '../src/ds/tokens.css';
import '../src/ds/base.css';

/**
 * The theme a story draws in: dark unless its `theme` global asks for light (the toolbar, or
 * `&globals=theme:light` in its address), set on the story's document as the app's first script
 * sets a chosen theme, so a story looks the same whatever its viewer's system prefers.
 */
function themeOf(globals: Record<string, unknown>): 'dark' | 'light' {
  return globals.theme === 'light' ? 'light' : 'dark';
}

const preview: Preview = {
  decorators: [
    (Story, { globals }) => {
      document.documentElement.dataset.theme = themeOf(globals);
      return <Story />;
    },
  ],
  globalTypes: {
    theme: {
      description: 'The theme stories draw in',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
        dynamicTitle: true,
      },
    },
  },
  // Before every story renders: the web fonts are in, so no play measures text drawn in a fallback.
  beforeEach: async () => {
    await webFontsLoaded();
  },
  // After every story renders (and its play runs): it names its canvas board, and its copy is clean.
  afterEach: ({ canvasElement, parameters }) => {
    assertCanvasParameter(parameters);
    assertCleanCopy(canvasElement);
  },
  parameters: {
    layout: 'fullscreen',
    // Any axe violation fails the story's test, in the Vitest run and in CI.
    a11y: { test: 'error' },
    viewport: {
      options: {
        // The windows the boards are drawn at: the canvas's, a 14-inch laptop's, the sidebar's and a phone's.
        ...Object.fromEntries(
          Object.entries(BOARD_VIEWPORTS).map(([key, { name, width, height }]) => [
            key,
            { name, styles: { width: `${width}px`, height: `${height}px` }, type: key.startsWith('phone') ? 'mobile' : 'desktop' },
          ]),
        ),
        desktop: { name: 'Desktop', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
        // A short laptop window, 1366 × 657 once the browser's own bars are drawn.
        short: { name: 'Short laptop', styles: { width: '1366px', height: '657px' }, type: 'desktop' },
        tablet: { name: 'Tablet', styles: { width: '768px', height: '1024px' }, type: 'tablet' },
      },
    },
  },
  initialGlobals: {
    viewport: { value: 'canvas', isRotated: false },
    theme: 'dark',
  },
};

export default preview;
