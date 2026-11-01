import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { SwitcherMenu, type SwitcherBusiness } from '../components/SwitcherMenu/SwitcherMenu.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { EMERGENCIES, MAIN_LINE, TodayNeedsYou } from './parts.tsx';
import { expectOwnerFrame, expectTabOrder } from './spec.ts';

/** Mike's businesses: Turner Plumbing with its two Desks, and his own, with one. */
const BUSINESSES: SwitcherBusiness[] = [
  { id: 'biz-rivera', name: rivera.business.name, desks: [MAIN_LINE, EMERGENCIES] },
  { id: 'biz-maria', name: rivera.business.ownerName, desks: [{ id: 'desk-maria-main', name: 'Main line' }] },
];
const OPENER = `Switch business, current: ${rivera.business.name}`;

/** Today with the business switcher open beside the sidebar's business row. */
function Switcher() {
  const [open, setOpen] = useState(true);
  return (
    <div className="board-switcher">
      <TodayNeedsYou twoDesks onSwitchBusiness={() => setOpen(true)} />
      {open ? (
        <div className="board-switcher__menu">
          <SwitcherMenu businesses={BUSINESSES} currentBusinessId="biz-rivera" onPick={fn()} onNewBusiness={fn()} onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

const meta = {
  title: 'Boards/Switcher',
  render: () => <Switcher />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Switcher-Run1',
    canvasNote: [
      'Signed at sign-off: the menu lists businesses only, the current one checked, and “New business” last; the board’s Desks under the current business and its Desk rows are in the sidebar’s Desk picker.',
      'Behind the menu is the signed Today (N-Today-Run1) with both of Turner’s Desks, where the board shows Today from before that sign-off, with “This week”. Where the web app (plan 04) anchors the menu is its own; here it opens beside the business row.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expectOwnerFrame(canvasElement, 'Today');
    const sidebar = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(within(sidebar).getByRole('button', { name: `Switch Desk, current: ${MAIN_LINE.name}` })).toBeVisible();

    // Businesses only, the current one checked, then New business; no Desks in the menu.
    const menu = canvas.getByRole('menu', { name: 'Switch business' });
    expectComputed(menu, { backgroundColor: 'rgb(42, 41, 39)', borderTopLeftRadius: '12px' });
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
    await expect(items).toEqual([
      within(menu).getByRole('menuitemradio', { name: 'Turner Plumbing 2 Desks' }),
      within(menu).getByRole('menuitemradio', { name: 'Mike Turner 1 Desk' }),
      within(menu).getByRole('menuitem', { name: 'New business' }),
    ]);
    await expect(items[0]).toHaveAttribute('aria-checked', 'true');
    await expect(within(menu).queryByText(EMERGENCIES.name)).toBeNull();
    await expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(sidebar.getBoundingClientRect().right);

    // focus_order_is_logical: focus starts on the current business, the arrows walk the menu,
    // Escape closes it; then Tab runs the bar, the business row, the Desk picker and the pages.
    await expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(items[2]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('menu')).toBeNull());
    const opener = within(sidebar).getByRole('button', { name: OPENER });
    await expectTabOrder(userEvent, [
      canvas.getByRole('button', { name: 'Start over' }),
      opener,
      within(sidebar).getByRole('button', { name: `Switch Desk, current: ${MAIN_LINE.name}` }),
      ...within(within(sidebar).getByRole('navigation', { name: 'Main' })).getAllByRole('link'),
    ]);

    // The business row opens it again, on the current business, as the board shows it.
    await userEvent.click(opener);
    await expect(within(canvas.getByRole('menu', { name: 'Switch business' })).getByRole('menuitemradio', { name: 'Turner Plumbing 2 Desks' })).toHaveFocus();
  },
};
