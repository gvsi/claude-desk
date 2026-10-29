import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { SegmentedControl, type SegmentedControlProps } from './SegmentedControl.tsx';

type Preset = 'ask_first' | 'auto' | 'custom';

const PRESETS = [
  { value: 'ask_first', label: 'Ask me first' },
  { value: 'auto', label: 'Auto' },
  { value: 'custom', label: 'Custom' },
] as const satisfies readonly { value: Preset; label: string }[];

/** The control as a screen holds it: it shows the new choice, and reports each change. */
function Controlled(props: SegmentedControlProps<Preset>) {
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
  component: SegmentedControl<Preset>,
  args: { label: 'Mode for this Desk', options: PRESETS, value: 'custom', onChange: fn() },
  render: (args) => <Controlled {...args} />,
  parameters: { layout: 'padded', canvas: 'N-Rules-Rivera' },
} satisfies Meta<typeof SegmentedControl<Preset>>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Mode: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const group = canvas.getByRole('radiogroup', { name: 'Mode for this Desk' });
    const option = (name: string) => canvas.getByRole('radio', { name });
    await expect(canvas.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Ask me first', 'Auto', 'Custom']);
    expectComputed(group, { backgroundColor: 'rgba(250, 249, 245, 0.05)', borderTopLeftRadius: '8px' });
    expectComputed(option('Custom'), {
      height: '28px',
      fontSize: '13px',
      lineHeight: '18px',
      fontWeight: '420',
      backgroundColor: 'rgb(60, 57, 47)',
      color: 'rgba(250, 249, 245, 0.92)',
    });
    expectComputed(option('Auto'), { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(250, 249, 245, 0.64)' });

    // One tab stop: Tab lands on the chosen option.
    await userEvent.tab();
    await expect(option('Custom')).toHaveFocus();
    await expect(option('Custom')).toHaveAttribute('aria-checked', 'true');

    // segments_follow_arrow_keys
    await userEvent.keyboard('{ArrowLeft}');
    await expect(option('Auto')).toHaveFocus();
    await expect(option('Auto')).toHaveAttribute('aria-checked', 'true');
    await expect(args.onChange).toHaveBeenLastCalledWith('auto');

    await userEvent.keyboard('{ArrowRight}');
    await expect(option('Custom')).toHaveFocus();
    await expect(option('Custom')).toHaveAttribute('aria-checked', 'true');
    await expect(option('Auto')).toHaveAttribute('aria-checked', 'false');
    await expect(args.onChange).toHaveBeenLastCalledWith('custom');

    // From the last option, the next one is the first.
    await userEvent.keyboard('{ArrowRight}');
    await expect(option('Ask me first')).toHaveFocus();
    await expect(option('Ask me first')).toHaveAttribute('aria-checked', 'true');
    await expect(args.onChange).toHaveBeenLastCalledWith('ask_first');
    await expect(args.onChange).toHaveBeenCalledTimes(3);

    // Still one tab stop, now on the new choice.
    await expect(canvas.getAllByRole('radio').map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  },
};
