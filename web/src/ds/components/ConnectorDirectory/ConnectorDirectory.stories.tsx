import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { ConnectorDirectory } from './ConnectorDirectory.tsx';

const { directory } = rivera;

/** The board's state once Google Calendar can be connected: each available app with "Connect". */
const CONNECTABLE = directory.available.map(({ connector, tools }) => ({ connector, tools, onConnect: fn() }));

const meta = {
  title: 'Connectors/ConnectorDirectory',
  component: ConnectorDirectory,
  args: { ...directory, available: CONNECTABLE },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConnectorDirectory {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-23-Connectors' },
} satisfies Meta<typeof ConnectorDirectory>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The group named `title`: its section and its rows. */
function group(root: HTMLElement, title: string): { section: HTMLElement; rows: HTMLElement[] } {
  const section = within(root).getByRole('region', { name: title });
  return { section, rows: within(section).getAllByRole('listitem') };
}

export const RiveraConnectors: Story = {
  play: async ({ args, canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    // Three groups, in order: what is built in, the apps connected, and the apps to connect.
    const headings = canvas.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    await expect(headings).toEqual(['Built in', 'Connected', 'Available']);
    await expect(canvas.getByText(directory.builtInCaption)).toBeVisible();

    // Built in: a row per connector, each one link to its page, with no "Built in" beside a name.
    const builtIn = group(canvasElement, 'Built in');
    await expect(builtIn.rows).toHaveLength(6);
    const quotes = within(builtIn.section).getByRole('link', { name: /^Quotes Prices jobs from your price list\. 1 tool$/ });
    await expect(quotes).toHaveAttribute('href', '/connectors/quotes');
    expectComputed(quotes, { paddingTop: '14px', paddingLeft: '16px' });
    await expect(builtIn.section.querySelectorAll('.cd-connector-name__built-in')).toHaveLength(0);
    expectComputed(builtIn.section.querySelector('.cd-card') as HTMLElement, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopLeftRadius: '12px',
      paddingTop: '0px',
    });
    // Verification says it is always on, beside its count.
    await expect(within(builtIn.section).getByRole('link', { name: /^Verification .* Always on\s+1 tool$/ })).toBeVisible();
    // Rows sit under hairlines, the first under none.
    expectComputed(builtIn.rows[1] as HTMLElement, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    expectComputed(builtIn.rows[0] as HTMLElement, { borderTopWidth: '0px' });

    // Connected: Stripe, with its Mock badge, connected in words beside a dot, and the account.
    const connected = group(canvasElement, 'Connected');
    const stripe = within(connected.section).getByRole('link', { name: /^Stripe Mock .* Connected · Turner Plumbing, test mode \(mock\) 2 tools$/ });
    await expect(stripe).toHaveAttribute('href', '/connectors/stripe');
    await expect(stripe.querySelector('.cd-status-dot--handled')).not.toBeNull();

    // Available: Google Calendar, with its Mock badge and its count, and "Connect" in place of a link.
    const available = group(canvasElement, 'Available');
    await expect(within(available.section).queryByRole('link')).toBeNull();
    const connect = within(available.section).getByRole('button', { name: 'Connect Google Calendar' });
    await expect(within(available.section).getByText('1 tool')).toBeVisible();
    connect.click();
    await expect(args.available[0]?.onConnect).toHaveBeenCalledTimes(1);

    // mock_badge_always_beside_external_names
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(2);
  },
};

export const ComingSoonInTheDemo: Story = {
  args: { available: directory.available },
  parameters: {
    canvasNote:
      'Google Calendar is catalog-only in the demo, so the web app passes it coming soon, with no "Connect"; the signed board draws the "Connect" it will have once it works.',
  },
  play: async ({ canvasElement }) => {
    // coming_soon_has_no_connect: the app says it is coming soon beside its count, and nothing on
    // its row can be pressed or followed, so it never leads to a sign-in that can't finish.
    const available = group(canvasElement, 'Available');
    const [row] = available.rows;
    if (!row) throw new Error('No available app');
    const meta = row.querySelector<HTMLElement>('.cd-connector-directory__meta');
    await expect(meta?.textContent?.replace(/\s+/g, ' ')).toBe('Coming soon in this demo · 1 tool');
    await expect(within(row).queryByRole('button')).toBeNull();
    await expect(within(row).queryByRole('link')).toBeNull();
    await expect(expectMockBesideExternalNames(available.section)).toBe(1);
  },
};

export const GoogleCalendarAdded: Story = {
  args: {
    ...directory,
    connected: [
      ...directory.connected,
      {
        connector: rivera.googleCalendar.view,
        tools: 1,
        href: '/connectors/google-calendar',
        connection: 'Turner Plumbing jobs (mock)',
      },
    ],
    available: [],
    justAdded: rivera.googleCalendar.view.id,
  },
  parameters: {
    canvas: 'N-Conn-11-GCal-Done',
    canvasNote: 'Google Calendar is catalog-only in the demo, so this shows the list once it works, right after it was connected.',
  },
  play: async ({ canvas, canvasElement }) => {
    // With nothing left to connect, there is no Available group.
    await expect(canvas.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Built in', 'Connected']);
    const connected = group(canvasElement, 'Connected');
    await expect(connected.rows).toHaveLength(2);
    await expect(
      within(connected.section).getByRole('link', {
        name: /^Google Calendar Mock .* Connected · Turner Plumbing jobs \(mock\) · Added just now 1 tool$/,
      }),
    ).toBeVisible();
    // just_added_is_quiet: the words follow the account in its secondary ink, and the row's only
    // status colour is the dot beside "Connected".
    const [, calendar] = connected.rows as [HTMLElement, HTMLElement];
    const added = within(calendar).getByText('Added just now', { exact: false });
    expectComputed(added, { color: 'rgba(250, 249, 245, 0.64)' });
    const dots = [...calendar.querySelectorAll('.cd-status-dot')];
    await expect(dots).toHaveLength(1);
    await expect(dots[0]?.nextElementSibling?.textContent).toBe('Connected');
    // Only the row just added says so.
    await expect(canvas.getAllByText(/Added just now/)).toHaveLength(1);
  },
};

/** Payments, removed from the Desk earlier, added back from "Add a connector" a moment ago. */
export const BuiltInAddedBack: Story = {
  args: { available: directory.available, justAdded: 'payments' },
  parameters: {
    canvas: 'N-Conn-11-GCal-Done',
    canvasNote:
      'No board draws a built-in connector added back; the nearest is Google Calendar added, whose account line ends in "Added just now". A built-in row has no account, so the words take that line on their own.',
  },
  play: async ({ canvas, canvasElement }) => {
    // just_added_built_in: the words sit under the connector's line, in secondary meta, with no dot.
    const builtIn = group(canvasElement, 'Built in');
    const payments = within(builtIn.section).getByRole('link', { name: /^Payments .* Added just now 2 tools$/ });
    const line = within(payments).getByText(/^Payment links and charges/);
    const added = within(payments).getByText('Added just now');
    expectComputed(added, { color: 'rgba(250, 249, 245, 0.64)', fontSize: '14px' });
    await expect(added.getBoundingClientRect().top).toBeGreaterThanOrEqual(line.getBoundingClientRect().bottom - 1);
    await expect(payments.querySelectorAll('.cd-status-dot')).toHaveLength(0);
    await expect(canvas.getAllByText(/Added just now/)).toHaveLength(1);
    // The app still coming soon in the demo keeps its words and has nothing to press.
    const available = group(canvasElement, 'Available');
    const [row] = available.rows;
    if (!row) throw new Error('No available app');
    await expect(row.querySelector('.cd-connector-directory__meta')?.textContent?.replace(/\s+/g, ' ')).toBe('Coming soon in this demo · 1 tool');
    await expect(within(row).queryByRole('button')).toBeNull();
  },
};

/** `justAdded` naming an app that is still only available: nothing on the page says it was added. */
export const NotAddedWhileAvailable: Story = {
  args: { available: directory.available, justAdded: rivera.googleCalendar.view.id },
  parameters: { canvasNote: 'A guard, drawn on no board: an app the demo can\'t connect yet is never marked added.' },
  play: async ({ canvas, canvasElement }) => {
    // just_added_never_on_available: an app still to connect can't have been added, so its row
    // keeps only its coming-soon words.
    await expect(canvas.queryByText(/Added just now/)).toBeNull();
    const [row] = group(canvasElement, 'Available').rows;
    await expect(row?.querySelector('.cd-connector-directory__meta')?.textContent?.replace(/\s+/g, ' ')).toBe('Coming soon in this demo · 1 tool');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'N-Conn-24-Phone-Connectors',
    canvasNote:
      'The caption is the laptop board’s at every width; the phone board shortens it to “Remove one on its own page. Verification is always on.”',
  },
  play: async ({ canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    // Each row's count sits under its line, with its note before it; "Connect" under the count.
    const builtIn = group(canvasElement, 'Built in');
    const verification = builtIn.rows[3] as HTMLElement;
    const line = within(verification).getByText('Confirms a customer is who they say.');
    const meta = verification.querySelector<HTMLElement>('.cd-connector-directory__meta');
    if (!meta) throw new Error('No count');
    await expect(meta.textContent?.replace(/\s+/g, ' ')).toBe('Always on · 1 tool');
    await expect(meta.getBoundingClientRect().top).toBeGreaterThanOrEqual(line.getBoundingClientRect().bottom - 1);
    const available = group(canvasElement, 'Available');
    const connect = within(available.section).getByRole('button', { name: 'Connect Google Calendar' });
    const count = within(available.section).getByText('1 tool');
    await expect(connect.getBoundingClientRect().top).toBeGreaterThanOrEqual(count.getBoundingClientRect().bottom - 1);
    // Nothing scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5);
    await expect(tooWide).toEqual([]);
  },
};
