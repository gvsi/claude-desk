import type { Preview } from '@storybook/react-vite';

import { BOARD_VIEWPORTS, assertCanvasParameter } from '../src/ds/reference/boards.ts';
import { assertCleanCopy } from '../src/ds/test/copy.ts';

import '../src/ds/tokens.css';
import '../src/ds/base.css';

const preview: Preview = {
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
            { name, styles: { width: `${width}px`, height: `${height}px` }, type: key === 'phone' ? 'mobile' : 'desktop' },
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
  },
};

export default preview;
