import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { Chip } from './Chip.tsx';

const meta = {
  title: 'Actions/Chip',
  component: Chip,
  args: { children: 'What happened overnight?', onClick: fn() },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof Chip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const chip = canvas.getByRole('button', { name: 'What happened overnight?' });
    // A suggestion has no state to announce.
    await expect(chip).not.toHaveAttribute('aria-pressed');
    await userEvent.click(chip);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

const OPTIONS = ['Call', 'Text', 'Email'] as const;

export const SelectedRadio: Story = {
  parameters: {
    canvas: 'N-Public-Handoff-Run1',
    canvasNote:
      'The board offers callback windows as times; here the options are plain words, because times come only from the kernel. The chip is 28 px, as on the owner boards.',
  },
  render: (args) => (
    <div role="radiogroup" aria-label="How Maria should reach you" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
      {OPTIONS.map((option) => (
        <Chip key={option} asRadio selected={option === 'Call'} onClick={args.onClick}>
          {option}
        </Chip>
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    const radios = canvas.getAllByRole('radio');
    await expect(radios).toHaveLength(3);
    await expect(canvas.getByRole('radio', { name: 'Call' })).toHaveAttribute('aria-checked', 'true');
    await expect(canvas.getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'false');
    await expect(canvas.getByRole('radio', { name: 'Email' })).toHaveAttribute('aria-checked', 'false');
  },
};
