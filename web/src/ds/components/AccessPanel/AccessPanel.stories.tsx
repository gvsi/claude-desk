import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { AccessPanel } from './AccessPanel.tsx';

const meta = {
  title: 'Vision/AccessPanel',
  component: AccessPanel,
  args: {
    name: 'Luis',
    canOpen: ['Job cards', 'Customer history', 'Warranties', 'Photos'],
    cantOpen: ['Invoices', 'Payroll'],
    onEditAccess: fn(),
  },
  // As the team Desk's board draws it: a 260 px column beside the conversation.
  render: (args) => (
    <div style={{ width: 260 }}>
      <AccessPanel {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Vision-TeamDesk' },
} satisfies Meta<typeof AccessPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Teammate: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // access_panel_lists_what_they_can_and_cant_open: a card named for the teammate's access.
    const panel = canvas.getByRole('region', { name: 'Luis’s access' });
    expectComputed(panel, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      paddingTop: '16px',
      paddingLeft: '16px',
    });

    // Two lists, each named by its heading line: what Luis can open, then what he can't.
    const can = canvas.getByRole('list', { name: 'Luis can open' });
    const cant = canvas.getByRole('list', { name: 'Can’t open' });
    await expect(within(can).getAllByRole('listitem').map((item) => item.textContent)).toEqual(args.canOpen);
    await expect(within(cant).getAllByRole('listitem').map((item) => item.textContent)).toEqual(args.cantOpen);
    await expectListsKeepTheirRole(canvasElement);
    // The name is the owner's own words, set off as user text, first in its line.
    const name = canvas.getByText('Luis');
    await expect(name).toHaveAttribute('data-copy', 'user');
    await expect(name.parentElement?.firstChild).toBe(name);

    // The headings in control type; "Can’t open" 16 px under the chips above it.
    const canHeading = canvas.getByText(/can open$/);
    const cantHeading = canvas.getByText('Can’t open');
    for (const heading of [canHeading, cantHeading]) {
      expectComputed(heading, { fontSize: '16px', lineHeight: '22px', fontWeight: '420', color: 'rgba(250, 249, 245, 0.92)' });
    }
    await expect(Math.round(cantHeading.getBoundingClientRect().top - can.getBoundingClientRect().bottom)).toBe(16);

    // Each chip: 28 px tall in a thin outline, fully rounded, in meta; never a control.
    for (const chip of [...within(can).getAllByRole('listitem'), ...within(cant).getAllByRole('listitem')]) {
      expectComputed(chip, {
        height: '28px',
        paddingLeft: '10px',
        paddingRight: '10px',
        borderTopWidth: '1px',
        borderTopColor: 'rgba(250, 249, 245, 0.22)',
        borderTopLeftRadius: '999px',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        fontSize: '14px',
        color: 'rgba(250, 249, 245, 0.92)',
      });
    }
    // Chips wrap 6 px apart: the first two of "can open" share a line.
    const [first, second] = within(can).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    await expect(Math.round(second.getBoundingClientRect().left - first.getBoundingClientRect().right)).toBe(6);

    // One control: "Edit access", a secondary button, under the lists.
    const edit = canvas.getByRole('button', { name: 'Edit access' });
    await expect(canvas.getAllByRole('button')).toHaveLength(1);
    expectComputed(edit, { height: '32px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    await userEvent.tab();
    await expect(edit).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onEditAccess).toHaveBeenCalledTimes(1);
  },
};

/** Nothing held back: "Can’t open" says so in words, not with an empty row. */
export const OpensEverything: Story = {
  args: { name: 'Grace', canOpen: ['Job cards', 'Customer history', 'Warranties', 'Photos', 'Invoices', 'Payroll'], cantOpen: [] },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-R2-Vision-TeamDesk draws Luis, who can’t open two things; an office manager who can open everything says so under “Can’t open”.',
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('region', { name: 'Grace’s access' })).toBeVisible();
    await expect(canvas.queryByRole('list', { name: 'Can’t open' })).toBeNull();
    await expect(canvas.getByText('Nothing on this Desk.')).toBeVisible();
  },
};
