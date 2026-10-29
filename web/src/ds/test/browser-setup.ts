/**
 * Setup for the ds-browser project: stories composed in its tests run under the same project
 * annotations as Storybook and the storybook project (the a11y addon, then the preview with its
 * styles and the copy and canvas hooks).
 */
import * as a11yAddonAnnotations from '@storybook/addon-a11y/preview';
import { setProjectAnnotations } from '@storybook/react-vite';

import * as previewAnnotations from '../../../.storybook/preview.tsx';

setProjectAnnotations([a11yAddonAnnotations, previewAnnotations]);
