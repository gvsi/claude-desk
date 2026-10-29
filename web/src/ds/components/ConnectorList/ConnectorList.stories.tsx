import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ConnectorSection } from '../ConnectorSection/ConnectorSection.tsx';
import { ConnectorList } from './ConnectorList.tsx';

const meta = {
  title: 'Connectors/ConnectorList',
  component: ConnectorList,
  args: {
    summary: rivera.connectors.summary,
    onAddConnector: fn(),
    children: rivera.connectors.sections.map((section) => <ConnectorSection key={section.connector.id} {...section} />),
  },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConnectorList {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-01-Rules' },
} satisfies Meta<typeof ConnectorList>;

export default meta;

type Story = StoryObj<typeof meta>;

const NAMES = ['Quotes', 'Bookings', 'Leads and callbacks', 'Verification', 'Documents', 'Payments', 'Stripe'];

export const RiveraHub: Story = {
  parameters: { canvasNote: 'Rivera keeps Documents, so the hub has six built-in connectors.' },
  play: async ({ args, canvas, canvasElement }) => {
    await expect(canvas.getByText(rivera.connectors.summary)).toBeVisible();
    // A list named "Connectors", one item per section, in the hub's order.
    const list = canvas.getByRole('list', { name: 'Connectors' });
    const items = [...list.children];
    await expect(items.map((item) => item.querySelector('section')?.getAttribute('aria-label'))).toEqual(NAMES);
    await expect(items.every((item) => item.tagName === 'LI')).toBe(true);
    // mock_badge_always_beside_external_names
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    // "Add a connector" after the last item.
    const add = canvas.getByRole('button', { name: 'Add a connector' });
    await expect(add.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await add.click();
    await expect(args.onAddConnector).toHaveBeenCalledTimes(1);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-Conn-16-Phone-Rules' },
  play: async ({ canvas, canvasElement }) => {
    // phone_hides_descriptions: at 390 px the summary and the last button go, as the phone board
    // draws them (the page header keeps its "Add a connector"), and nothing scrolls sideways.
    const width = window.innerWidth;
    await expect(width).toBe(390);
    await expect(canvas.getByText(rivera.connectors.summary)).not.toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Add a connector' })).toBeNull();
    for (const description of rivera.connectors.sections.map((section) => section.connector.description)) {
      await expect(canvas.getByText(description)).not.toBeVisible();
    }
    await expect(canvas.getAllByRole('listitem').length).toBeGreaterThan(7);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
