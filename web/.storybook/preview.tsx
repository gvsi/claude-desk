import type { Preview } from '@storybook/react-vite';

import '../src/ds/tokens.css';
import '../src/ds/base.css';

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    // Any axe violation fails the story's test, in the Vitest run and in CI.
    a11y: { test: 'error' },
    viewport: {
      options: {
        canvas: { name: 'Canvas', styles: { width: '1280px', height: '820px' }, type: 'desktop' },
        desktop: { name: 'Desktop', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' }, type: 'mobile' },
      },
    },
  },
  initialGlobals: {
    viewport: { value: 'canvas', isRotated: false },
  },
};

export default preview;
