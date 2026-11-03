import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { SegmentedControl, type SegmentedControlProps } from './SegmentedControl.tsx';

type View = 'attempts' | 'entries';

/** The Safety page's view switch, as the signed Safety board draws it. */
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
  args: { label: 'Show', options: VIEWS, value: 'attempts', onChange: fn() },
  render: (args) => <Controlled {...args} />,
  parameters: { layout: 'padded', canvas: 'N-Safety-Run1' },
} satisfies Meta<typeof SegmentedControl<View>>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SafetyView: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const group = canvas.getByRole('radiogroup', { name: 'Show' });
    const option = (name: string) => canvas.getByRole('radio', { name });
    await expect(canvas.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Attempts', 'Every entry']);
    expectComputed(group, { backgroundColor: 'rgba(250, 249, 245, 0.05)', borderTopLeftRadius: '8px' });
    expectComputed(option('Attempts'), {
      height: '28px',
      fontSize: '14px',
      lineHeight: '19px',
      fontWeight: '420',
      backgroundColor: 'rgb(60, 57, 47)',
      color: 'rgba(250, 249, 245, 0.92)',
    });
    expectComputed(option('Every entry'), { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(250, 249, 245, 0.64)' });

    // One tab stop: Tab lands on the chosen option.
    await userEvent.tab();
    await expect(option('Attempts')).toHaveFocus();
    await expect(option('Attempts')).toHaveAttribute('aria-checked', 'true');

    // segments_follow_arrow_keys
    await userEvent.keyboard('{ArrowRight}');
    await expect(option('Every entry')).toHaveFocus();
    await expect(option('Every entry')).toHaveAttribute('aria-checked', 'true');
    await expect(option('Attempts')).toHaveAttribute('aria-checked', 'false');
    await expect(args.onChange).toHaveBeenLastCalledWith('entries');

    // From the last option, the next one is the first; from the first, the previous is the last.
    await userEvent.keyboard('{ArrowRight}');
    await expect(option('Attempts')).toHaveFocus();
    await expect(args.onChange).toHaveBeenLastCalledWith('attempts');
    await userEvent.keyboard('{ArrowLeft}');
    await expect(option('Every entry')).toHaveFocus();
    await expect(args.onChange).toHaveBeenLastCalledWith('entries');
    await expect(args.onChange).toHaveBeenCalledTimes(3);

    // Still one tab stop, now on the new choice.
    await expect(canvas.getAllByRole('radio').map((radio) => radio.tabIndex)).toEqual([-1, 0]);
  },
};
