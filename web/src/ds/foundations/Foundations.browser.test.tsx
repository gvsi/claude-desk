/**
 * The Foundations color sheet checks the values of the theme it draws in: the Colors story passes
 * whichever theme the Storybook toolbar sets, as a reviewer may switch it while it is open.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it, onTestFinished } from 'vitest';

import * as stories from './Foundations.stories.tsx';

it('the_color_sheet_checks_the_theme_it_draws_in', async () => {
  onTestFinished(() => {
    delete document.documentElement.dataset.theme;
  });
  for (const theme of ['dark', 'light']) {
    const story = composeStory({ ...stories.Colors, globals: { theme } }, stories.default, undefined, 'Colors');
    await expect(story.run(), theme).resolves.toBeUndefined();
    expect(document.documentElement.dataset.theme).toBe(theme);
  }
});
