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
  parameters: { canvasNote: 'The endpoint under “Connect your own agent”: the address in mono with “Copy address” at the right of its line.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const value = canvasElement.querySelector<HTMLElement>('code')!;
    await expect(value.textContent).toBe(ENDPOINT);
    await expect(value).toHaveAttribute('data-copy', 'code');
    // A page translator leaves it alone, as it does the full trace.
    await expect(value).toHaveAttribute('translate', 'no');
    expectComputed(value, { fontFamily: /^"JetBrains Mono"/, fontSize: '13px', lineHeight: '20px', paddingLeft: '12px', backgroundColor: 'rgba(0, 0, 0, 0)' });
    // The button at the right of the line, a screen's main size, centered on the address.
    const button = canvas.getByRole('button', { name: 'Copy address' });
    expectComputed(button, { height: '40px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    const row = button.parentElement!.getBoundingClientRect();
    await expect(Math.round(button.getBoundingClientRect().right)).toBe(Math.round(row.right));
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
  parameters: { canvas: 'none', canvasNote: 'No board draws a failed copy; it keeps N-R2-Agents-02-Demo-Key’s field and says what to do under it.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Copy key' }));
    await expect(args.onCopy).toHaveBeenCalledOnce();
    // copy_failure_selects_the_text: the key is selected, ready to copy by hand, and a line says so.
    const value = canvasElement.querySelector<HTMLElement>('code')!;
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(KEY));
    await expect(window.getSelection()?.containsNode(value, true)).toBe(true);
    await expect(canvas.getByRole('status')).toHaveTextContent(/^Couldn’t copy\. The text is selected, so you can copy it yourself\.$/);
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
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-06-Phone: the address takes its own line and “Copy address” goes under it.' },
  play: async ({ canvas, canvasElement }) => {
    const value = canvasElement.querySelector<HTMLElement>('code')!;
    const button = canvas.getByRole('button', { name: 'Copy address' });
    await expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(value.getBoundingClientRect().bottom);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
