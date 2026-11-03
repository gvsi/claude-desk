import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { SIDEBAR_ABOUT } from '../../owner/sidebarAbout.ts';
import { Sidebar } from '../components/Sidebar/Sidebar.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { MAIN_LINE, OWNER_HREFS } from './parts.tsx';
import { SPEC, expectTabOrder, one } from './spec.ts';

/** The documents behind the prototype, the owner reading the first. */
const ABOUT = {
  ...SIDEBAR_ABOUT,
  links: SIDEBAR_ABOUT.links.map((link) => ({ ...link, current: link.id === 'prediction' })),
};

/** The sidebar alone, in the column the AppShell gives it, with the "About this prototype" group. */
function DocsSidebar() {
  return (
    <aside className="board-sidebar-column" aria-label="Claude Desk">
      <Sidebar
        business={rivera.business.name}
        onSwitchBusiness={fn()}
        desks={[MAIN_LINE]}
        currentDeskId={MAIN_LINE.id}
        onSwitchDesk={fn()}
        current="today"
        hrefs={{ ...OWNER_HREFS, connectors: '#connectors' }}
        peopleLabel="Customers"
        counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}
        answering
        onAnsweringChange={fn()}
        owner={{ name: rivera.business.ownerName, status: 'Available for chats' }}
        about={ABOUT}
        conceptFooter
      />
    </aside>
  );
}

const meta = {
  title: 'Boards/Sidebar, about this prototype',
  render: () => <DocsSidebar />,
  // Drawn as the sidebar alone, 264 px wide and a 14-inch laptop's height.
  globals: { viewport: { value: 'sidebar', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Docs-Sidebar',
    canvasNote: [
      'The sidebar with the “About this prototype” group just above the Claude acts for you block, behind its hairline: “Capability prediction” and “Product proposal”, nav rows with the document icon.',
      'The nav includes Connectors after Rules and Knowledge just above Settings; the group and pinned foot keep their layout.',
      'The board marks no row current; here the owner is reading the capability prediction, so its row is the current page, on the selected fill, and the main nav marks none.',
      'The board draws the mark 1 px and every row’s icon 2 px higher than the other signed boards do; the sidebar keeps their placement, so all its icons, the group’s included, sit as on Today and the recorded-history boards.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, userEvent }) => {
    // The board's own window: the sidebar's width, a 14-inch laptop's height.
    await expect([window.innerWidth, window.innerHeight]).toEqual([264, 982]);
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    expectComputed(column, SPEC.sidebar);
    const foot = one(column, '.cd-sidebar__footer');
    await expect(column.getBoundingClientRect().bottom - foot.getBoundingClientRect().bottom, 'the sidebar foot at the bottom').toBe(12);

    // The group: its caption title in secondary ink, behind a hairline, just above the foot.
    const about = canvas.getByRole('navigation', { name: 'About this prototype' });
    const group = about.closest('.cd-sidebar__about') as HTMLElement;
    expectComputed(within(about).getByText('About this prototype'), { fontSize: '12px', lineHeight: '17px', fontWeight: '380', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(group, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)', paddingTop: '14px' });
    const concept = one(column, '.cd-sidebar__concept-footer');
    await expect(Math.round(concept.getBoundingClientRect().top - group.getBoundingClientRect().bottom)).toBe(4);
    await expect(Math.round(foot.getBoundingClientRect().top - concept.getBoundingClientRect().bottom)).toBe(4);

    // Its rows: nav rows like the main ones, the document icon, the open document current.
    const links = within(about).getAllByRole('link');
    await expect(links.map((link) => link.textContent)).toEqual(['Capability prediction', 'Product proposal', 'Vision', 'GitHub']);
    const { height, borderTopLeftRadius, fontSize, lineHeight, fontWeight } = SPEC.activeNavRow;
    const row = { height, borderTopLeftRadius, fontSize, lineHeight, fontWeight };
    for (const link of links) {
      expectComputed(link, row);
      await expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    await expect(links[0]).toHaveAttribute('aria-current', 'page');
    expectComputed(links[0] as HTMLElement, SPEC.activeNavRow);
    await expect(links[1]).not.toHaveAttribute('aria-current');
    const nav = within(column).getByRole('navigation', { name: 'Main' });
    await expect(within(nav).queryAllByRole('link', { current: 'page' })).toEqual([]);

    // Connectors is fourth, after Rules, and Knowledge sits just above Settings.
    const pages = within(nav).getAllByRole('link');
    await expect(pages.map((page) => page.querySelector('.cd-sidebar__label')?.textContent)).toEqual([
      'Today',
      'Conversations',
      'Rules',
      'Connectors',
      'Safety',
      'Customers',
      'Profile',
      'Share',
      'Knowledge',
      'Settings',
    ]);
    const connectors = pages[3] as HTMLElement;
    await expect(Math.round(connectors.getBoundingClientRect().top - column.getBoundingClientRect().top)).toBe(232);

    // focus_order_is_logical: the business, the main nav, the about links, then Claude acts for you.
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(nav).getAllByRole('link'),
      ...links,
      within(column).getByRole('link', { name: 'Giovanni Alcantara' }),
      within(column).getByRole('switch', { name: 'Claude acts for you' }),
    ]);
  },
};
