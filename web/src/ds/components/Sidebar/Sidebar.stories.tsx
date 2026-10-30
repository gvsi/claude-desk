import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Sidebar, type NavKey, type SidebarProps } from './Sidebar.tsx';

const MAIN_LINE = { id: 'desk-rivera-main', name: rivera.business.deskName };
const EMERGENCIES = { id: 'desk-rivera-emergencies', name: 'Emergencies' };

const hrefs = {
  today: '#today',
  conversations: '#conversations',
  people: '#customers',
  rules: '#rules',
  connectors: '#connectors',
  safety: '#safety',
  share: '#share',
  settings: '#settings',
} satisfies Record<NavKey, string>;

/**
 * The sidebar as the owner layout holds it: the Answering switch and the Desk picker show what the
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
      "The board draws seven pages; Connectors, signed after it as its own page (N-Conn-23-Connectors), is the fifth of eight. The board's Desk picker opens a popover list with a green dot beside the Desk's name; here it opens the list under itself, with no dot, since no words say what it means. The owner row isn't a button, because it opens nothing yet.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // nav_order_is_fixed: the eight rows in their fixed order, the people row third and Connectors after Rules.
    const rows = navRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Today', 'Conversations', 'Customers', 'Rules', 'Connectors', 'Safety', 'Share', 'Settings']);
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
    const safety = rows[5]?.link as HTMLElement;
    await expect(within(safety).getByRole('img', { name: '2 blocked' })).toBeVisible();
    await expect(safety.querySelectorAll('.cd-status-dot--held')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('.cd-status-dot')).toHaveLength(1);

    // The business row opens the switcher.
    await userEvent.click(canvas.getByRole('button', { name: 'Switch business, current: Rivera Plumbing' }));
    await expect(args.onSwitchBusiness).toHaveBeenCalledTimes(1);

    // desk_picker_only_with_two_desks: the picker opens the Desks under it, the current one marked.
    const picker = canvas.getByRole('button', { name: 'Switch Desk, current: Main line' });
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(picker);
    await expect(picker).toHaveAttribute('aria-expanded', 'true');
    const list = canvas.getByRole('list', { name: 'Desks in Rivera Plumbing' });
    const choices = within(list).getAllByRole('button');
    await expect(choices.map((choice) => choice.textContent)).toEqual(['Main line', 'Emergencies']);
    await expect(choices[0]).toHaveAttribute('aria-current', 'true');
    await expect(choices[1]).not.toHaveAttribute('aria-current');

    // Escape closes the list and returns focus to the picker.
    await userEvent.tab();
    await expect(choices[0]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('list', { name: 'Desks in Rivera Plumbing' })).toBeNull();
    await expect(picker).toHaveFocus();

    // Picking another Desk switches to it and closes the list.
    await userEvent.keyboard('{Enter}');
    await userEvent.click(canvas.getByRole('button', { name: 'Emergencies' }));
    await expect(args.onSwitchDesk).toHaveBeenCalledTimes(1);
    await expect(args.onSwitchDesk).toHaveBeenLastCalledWith(EMERGENCIES.id);
    await expect(canvas.queryByRole('list', { name: 'Desks in Rivera Plumbing' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Switch Desk, current: Emergencies' })).toHaveFocus();

    // Answering is a switch at the bottom, with what "on" means.
    const answering = canvas.getByRole('switch', { name: 'Answering' });
    await expect(answering).toHaveAccessibleDescription('Claude answers under your rules');
    await userEvent.click(answering);
    await expect(args.onAnsweringChange).toHaveBeenLastCalledWith(false);

    // The owner row: the name and status in words, the initials avatar hidden beside them.
    await expect(canvas.getByText('Maria Rivera')).toBeVisible();
    await expect(canvas.getByText('Available for chats')).toBeVisible();
    const avatar = canvasElement.querySelector('.cd-sidebar__avatar');
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
    await expect(avatar).toHaveTextContent('MR');

    // Nothing reaches past the 264 px column.
    const column = canvasElement.querySelector<HTMLElement>('.cd-sidebar');
    await expect(column?.scrollWidth).toBeLessThanOrEqual(column?.clientWidth ?? 0);

    // about_group_only_when_given: without `about`, no group and no extra hairline.
    await expect(canvas.queryByRole('navigation', { name: 'About this prototype' })).toBeNull();
    await expect(canvasElement.querySelector('.cd-sidebar__about')).toBeNull();
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
      'The board shows two Desks; with one there is nothing to switch to, so the picker is left out. The board draws seven pages, from before Connectors was signed as the fifth.',
  },
  play: async ({ canvas, canvasElement }) => {
    // desk_picker_only_with_two_desks
    await expect(canvas.queryByRole('button', { name: /Switch Desk/ })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Switch business, current: Rivera Plumbing' })).toBeVisible();

    // The people row takes the business's word for them, and only Safety is current.
    const rows = navRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Today', 'Conversations', 'Clients', 'Rules', 'Connectors', 'Safety', 'Share', 'Settings']);
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
    // Connectors is the fifth of eight rows, and the only current page.
    const rows = navRows(canvasElement);
    await expect(rows.map((row) => row.text)).toEqual(['Today', 'Conversations', 'Customers', 'Rules', 'Connectors', 'Safety', 'Share', 'Settings']);
    await expect(rows.filter((row) => row.link.hasAttribute('aria-current')).map((row) => [row.text, row.link.getAttribute('aria-current')])).toEqual([
      ['Connectors', 'page'],
    ]);
    const connectors = rows[4]?.link as HTMLElement;
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
    await expect(tops.slice(1).map((top, index) => Math.round(top - (tops[index] ?? 0)))).toEqual([38, 38, 38, 38, 38, 38, 38]);
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
      "The board's eight pages, Connectors after Rules, with the group and the foot where the board draws them.",
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

    // Just above the Answering block, behind a hairline that spans the column's inner width.
    const group = nav.closest('.cd-sidebar__about') as HTMLElement;
    const footer = canvasElement.querySelector('.cd-sidebar__footer') as HTMLElement;
    expectComputed(group, { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    await expect(group.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer.getBoundingClientRect().top);
    await expect(Math.round(group.getBoundingClientRect().width)).toBe(Math.round(footer.getBoundingClientRect().width));
    // The main page stays current in the main nav.
    await expect(navRows(canvasElement).filter((row) => row.link.hasAttribute('aria-current')).map((row) => row.text)).toEqual(['Today']);

    // about_links_in_tab_order: the main nav, then the about links, then Answering.
    (document.activeElement as HTMLElement | null)?.blur();
    const main = navRows(canvasElement).map((row) => row.link);
    const answering = canvas.getByRole('switch', { name: 'Answering' });
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
