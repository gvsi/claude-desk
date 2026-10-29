import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/ds/**/*.stories.tsx'],
  // The vitest addon applies the project annotations itself, so there is no setup file.
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest', '@storybook/addon-docs'],
  core: { disableTelemetry: true },
};

export default config;
