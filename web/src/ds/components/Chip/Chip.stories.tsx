import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import { Chip, type ChipProps } from './Chip.tsx';

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

/** Radio chips as a screen holds them: the chosen one follows each pick, and each pick is reported. */
function RadioChips({ onClick, initial }: { onClick: ChipProps['onClick']; initial?: (typeof OPTIONS)[number] }) {
  const [chosen, setChosen] = useState<string | undefined>(initial);
  return (
    <div role="radiogroup" aria-label="How Mike should reach you" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
      {OPTIONS.map((option) => (
        <Chip
          key={option}
          asRadio
          selected={option === chosen}
          onClick={(event) => {
            setChosen(option);
            onClick(event);
          }}
        >
          {option}
        </Chip>
      ))}
    </div>
  );
}

export const SelectedRadio: Story = {
  parameters: {
    canvas: 'N-Public-Handoff-Run1',
    canvasNote:
      'The board offers callback windows as times; here the options are plain words, because times come only from the kernel. The chip is 28 px, as on the owner boards.',
  },
  render: (args) => <RadioChips onClick={args.onClick} initial="Call" />,
  play: async ({ args, canvas, userEvent }) => {
    const radios = canvas.getAllByRole('radio');
    await expect(radios).toHaveLength(3);
    const [call, text, email] = radios as [HTMLElement, HTMLElement, HTMLElement];
    await expect(call).toHaveAttribute('aria-checked', 'true');
    await expect(text).toHaveAttribute('aria-checked', 'false');
    await expect(email).toHaveAttribute('aria-checked', 'false');

    // radio_chips_take_one_tab_stop: Tab reaches the chosen chip only, and Tab again leaves the group.
    await expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    await userEvent.tab();
    await expect(call).toHaveFocus();
    await userEvent.tab();
    await expect(document.activeElement?.closest('[role="radiogroup"]')).toBeNull();

    // The arrows move and choose, wrapping at the ends; Home and End jump.
    await userEvent.tab({ shift: true });
    await expect(call).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(text).toHaveFocus();
    await expect(text).toHaveAttribute('aria-checked', 'true');
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{ArrowDown}');
    await expect(email).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(call).toHaveFocus();
    await expect(call).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{ArrowLeft}');
    await expect(email).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(call).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(email).toHaveFocus();
    await expect(email).toHaveAttribute('aria-checked', 'true');
    await expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);
  },
};

export const RadioNoneChosen: Story = {
  parameters: {
    canvas: 'none',
    canvasNote: 'No board shows radio chips with nothing chosen yet; the first chip is the one tab stop until one is.',
  },
  render: (args) => <RadioChips onClick={args.onClick} />,
  play: async ({ canvas, userEvent }) => {
    // With nothing chosen, the first chip is the group's tab stop, and Space chooses it.
    const radios = canvas.getAllByRole('radio');
    await expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    await expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    await userEvent.tab();
    await expect(radios[0]).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  },
};
