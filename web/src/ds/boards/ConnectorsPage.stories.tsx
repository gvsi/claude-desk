import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Notice } from '../components/Notice/Notice.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../test/expectMockBadges.ts';
import { ConnectorsPage, RiveraFrame, type ConnectorsPageProps, SIDEBAR_NOTE } from './parts.tsx';
import { CONNECTORS_SPEC, SPEC, expectFooter, expectOwnerFrame, expectTabOrder, one, some } from './spec.ts';

const COUNTS = { conversations: { n: 2, label: '2 live conversations' }, safety: { n: 2, label: '2 blocked' } };

/**
 * Turner's Connectors page as the board draws it, its apps to connect each with "Connect". In the
 * demo Google Calendar is coming soon, with no "Connect" (`rivera.directory`).
 */
const RIVERA: ConnectorsPageProps['directory'] = {
  ...rivera.directory,
  available: rivera.directory.available.map(({ connector, tools }) => ({ connector, tools, onConnect: () => {} })),
};

/** Right after Google Calendar was connected: both apps connected, none left to connect. */
const GCAL_ADDED: ConnectorsPageProps['directory'] = {
  ...rivera.directory,
  connected: [
    ...rivera.directory.connected,
    {
      connector: rivera.googleCalendar.view,
      tools: 1,
      href: '/connectors/google-calendar',
      connection: 'Turner Plumbing jobs (mock)',
    },
  ],
  available: [],
  justAdded: rivera.googleCalendar.view.id,
};

const meta = {
  title: 'Boards/Connectors',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * A Connectors page in its frame and look: the sidebar on Connectors, the serif title with
 * "Add a connector", each group's card of rows in the section look, and the footer. Returns the
 * main area and the rows' links.
 */
async function expectConnectorsPage(root: HTMLElement): Promise<{ main: HTMLElement; add: HTMLElement; rows: HTMLElement[] }> {
  const main = within(root).getByRole('main');
  expectComputed(within(main).getByRole('heading', { level: 1, name: 'Connectors' }), SPEC.pageTitle);
  await expect(within(main).getByText('What Claude can reach, and the accounts behind it.')).toBeVisible();
  const add = within(main).getByRole('button', { name: 'Add a connector' });
  for (const card of some(main, '.cd-connector-directory .cd-card')) expectComputed(card, CONNECTORS_SPEC.section);
  // The 36 px tiles, 32 px on a phone, as the boards draw them.
  const side = window.innerWidth < 640 ? '32px' : '36px';
  for (const tile of some(main, '.cd-connector-directory .cd-connector-icon')) {
    const look = tile.classList.contains('cd-connector-icon--brand') ? CONNECTORS_SPEC.brandTile : CONNECTORS_SPEC.iconTile;
    expectComputed(tile, { ...look, width: side, height: side });
  }
  await expect(main.querySelectorAll('.cd-connector-directory .cd-connector-name__built-in')).toHaveLength(0);
  await expect(expectMockBesideExternalNames(one(main, '.cd-connector-directory'))).toBeGreaterThanOrEqual(1);
  await expectFooter(root);
  return { main, add, rows: [...main.querySelectorAll<HTMLElement>('.cd-connector-directory a, .cd-connector-directory button')] };
}

export const Page: Story = {
  name: 'Connectors',
  globals: { viewport: { value: 'laptop', isRotated: false } },
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <ConnectorsPage directory={RIVERA} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-23-Connectors',
    canvasNote: [
      'The page layout is the web app’s (plan 04), composed from PageHeader and ConnectorDirectory. Google Calendar is catalog-only in the demo, where the web app passes it as coming soon with no “Connect” (ConnectorDirectory › Coming soon in the demo); this shows the signed board’s “Connect”, the state it will have once it works.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const page = await expectConnectorsPage(canvasElement);
    expectComputed(page.add, SPEC.secondaryMain);
    // Built in, Connected and Available, in that order.
    await expect(
      within(page.main)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Built in', 'Connected', 'Available']);
    await expect(within(page.main).getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible();
    // focus_order_is_logical: the nav, "Add a connector", then each row in order, "Connect" last.
    const nav = within(within(canvasElement).getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    await expectTabOrder(userEvent, [...nav, page.add, ...page.rows]);
  },
};

export const Phone: Story = {
  name: 'Connectors on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <ConnectorsPage directory={RIVERA} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-24-Phone-Connectors',
    canvasNote: [
      'The caption beside “Built in” is the laptop board’s at every width; the phone board shortens it to “Remove one on its own page. Verification is always on.”',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    // The top bar replaces the sidebar; the title keeps "Add a connector" beside it, at control height.
    await expect(canvas.queryByRole('complementary', { name: 'Claude Desk' })).toBeNull();
    const menu = canvas.getByRole('button', { name: 'Menu' });
    const page = await expectConnectorsPage(canvasElement);
    expectComputed(page.add, { height: '32px' });
    const title = within(page.main).getByRole('heading', { level: 1, name: 'Connectors' });
    await expect(page.add.getBoundingClientRect().top).toBe(title.getBoundingClientRect().top);
    // Each row's count under its line; "Connect" under the count.
    const connect = within(page.main).getByRole('button', { name: 'Connect Google Calendar' });
    const count = connect.closest('.cd-connector-directory__item')?.querySelector('.cd-connector-directory__meta') as HTMLElement;
    await expect(connect.getBoundingClientRect().top).toBeGreaterThan(count.getBoundingClientRect().bottom);
    // Nothing scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5);
    await expect(tooWide).toEqual([]);
    await expectTabOrder(userEvent, [menu, page.add, ...page.rows]);
  },
};

export const GoogleCalendarAdded: Story = {
  name: 'Google Calendar added',
  globals: { viewport: { value: 'laptop', isRotated: false } },
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <ConnectorsPage
        directory={GCAL_ADDED}
        notice={
          <Notice tone="info">
            Google Calendar is on. Claude asks you first before it checks when you’re busy, and never sees what an event is.
          </Notice>
        }
      />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-11-GCal-Done',
    canvasNote: [
      'Google Calendar is catalog-only in the demo, so this shows the Connectors page once it works: connected, “Added just now”, and the notice under the title.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const page = await expectConnectorsPage(canvasElement);
    const notice = canvas.getByRole('status');
    await expect(notice).toHaveTextContent(
      'Google Calendar is on. Claude asks you first before it checks when you’re busy, and never sees what an event is.',
    );
    await expect(
      within(page.main)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Built in', 'Connected']);
    await expect(within(page.main).getByRole('link', { name: /^Google Calendar Mock .* Added just now 1 tool$/ })).toBeVisible();
    await expect(expectMockBesideExternalNames(one(page.main, '.cd-connector-directory'))).toBe(2);
    const nav = within(within(canvasElement).getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    await expectTabOrder(userEvent, [...nav, page.add, ...page.rows]);
  },
};
