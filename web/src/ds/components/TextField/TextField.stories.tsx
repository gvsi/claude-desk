import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { TextField, type TextFieldProps } from './TextField.tsx';

const PASSCODE_ERROR = "That passcode didn't work. Check it and try again.";

/** The field as a form holds it: it shows what was typed, and reports each change. */
function Controlled(props: TextFieldProps) {
  const [value, setValue] = useState(props.value);
  return (
    <div style={{ width: 360, maxWidth: '100%' }}>
      <TextField
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next);
          props.onChange(next);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Controls/TextField',
  component: TextField,
  args: {
    label: 'Business name',
    value: 'Rivera Plumbing',
    hint: 'Customers see this name at the top of your public page.',
    onChange: fn(),
  },
  render: (args) => <Controlled {...args} />,
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote:
      'No board draws a form field on its own. The passcode field opens the demo before N-Reviewer-Arrival, and the nearest drawn field is the code input on N-Public-Verify; this one keeps the design system’s control radius and outline.',
  },
} satisfies Meta<typeof TextField>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // The label sits above the field and names it; the hint describes it.
    const field = canvas.getByRole('textbox', { name: 'Business name' });
    const label = canvas.getByText('Business name');
    await expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(field.getBoundingClientRect().top);
    await expect(field).toHaveAccessibleDescription(args.hint as string);
    await expect(field).not.toHaveAttribute('aria-invalid');

    // Control radius, the control outline, body type, on the page's own ground.
    expectComputed(field, {
      borderTopLeftRadius: '8px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.22)',
      fontSize: '14px',
      lineHeight: '20px',
      fontWeight: '380',
      color: 'rgba(250, 249, 245, 0.92)',
    });

    // Typing reports each change; the field shows what the form passes back.
    await userEvent.clear(field);
    await userEvent.type(field, 'Rivera');
    await expect(args.onChange).toHaveBeenLastCalledWith('Rivera');
    await expect(field).toHaveValue('Rivera');
  },
};

export const WithError: Story = {
  args: { label: 'Passcode', type: 'password', value: 'demo1', hint: undefined, error: PASSCODE_ERROR, autoComplete: 'current-password' },
  play: async ({ canvas }) => {
    // error_is_described: the field is invalid, and the error is what describes it.
    const field = canvas.getByLabelText('Passcode');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription(PASSCODE_ERROR);

    // The error is words beside a refused dot, never color alone; the outline stays neutral.
    const error = canvas.getByText(PASSCODE_ERROR);
    await expect(error).toBeVisible();
    const line = error.closest('p') as HTMLElement;
    const dot = line.querySelector('.cd-status-dot--refused');
    await expect(dot).not.toBeNull();
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    expectComputed(error, { color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(field, { borderTopColor: 'rgba(250, 249, 245, 0.22)' });
  },
};

export const Password: Story = {
  args: { label: 'Passcode', type: 'password', value: '', hint: undefined, autoComplete: 'current-password' },
  parameters: {
    canvasNote:
      'No board draws the passcode screen; it opens the demo before N-Reviewer-Arrival, so this story names no board.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const field = canvas.getByLabelText('Passcode');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'current-password');
    await expect(field).not.toHaveAttribute('aria-describedby');

    // Focus shows the 2 px blue ring at a 2 px offset.
    await userEvent.tab();
    await expect(field).toHaveFocus();
    expectComputed(field, { outlineStyle: 'solid', outlineWidth: '2px', outlineOffset: '2px', outlineColor: 'rgb(126, 174, 218)' });
    await userEvent.keyboard('demo');
    await expect(args.onChange).toHaveBeenLastCalledWith('demo');
  },
};

export const Multiline: Story = {
  args: {
    label: 'Your business',
    multiline: true,
    value: 'I run Rivera Plumbing in Oakland. ',
    hint: 'Include your first name as customers should see it.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const field = canvas.getByRole('textbox', { name: 'Your business' });
    await expect(field.tagName).toBe('TEXTAREA');
    await expect(field).toHaveAccessibleDescription('Include your first name as customers should see it.');

    // Enter adds a line; nothing submits from a multiline field.
    await userEvent.click(field);
    await userEvent.keyboard('{End}{Enter}Maria');
    await expect(args.onChange).toHaveBeenLastCalledWith('I run Rivera Plumbing in Oakland. \nMaria');

    // A long word wraps inside the field instead of widening it.
    const box = field.getBoundingClientRect();
    await userEvent.type(field, ` ${'x'.repeat(120)}`);
    await expect(field.getBoundingClientRect().width).toBe(box.width);
    await expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth);
  },
};
