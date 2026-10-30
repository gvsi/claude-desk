import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { SegmentedControl, type SegmentedControlProps } from './SegmentedControl.tsx';

/** A view of the Safety page: the attempts, or every entry in the record. */
type View = 'attempts' | 'entries';

const VIEWS = [
  { value: 'attempts', label: 'Attempts' },
  { value: 'entries', label: 'Every entry' },
] as const satisfies readonly { value: View; label: string }[];

/** The control as a screen holds it: it shows the new choice, and reports each change. */
function Controlled(props: SegmentedControlProps<View>) {
  const [value, setValue] = useState(props.value);
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        props.onChange(next);
      }}
    />
  );
}

const meta = {
  title: 'Controls/SegmentedControl',
  component: SegmentedControl<View>,
  args: { label: 'What to show', options: VIEWS, value: 'entries', onChange: fn() },
  render: (args) => <Controlled {...args} />,
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote: "A view switch, such as the Safety page's. No signed board draws a segmented control; the nearest is N-Safety.",
  },
} satisfies Meta<typeof SegmentedControl<View>>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Views: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const group = canvas.getByRole('radiogroup', { name: 'What to show' });
    const option = (name: string) => canvas.getByRole('radio', { name });
    await expect(canvas.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Attempts', 'Every entry']);
    expectComputed(group, { backgroundColor: 'rgba(250, 249, 245, 0.05)', borderTopLeftRadius: '8px' });
    expectComputed(option('Every entry'), {
      height: '28px',
      fontSize: '13px',
      lineHeight: '18px',
      fontWeight: '420',
      backgroundColor: 'rgb(60, 57, 47)',
      color: 'rgba(250, 249, 245, 0.92)',
    });
    expectComputed(option('Attempts'), { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(250, 249, 245, 0.64)' });

    // One tab stop: Tab lands on the chosen option.
    await userEvent.tab();
    await expect(option('Every entry')).toHaveFocus();
    await expect(option('Every entry')).toHaveAttribute('aria-checked', 'true');

    // segments_follow_arrow_keys
    await userEvent.keyboard('{ArrowLeft}');
    await expect(option('Attempts')).toHaveFocus();
    await expect(option('Attempts')).toHaveAttribute('aria-checked', 'true');
    await expect(args.onChange).toHaveBeenLastCalledWith('attempts');

    await userEvent.keyboard('{ArrowRight}');
    await expect(option('Every entry')).toHaveFocus();
    await expect(option('Every entry')).toHaveAttribute('aria-checked', 'true');
    await expect(option('Attempts')).toHaveAttribute('aria-checked', 'false');
    await expect(args.onChange).toHaveBeenLastCalledWith('entries');

    // From the last option, the next one is the first.
    await userEvent.keyboard('{ArrowRight}');
    await expect(option('Attempts')).toHaveFocus();
    await expect(option('Attempts')).toHaveAttribute('aria-checked', 'true');
    await expect(args.onChange).toHaveBeenLastCalledWith('attempts');
    await expect(args.onChange).toHaveBeenCalledTimes(3);

    // Still one tab stop, now on the new choice.
    await expect(canvas.getAllByRole('radio').map((radio) => radio.tabIndex)).toEqual([0, -1]);
  },
};
