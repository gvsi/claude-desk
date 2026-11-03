import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import { chen, rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { Button } from '../Button/Button.tsx';
import { ConnectorPicker, type ConnectorPickerProps } from './ConnectorPicker.tsx';

const MOCK_LINE = 'Mock connectors stand in for the real apps. No account is used and nothing is sent to them.';

/** The list item of the connector named `name`, found by its name rather than its button's words. */
function itemOf(list: HTMLElement, name: string): HTMLElement {
  const item = within(list).getByText(name, { selector: '.cd-connector-name__name' }).closest('li');
  if (!(item instanceof HTMLElement)) throw new Error(`No item for ${name}`);
  return item;
}

/** The Rules page's "Add a connector" opens the picker; it starts open, so the story shows it. */
function RulesPage(props: ConnectorPickerProps) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ padding: 'var(--space-24) var(--space-40)' }}>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Add a connector
      </Button>
      {open ? (
        <ConnectorPicker
          {...props}
          onClose={() => {
            props.onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

const meta = {
  title: 'Connectors/ConnectorPicker',
  component: ConnectorPicker,
  args: { ...chen.picker, onChoose: fn(), onClose: fn() },
  render: (args) => <RulesPage {...args} />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Conn-07b-Add-Picker-ComingSoon',
    canvasNote:
      'Verification is never listed, since it is always added, and Quotes and Leads and callbacks read Added, as on Chen\'s hub. A "Close" button the board doesn\'t draw lets the dialog close by pointer as well as by Escape, and the mock line also shows under the coming-soon note.',
  },
} satisfies Meta<typeof ConnectorPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ChenComingSoon: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    // picker_by_keyboard: a modal dialog named by its serif title, with focus on Payments' "Add".
    const dialog = canvas.getByRole('dialog', { name: 'Add a connector' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    expectComputed(within(dialog).getByRole('heading', { name: 'Add a connector' }), { fontFamily: '"Source Serif 4", Georgia, serif', fontSize: '26px' });
    expectComputed(dialog, { backgroundColor: 'rgb(42, 41, 39)', borderTopLeftRadius: '12px' });
    await expect(getComputedStyle(dialog).boxShadow).not.toBe('none');
    await expect(getComputedStyle(dialog, '::backdrop').backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
    const add = within(dialog).getByRole('button', { name: 'Add Payments' });
    await expect(add).toHaveFocus();
    await expect(add.closest('li')).toHaveTextContent('Payments');
    await expect(
      within(dialog).getByText(
        'Add what fits Chen & Co. CPA. Each tool you add starts at Ask me first unless one of your rules already covers it, and you review them before anything turns on.',
      ),
    ).toBeVisible();

    // picker_states_in_words: two lists, each item's state in words.
    const builtIn = within(dialog).getByRole('list', { name: 'Claude Desk' });
    const external = within(dialog).getByRole('list', { name: 'Other apps' });
    await expect(within(builtIn).queryByText('Verification', { selector: '.cd-connector-name__name' })).toBeNull();
    await expect(within(dialog).queryByText('Verification')).toBeNull();
    for (const name of ['Quotes', 'Bookings', 'Leads and callbacks', 'Documents']) {
      const item = itemOf(builtIn, name);
      await expect(within(item).getByText('Added')).toBeVisible();
      await expect(within(item).queryByRole('button')).toBeNull();
    }
    const calendar = itemOf(external, 'Google Calendar');
    await expect(within(calendar).getByText('Coming soon in this demo')).toBeVisible();
    await expect(within(calendar).queryByRole('button')).toBeNull();
    const stripe = itemOf(external, 'Stripe');
    await expect(within(stripe).getByRole('button', { name: 'Connect Stripe' })).toBeVisible();
    await expect(expectMockBesideExternalNames(dialog)).toBe(2);
    await expect(within(dialog).getByText(chen.picker.note)).toBeVisible();
    await expect(within(dialog).getByText(MOCK_LINE)).toBeVisible();

    // Tab stays inside: Add (Payments), Connect (Stripe), Close, then back to Add.
    await userEvent.tab();
    await expect(within(stripe).getByRole('button', { name: 'Connect Stripe' })).toHaveFocus();
    await userEvent.tab();
    await expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab();
    await expect(add).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab();

    // Enter chooses Payments once.
    await userEvent.keyboard('{Enter}');
    await expect(args.onChoose).toHaveBeenCalledTimes(1);
    await expect(args.onChoose).toHaveBeenCalledWith('payments');
    await expect(args.onClose).not.toHaveBeenCalled();

    // Escape closes it, and focus goes back to what opened it.
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole('dialog')).toBeNull();
    const opener = canvas.getByRole('button', { name: 'Add a connector' });
    await userEvent.click(opener);
    // The Close button closes it too.
    await userEvent.click(within(canvas.getByRole('dialog', { name: 'Add a connector' })).getByRole('button', { name: 'Close' }));
    await expect(args.onClose).toHaveBeenCalledTimes(2);
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(opener).toHaveFocus();
    await expect(canvasElement.ownerDocument.activeElement).toBe(opener);
  },
};

export const RiveraConnectable: Story = {
  args: { ...rivera.googleCalendar.picker, note: undefined },
  parameters: {
    canvas: 'N-Conn-07-Add-Picker',
    canvasNote:
      "Turner Plumbing's picker, where the board draws Chen & Co. CPA's: every built-in connector is added and Stripe is connected, so Google Calendar is the one to connect. Verification is never listed, and a Close button the board doesn't draw closes it by pointer.",
  },
  play: async ({ args, canvas }) => {
    const dialog = canvas.getByRole('dialog', { name: 'Add a connector' });
    const external = within(dialog).getByRole('list', { name: 'Other apps' });
    const calendar = itemOf(external, 'Google Calendar');
    const connect = within(calendar).getByRole('button', { name: 'Connect Google Calendar' });
    // With nothing built in left to add, focus starts on the first button there is.
    await expect(connect).toHaveFocus();
    const stripe = itemOf(external, 'Stripe');
    await expect(within(stripe).getByText('Connected')).toBeVisible();
    await expect(within(dialog).getAllByText('Added')).toHaveLength(5);
    await expect(within(dialog).getByText(MOCK_LINE)).toBeVisible();
    await expect(within(dialog).queryByText(/coming soon/i)).toBeNull();
    connect.click();
    await expect(args.onChoose).toHaveBeenCalledWith('google_calendar');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: 'The picker on a phone; no board draws it. Each state stays at the right of its connector, and the dialog scrolls inside itself.' },
  play: async ({ canvas }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const dialog = canvas.getByRole('dialog', { name: 'Add a connector' });
    const box = dialog.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(16);
    await expect(box.right).toBeLessThanOrEqual(width - 16);
    const tooWide = [...dialog.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right);
    await expect(tooWide).toEqual([]);
  },
};
