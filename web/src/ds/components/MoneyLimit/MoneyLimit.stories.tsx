import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { ConnectorSection } from '../ConnectorSection/ConnectorSection.tsx';
import { MoneyLimit, type MoneyLimitProps } from './MoneyLimit.tsx';

const { line, unset, hint } = rivera.paymentLimit;
/** Turner's Payments group on the Rules page, whose line above its tools holds the limit. */
const payments = rivera.connectors.sections.find((section) => section.connector.id === 'payments');
if (payments === undefined) throw new Error('No Payments section');

/**
 * The limit as the Rules page holds it: "Change" opens the field, "Cancel" closes it, and the field
 * shows what was typed. Every callback is still reported.
 */
function Controlled(props: MoneyLimitProps) {
  const [editing, setEditing] = useState(props.editing ?? false);
  const [value, setValue] = useState(props.value ?? '');
  // A limit with nothing to change has no field to hold.
  if (props.onEdit === undefined) return <MoneyLimit {...props} />;
  const { onEdit, onCancel, onChange } = props;
  return (
    <MoneyLimit
      {...props}
      editing={editing}
      value={value}
      onEdit={() => {
        onEdit();
        setEditing(true);
      }}
      onCancel={() => {
        onCancel();
        setEditing(false);
        setValue('');
      }}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

const meta = {
  title: 'Rules/MoneyLimit',
  component: MoneyLimit,
  args: { line, editing: false, value: '', hint, onEdit: fn(), onChange: fn(), onReview: fn(), onCancel: fn() },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConnectorSection {...payments} aboveTools={<Controlled {...args} />} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-19-Ceiling' },
} satisfies Meta<typeof MoneyLimit>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The limit, and the group's row that holds it. */
function row(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.cd-money-limit');
  if (el === null) throw new Error('No payment limit');
  return el;
}

function slot(canvasElement: HTMLElement): HTMLElement {
  const el = row(canvasElement).closest<HTMLElement>('.cd-connector-section__above');
  if (el === null) throw new Error('The limit is not in its group');
  return el;
}

export const Reading: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // The group's line above its tools holds it, under a hairline, padded 12 px 16 px; the limit
    // adds no padding or line of its own. The limit in body type and a secondary "Change" at the
    // right, centered on it, 56 px under the hairline in all.
    const group = slot(canvasElement);
    expectComputed(group, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)', paddingTop: '12px', paddingLeft: '16px', paddingBottom: '12px' });
    const limit = row(canvasElement);
    expectComputed(limit, { paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px' });
    await expect(group.getBoundingClientRect().height).toBe(57);
    const words = canvas.getByText(line);
    expectComputed(words, { fontSize: '15px', lineHeight: '21px', fontWeight: '380', color: 'rgba(250, 249, 245, 0.92)' });
    const change = canvas.getByRole('button', { name: 'Change' });
    // change_is_described_by_its_limit: "Change" says which limit it changes.
    await expect(change).toHaveAccessibleDescription(line);
    await expect(change.getAttribute('aria-describedby')).toBe(words.id);
    await expect(change).toHaveClass('cd-button--secondary');
    expectComputed(change, { height: '32px' });
    await expect(group.getBoundingClientRect().right - change.getBoundingClientRect().right).toBe(16);
    const middle = (r: DOMRect) => r.top + r.height / 2;
    await expect(middle(change.getBoundingClientRect())).toBe(middle(words.getBoundingClientRect()));
    await expect(canvas.queryByRole('textbox')).toBeNull();
    // change_opens_the_field: "Change" calls onEdit once; the screen opens the field, and focus goes to it.
    await userEvent.click(change);
    await expect(args.onEdit).toHaveBeenCalledTimes(1);
    await expect(args.onEdit).toHaveBeenCalledWith();
    const field = await canvas.findByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' });
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
  parameters: { canvas: 'N-Conn-19b-Ceiling-Edit' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // The field, named by its default label, with the screen's hint, 360 px wide at most; 12 px
    // above it and 16 px under the buttons, 165 px under the hairline in all, as the board draws it.
    const group = slot(canvasElement);
    await expect(group.getBoundingClientRect().height).toBe(165);
    await expect(group.getBoundingClientRect().bottom - canvas.getByRole('button', { name: 'Review change' }).getBoundingClientRect().bottom).toBe(16);
    const field = canvas.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' });
    await expect(field).toHaveValue('1000');
    await expect(field).toHaveAccessibleDescription(hint);
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

const TOO_HIGH = 'No single payment can be above $10,000.';

export const TooHigh: Story = {
  args: { editing: true, value: '20000', error: TOO_HIGH },
  parameters: { canvas: 'N-Conn-19b-Ceiling-Edit', canvasNote: "The screen's check of an amount above the per-payment limit; the board draws the field without an error." },
  play: async ({ canvas }) => {
    // limit_error_is_announced: the screen's error marks the field invalid, describes it, and sits
    // in a live region, so it is read out when it appears. The field keeps what was typed.
    const field = canvas.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' });
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription(`${TOO_HIGH} ${hint}`);
    const error = canvas.getByText(TOO_HIGH);
    await expect(error.closest('[aria-live="polite"]')).not.toBeNull();
    await expect(field).toHaveValue('20000');
  },
};

export const Unset: Story = {
  args: { line: unset },
  parameters: { canvasNote: 'A Desk with no payment limit set, so every payment asks; the board draws Turner at $500.' },
  play: async ({ canvas, canvasElement }) => {
    // unset_limit_never_says_zero: no limit reads as what it means, never as an amount of nothing.
    await expect(canvas.getByText(unset)).toBeVisible();
    await expect(row(canvasElement)).not.toHaveTextContent('$0');
    await expect(row(canvasElement).textContent ?? '').not.toMatch(/\b0\b/);
  },
};

export const Prominent: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <MoneyLimit line={line} prominent />
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote:
      "Drawn on N-R2-Setup-08-Rules. Above the setup interview's rules, where the limit leads them, its line is in weight 520, and by the owner's ruling of 2026-10-30 it has no “Change” there.",
  },
  play: async ({ canvas }) => {
    // prominent_line_leads: the line at 520 in the primary ink.
    expectComputed(canvas.getByText(line), { fontWeight: '520', fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    // read_only_limit_has_no_change: with no `onEdit`, the limit is only read, and nothing is there to press.
    await expect(canvas.queryAllByRole('button')).toEqual([]);
    await expect(canvas.queryByRole('textbox')).toBeNull();
  },
};

export const Waiting: Story = {
  args: { editing: true, value: '1000', disabled: true },
  parameters: { canvas: 'N-Conn-19b-Ceiling-Edit', canvasNote: 'A draft in flight; the board draws the field at rest.' },
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

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-Conn-22-Phone-Presets' },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(390);
    // On a phone the row pads 12 px 14 px, and "Change" sits 10 px under the limit, at its left.
    expectComputed(slot(canvasElement), { paddingTop: '12px', paddingLeft: '14px' });
    const words = canvas.getByText(line);
    const change = canvas.getByRole('button', { name: 'Change' });
    await expect(change.getBoundingClientRect().top - words.getBoundingClientRect().bottom).toBe(10);
    await expect(change.getBoundingClientRect().left).toBe(words.getBoundingClientRect().left);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const Updated: Story = {
  args: { updated: true },
  parameters: {
    canvasNote:
      'The signed board draws the limit at rest; P7-01 on the review canvas has a new limit land the way a changed rule does, so its line carries "Updated" until the owner leaves Rules. The line keeps no fill: its "Change" is a Button, which the selected ground can\'t take. Storybook shows the motion your system asks for: under reduced motion "Updated" is there at once.',
  },
  play: async ({ canvas, canvasElement }) => {
    const words = canvas.getByText(line);
    const pill = canvas.getByText('Updated', { exact: true });
    await expect(pill).toHaveClass('cd-pill');
    await Promise.all((pill.parentElement ?? pill).getAnimations().map((arrival) => arrival.finished));
    // In the line, after its words, and "Change" still at the right.
    await expect(words.contains(pill)).toBe(true);
    await expect(canvas.getByRole('button', { name: 'Change' })).toBeVisible();
    expectComputed(pill.parentElement ?? pill, { marginLeft: '8px' });
    expectComputed(row(canvasElement).closest('.cd-connector-section__above') ?? canvasElement, { backgroundColor: 'rgba(0, 0, 0, 0)' });
  },
};
