import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { expect, fn, waitFor } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName } from '../ConnectorName/ConnectorName.tsx';
import { MoneyLimit, type MoneyLimitProps } from './MoneyLimit.tsx';

const { line, unset, hint } = rivera.paymentLimit;
const payments = rivera.connectors.views.payments;

/** The Payments group's head, as the Rules page draws it above the limit (a stand-in for its section's header). */
function Group({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 960 }}>
      <Card as="section" label={payments.name} padding={0}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }}>
          <ConnectorIcon icon={payments.icon} size="section" />
          <div>
            <ConnectorName connector={payments} size="section" />
            <p className="cd-type-meta" style={{ margin: 0, color: 'var(--text-secondary)' }}>
              {payments.description}
            </p>
          </div>
        </div>
        {children}
      </Card>
    </div>
  );
}

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
  args: { line, editing: false, value: '', hint, onEdit: fn(), onChange: fn(), onReview: fn(), onCancel: fn() },
  render: (args) => (
    <Group>
      <Controlled {...args} />
    </Group>
  ),
  parameters: { layout: 'padded', canvas: 'none', canvasNote: 'Drawn on N-Conn-19-Ceiling, which joins the reference boards with its board story.' },
} satisfies Meta<typeof MoneyLimit>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The limit's row, and the padded body inside it. */
function row(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.cd-money-limit');
  if (el === null) throw new Error('No payment limit');
  return el;
}

function body(canvasElement: HTMLElement): HTMLElement {
  const el = row(canvasElement).firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('No body');
  return el;
}

export const Reading: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // A row under the group's head: a hairline above it, padded 12 px 16 px, the limit in body type
    // and a secondary "Change" at the right, centered on it.
    const limit = row(canvasElement);
    expectComputed(limit, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    expectComputed(body(canvasElement), { paddingTop: '12px', paddingLeft: '16px', paddingBottom: '12px' });
    const words = canvas.getByText(line);
    expectComputed(words, { fontSize: '14px', lineHeight: '20px', fontWeight: '380', color: 'rgba(250, 249, 245, 0.92)' });
    const change = canvas.getByRole('button', { name: 'Change' });
    await expect(change).toHaveClass('cd-button--secondary');
    expectComputed(change, { height: '32px' });
    const box = limit.getBoundingClientRect();
    await expect(box.right - change.getBoundingClientRect().right).toBe(16);
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
  parameters: { canvas: 'none', canvasNote: 'Drawn on N-Conn-19b-Ceiling-Edit, which joins the reference boards with its board story.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // The field, named by its default label, with the screen's hint, 360 px wide at most; the row
    // pads 12 px above and 16 px below.
    expectComputed(body(canvasElement), { paddingTop: '12px', paddingBottom: '16px' });
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
  parameters: { canvas: 'none', canvasNote: "Drawn on N-Conn-19b-Ceiling-Edit, which joins the reference boards with its board story. The screen's check of an amount above the per-payment limit; the board draws the field without an error." },
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
  parameters: { canvasNote: 'A Desk with no payment limit set, so every payment asks; the board draws Rivera at $500.' },
  play: async ({ canvas, canvasElement }) => {
    // unset_limit_never_says_zero: no limit reads as what it means, never as an amount of nothing.
    await expect(canvas.getByText(unset)).toBeVisible();
    await expect(row(canvasElement)).not.toHaveTextContent('$0');
    await expect(row(canvasElement).textContent ?? '').not.toMatch(/\b0\b/);
  },
};

export const Waiting: Story = {
  args: { editing: true, value: '1000', disabled: true },
  parameters: { canvas: 'none', canvasNote: 'Drawn on N-Conn-19b-Ceiling-Edit, which joins the reference boards with its board story. A draft in flight; the board draws the field at rest.' },
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
  parameters: { canvas: 'none', canvasNote: 'Drawn on N-Conn-22-Phone-Presets, which joins the reference boards with its board story.' },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(390);
    // On a phone the row pads 12 px 14 px, and "Change" sits 10 px under the limit, at its left.
    expectComputed(body(canvasElement), { paddingTop: '12px', paddingLeft: '14px' });
    const words = canvas.getByText(line);
    const change = canvas.getByRole('button', { name: 'Change' });
    await expect(change.getBoundingClientRect().top - words.getBoundingClientRect().bottom).toBe(10);
    await expect(change.getBoundingClientRect().left).toBe(words.getBoundingClientRect().left);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
