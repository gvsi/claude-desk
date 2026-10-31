import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { ConnectorIcon, type ConnectorIconName } from './ConnectorIcon.tsx';

const meta = {
  title: 'Connectors/ConnectorIcon',
  component: ConnectorIcon,
  args: { icon: 'quotes', size: 'section' },
  parameters: { layout: 'padded', canvas: 'N-Conn-23-Connectors' },
} satisfies Meta<typeof ConnectorIcon>;

export default meta;

type Story = StoryObj<typeof meta>;

const SIZES = ['page', 'section', 'inline'] as const;
const TILE_PX = { page: '48px', section: '36px', inline: '24px' } as const;
const MARK_PX = { page: '26px', section: '20px', inline: '13px' } as const;

const GOOGLE_CALENDAR: ConnectorView = {
  id: 'google_calendar',
  name: 'Google Calendar',
  icon: 'google_calendar',
  description: "Lets Claude see when you're busy, never what the event is.",
  source: { kind: 'external', mock: true },
};

/** Each connector's tile at every size, beside its name as the hub shows it. */
function Tiles({ connectors }: { connectors: readonly ConnectorView[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-16)' }}>
      {connectors.map((connector) => (
        <li key={connector.id} data-connector={connector.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-14)' }}>
          {SIZES.map((size) => (
            <ConnectorIcon key={size} icon={connector.icon} size={size} />
          ))}
          <ConnectorName connector={connector} size="section" />
        </li>
      ))}
    </ul>
  );
}

/** Checks one icon: its box's size, its 8 px radius, its ground, and its mark's size; hidden from screen readers. */
function expectTile(tile: Element, size: (typeof SIZES)[number], ground: string) {
  expectComputed(tile, { width: TILE_PX[size], height: TILE_PX[size], borderTopLeftRadius: '8px', backgroundColor: ground });
  const mark = tile.querySelector('svg');
  if (mark === null) throw new Error('The tile has no mark');
  expectComputed(mark, { width: MARK_PX[size], height: MARK_PX[size] });
}

const BUILT_IN = ['quotes', 'bookings', 'leads', 'verification', 'documents', 'payments'] as const satisfies readonly ConnectorIconName[];

export const BuiltIn: Story = {
  render: () => <Tiles connectors={BUILT_IN.map((id) => rivera.connectors.views[id])} />,
  play: async ({ canvasElement }) => {
    const rows = [...canvasElement.querySelectorAll('[data-connector]')];
    await expect(rows.map((row) => row.getAttribute('data-connector'))).toEqual([...BUILT_IN]);
    for (const row of rows) {
      const tiles = [...row.querySelectorAll('.cd-connector-icon')];
      await expect(tiles).toHaveLength(3);
      // A built-in tile: the line icon in text-primary on fill-secondary.
      tiles.forEach((tile, index) => expectTile(tile, SIZES[index] ?? 'section', 'rgba(250, 249, 245, 0.1)'));
      for (const tile of tiles) {
        await expect(tile).toHaveAttribute('aria-hidden', 'true');
        expectComputed(tile, { color: 'rgba(250, 249, 245, 0.92)' });
      }
    }
  },
};

export const Brands: Story = {
  render: () => <Tiles connectors={[rivera.connectors.views.stripe, GOOGLE_CALENDAR]} />,
  parameters: {
    canvas: 'N-Conn-07b-Add-Picker-ComingSoon',
    canvasNote:
      'Google Calendar is catalog-only in the demo; its mark shows what the component draws once it works. The board draws the marks on a white tile; they have none (N-Explore-Connector-Decided, signed 2026-10-30).',
  },
  play: async ({ canvasElement }) => {
    // brand_marks_have_no_tile: a third-party connector's own mark with no tile behind it (owner,
    // 2026-10-30): Stripe's in white on the dark page, as Stripe's guidelines allow, and Google
    // Calendar's in its own blue.
    const fills = { stripe: 'rgb(255, 255, 255)', google_calendar: 'rgb(66, 133, 244)' } as const;
    for (const [id, fill] of Object.entries(fills)) {
      const tiles = [...canvasElement.querySelectorAll(`[data-connector="${id}"] .cd-connector-icon`)];
      await expect(tiles).toHaveLength(3);
      tiles.forEach((tile, index) => expectTile(tile, SIZES[index] ?? 'section', 'rgba(0, 0, 0, 0)'));
      for (const tile of tiles) {
        await expect(tile).toHaveAttribute('aria-hidden', 'true');
        const path = tile.querySelector('path');
        if (path === null) throw new Error(`${id} has no mark`);
        expectComputed(path, { fill });
      }
    }
    // mock_badge_always_beside_external_names
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(2);
  },
};
