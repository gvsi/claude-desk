import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { CAPS_BADGE } from '../../test/copy.ts';
import { loadWebFonts } from '../../test/fonts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { SidebarSkeleton as SidebarShapes } from './SidebarSkeleton.tsx';
import { Sidebar, type NavKey, type SidebarProps } from './Sidebar.tsx';

const MAIN_LINE = { id: 'desk-rivera-main', name: rivera.business.deskName };
const EMERGENCIES = { id: 'desk-rivera-emergencies', name: 'Emergencies' };

const hrefs = {
  today: '#today',
  conversations: '#conversations',
  people: '#customers',
  knowledge: '#knowledge',
  rules: '#rules',
  connectors: '#connectors',
  safety: '#safety',
  share: '#share',
  settings: '#settings',
} satisfies Record<NavKey, string>;

/**
 * The sidebar as the owner layout holds it: the Claude acts for you switch and the Desk picker show what the
 * screen passes back, and each change is reported to the story.
 */
function Layout(props: SidebarProps) {
  const [answering, setAnswering] = useState(props.answering);
  const [deskId, setDeskId] = useState(props.currentDeskId);
  return (
    <Sidebar
      {...props}
      answering={answering}
      onAnsweringChange={(next) => {
        setAnswering(next);
        props.onAnsweringChange(next);
      }}
      currentDeskId={deskId}
      onSwitchDesk={(id) => {
        setDeskId(id);
        props.onSwitchDesk(id);
      }}
    />
  );
}

const meta = {
  title: 'Layout/Sidebar',
  component: Sidebar,
  args: {
    business: rivera.business.name,
    onSwitchBusiness: fn(),
    desks: [MAIN_LINE, EMERGENCIES],
    currentDeskId: MAIN_LINE.id,
    onSwitchDesk: fn(),
    current: 'today',
    hrefs,
    peopleLabel: 'Customers',
    counts: {
      conversations: { n: 2, label: '2 need you' },
      safety: { n: 2, label: '2 blocked', attention: true },
    },
    answering: true,
    onAnsweringChange: fn(),
    owner: { name: rivera.business.ownerName, status: 'Available for chats' },
  },
  render: (args) => <Layout {...args} />,
  // The owner app's sidebar column: 264 px on the panel, the board's full height.
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', width: 'var(--size-sidebar)', minHeight: 820, background: 'var(--bg-panel)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'fullscreen', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof Sidebar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The nav's links, each by the words of its row (its count is read separately). */
function navRows(root: HTMLElement): { link: HTMLElement; text: string }[] {
  const nav = within(root).getByRole('navigation', { name: 'Main' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => ({ link, text: link.querySelector('.cd-sidebar__label')?.textContent ?? '' }));
}

export const TwoDesks: Story = {
  parameters: {
    canvasNote:
      "Knowledge follows Customers; Connectors keeps its conditional place after Rules, the sixth of nine rows. The board's Desk picker opens a popover list with a green dot beside the Desk's name; here it opens the list under itself, with no dot, since no words say what it means. The owner row isn't a button, because it opens nothing yet.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // nav_order_is_fixed: the nine rows in their fixed order, Knowledge after the people row and Connectors after Rules.
    const rows = navRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Connectors', 'Safety', 'Share', 'Settings']);
    await expect(rows.map((row) => row.link.getAttribute('href'))).toEqual(Object.values(hrefs));

    // current_page_marked: only Today is the current page, on the selected fill, with no accent bar.
    const current = rows.filter((row) => row.link.getAttribute('aria-current') !== null);
    await expect(current.map((row) => [row.text, row.link.getAttribute('aria-current')])).toEqual([['Today', 'page']]);
    const today = rows[0]?.link as HTMLElement;
    expectComputed(today, { height: '36px', backgroundColor: 'rgb(60, 57, 47)', borderLeftWidth: '0px', borderRadius: '8px' });
    expectComputed(rows[1]?.link as HTMLElement, { backgroundColor: 'rgba(0, 0, 0, 0)' });

    // Counts only on Conversations and Safety, read as what they mean; Safety's held dot asks for attention.
    await expect(canvas.getAllByRole('img').map((pill) => pill.getAttribute('aria-label'))).toEqual(['2 need you', '2 blocked']);
    await expect(within(rows[1]?.link as HTMLElement).getByRole('img', { name: '2 need you' })).toBeVisible();
    const safety = rows[6]?.link as HTMLElement;
    await expect(within(safety).getByRole('img', { name: '2 blocked' })).toBeVisible();
    await expect(safety.querySelectorAll('.cd-status-dot--held')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('.cd-status-dot')).toHaveLength(1);

    // The business row opens the switcher.
    await userEvent.click(canvas.getByRole('button', { name: 'Switch business, current: Turner Plumbing' }));
    await expect(args.onSwitchBusiness).toHaveBeenCalledTimes(1);

    // desk_picker_only_with_two_desks: the picker opens the Desks under it, the current one marked.
    const picker = canvas.getByRole('button', { name: 'Switch Desk, current: Main line' });
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(picker);
    await expect(picker).toHaveAttribute('aria-expanded', 'true');
    const list = canvas.getByRole('list', { name: 'Desks in Turner Plumbing' });
    // list_role_survives_unstyled_markers: Safari announces the Desks only with role="list".
    await expect(list).toHaveAttribute('role', 'list');
    const choices = within(list).getAllByRole('button');
    await expect(choices.map((choice) => choice.textContent)).toEqual(['Main line', 'Emergencies']);
    await expect(choices[0]).toHaveAttribute('aria-current', 'true');
    await expect(choices[1]).not.toHaveAttribute('aria-current');

    // Escape closes the list and returns focus to the picker.
    await userEvent.tab();
    await expect(choices[0]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('list', { name: 'Desks in Turner Plumbing' })).toBeNull();
    await expect(picker).toHaveFocus();

    // Picking another Desk switches to it and closes the list.
    await userEvent.keyboard('{Enter}');
    await userEvent.click(canvas.getByRole('button', { name: 'Emergencies' }));
    await expect(args.onSwitchDesk).toHaveBeenCalledTimes(1);
    await expect(args.onSwitchDesk).toHaveBeenLastCalledWith(EMERGENCIES.id);
    await expect(canvas.queryByRole('list', { name: 'Desks in Turner Plumbing' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Switch Desk, current: Emergencies' })).toHaveFocus();

    // Claude acts for you is a switch at the bottom, with what "on" means.
    const answering = canvas.getByRole('switch', { name: 'Claude acts for you' });
    await expect(answering).toHaveAccessibleDescription('Within your rules');
    await userEvent.click(answering);
    await expect(args.onAnsweringChange).toHaveBeenLastCalledWith(false);
    await expect(answering).toHaveAccessibleDescription('Taking messages only');

    // The owner row: the name and status in words, the initials avatar hidden beside them.
    await expect(canvas.getByText('Mike Turner')).toBeVisible();
    await expect(canvas.getByText('Available for chats')).toBeVisible();
    const avatar = canvasElement.querySelector('.cd-sidebar__avatar');
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
    await expect(avatar).toHaveTextContent('MT');

    // Nothing reaches past the 264 px column.
    const column = canvasElement.querySelector<HTMLElement>('.cd-sidebar');
    await expect(column?.scrollWidth).toBeLessThanOrEqual(column?.clientWidth ?? 0);

    // about_group_only_when_given: without `about`, no group and no extra hairline.
    await expect(canvas.queryByRole('navigation', { name: 'About this prototype' })).toBeNull();
    await expect(canvasElement.querySelector('.cd-sidebar__about')).toBeNull();
  },
};

export const Lockup: Story = {
  parameters: {
    canvasNote:
      'N-Today-Run1 draws the earlier lockup, a 20 px mark beside "Claude Desk" with "Beta" under it. The owner signed the one-line lockup on 2026-10-30: the 36 px bell with no tile, "Claude Desk" and the "Preview" badge in capitals, centred on one line.',
  },
  play: async ({ canvasElement }) => {
    // lockup_on_one_line: the bell, the wordmark and the badge, in that order, each centred on the
    // same line; 10 px from the bell to the name and 8 px from the name to the badge.
    const brand = canvasElement.querySelector('.cd-sidebar__brand') as HTMLElement;
    const mark = brand.querySelector(':scope > svg.cd-mark') as SVGSVGElement;
    const name = brand.querySelector('.cd-type-wordmark') as HTMLElement;
    const badge = brand.querySelector(CAPS_BADGE.selector) as HTMLElement;
    await expect(mark).not.toBeNull();
    await expect(brand.textContent).toBe('Claude DeskPreview');
    await expect([mark.getAttribute('width'), mark.getAttribute('height')]).toEqual(['36', '36']);
    // The bell with no tile, in its light ink on the panel.
    await expect(mark.querySelector('rect')).toBeNull();
    expectComputed(mark.querySelector(':scope > g > g:last-child') as Element, { fill: 'rgb(250, 249, 245)' });
    const [m, n, b] = [mark, name, badge].map((el) => el.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect];
    await expect(n.left - m.right).toBe(10);
    await expect(b.left - n.right).toBe(8);
    const middle = (r: DOMRect) => r.top + r.height / 2;
    await expect(Math.abs(middle(n) - middle(m))).toBeLessThanOrEqual(0.5);
    await expect(Math.abs(middle(b) - middle(m))).toBeLessThanOrEqual(0.5);
    // The name in the serif wordmark style; the badge is the Pill, 20 px tall in its thin outline,
    // its word written "Preview" and drawn in small, slightly spaced capitals.
    expectComputed(name, { fontFamily: /^"Source Serif 4"/, fontSize: '18px', lineHeight: '22px' });
    expectComputed(badge, {
      height: '20px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.22)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      color: 'rgba(250, 249, 245, 0.92)',
      fontSize: '11px',
      lineHeight: '14px',
      fontWeight: '520',
      letterSpacing: '0.66px',
      textTransform: 'uppercase',
    });
    await expect(badge.classList.contains('cd-pill')).toBe(true);
    await expect(badge.textContent).toBe('Preview');
    // The row keeps its height, so the business row and the nav stay where they were.
    expectComputed(brand, { height: '50px', paddingTop: '2px', paddingBottom: '12px' });
  },
};

export const OneDesk: Story = {
  args: {
    desks: [MAIN_LINE],
    current: 'safety',
    peopleLabel: 'Clients',
    counts: { safety: { n: 1, label: '1 blocked' } },
  },
  parameters: {
    canvasNote:
      'The board shows two Desks; with one there is nothing to switch to, so the picker is left out. Knowledge follows the people row; Connectors keeps its place after Rules.',
  },
  play: async ({ canvas, canvasElement }) => {
    // desk_picker_only_with_two_desks
    await expect(canvas.queryByRole('button', { name: /Switch Desk/ })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Switch business, current: Turner Plumbing' })).toBeVisible();

    // The people row takes the business's word for them, and only Safety is current.
    const rows = navRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Today', 'Conversations', 'Clients', 'Knowledge', 'Rules', 'Connectors', 'Safety', 'Share', 'Settings']);
    await expect(rows.filter((row) => row.link.hasAttribute('aria-current')).map((row) => row.text)).toEqual(['Safety']);
    // A count without attention has no dot; Conversations has no count to show.
    await expect(canvas.getAllByRole('img').map((pill) => pill.getAttribute('aria-label'))).toEqual(['1 blocked']);
    await expect(canvasElement.querySelectorAll('.cd-status-dot')).toHaveLength(0);
  },
};

export const OnConnectors: Story = {
  // As the Connectors page draws it: one Desk, and Safety's count without the held dot.
  args: {
    current: 'connectors',
    desks: [MAIN_LINE],
    counts: { conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } },
  },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The Connectors page draws this sidebar (N-Conn-23-Connectors, at 1512 px, not yet a reference board): Connectors after Rules with a plug icon, the current row on the selected fill. Nearest reference board: N-Today-Run1.',
  },
  play: async ({ canvasElement }) => {
    // Connectors is the sixth of nine rows, and the only current page.
    const rows = navRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Connectors', 'Safety', 'Share', 'Settings']);
    await expect(rows.filter((row) => row.link.hasAttribute('aria-current')).map((row) => [row.text, row.link.getAttribute('aria-current')])).toEqual([
      ['Connectors', 'page'],
    ]);
    const connectors = rows[5]?.link as HTMLElement;
    await expect(connectors).toHaveAttribute('href', '#connectors');
    expectComputed(connectors, { height: '36px', backgroundColor: 'rgb(60, 57, 47)', borderLeftWidth: '0px', borderRadius: '8px' });
    expectComputed(rows[3]?.link as HTMLElement, { backgroundColor: 'rgba(0, 0, 0, 0)' });

    // Its icon is a 20 px line icon like the other rows', hidden beside the word.
    const icon = connectors.querySelector('svg');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon).toHaveAttribute('width', '20');
    await expect(icon).toHaveAttribute('fill', 'none');

    // The rows keep the board's spacing: 36 px tall, 2 px apart, so a row every 38 px.
    const tops = rows.map((row) => row.link.getBoundingClientRect().top);
    await expect(tops.slice(1).map((top, index) => Math.round(top - (tops[index] ?? 0)))).toEqual([38, 38, 38, 38, 38, 38, 38, 38]);
  },
};

const TEAM = { id: 'desk-rivera-team', name: 'Team' };

/** A team Desk, as N-R2-Vision-TeamDesk draws it: its own people's word, and Claude acts for you in the team's words. */
export const TeamDesk: Story = {
  args: {
    desks: [MAIN_LINE, TEAM],
    currentDeskId: TEAM.id,
    current: 'conversations',
    peopleLabel: 'Teammates',
    counts: { conversations: { n: 12, label: '12 team conversations today' }, safety: { n: 1, label: '1 attempt stopped today' } },
    answeringDescription: 'Within your rules',
  },
  parameters: { canvas: 'N-R2-Vision-TeamDesk' },
  play: async ({ canvas, canvasElement }) => {
    // answering_line_from_the_desk: the switch's line is the one the Desk passes, as its description.
    const answering = canvas.getByRole('switch', { name: 'Claude acts for you' });
    await expect(answering).toHaveAccessibleDescription('Within your rules');
    await expect(canvas.getByText('Within your rules')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Switch Desk, current: Team' })).toBeVisible();
    await expect(navRows(canvasElement).map((row) => row.text)).toEqual([
      'Today',
      'Conversations',
      'Teammates',
      'Knowledge',
      'Rules',
      'Connectors',
      'Safety',
      'Share',
      'Settings',
    ]);
  },
};

/** Without its own line, Claude acts for you keeps the owner app's. */
export const AnsweringLine: Story = {
  parameters: { canvasNote: 'Only the Claude acts for you line is checked here; the rest is the board’s, as in TwoDesks.' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('switch', { name: 'Claude acts for you' })).toHaveAccessibleDescription('Within your rules');
  },
};

/** Where the rows go in an app with no Connectors page yet: every page but Connectors. */
const { connectors: _noConnectorsPage, ...hrefsWithoutConnectors } = hrefs;

export const WithoutConnectors: Story = {
  args: { hrefs: hrefsWithoutConnectors },
  parameters: {
    canvasNote:
      'An app with no Connectors page passes no Connectors href, so the row isn’t drawn: the eight pages including Knowledge, one row apart, with no gap after Rules.',
  },
  play: async ({ canvasElement }) => {
    // connectors_row_only_with_its_href: eight rows, each with somewhere to go.
    const rows = navRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Today', 'Conversations', 'Customers', 'Knowledge', 'Rules', 'Safety', 'Share', 'Settings']);
    await expect(rows.map((row) => row.link.getAttribute('href'))).toEqual(Object.values(hrefsWithoutConnectors));
    await expect(within(canvasElement).queryByRole('link', { name: 'Connectors' })).toBeNull();

    // The rows close up: Safety follows Rules one 38 px row down, as every row follows the one before.
    const tops = rows.map((row) => row.link.getBoundingClientRect().top);
    await expect(tops.slice(1).map((top, index) => Math.round(top - (tops[index] ?? 0)))).toEqual([38, 38, 38, 38, 38, 38, 38]);
    // Safety keeps its count and its held dot, and Today stays the current page.
    const safety = rows[5]?.link as HTMLElement;
    await expect(within(safety).getByRole('img', { name: '2 blocked' })).toBeVisible();
    await expect(rows.filter((row) => row.link.hasAttribute('aria-current')).map((row) => row.text)).toEqual(['Today']);
  },
};

/** The two documents behind the prototype, as the docs pages link them. */
const ABOUT = {
  title: 'About this prototype',
  links: [
    { id: 'proposal', label: 'Product proposal', href: '#docs/product-proposal' },
    { id: 'prediction', label: 'Capability prediction', href: '#docs/capability-prediction' },
  ],
};

/** The about group's links, each by its words. */
function aboutRows(root: HTMLElement): { link: HTMLElement; text: string }[] {
  const nav = within(root).getByRole('navigation', { name: 'About this prototype' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => ({ link, text: link.querySelector('.cd-sidebar__label')?.textContent ?? '' }));
}

export const AboutThisPrototype: Story = {
  args: { about: ABOUT },
  parameters: {
    canvas: 'N-Docs-Sidebar',
    canvasNote:
      "The nine pages, Knowledge after Customers and Connectors after Rules, with the group and the foot where the board draws them.",
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The group: its own navigation, named by its caption title, with one row per link.
    const nav = canvas.getByRole('navigation', { name: 'About this prototype' });
    const title = within(nav).getByText('About this prototype');
    expectComputed(title, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    const rows = aboutRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Product proposal', 'Capability prediction']);
    await expect(rows.map((row) => row.link.getAttribute('href'))).toEqual(ABOUT.links.map((link) => link.href));

    // Each row is a nav row like the main ones, with the document icon, and none is current.
    const today = navRows(canvasElement)[0]?.link as HTMLElement;
    for (const { link } of rows) {
      await expect(link).toHaveClass('cd-sidebar__row');
      await expect(link).not.toHaveAttribute('aria-current');
      expectComputed(link, { height: '36px', fontSize: '14px', lineHeight: '20px', fontWeight: '420', backgroundColor: 'rgba(0, 0, 0, 0)' });
      const icon = link.querySelector('svg');
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      await expect(icon?.getBoundingClientRect().width).toBe(20);
      await expect(Math.round(link.getBoundingClientRect().left)).toBe(Math.round(today.getBoundingClientRect().left));
    }

    // Just above the Claude acts for you block, behind a hairline that spans the column's inner width.
    const group = nav.closest('.cd-sidebar__about') as HTMLElement;
    const footer = canvasElement.querySelector('.cd-sidebar__footer') as HTMLElement;
    expectComputed(group, { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    await expect(group.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer.getBoundingClientRect().top);
    await expect(Math.round(group.getBoundingClientRect().width)).toBe(Math.round(footer.getBoundingClientRect().width));
    // The main page stays current in the main nav.
    await expect(navRows(canvasElement).filter((row) => row.link.hasAttribute('aria-current')).map((row) => row.text)).toEqual(['Today']);

    // about_links_in_tab_order: the main nav, then the about links, then Claude acts for you.
    (document.activeElement as HTMLElement | null)?.blur();
    const main = navRows(canvasElement).map((row) => row.link);
    const answering = canvas.getByRole('switch', { name: 'Claude acts for you' });
    main[main.length - 1]?.focus();
    await userEvent.tab();
    await expect(rows[0]?.link).toHaveFocus();
    await userEvent.tab();
    await expect(rows[1]?.link).toHaveFocus();
    await userEvent.tab();
    await expect(answering).toHaveFocus();
  },
};

export const AboutCurrent: Story = {
  args: {
    about: { ...ABOUT, links: ABOUT.links.map((link) => (link.id === 'proposal' ? { ...link, current: true } : link)) },
  },
  parameters: {
    canvas: 'N-Docs-Sidebar',
    canvasNote:
      'The owner reading the product proposal: its row is the current page, where the board marks no row.',
  },
  play: async ({ canvasElement }) => {
    // about_link_marks_the_current_page: the current link is the page, on the selected fill.
    const rows = aboutRows(canvasElement);
    const [proposal, prediction] = rows.map((row) => row.link) as [HTMLElement, HTMLElement];
    await expect(proposal).toHaveAttribute('aria-current', 'page');
    expectComputed(proposal, { backgroundColor: 'rgb(60, 57, 47)' });
    await expect(prediction).not.toHaveAttribute('aria-current');
    // One current page: the main nav marks none while a document is open.
    await expect(navRows(canvasElement).filter((row) => row.link.hasAttribute('aria-current'))).toEqual([]);
  },
};

/** Compare the fresh copy's column with its shapes, using each column's own origin. */
export const SidebarSkeleton: Story = {
  beforeEach: loadWebFonts,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'P12-01, UXC-P1201-After (#artboard-dec46cf506e4): the frame follows the real sidebar where the board differs.' },
  render: (args) => (
    <div style={{ width: '100%' }}>
      <div data-real-sidebar style={{ display: 'flex', height: 820 }}>
        <Sidebar {...args} desks={[MAIN_LINE]} hrefs={{ ...hrefs, connectors: undefined }} about={{ title: 'About this prototype', links: [{ id: 'proposal', label: 'Product proposal', href: '#proposal' }, { id: 'prediction', label: 'Capability prediction', href: '#prediction' }] }} />
      </div>
      <div data-shaped-sidebar aria-hidden="true" style={{ display: 'flex', height: 820 }}><SidebarShapes rows={8} about={2} /></div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const real = canvasElement.querySelector<HTMLElement>('[data-real-sidebar]')!;
    const shapes = canvasElement.querySelector<HTMLElement>('[data-shaped-sidebar]')!;
    for (const selector of ['.cd-sidebar__brand', '.cd-sidebar__business', '.cd-sidebar__nav', '.cd-sidebar__about', '.cd-sidebar__footer', '.cd-sidebar__owner']) {
      const a = real.querySelector(selector)!.getBoundingClientRect();
      const b = shapes.querySelector(selector)!.getBoundingClientRect();
      for (const [edge, delta] of [['top', real.getBoundingClientRect().top - shapes.getBoundingClientRect().top], ['left', 0], ['width', 0], ['height', 0]] as const) {
        await expect(Math.abs(a[edge] - b[edge] - delta), `${selector} ${edge}`).toBeLessThanOrEqual(2);
      }
    }
  },
};

export const SidebarSkeletonPhone: Story = {
  ...SidebarSkeleton,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'P12-01 phone, UXC-P1201-After-Phone (#artboard-1a93c5a1f31f): the same column opens behind Menu.' },
};
