import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { AlwaysOnList } from './AlwaysOnList.tsx';

const meta = {
  title: 'Rules/AlwaysOnList',
  component: AlwaysOnList,
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <AlwaysOnList {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-12-Chat' },
} satisfies Meta<typeof AlwaysOnList>;

export default meta;

type Story = StoryObj<typeof meta>;

const LINES = [
  "Always says it's an AI",
  'Private data only to its verified owner',
  'Codes only go to the contact on record',
  'No money moves without your rule or a signed limit',
  'Every attempt is logged and shown to you',
];

export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    const heading = canvas.getByRole('heading', { level: 2, name: 'Always on' });
    await expect(heading).toBeVisible();
    await expect(canvas.getByText("On every Desk, whatever is connected. They can't be turned off.")).toBeVisible();
    const region = canvas.getByRole('region', { name: 'Always on' });
    const items = canvas.getAllByRole('listitem');
    await expect(items.map((item) => item.textContent)).toEqual(LINES);
    // A lock beside each line, hidden from screen readers.
    for (const item of items) {
      const lock = item.querySelector('svg');
      await expect(lock).toHaveAttribute('aria-hidden', 'true');
      expectComputed(item, { fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    }
    // always_on_has_no_controls
    await expect(region.querySelectorAll('button, input, select, textarea, a, [role="switch"]')).toHaveLength(0);
    await expect(canvasElement.querySelectorAll('button, input')).toHaveLength(0);
  },
};
