import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { RecentRequests } from './RecentRequests.tsx';

const meta = {
  title: 'Connectors/RecentRequests',
  component: RecentRequests,
  args: { rows: rivera.recentRequests.refund },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <RecentRequests {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Conn-05-Refund',
    canvasNote:
      "Each request reads the decision's own words (its reason_plain), so Dana's held refund says she was verified with a code, and the refunded deposit is Lucía Herrera's, as in the seed.",
  },
} satisfies Meta<typeof RecentRequests>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Refund: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    const section = canvas.getByRole('region', { name: 'Recent requests under these rules' });
    await expect(within(section).getByRole('heading', { level: 2, name: 'Recent requests under these rules' })).toBeVisible();
    const items = within(section).getAllByRole('listitem');
    await expect(items).toHaveLength(args.rows.length);
    // recent_requests_show_outcomes_in_words: each row's outcome in words, beside a dot of its tone.
    for (const [index, row] of args.rows.entries()) {
      const item = items[index] as HTMLElement;
      const outcome = within(item).getByText(row.outcome);
      const dot = outcome.closest('.cd-status-label')?.querySelector(`.cd-status-dot--${row.tone}`);
      await expect(dot).not.toBeUndefined();
      await expect(dot).not.toBeNull();
      // When, what and why, as the screen words them.
      await expect(within(item).getByText(row.when)).toBeVisible();
      await expect(within(item).getByText(row.why)).toBeVisible();
      // Each row links to its record: the request's words are the link, described by the rest.
      const link = within(item).getByRole('link', { name: row.what });
      await expect(link).toHaveAttribute('href', row.href);
      await expect(link).toHaveAccessibleDescription(`${row.when} ${row.why} ${row.outcome}`);
    }
    await expect(canvas.getAllByRole('link')).toHaveLength(args.rows.length);
    // Rows under hairlines; when in secondary meta, why in secondary caption type, what in body type.
    const first = items[0] as HTMLElement;
    const row = args.rows[0];
    if (!row) throw new Error('No rows');
    expectComputed(first, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    expectComputed(within(first).getByText(row.when), { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(within(first).getByText(row.why), { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(within(first).getByRole('link'), { fontSize: '14px', color: 'rgba(250, 249, 245, 0.92)' });
    // The whole row opens the record: the link's overlay covers it.
    const overlay = getComputedStyle(within(first).getByRole('link'), '::after');
    await expect([overlay.position, overlay.top, overlay.bottom]).toEqual(['absolute', '0px', '0px']);
    // The outcome sits at the right of the request's words.
    const outcome = within(first).getByText(row.outcome);
    await expect(outcome.getBoundingClientRect().left).toBeGreaterThan(within(first).getByRole('link').getBoundingClientRect().right);
    // By keyboard, the row's overlay draws the focus edge: 1 px of line-focus just inside the row, at
    // the control radius, and no ring outside it; the words' own link draws nothing around them.
    await userEvent.tab();
    const firstLink = within(first).getByRole('link');
    await expect(firstLink).toHaveFocus();
    const edge = getComputedStyle(firstLink, '::after');
    await expect([edge.outlineStyle, edge.boxShadow, edge.borderTopLeftRadius]).toEqual(['none', 'rgba(250, 249, 245, 0.64) 0px 0px 0px 1px inset', '8px']);
    await expect([getComputedStyle(firstLink).outlineStyle, getComputedStyle(firstLink).boxShadow]).toEqual(['none', 'none']);
  },
};

export const Quote: Story = {
  args: { rows: rivera.recentRequests.quote },
  parameters: { canvas: 'N-Conn-06-Quote', canvasNote: "The held quote reads the decision's own words (its reason_plain)." },
  play: async ({ args, canvas }) => {
    const items = canvas.getAllByRole('listitem');
    await expect(items.map((item) => within(item).getByRole('link').textContent)).toEqual(args.rows.map((row) => row.what));
  },
};

export const WithoutRecords: Story = {
  args: { rows: rivera.recentRequests.refund.map(({ href: _href, ...row }) => row) },
  parameters: { canvasNote: "Requests whose records the screen can't link: each row is words only." },
  play: async ({ args, canvas }) => {
    await expect(canvas.queryByRole('link')).toBeNull();
    for (const row of args.rows) await expect(canvas.getByText(row.what)).toBeVisible();
  },
};

export const Empty: Story = {
  args: { rows: [] },
  parameters: { canvasNote: 'A tool with no requests yet; no board draws it.' },
  play: async ({ canvas }) => {
    // recent_requests_show_outcomes_in_words: the empty state says so in one line.
    await expect(canvas.getByRole('heading', { name: 'Recent requests under these rules' })).toBeVisible();
    await expect(canvas.getByText('No requests under these rules yet.')).toBeVisible();
    await expect(canvas.queryByRole('list')).toBeNull();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: 'The rows on a phone, each part on its own line; no board draws a tool page on a phone.' },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const first = canvas.getAllByRole('listitem')[0] as HTMLElement;
    const link = within(first).getByRole('link');
    const row = rivera.recentRequests.refund[0];
    if (!row) throw new Error('No rows');
    // The outcome sits on its own line under the request's words.
    await expect(within(first).getByText(row.outcome).getBoundingClientRect().top).toBeGreaterThanOrEqual(link.getBoundingClientRect().bottom);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
