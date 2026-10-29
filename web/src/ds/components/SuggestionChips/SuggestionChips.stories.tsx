import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { SuggestionChips } from './SuggestionChips.tsx';

const TODAY = ['Why was the 50% request held?', 'Raise my cash discount limit to 15%', 'What happened overnight?'];

const meta = {
  title: 'Controls/SuggestionChips',
  component: SuggestionChips,
  args: { label: 'Suggestions', suggestions: TODAY, onPick: fn() },
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof SuggestionChips>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Today: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const group = canvas.getByRole('group', { name: 'Suggestions' });
    const chips = canvas.getAllByRole('button');
    await expect(chips.map((chip) => chip.textContent)).toEqual(TODAY);
    for (const chip of chips) await expect(group).toContainElement(chip);
    // Suggestions have no state, and a long one wraps inside a narrow line instead of overflowing it.
    await expect(chips[0]).not.toHaveAttribute('aria-pressed');
    expectComputed(chips[0] as HTMLElement, { height: '28px', whiteSpace: 'normal', maxWidth: '100%' });
    expectComputed(group, { columnGap: '8px', rowGap: '8px', flexWrap: 'wrap' });

    // A pick hands its words to the screen, once.
    await userEvent.click(canvas.getByRole('button', { name: 'Raise my cash discount limit to 15%' }));
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await expect(args.onPick).toHaveBeenCalledWith('Raise my cash discount limit to 15%');
  },
};
