import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { SubNav } from './SubNav.tsx';

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

const meta = {
  title: 'Navigation/SubNav',
  component: SubNav,
  args: {
    label: 'Settings',
    // Connectors have their own tab, so Settings has no Integrations or Connectors entry.
    items: [
      { key: 'general', label: 'General', href: '/settings/general' },
      { key: 'notifications', label: 'Notifications', href: '/settings/notifications' },
      { key: 'channels', label: 'Channels', href: '/settings/channels' },
      { key: 'billing', label: 'Billing', href: '/settings/billing' },
    ],
    current: 'general',
  },
  render: (args) => (
    <div style={{ maxWidth: 220 }}>
      <SubNav {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Run2-Settings-General',
    canvasNote: 'The section links at the left of Settings, on their own: 36 px rows 2 px apart, the current one on the selected fill.',
  },
} satisfies Meta<typeof SubNav>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Settings: Story = {
  play: async ({ canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    // current_is_marked: a nav named by its label, one link per item, the current one marked.
    const nav = canvas.getByRole('navigation', { name: 'Settings' });
    const links = within(nav).getAllByRole('link');
    await expect(links.map((link) => link.textContent)).toEqual(['General', 'Notifications', 'Channels', 'Billing']);
    await expect(within(nav).queryByRole('link', { name: /Integrations|Connectors/ })).toBeNull();
    const current = within(nav).getByRole('link', { name: 'General' });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAttribute('href', '/settings/general');
    for (const link of links.slice(1)) await expect(link).not.toHaveAttribute('aria-current');
    // Vertical rows, size-nav-row tall, the current one on the selected fill.
    expectComputed(current, { height: '36px', backgroundColor: 'rgb(60, 57, 47)', borderTopLeftRadius: '8px', color: PRIMARY });
    // The other rows in secondary text, as N-Run2-Settings-General draws them.
    for (const link of links.slice(1)) expectComputed(link, { backgroundColor: 'rgba(0, 0, 0, 0)', color: SECONDARY });
    const [first, second] = links.map((link) => link.getBoundingClientRect());
    if (!first || !second) throw new Error('Expected two rows');
    await expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  },
};

export const Phone: Story = {
  args: { current: 'channels' },
  // In a phone page's 16 px gutters.
  render: (args) => (
    <div style={{ padding: 'var(--space-16)' }}>
      <SubNav {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Phone',
    canvasNote: 'The links as N-Run2-Settings-Phone draws them, with Channels current where the board marks General.',
  },
  play: async ({ canvas }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const nav = canvas.getByRole('navigation', { name: 'Settings' });
    const links = within(nav).getAllByRole('link');
    // One row: every link on the first link's line, 4 px apart.
    const top = links[0]?.getBoundingClientRect().top;
    for (const link of links) await expect(link.getBoundingClientRect().top).toBe(top);
    await expect(Math.round(links[1]!.getBoundingClientRect().left - links[0]!.getBoundingClientRect().right)).toBe(4);
    // sub_nav_runs_edge_to_edge_on_a_phone: across the page's gutters, over a hairline 4 px under the
    // links; the first link at the gutter, level with the nav's top.
    const box = nav.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.width)]).toEqual([0, width]);
    expectComputed(nav, { borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: 'rgba(250, 249, 245, 0.12)' });
    await expect(Math.round(links[0]!.getBoundingClientRect().left)).toBe(16);
    await expect(Math.round(links[0]!.getBoundingClientRect().top)).toBe(Math.round(box.top));
    await expect(Math.round(box.bottom - 1 - links[0]!.getBoundingClientRect().bottom)).toBe(4);
    // The list scrolls inside itself, so the page never does.
    const list = within(nav).getByRole('list');
    expectComputed(list, { overflowX: 'auto' });
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await expect(within(nav).getByRole('link', { name: 'Channels' })).toHaveAttribute('aria-current', 'page');
  },
};

export const PhoneWiderGutters: Story = {
  args: { current: 'general' },
  // A page with 24 px gutters says so through --cd-sub-nav-bleed.
  render: (args) => (
    <div style={{ padding: 'var(--space-24)', ['--cd-sub-nav-bleed' as string]: 'var(--space-24)' }}>
      <SubNav {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'none',
    canvasNote: 'No board draws a phone page with 24 px gutters; N-Run2-Settings-Phone draws 16. The bleed follows --cd-sub-nav-bleed, so the line still runs edge to edge.',
  },
  play: async ({ canvas }) => {
    const nav = canvas.getByRole('navigation', { name: 'Settings' });
    // sub_nav_bleed_follows_the_gutter: edge to edge across 24 px gutters, the first link at the gutter.
    await expect([Math.round(nav.getBoundingClientRect().left), Math.round(nav.getBoundingClientRect().width)]).toEqual([0, window.innerWidth]);
    await expect(Math.round(within(nav).getAllByRole('link')[0]!.getBoundingClientRect().left)).toBe(24);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
