import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ApprovalCard } from '../ApprovalCard/ApprovalCard.tsx';
import { Greeting } from '../Greeting/Greeting.tsx';
import { ReviewerBar } from '../ReviewerBar/ReviewerBar.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';
import { Sidebar, type NavKey, type SidebarLinkProps } from '../Sidebar/Sidebar.tsx';
import { AppShell } from './AppShell.tsx';

const navigate = fn();

/** A router's link, as the app passes one: it reports the move instead of leaving the page. */
function RouterLink({ children, href, ...props }: SidebarLinkProps) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

const hrefs = {
  today: '/app/desk-rivera-main/today',
  conversations: '/app/desk-rivera-main/conversations',
  people: '/app/desk-rivera-main/people',
  rules: '/app/desk-rivera-main/rules',
  safety: '/app/desk-rivera-main/safety',
  share: '/app/desk-rivera-main/share',
  settings: '/app/desk-rivera-main/settings',
} satisfies Record<NavKey, string>;

const sidebar = (
  <Sidebar
    business={rivera.business.name}
    onSwitchBusiness={fn()}
    desks={[
      { id: 'desk-rivera-main', name: rivera.business.deskName },
      { id: 'desk-rivera-emergencies', name: 'Emergencies' },
    ]}
    currentDeskId="desk-rivera-main"
    onSwitchDesk={fn()}
    current="today"
    hrefs={hrefs}
    peopleLabel="Customers"
    counts={{ conversations: { n: 1, label: '1 needs you' }, safety: { n: 2, label: '2 blocked' } }}
    answering
    onAnsweringChange={fn()}
    owner={{ name: rivera.business.ownerName, status: 'Available for chats' }}
    linkComponent={RouterLink}
  />
);

const today = (
  <>
    <Greeting
      text="Good morning, Maria"
      presence={{ line: 'One person is talking to your Desk right now.', people: [{ kind: 'person' }] }}
      link={{ label: `desk.example/d/${rivera.business.slug}`, onCopy: fn() }}
    />
    <div style={{ marginTop: 'var(--space-28)', display: 'grid', gap: 'var(--space-12)' }}>
      <SectionHeader title="Needs you" count={{ n: 1, label: '1 thing needs you' }} />
      <div style={{ maxWidth: 'var(--size-reading)' }}>
        <ApprovalCard
          decision={rivera.decisions.held}
          heldBy={rivera.ruleCards['rv-quote'].reason}
          waiting="Web chat, 2 min ago"
          onAnswer={fn()}
        />
      </div>
    </div>
  </>
);

const meta = {
  title: 'Layout/AppShell',
  component: AppShell,
  args: {
    business: rivera.business.name,
    sidebar,
    banner: <ReviewerBar ownerName={rivera.business.ownerName} onStartOver={fn()} />,
    children: today,
  },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Today-Run1',
    canvasNote:
      "The board's Today also holds the things to try, the last 7 days and the public page panel, which the Today board story composes; here the shell holds the greeting and one held request, under the reviewer bar.",
  },
} satisfies Meta<typeof AppShell>;

export default meta;

type Story = StoryObj<typeof meta>;

export const OwnerToday: Story = {
  play: async ({ canvas, canvasElement }) => {
    const viewport = document.documentElement.clientWidth;

    // The reviewer bar runs the full width above the sidebar and the page.
    const banner = canvas.getByRole('note');
    await expect(banner.getBoundingClientRect().width).toBe(viewport);

    // The sidebar column: 264 px on the panel, with a hairline seam, under the banner.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    expectComputed(column, {
      width: '264px',
      backgroundColor: 'rgb(34, 34, 32)',
      borderRightWidth: '1px',
      borderRightColor: 'rgba(250, 249, 245, 0.12)',
    });
    await expect(column.getBoundingClientRect().top).toBe(banner.getBoundingClientRect().bottom);
    await expect(within(column).getByRole('navigation', { name: 'Main' })).toBeVisible();
    // It runs to the bottom of the window, so the Answering switch sits at the foot.
    await expect(column.getBoundingClientRect().bottom).toBe(window.innerHeight);

    // The page: padded 24/40/20, its content at most 960 px wide and centered in what's left.
    const main = canvas.getByRole('main');
    expectComputed(main, { paddingTop: '24px', paddingRight: '40px', paddingBottom: '20px', paddingLeft: '40px' });
    const content = main.firstElementChild as HTMLElement;
    expectComputed(content, { maxWidth: '960px' });
    const mainBox = main.getBoundingClientRect();
    const contentBox = content.getBoundingClientRect();
    await expect(contentBox.width).toBe(Math.min(960, mainBox.width - 80));
    await expect(Math.abs(contentBox.left - mainBox.left - (mainBox.right - contentBox.right))).toBeLessThanOrEqual(1);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Good morning, Maria' })).toBeVisible();

    // At this width there is no top bar and no menu.
    await expect(canvas.queryByRole('button', { name: 'Menu' })).toBeNull();
    await expect(canvasElement.querySelector('dialog')).toBeNull();
  },
};

/** A page that lays out its own columns, as the conversations page does: a list, then the conversation. */
const columns = (
  <div style={{ display: 'flex' }}>
    <nav aria-label="Conversations" style={{ width: 260, flex: 'none', borderRight: '1px solid var(--line-hairline)' }}>
      <h1 className="cd-type-page-title" style={{ margin: 'var(--space-24) var(--space-20) 0' }}>
        Conversations
      </h1>
    </nav>
    <section aria-label="Conversation with Dana Whitfield" style={{ flex: 1, minWidth: 0 }} />
  </div>
);

export const FillsTheMain: Story = {
  args: { banner: undefined, fill: true, children: columns },
  parameters: {
    canvas: 'N-Conv-Run1',
    canvasNote: 'Only the page’s frame: the board’s conversation list starts where the sidebar ends and runs the window’s height, with the conversation beside it.',
  },
  play: async ({ canvas }) => {
    // The signed conversation boards draw the sidebar on the app ground with no seam, at its own
    // height: its Answering switch and owner sit under the pages, not at the window's foot.
    const sidebarColumn = canvas.getByRole('complementary', { name: 'Claude Desk' });
    expectComputed(sidebarColumn, { backgroundColor: 'rgb(28, 27, 25)', borderRightWidth: '0px' });
    const nav = within(sidebarColumn).getByRole('navigation', { name: 'Main' });
    const foot = sidebarColumn.querySelector('.cd-sidebar__footer') as HTMLElement;
    await expect(foot.getBoundingClientRect().top - nav.getBoundingClientRect().bottom).toBe(4);

    // The page fills the main area edge to edge: no padding and no content width, so its first
    // column starts at the sidebar's seam and runs the height of the window.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    const main = canvas.getByRole('main');
    expectComputed(main, { paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' });
    const content = main.firstElementChild as HTMLElement;
    expectComputed(content, { maxWidth: 'none' });
    await expect(content.getBoundingClientRect().width).toBe(main.clientWidth);
    await expect(content.getBoundingClientRect().height).toBe(main.clientHeight);
    const list = canvas.getByRole('navigation', { name: 'Conversations' });
    await expect(list.getBoundingClientRect().left).toBe(column.getBoundingClientRect().right);
    await expect(list.getBoundingClientRect().height).toBe(window.innerHeight);
  },
};

export const Compact: Story = {
  args: { layout: 'compact' },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board shows the owner app on a phone; the top bar holds the mark, the business and Menu, and Menu opens the sidebar of N-Today-Run1 as a sheet.',
  },
  play: async ({ canvas, userEvent }) => {
    // A top bar instead of the column: the mark, the business and Menu.
    await expect(canvas.queryByRole('navigation', { name: 'Main' })).toBeNull();
    const menu = canvas.getByRole('button', { name: 'Menu' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    const bar = menu.closest('.cd-app-shell__topbar') as HTMLElement;
    await expect(within(bar).getByText(rivera.business.name)).toBeVisible();
    await expect(bar.querySelector('.cd-mark')).not.toBeNull();
    await expect(canvas.getByRole('main')).toBeVisible();

    // compact_menu_returns_focus: Menu opens the sidebar as a sheet with focus inside it, and
    // Escape closes it and puts focus back on Menu.
    await userEvent.click(menu);
    const sheet = canvas.getByRole('dialog', { name: 'Menu' });
    await expect(sheet).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(within(sheet).getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(sheet.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    await expect(menu).toHaveFocus();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');

    // Close menu does the same.
    await userEvent.keyboard('{Enter}');
    await userEvent.click(within(canvas.getByRole('dialog', { name: 'Menu' })).getByRole('button', { name: 'Close menu' }));
    await expect(canvas.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    await expect(menu).toHaveFocus();

    // Escape inside the Desk list closes only the list; the sheet stays open.
    await userEvent.click(menu);
    const reopened = canvas.getByRole('dialog', { name: 'Menu' });
    const picker = within(reopened).getByRole('button', { name: 'Switch Desk, current: Main line' });
    await userEvent.click(picker);
    await userEvent.keyboard('{Escape}');
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await expect(picker).toHaveFocus();
    await expect(canvas.getByRole('dialog', { name: 'Menu' })).toBeVisible();

    // Going to a page closes the sheet.
    await userEvent.click(within(reopened).getByRole('link', { name: 'Rules' }));
    await expect(navigate).toHaveBeenLastCalledWith(hrefs.rules);
    await expect(canvas.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    await expect(menu).toHaveFocus();
  },
};
