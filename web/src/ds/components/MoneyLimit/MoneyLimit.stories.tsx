import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { MoneyLimit, type MoneyLimitProps } from './MoneyLimit.tsx';

const { capLine, capHelp, capHint } = rivera.rulesMode;

/**
 * The limit as the Rules page holds it: "Change" opens the field, "Cancel" closes it, and the field
 * shows what was typed. Every callback is still reported.
 */
function Controlled(props: MoneyLimitProps) {
  const [editing, setEditing] = useState(props.editing);
  const [value, setValue] = useState(props.value);
  return (
    <MoneyLimit
      {...props}
      editing={editing}
      value={value}
      onEdit={() => {
        props.onEdit();
        setEditing(true);
      }}
      onCancel={() => {
        props.onCancel();
        setEditing(false);
        setValue('');
      }}
      onChange={(next) => {
        props.onChange(next);
        setValue(next);
      }}
    />
  );
}

const meta = {
  title: 'Rules/MoneyLimit',
  component: MoneyLimit,
  args: {
    line: capLine,
    help: capHelp,
    editing: false,
    value: '',
    hint: capHint,
    onEdit: fn(),
    onChange: fn(),
    onReview: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <div style={{ maxWidth: 928 }}>
      <Controlled {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-17-Mode' },
} satisfies Meta<typeof MoneyLimit>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Reading: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // The limit at body weight 520, the help under it in secondary meta.
    const line = canvas.getByText(capLine);
    expectComputed(line, { fontSize: '14px', lineHeight: '20px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(canvas.getByText(capHelp), { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(canvas.queryByRole('textbox')).toBeNull();
    // change_opens_the_field: "Change" calls onEdit once; the screen opens the field, and focus goes to it.
    const change = canvas.getByRole('button', { name: 'Change' });
    await expect(change).toHaveClass('cd-button--secondary');
    await userEvent.click(change);
    await expect(args.onEdit).toHaveBeenCalledTimes(1);
    await expect(args.onEdit).toHaveBeenCalledWith();
    const field = await canvas.findByRole('textbox', { name: 'Most I take without asking, in dollars' });
    await waitFor(() => expect(field).toHaveFocus());
    // "Cancel" calls onCancel; the screen closes the field, and focus goes back to "Change".
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Change' })).toHaveFocus());
    await expect(args.onReview).not.toHaveBeenCalled();
  },
};

export const Editing: Story = {
  args: { editing: true, value: '1000' },
  parameters: { canvas: 'N-Conn-19-Money-Cap' },
  play: async ({ args, canvas, userEvent }) => {
    // The field, named by its default label, with the screen's hint, 360 px wide at most.
    const field = canvas.getByRole('textbox', { name: 'Most I take without asking, in dollars' });
    await expect(field).toHaveValue('1000');
    await expect(field).toHaveAccessibleDescription(capHint);
    await expect(field.getBoundingClientRect().width).toBe(360);
    await expect(field).not.toHaveFocus();
    // review_passes_no_value: typing reports the raw text, never a number the field worked out.
    await userEvent.clear(field);
    await userEvent.type(field, ' 1,000.50');
    await expect(args.onChange).toHaveBeenLastCalledWith(' 1,000.50');
    await expect(field).toHaveValue(' 1,000.50');
    // "Review change" and Enter in the field each ask the screen to review what it holds, passing nothing.
    const review = canvas.getByRole('button', { name: 'Review change' });
    await expect(review).toHaveClass('cd-button--primary');
    await userEvent.click(review);
    await expect(args.onReview).toHaveBeenCalledTimes(1);
    await expect(args.onReview).toHaveBeenLastCalledWith();
    await userEvent.type(field, '{Enter}');
    await expect(args.onReview).toHaveBeenCalledTimes(2);
    await expect(args.onReview).toHaveBeenLastCalledWith();
    await expect(args.onCancel).not.toHaveBeenCalled();
    await expect(args.onEdit).not.toHaveBeenCalled();
  },
};

export const Waiting: Story = {
  args: { editing: true, value: '1000', disabled: true },
  parameters: { canvas: 'N-Conn-19-Money-Cap', canvasNote: 'A draft in flight; the board draws the field at rest.' },
  play: async ({ args, canvas, userEvent }) => {
    // While a draft is in flight, the buttons wait and nothing is sent.
    const review = canvas.getByRole('button', { name: 'Review change' });
    await expect(review).toHaveAttribute('aria-disabled', 'true');
    await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(review);
    await userEvent.type(canvas.getByRole('textbox'), '{Enter}');
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onReview).not.toHaveBeenCalled();
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};
