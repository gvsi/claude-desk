import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { SubNav } from './SubNav.tsx';

const meta = {
  title: 'Navigation/SubNav',
  component: SubNav,
  args: {
    label: 'Settings',
    // Connectors live only under Rules, so Settings has no Integrations or Connectors entry.
    items: [
      { key: 'general', label: 'General', href: '/settings/general' },
      { key: 'knowledge', label: 'Knowledge', href: '/settings/knowledge' },
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
    canvas: 'none',
    canvasNote: "No signed board draws Settings; its rows follow the sidebar's nav rows on N-Conn-23-Connectors (36 px, the current one on the selected fill).",
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
    await expect(links.map((link) => link.textContent)).toEqual(['General', 'Knowledge', 'Notifications', 'Channels', 'Billing']);
    await expect(within(nav).queryByRole('link', { name: /Integrations|Connectors/ })).toBeNull();
    const current = within(nav).getByRole('link', { name: 'General' });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAttribute('href', '/settings/general');
    for (const link of links.slice(1)) await expect(link).not.toHaveAttribute('aria-current');
    // Vertical rows, size-nav-row tall, the current one on the selected fill.
    expectComputed(current, { height: '36px', backgroundColor: 'rgb(60, 57, 47)', borderTopLeftRadius: '8px' });
    expectComputed(links[1] as Element, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    const [first, second] = links.map((link) => link.getBoundingClientRect());
    if (!first || !second) throw new Error('Expected two rows');
    await expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  },
};

export const Phone: Story = {
  args: { current: 'channels' },
  render: (args) => <SubNav {...args} />,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvasNote: 'At phone width the rows become one line that scrolls sideways inside itself; no board draws it.',
  },
  play: async ({ canvas }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const nav = canvas.getByRole('navigation', { name: 'Settings' });
    const links = within(nav).getAllByRole('link');
    // One row: every link on the first link's line.
    const top = links[0]?.getBoundingClientRect().top;
    for (const link of links) await expect(link.getBoundingClientRect().top).toBe(top);
    // The list scrolls inside itself, so the page never does.
    const list = within(nav).getByRole('list');
    expectComputed(list, { overflowX: 'auto' });
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await expect(within(nav).getByRole('link', { name: 'Channels' })).toHaveAttribute('aria-current', 'page');
  },
};
