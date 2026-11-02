import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import { chen, rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Sidebar, type SidebarHrefs } from '../Sidebar/Sidebar.tsx';
import { SwitcherMenu, type SwitcherBusiness, type SwitcherMenuProps } from './SwitcherMenu.tsx';

const MAIN_LINE = { id: 'desk-rivera-main', name: rivera.business.deskName };
const EMERGENCIES = { id: 'desk-rivera-emergencies', name: 'Emergencies' };
const CHEN_MAIN = { id: 'desk-chen-main', name: chen.business.deskName };

const businesses = [
  { id: 'biz-rivera', name: rivera.business.name, desks: [MAIN_LINE, EMERGENCIES] },
  { id: 'biz-chen', name: chen.business.name, desks: [CHEN_MAIN] },
] satisfies SwitcherBusiness[];

// The switcher board draws the sidebar's seven pages, from before Connectors: no Connectors href.
const hrefs = {
  today: '#today',
  conversations: '#conversations',
  people: '#customers',
  knowledge: '#knowledge',
  rules: '#rules',
  safety: '#safety',
  share: '#share',
  settings: '#settings',
} satisfies SidebarHrefs;

const OPENER = `Switch business, current: ${rivera.business.name}`;

/**
 * The switcher as the owner layout opens it: the sidebar's business row opens it beside the row,
 * and every way of closing it ends in `onClose`. It starts open, so the story shows the menu.
 */
function OwnerLayout(props: SwitcherMenuProps) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ position: 'relative', display: 'flex', minHeight: 820 }}>
      <div style={{ display: 'flex', width: 'var(--size-sidebar)', background: 'var(--bg-panel)', borderRight: '1px solid var(--line-hairline)' }}>
        <Sidebar
          business={rivera.business.name}
          onSwitchBusiness={() => setOpen(true)}
          desks={[MAIN_LINE, EMERGENCIES]}
          currentDeskId={MAIN_LINE.id}
          onSwitchDesk={fn()}
          current="today"
          hrefs={hrefs}
          peopleLabel="Customers"
          answering
          onAnsweringChange={fn()}
          owner={{ name: rivera.business.ownerName, status: 'Available for chats' }}
        />
      </div>
      {open ? (
        <div style={{ position: 'absolute', top: 64, left: 256 }}>
          <SwitcherMenu
            {...props}
            onClose={() => {
              props.onClose();
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

const meta = {
  title: 'Navigation/SwitcherMenu',
  component: SwitcherMenu,
  args: {
    businesses,
    currentBusinessId: 'biz-rivera',
    onPick: fn(),
    onNewBusiness: fn(),
    onClose: fn(),
  },
  render: (args) => <OwnerLayout {...args} />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Switcher-Run1',
    canvasNote:
      "The board's two columns become one menu of businesses, with New business last. The current business's Desks, New Desk and the Desks' status dots and captions aren't in it: the sidebar's Desk picker has the Desks. It has no shadow, which the brand book keeps for the composer.",
  },
} satisfies Meta<typeof SwitcherMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RiveraTwoDesks: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const menu = canvas.getByRole('menu', { name: 'Switch business' });
    expectComputed(menu, {
      backgroundColor: 'rgb(42, 41, 39)',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      boxShadow: 'none',
    });

    // The businesses, then New business last. No Desks: the sidebar's Desk picker has those.
    const riveraRow = within(menu).getByRole('menuitemradio', { name: 'Turner Plumbing 2 Desks' });
    const chenRow = within(menu).getByRole('menuitemradio', { name: 'Chen & Co. CPA 1 Desk' });
    const newBusiness = within(menu).getByRole('menuitem', { name: 'New business' });
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
    await expect(items).toEqual([riveraRow, chenRow, newBusiness]);
    await expect(within(menu).queryByRole('group')).toBeNull();
    await expect(within(menu).queryByText(MAIN_LINE.name)).toBeNull();
    await expect(within(menu).queryByText(EMERGENCIES.name)).toBeNull();

    // new_business_is_last
    const last = items[items.length - 1] as HTMLElement;
    await expect(last).toBe(newBusiness);
    await expect(last).not.toHaveAttribute('aria-checked');

    // The current business is checked.
    await expect(riveraRow).toHaveAttribute('aria-checked', 'true');
    await expect(chenRow).toHaveAttribute('aria-checked', 'false');

    // menu_arrows_and_escape: focus starts on the current business, the arrows move through every
    // item and wrap, Home and End jump, and only the focused item is in the tab order.
    await expect(riveraRow).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(chenRow).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(last).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(riveraRow).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(last).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(riveraRow).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(last).toHaveFocus();
    await expect(items.filter((item) => item.tabIndex === 0)).toEqual([last]);

    // Escape closes it.
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole('menu')).toBeNull();

    // Opened from the business row, Escape returns focus to the row.
    const opener = canvas.getByRole('button', { name: OPENER });
    await userEvent.click(opener);
    await expect(within(canvas.getByRole('menu')).getByRole('menuitemradio', { name: 'Turner Plumbing 2 Desks' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{Escape}');
    await expect(args.onClose).toHaveBeenCalledTimes(2);
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(opener).toHaveFocus();
    await expect(args.onPick).not.toHaveBeenCalled();

    // Another business opens at its first Desk. Picking it reports it, closes the menu and returns
    // focus to the row.
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await expect(args.onPick).toHaveBeenLastCalledWith({ businessId: 'biz-chen', deskId: CHEN_MAIN.id });
    await expect(args.onClose).toHaveBeenCalledTimes(3);
    await expect(opener).toHaveFocus();

    // A click picks it too.
    await userEvent.keyboard('{Enter}');
    await userEvent.click(within(canvas.getByRole('menu')).getByRole('menuitemradio', { name: 'Chen & Co. CPA 1 Desk' }));
    await expect(args.onPick).toHaveBeenCalledTimes(2);
    await expect(args.onPick).toHaveBeenLastCalledWith({ businessId: 'biz-chen', deskId: CHEN_MAIN.id });

    // The current business changes nothing: the menu only closes.
    await userEvent.click(opener);
    await userEvent.keyboard('{Enter}');
    await expect(args.onPick).toHaveBeenCalledTimes(2);
    await expect(canvas.queryByRole('menu')).toBeNull();

    // New business, from the keyboard.
    await userEvent.click(opener);
    await userEvent.keyboard('{End}{Enter}');
    await expect(args.onNewBusiness).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole('menu')).toBeNull();

    // A click outside closes it, as does Tab.
    await userEvent.click(opener);
    await userEvent.click(canvas.getByText(rivera.business.ownerName));
    await expect(canvas.queryByRole('menu')).toBeNull();
    await userEvent.click(opener);
    await userEvent.tab();
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(args.onClose).toHaveBeenCalledTimes(8);
    await expect(args.onPick).toHaveBeenCalledTimes(2);
  },
};
