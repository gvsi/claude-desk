import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Switch, type SwitchProps } from './Switch.tsx';
import { ACTING_SWITCH_COPY } from './copy.ts';

/** The switch as the sidebar holds it (264 px on the panel): it shows the new state, and reports each change. */
function Controlled(props: SwitchProps) {
  const [checked, setChecked] = useState(props.checked);
  return (
    <div style={{ width: 264, maxWidth: '100%', background: 'var(--bg-panel)', padding: 'var(--space-8) var(--space-10)' }}>
      <Switch
        {...props}
        description={props.label === ACTING_SWITCH_COPY.label ? ACTING_SWITCH_COPY[checked ? 'on' : 'off'] : props.description}
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
  args: { label: 'Claude acts for you', description: 'Within your rules', checked: true, onChange: fn() },
  render: (args) => <Controlled {...args} />,
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof Switch>;

export default meta;

type Story = StoryObj<typeof meta>;

export const On: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const toggle = canvas.getByRole('switch', { name: 'Claude acts for you' });
    await expect(toggle).toHaveAccessibleDescription('Within your rules');
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
    await expect(toggle).toHaveAccessibleDescription('Taking messages only');
  },
};

export const Off: Story = {
  args: { checked: false },
  parameters: { canvasNote: 'The board shows the switch on; off is a faint track with the knob at the start.' },
  play: async ({ args, canvas, userEvent }) => {
    const toggle = canvas.getByRole('switch', { name: 'Claude acts for you' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toHaveAccessibleDescription('Taking messages only');
    await userEvent.click(toggle);
    await expect(args.onChange).toHaveBeenCalledTimes(1);
    await expect(args.onChange).toHaveBeenLastCalledWith(true);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  },
};

/** A change in flight: the switch shows what the screen last passed and ignores presses until it answers. */
export const Waiting: Story = {
  args: { label: 'Customers can see this', description: 'Claude can quote it to visitors when it answers.', checked: false, waiting: true },
  render: (args) => (
    <div style={{ maxWidth: 680 }}>
      <Switch {...args} />
    </div>
  ),
  parameters: { canvas: 'none', canvasNote: 'N-Run2-Settings-Knowledge’s “Customers can see this” while its change is being saved: no board draws it, so the switch keeps its look and waits.' },
  play: async ({ args, canvas, userEvent }) => {
    // switch_waits_while_saving: it says so, keeps focus, and a press or a key does nothing.
    const toggle = canvas.getByRole('switch', { name: 'Customers can see this' });
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).not.toBeDisabled();
    await userEvent.click(toggle);
    await expect(toggle).toHaveFocus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    await expect(args.onChange).not.toHaveBeenCalled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  },
};
