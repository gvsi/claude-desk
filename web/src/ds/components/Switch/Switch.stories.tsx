import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Switch, type SwitchProps } from './Switch.tsx';

/** The switch as the sidebar holds it (264 px on the panel): it shows the new state, and reports each change. */
function Controlled(props: SwitchProps) {
  const [checked, setChecked] = useState(props.checked);
  return (
    <div style={{ width: 264, maxWidth: '100%', background: 'var(--bg-panel)', padding: 'var(--space-8) var(--space-10)' }}>
      <Switch
        {...props}
        checked={checked}
        onChange={(next) => {
          setChecked(next);
          props.onChange(next);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Controls/Switch',
  component: Switch,
  args: { label: 'Answering', description: 'Claude answers under your rules', checked: true, onChange: fn() },
  render: (args) => <Controlled {...args} />,
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof Switch>;

export default meta;

type Story = StoryObj<typeof meta>;

export const On: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const toggle = canvas.getByRole('switch', { name: 'Answering' });
    await expect(toggle).toHaveAccessibleDescription('Claude answers under your rules');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // On is the inverted neutral track with a dark knob.
    const track = toggle.querySelector('.cd-switch__track');
    if (!track) throw new Error('no switch track');
    expectComputed(track, { backgroundColor: 'rgb(239, 236, 228)' });

    // switch_toggles_with_space
    await userEvent.tab();
    await expect(toggle).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(args.onChange).toHaveBeenCalledTimes(1);
    await expect(args.onChange).toHaveBeenLastCalledWith(false);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  },
};

export const Off: Story = {
  args: { checked: false },
  parameters: { canvasNote: 'The board shows the switch on; off is a faint track with the knob at the start.' },
  play: async ({ args, canvas, userEvent }) => {
    const toggle = canvas.getByRole('switch', { name: 'Answering' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await expect(args.onChange).toHaveBeenCalledTimes(1);
    await expect(args.onChange).toHaveBeenLastCalledWith(true);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  },
};
