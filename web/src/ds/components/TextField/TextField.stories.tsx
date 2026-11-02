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
    value: 'Turner Plumbing',
    hint: 'Customers see this name at the top of your public page.',
    onChange: fn(),
  },
  render: (args) => <Controlled {...args} />,
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote:
      'No board draws a form field on its own. The passcode field is part of the first-visit dialog on N-Intro-D, and the code input on N-Public-Verify-Run1 is drawn from this component; this one keeps the design system’s control radius and outline.',
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

    // Control radius, the field outline (line-field, 3:1 on the page), body type, on the page's own ground.
    expectComputed(field, {
      borderTopLeftRadius: '8px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.36)',
      fontSize: '14px',
      lineHeight: '20px',
      fontWeight: '380',
      color: 'rgba(250, 249, 245, 0.92)',
    });

    // field_outline_keeps_contrast: the outline is the field's boundary, so hover never takes it under 3:1.
    await userEvent.hover(field);
    expectComputed(field, { borderTopColor: 'rgba(250, 249, 245, 0.36)' });
    await userEvent.unhover(field);

    // Typing reports each change; the field shows what the form passes back.
    await userEvent.clear(field);
    await userEvent.type(field, 'Turner');
    await expect(args.onChange).toHaveBeenLastCalledWith('Turner');
    await expect(field).toHaveValue('Turner');
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
    expectComputed(field, { borderTopColor: 'rgba(250, 249, 245, 0.36)' });
  },
};

export const Password: Story = {
  args: { label: 'Passcode', type: 'password', value: '', hint: undefined, autoComplete: 'current-password' },
  parameters: {
    canvasNote:
      'No board draws the passcode field on its own; the first-visit dialog on N-Intro-D draws it inside the dialog, so this story names no board.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const field = canvas.getByLabelText('Passcode');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'current-password');
    await expect(field).not.toHaveAttribute('aria-describedby');

    // Focus by keyboard shows the caret and the 2 px line-focus edge, never an outer ring.
    await userEvent.tab();
    await expect(field).toHaveFocus();
    expectComputed(field, { outlineStyle: 'none', borderTopColor: 'rgba(250, 249, 245, 0.64)', boxShadow: 'rgba(250, 249, 245, 0.64) 0px 0px 0px 1px inset' });
    await userEvent.keyboard('demo');
    await expect(args.onChange).toHaveBeenLastCalledWith('demo');
  },
};

export const Multiline: Story = {
  args: {
    label: 'Your business',
    multiline: true,
    value: 'I run Turner Plumbing in Oakland. ',
    hint: 'Include your first name as customers should see it.',
    maxLength: 1500,
  },
  play: async ({ args, canvas, userEvent }) => {
    const hint = 'Include your first name as customers should see it.';
    const field = canvas.getByRole('textbox', { name: 'Your business' });
    const counter = () => canvas.queryByText(/^\d+ \/ 1500$/);
    await expect(field.tagName).toBe('TEXTAREA');
    await expect(field).toHaveAccessibleDescription(hint);

    // Well under the limit there is no counter.
    await expect(counter()).toBeNull();

    // Enter adds a line; nothing submits from a multiline field.
    await userEvent.click(field);
    await userEvent.keyboard('{End}{Enter}Mike');
    await expect(args.onChange).toHaveBeenLastCalledWith('I run Turner Plumbing in Oakland. \nMike');

    // A long word wraps inside the field instead of widening it.
    const box = field.getBoundingClientRect();
    await userEvent.type(field, ` ${'x'.repeat(120)}`);
    await expect(field.getBoundingClientRect().width).toBe(box.width);
    await expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth);

    // The counter shows from 90% of the limit (1350 of 1500), and the field names it in its description.
    await userEvent.clear(field);
    await userEvent.paste('x'.repeat(1349));
    await expect(counter()).toBeNull();
    await userEvent.keyboard('x');
    await expect(counter()).toHaveTextContent('1350 / 1500');
    await expect(field).toHaveAccessibleDescription(`${hint} 1350 / 1500`);
    expectComputed(counter() as HTMLElement, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });

    // maxLength caps the text: a paste past it stops at the limit, and the counter shows the field is full.
    await expect(field).toHaveAttribute('maxlength', '1500');
    await userEvent.clear(field);
    await userEvent.paste('x'.repeat(1600));
    await expect(args.onChange).toHaveBeenLastCalledWith('x'.repeat(1500));
    await expect(counter()).toHaveTextContent('1500 / 1500');
    await expect(field).toHaveAccessibleDescription(`${hint} 1500 / 1500`);
  },
};

export const ReadOnly: Story = {
  name: 'Read only',
  render: (args) => (
    <>
      <Controlled {...args} />
      <Controlled {...args} label="Business name" multiline={false} value="Turner Plumbing" hint="Customers see this name at the top of your public page." maxLength={undefined} />
    </>
  ),
  args: {
    label: 'Your business',
    multiline: true,
    value: "Turner Plumbing. I'm Mike, a licensed plumber in Oakland.",
    hint: 'Include your first name as customers should see it.',
    maxLength: 1500,
    readOnly: true,
  },
  parameters: {
    canvasNote:
      'Held fields use the muted fill of N-Explore-ReadOnly-B (owner, 2026-10-31, option B): a line-field outline on fill-secondary, with readable, selectable text. Setup’s description is held while a start whose answer was lost is tried again with its words as they were (plan 04, Task 12).',
  },
  play: async ({ args, canvas, userEvent }) => {
    const multiline = canvas.getByRole('textbox', { name: 'Your business' }) as HTMLTextAreaElement;
    const singleLine = canvas.getByRole('textbox', { name: 'Business name' }) as HTMLInputElement;
    for (const [field, value] of [[multiline, args.value], [singleLine, 'Turner Plumbing']] as const) {
      await expect(field).toHaveAttribute('readonly');
      await expect(field).not.toBeDisabled();
      expectComputed(field, {
        borderTopColor: 'rgba(250, 249, 245, 0.36)',
        backgroundColor: 'rgba(250, 249, 245, 0.1)',
        color: 'rgba(250, 249, 245, 0.92)',
        opacity: '1',
        cursor: 'default',
      });

      // Typing and pasting change nothing, and nothing is reported.
      await userEvent.click(field);
      await userEvent.keyboard('{End} We clear drains.');
      await userEvent.paste(' And water heaters.');
      await expect(field).toHaveValue(value);
      await expect(args.onChange).not.toHaveBeenCalled();

      // The text stays selectable, to read or copy.
      await expect(getComputedStyle(field).userSelect).not.toBe('none');
      field.select();
      await expect([field.selectionStart, field.selectionEnd]).toEqual([0, value.length]);
    }

    // Both stay in the tab order. Held fields share the 2 px line-focus edge: their border
    // and a 1 px inset shadow, without an outer ring.
    multiline.focus();
    await userEvent.tab();
    await expect(singleLine).toHaveFocus();
    expectComputed(singleLine, { outlineStyle: 'none', borderTopColor: 'rgba(250, 249, 245, 0.64)', boxShadow: 'rgba(250, 249, 245, 0.64) 0px 0px 0px 1px inset' });
    await userEvent.tab({ shift: true });
    await expect(multiline).toHaveFocus();
    expectComputed(multiline, { outlineStyle: 'none', borderTopColor: 'rgba(250, 249, 245, 0.64)', boxShadow: 'rgba(250, 249, 245, 0.64) 0px 0px 0px 1px inset' });
  },
};
