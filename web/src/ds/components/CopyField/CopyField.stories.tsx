import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { CopyField } from './CopyField.tsx';

const ENDPOINT = 'https://desk.example/api/a2a/rivera';
const KEY = '0000000000000000000000000000000000000000000000000000000000000000';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

const meta = {
  title: 'Agents/CopyField',
  component: CopyField,
  args: { value: ENDPOINT, copyLabel: 'Copy address', layout: 'inline', language: 'en', onCopy: fn(async () => {}) },
  render: (args) => (
    <div style={{ maxWidth: 726 }}>
      <CopyField {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Agents-01-Page' },
} satisfies Meta<typeof CopyField>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Address: Story = {
  parameters: { canvasNote: 'The endpoint under “Connect your own agent”: the address in mono in its outlined box, with “Copy address” at the right of its line.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const value = canvasElement.querySelector<HTMLElement>('code')!;
    await expect(value.textContent).toBe(ENDPOINT);
    await expect(value).toHaveAttribute('data-copy', 'code');
    // A page translator leaves it alone, as it does the full trace.
    await expect(value).toHaveAttribute('translate', 'no');
    // inline_value_is_outlined: the address in a box as every signed board with one draws it (the
    // agents page, its phone board and the setup's live link): a 1 px line-field outline at the
    // control radius, no fill, a control's 32 px tall, the words 12 px in.
    expectComputed(value, {
      fontFamily: /^"JetBrains Mono"/,
      fontSize: '13px',
      lineHeight: '20px',
      paddingLeft: '12px',
      paddingRight: '12px',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth: '1px',
      borderTopStyle: 'solid',
      borderTopColor: 'rgba(250, 249, 245, 0.36)',
      borderTopLeftRadius: '8px',
    });
    await expect(value.getBoundingClientRect().height).toBe(32);
    // The button 8 px after the box, at the right of the line, a screen's main size, centered on the address.
    const button = canvas.getByRole('button', { name: 'Copy address' });
    expectComputed(button, { height: '40px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    const row = button.parentElement!.getBoundingClientRect();
    await expect(Math.round(button.getBoundingClientRect().right)).toBe(Math.round(row.right));
    await expect(Math.round(button.getBoundingClientRect().left - value.getBoundingClientRect().right)).toBe(8);
    const mid = (box: DOMRect) => Math.round(box.top + box.height / 2);
    await expect(mid(value.getBoundingClientRect())).toBe(mid(button.getBoundingClientRect()));

    // copy_goes_through_the_callback: the field never touches the clipboard itself.
    await userEvent.click(button);
    await expect(args.onCopy).toHaveBeenCalledOnce();
    await expect(args.onCopy).toHaveBeenCalledWith(ENDPOINT);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent(/^Copied\.$/));
  },
};

export const Key: Story = {
  args: {
    label: 'Private key',
    value: KEY,
    copyLabel: 'Copy key',
    note: 'Shown once. It’s a demo key for this Desk, not a business credential.',
    layout: 'block',
  },
  parameters: {
    canvas: 'N-R2-Agents-02-Demo-Key',
    canvasNote: 'The demo key, shown once: its label, the key in a mono box, then “Copy key” with the warning beside it.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const field = canvas.getByRole('group', { name: 'Private key' });
    const label = within(field).getByText('Private key');
    expectComputed(label, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
    const value = canvasElement.querySelector<HTMLElement>('code')!;
    expectComputed(value, { backgroundColor: 'rgba(250, 249, 245, 0.1)', paddingTop: '12px', paddingLeft: '14px', borderTopLeftRadius: '8px' });
    // The box is 44 px: one 20 px line, 12 px above and below; 6 px under its label.
    await expect(value.getBoundingClientRect().height).toBe(44);
    await expect(Math.round(value.getBoundingClientRect().top - label.getBoundingClientRect().bottom)).toBe(6);
    // The button 10 px under the box, the warning 12 px after it, on its middle.
    const button = canvas.getByRole('button', { name: 'Copy key' });
    await expect(Math.round(button.getBoundingClientRect().top - value.getBoundingClientRect().bottom)).toBe(10);
    const note = within(field).getByText(args.note!);
    expectComputed(note, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
    await expect(Math.round(note.getBoundingClientRect().left - button.getBoundingClientRect().right)).toBe(12);
    await userEvent.click(button);
    await expect(args.onCopy).toHaveBeenCalledOnce();
    await expect(args.onCopy).toHaveBeenCalledWith(KEY);
  },
};

export const CopyFailed: Story = {
  args: {
    label: 'Private key',
    value: KEY,
    copyLabel: 'Copy key',
    note: 'Shown once. It’s a demo key for this Desk, not a business credential.',
    layout: 'block',
    onCopy: fn(async () => {
      throw new Error('The clipboard is blocked');
    }),
  },
  parameters: { canvas: 'none', canvasNote: 'No board draws a failed copy of a key; it keeps N-R2-Agents-02-Demo-Key’s field and says what to do under it, in the words N-R2-Setup-15-Copy-Failed uses for the link, naming the text.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Copy key' }));
    await expect(args.onCopy).toHaveBeenCalledOnce();
    // copy_failure_selects_the_text: the key is selected, ready to copy by hand, and a line says so.
    const value = canvasElement.querySelector<HTMLElement>('code')!;
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(KEY));
    await expect(window.getSelection()?.containsNode(value, true)).toBe(true);
    await expect(canvas.getByRole('status')).toHaveTextContent(/^Copy didn’t work\. The text is selected, so copy it yourself\.$/);
  },
};

export const CopyFailedSpanish: Story = {
  args: {
    value: ENDPOINT,
    copyLabel: 'Copiar dirección',
    layout: 'inline',
    language: 'es',
    onCopy: fn(async () => {
      throw new Error('The clipboard is blocked');
    }),
  },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-01-Page’s address in Spanish, after a failed copy: the address is selected and the line says so in Spanish.' },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Copiar dirección' }));
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(ENDPOINT));
    await expect(canvas.getByRole('status')).toHaveTextContent(/^No se pudo copiar\. El texto está seleccionado para que lo copies tú\.$/);
    await expect(canvasElement.querySelector('[lang="es"]')).not.toBeNull();
  },
};

export const KeyId: Story = {
  args: { label: 'Key id', value: 'demo-7f3a2c', layout: 'block', copyLabel: undefined, onCopy: undefined },
  parameters: { canvas: 'N-R2-Agents-02-Demo-Key', canvasNote: 'The key id over the key: the same box with no button, since the key is what an agent needs.' },
  play: async ({ canvas }) => {
    const field = canvas.getByRole('group', { name: 'Key id' });
    await expect(within(field).queryByRole('button')).toBeNull();
    await expect(within(field).getByText('demo-7f3a2c')).toBeVisible();
  },
};

export const Phone: Story = {
  render: (args) => (
    <div style={{ maxWidth: 326 }}>
      <CopyField {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'N-R2-Agents-06-Phone',
    canvasNote:
      'The address alone, as the board draws it under “Connect your own agent”: it takes its own line and “Copy address” goes under it. Its column is 326 px, 2 px wider than the board’s card is inside; the card and the rest of the board’s 390 × 2000 page aren’t drawn, and the story runs at the 390 × 844 phone window.',
  },
  play: async ({ canvas, canvasElement }) => {
    const value = canvasElement.querySelector<HTMLElement>('code')!;
    const button = canvas.getByRole('button', { name: 'Copy address' });
    // The outlined box across the line, 32 px, and the button 8 px under it at its own width.
    const field = value.parentElement!.getBoundingClientRect();
    await expect([Math.round(value.getBoundingClientRect().width), value.getBoundingClientRect().height]).toEqual([Math.round(field.width), 32]);
    await expect(Math.round(button.getBoundingClientRect().top - value.getBoundingClientRect().bottom)).toBe(8);
    await expect(Math.round(button.getBoundingClientRect().left)).toBe(Math.round(value.getBoundingClientRect().left));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
