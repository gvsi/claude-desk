import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { loadWebFonts } from '../../test/fonts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ApprovalCard } from '../ApprovalCard/ApprovalCard.tsx';
import { Greeting } from '../Greeting/Greeting.tsx';
import { ReviewerBar } from '../ReviewerBar/ReviewerBar.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';
import { SidebarSkeleton } from '../Sidebar/SidebarSkeleton.tsx';
import { ReviewerBarSkeleton } from '../ReviewerBar/ReviewerBarSkeleton.tsx';
import { Sidebar, type SidebarHrefs, type SidebarLinkProps } from '../Sidebar/Sidebar.tsx';
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
  knowledge: '/app/desk-rivera-main/knowledge',
  rules: '/app/desk-rivera-main/rules',
  safety: '/app/desk-rivera-main/safety',
  share: '/app/desk-rivera-main/share',
  settings: '/app/desk-rivera-main/settings',
} satisfies SidebarHrefs;

/** The same app once it has a Connectors page, as N-Docs-Sidebar draws it. */
const hrefsWithConnectors = { ...hrefs, connectors: '/app/desk-rivera-main/connectors' } satisfies SidebarHrefs;

/** The documents behind the prototype, linked from the sidebar's "About this prototype" group. */
const ABOUT = {
  title: 'About this prototype',
  links: [
    { id: 'proposal', label: 'Product proposal', href: '/docs/product-proposal' },
    { id: 'prediction', label: 'Capability prediction', href: '/docs/capability-prediction' },
  ],
};

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

/** The eight pages, including Knowledge, without Connectors. */
const PAGES = ['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Safety', 'Share', 'Settings'];

/** The nine pages with Knowledge after Customers and Connectors after Rules. */
const PAGES_WITH_CONNECTORS = ['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Connectors', 'Safety', 'Share', 'Settings'];

/** The words of each page row in a nav, in order (a row's count is read separately). */
function pageNames(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.querySelector('.cd-sidebar__label')?.textContent ?? '');
}

const today = (
  <>
    <Greeting
      text="Good morning, Mike"
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
    const nav = within(column).getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    // nav_order_is_fixed: the eight pages, each to its own route (no Connectors page here).
    await expect(pageNames(nav)).toEqual(PAGES);
    await expect(within(nav).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(Object.values(hrefs));
    // It runs to the bottom of the window, so the Claude acts for you switch sits at the foot.
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
    await expect(canvas.getByRole('heading', { level: 1, name: 'Good morning, Mike' })).toBeVisible();

    // At this width there is no top bar and no menu.
    await expect(canvas.queryByRole('button', { name: 'Menu' })).toBeNull();
    await expect(canvasElement.querySelector('dialog')).toBeNull();
  },
};

export const SkipToContent: Story = {
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws Skip to content: the first Tab stop on every owner page, out of sight until the keyboard reaches it, then at the top left over the reviewer bar and the sidebar, on the raised surface with the standard focus ring.',
  },
  play: async ({ canvas, userEvent }) => {
    // skip_link_first_and_out_of_sight: nothing shows until the keyboard reaches it.
    const skip = canvas.getByRole('link', { name: 'Skip to content' });
    await expect(skip.getBoundingClientRect().width).toBeLessThanOrEqual(1);

    // The first Tab, before Start over: at the top left, over the reviewer bar, with the ring.
    await userEvent.tab();
    await expect(skip).toHaveFocus();
    expectComputed(skip, {
      height: '32px',
      paddingLeft: '12px',
      borderTopLeftRadius: '8px',
      backgroundColor: 'rgb(42, 41, 39)',
      color: 'rgba(250, 249, 245, 0.92)',
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineColor: 'rgba(250, 249, 245, 0.64)',
    });
    const box = skip.getBoundingClientRect();
    await expect([box.left, box.top]).toEqual([8, 8]);
    await expect(box.top).toBeLessThan(canvas.getByRole('note').getBoundingClientRect().bottom);
    await expect(document.elementFromPoint(box.left + 4, box.top + 4)).toBe(skip);
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
    canvasNote:
      'Only the page’s frame: the board’s conversation list starts where the sidebar ends and runs the window’s height, with the conversation beside it (fill). The sidebar is the panel, as on every page (owner decision 2026-10-29: one sidebar look on every page; the conversation boards are drawn with the one sidebar).',
  },
  play: async ({ canvas }) => {
    // One sidebar look on every page (owner decision 2026-10-29): beside a filled page too, it is
    // the panel with its seam, as tall as the window, its Claude acts for you switch and owner at the foot.
    const sidebarColumn = canvas.getByRole('complementary', { name: 'Claude Desk' });
    expectComputed(sidebarColumn, { backgroundColor: 'rgb(34, 34, 32)', borderRightWidth: '1px' });
    const foot = sidebarColumn.querySelector('.cd-sidebar__footer') as HTMLElement;
    await expect(sidebarColumn.getBoundingClientRect().bottom - foot.getBoundingClientRect().bottom).toBe(12);

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
    // compact_bar_mark_has_no_tile: the 20 px bell with no tile, in its light ink on the panel.
    const mark = bar.querySelector('svg.cd-mark') as SVGSVGElement;
    await expect(mark.getAttribute('width')).toBe('20');
    await expect(mark.querySelector('rect')).toBeNull();
    expectComputed(mark.querySelector(':scope > g > g:last-child') as Element, { fill: 'rgb(250, 249, 245)' });
    await expect(canvas.getByRole('main')).toBeVisible();

    // compact_menu_returns_focus: Menu opens the sidebar as a sheet with focus inside it, and
    // Escape closes it and puts focus back on Menu.
    await userEvent.click(menu);
    const sheet = canvas.getByRole('dialog', { name: 'Menu' });
    await expect(sheet).toBeVisible();
    // menu_sheet_backdrop_is_the_scrim: the page behind the sheet is dimmed by the scrim at full
    // strength, as it is behind Dialog and the Demo inbox sheet.
    const backdrop = getComputedStyle(sheet, '::backdrop');
    await expect(backdrop.backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
    await expect(backdrop.opacity).toBe('1');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(within(sheet).getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(pageNames(within(sheet).getByRole('navigation', { name: 'Main' }))).toEqual(PAGES);
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

/** A business name longer than a phone's top bar. */
const LONG_BUSINESS_NAME = 'Bayview Heating, Plumbing & Drain Services of Greater Oakland';

export const PhoneLongName: Story = {
  args: {
    business: LONG_BUSINESS_NAME,
    sidebar: (
      <Sidebar
        business={LONG_BUSINESS_NAME}
        onSwitchBusiness={fn()}
        desks={[{ id: 'desk-bayview-main', name: rivera.business.deskName }]}
        currentDeskId="desk-bayview-main"
        onSwitchDesk={fn()}
        current="today"
        hrefs={hrefs}
        peopleLabel="Customers"
        answering
        onAnsweringChange={fn()}
        owner={{ name: rivera.business.ownerName, status: 'Available for chats' }}
        linkComponent={RouterLink}
      />
    ),
  },
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board shows the owner app on a phone; this is the Compact top bar at a phone’s 390 px with a business name too long for it, cut with an ellipsis and carried in full as its title.',
  },
  play: async ({ canvas }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([390, 844]);
    const bar = canvas.getByRole('button', { name: 'Menu' }).closest('.cd-app-shell__topbar') as HTMLElement;
    // long_name_carries_its_title: the name is cut with an ellipsis where it doesn't fit, and its
    // title holds it in full, so it can still be read.
    const business = within(bar).getByText(LONG_BUSINESS_NAME);
    await expect(business).toBeVisible();
    await expect(business.scrollWidth).toBeGreaterThan(business.clientWidth);
    expectComputed(business, { textOverflow: 'ellipsis' });
    await expect(business).toHaveAttribute('title', LONG_BUSINESS_NAME);
    // Menu keeps its place in the bar, and nothing scrolls sideways.
    const menu = within(bar).getByRole('button', { name: 'Menu' }).getBoundingClientRect();
    await expect(business.getBoundingClientRect().right).toBeLessThanOrEqual(menu.left);
    await expect(menu.right).toBeLessThanOrEqual(window.innerWidth - 16);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const CompactAbout: Story = {
  args: {
    layout: 'compact',
    sidebar: (
      <Sidebar
        business={rivera.business.name}
        onSwitchBusiness={fn()}
        desks={[{ id: 'desk-rivera-main', name: rivera.business.deskName }]}
        currentDeskId="desk-rivera-main"
        onSwitchDesk={fn()}
        current="today"
        hrefs={hrefsWithConnectors}
        peopleLabel="Customers"
        answering
        onAnsweringChange={fn()}
        owner={{ name: rivera.business.ownerName, status: 'Available for chats' }}
        about={ABOUT}
        linkComponent={RouterLink}
      />
    ),
  },
  parameters: {
    canvas: 'N-Docs-Sidebar',
    canvasNote:
      'The board draws the sidebar in its column; on a phone, Menu opens the same sidebar as a sheet, with the about group above the Claude acts for you block.',
  },
  play: async ({ canvas, userEvent }) => {
    // compact_sheet_shows_the_about_group: the sheet holds the same group, between the main nav
    // and the Claude acts for you block, in that keyboard order.
    const menu = canvas.getByRole('button', { name: 'Menu' });
    await userEvent.click(menu);
    const sheet = canvas.getByRole('dialog', { name: 'Menu' });
    const about = within(sheet).getByRole('navigation', { name: 'About this prototype' });
    const links = within(about).getAllByRole('link');
    await expect(links.map((link) => link.textContent)).toEqual(['Product proposal', 'Capability prediction']);
    const mainLinks = within(within(sheet).getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    mainLinks[mainLinks.length - 1]?.focus();
    await userEvent.tab();
    await expect(links[0]).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    await expect(within(sheet).getByRole('switch', { name: 'Claude acts for you' })).toHaveFocus();

    // Going to a document closes the sheet, like any page.
    await userEvent.click(links[0] as HTMLElement);
    await expect(navigate).toHaveBeenLastCalledWith('/docs/product-proposal');
    await expect(canvas.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    await expect(menu).toHaveFocus();
  },
};

export const ShortWindow: Story = {
  args: {
    sidebar: (
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
        hrefs={hrefsWithConnectors}
        peopleLabel="Customers"
        counts={{ conversations: { n: 1, label: '1 needs you' }, safety: { n: 2, label: '2 blocked' } }}
        answering
        onAnsweringChange={fn()}
        owner={{ name: rivera.business.ownerName, status: 'Available for chats' }}
        about={ABOUT}
        linkComponent={RouterLink}
      />
    ),
  },
  // A short laptop window: the reviewer bar, two Desks and the about group are more than its height.
  globals: { viewport: { value: 'short', isRotated: false } },
  parameters: {
    canvas: 'N-Docs-Sidebar',
    canvasNote:
      'The board draws the sidebar at 982 px; in a window 657 px tall, under the reviewer bar and with two Desks, the nav’s nine pages and the about group scroll between the pinned top and the pinned foot.',
  },
  play: async ({ canvas, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1366, 657]);
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    const sidebar = column.querySelector('.cd-sidebar') as HTMLElement;
    const foot = sidebar.querySelector('.cd-sidebar__footer') as HTMLElement;
    const middle = sidebar.querySelector('.cd-sidebar__middle') as HTMLElement | null;
    // All nine pages, Connectors included, and the foot still wholly in the window.
    await expect(pageNames(within(column).getByRole('navigation', { name: 'Main' }))).toEqual(PAGES_WITH_CONNECTORS);

    // sidebar_foot_stays_in_view: the column itself never scrolls; the foot sits 12 px over its
    // bottom, wholly in the window.
    await expect(column.scrollHeight).toBeLessThanOrEqual(column.clientHeight);
    await expect(Math.round(column.getBoundingClientRect().bottom - foot.getBoundingClientRect().bottom)).toBe(12);
    await expect(foot.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    await expect(foot.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);

    // The middle, the nav and the about group, scrolls between the pinned top and the foot.
    await expect(middle).not.toBeNull();
    const scroller = middle as HTMLElement;
    expectComputed(scroller, { overflowY: 'auto' });
    await expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    const business = within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` });
    const businessTop = business.getBoundingClientRect().top;
    const footTop = foot.getBoundingClientRect().top;

    // Tab reaches the about links through the scroll: each comes into view with its whole ring,
    // and the top and the foot stay where they are.
    const about = within(scroller).getByRole('navigation', { name: 'About this prototype' });
    const links = within(about).getAllByRole('link');
    const settings = within(within(scroller).getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Settings' });
    settings.focus();
    await userEvent.tab();
    await userEvent.tab();
    await expect(links[1]).toHaveFocus();
    const box = scroller.getBoundingClientRect();
    const ring = (links[1] as HTMLElement).getBoundingClientRect();
    await expect(scroller.scrollTop).toBeGreaterThan(0);
    await expect(ring.top - 4).toBeGreaterThanOrEqual(box.top);
    await expect(ring.bottom + 4).toBeLessThanOrEqual(box.bottom);
    await expect(ring.left - 4).toBeGreaterThanOrEqual(box.left);
    await expect(ring.right + 4).toBeLessThanOrEqual(box.right);
    await expect(business.getBoundingClientRect().top).toBe(businessTop);
    await expect(foot.getBoundingClientRect().top).toBe(footTop);
    await userEvent.tab();
    await expect(canvas.getByRole('switch', { name: 'Claude acts for you' })).toHaveFocus();
  },
};

export const Skeleton: Story = {
  beforeEach: loadWebFonts,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote:
      'P12-01, UXC-P1201-After (#artboard-dec46cf506e4): the frame uses its real classes. The skeleton column and main area are divs, leaving the loading page one main landmark.',
  },
  render: (args) => (
    <div>
      <div data-real-frame>
        <AppShell
          {...args}
          sidebar={<Sidebar {...sidebar.props} desks={[{ id: 'desk-rivera-main', name: rivera.business.deskName }]} about={ABOUT} />}
        />
      </div>
      <div data-shaped-frame aria-hidden="true" ref={(element) => element?.setAttribute('inert', '')}>
        <AppShell skeleton business="" banner={<ReviewerBarSkeleton />} sidebar={<SidebarSkeleton rows={8} about={ABOUT.links.length} />}>
          <div />
        </AppShell>
      </div>
    </div>
  ),
  play: async ({ canvasElement, userEvent }) => {
    const real = canvasElement.querySelector<HTMLElement>('[data-real-frame]')!;
    const shapes = canvasElement.querySelector<HTMLElement>('[data-shaped-frame]')!;
    // During the hand-off both shells are mounted, but only the real shell owns a skip target.
    const main = real.querySelector('main')!;
    const skip = real.querySelector<HTMLAnchorElement>('.cd-app-shell__skip')!;
    await expect(canvasElement.querySelectorAll('.cd-app-shell__skip')).toHaveLength(1);
    await expect(document.querySelectorAll(`#${CSS.escape(main.id)}`)).toHaveLength(1);
    await expect(shapes.querySelector('.cd-app-shell__main')).not.toHaveAttribute('id');
    await expect(shapes.querySelector('.cd-app-shell__main')).not.toHaveAttribute('tabindex');
    await expect(skip).toHaveAttribute('href', `#${main.id}`);
    await expect(document.getElementById(skip.hash.slice(1))).toBe(main);
    skip.focus();
    await userEvent.keyboard('{Enter}');
    await expect(main).toHaveFocus();
    await expect(shapes.querySelector('main, aside')).toBeNull();
    await expect(shapes.querySelector('button, a[href]')).toBeNull();
    for (const selector of ['.cd-reviewer-bar', '.cd-app-shell__column', '.cd-app-shell__main', '.cd-app-shell__topbar']) {
      const a = real.querySelector(selector)?.getBoundingClientRect();
      const b = shapes.querySelector(selector)?.getBoundingClientRect();
      if (!a || !b) {
        await expect(Boolean(a)).toBe(Boolean(b));
        continue;
      }
      for (const [edge, delta] of [
        ['top', real.getBoundingClientRect().top - shapes.getBoundingClientRect().top],
        ['left', 0],
        ['width', 0],
        ['height', 0],
      ] as const) {
        await expect(Math.abs(a[edge] - b[edge] - delta), `${selector} ${edge}`).toBeLessThanOrEqual(2);
      }
    }
  },
};

export const SkeletonPhone: Story = {
  ...Skeleton,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote:
      'P12-01 phone, UXC-P1201-After-Phone (#artboard-1a93c5a1f31f): the compact frame follows the real top bar and keeps no extra main.',
  },
};
