import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, waitFor } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { ConnectorSection } from '../ConnectorSection/ConnectorSection.tsx';
import { ConnectorList, type ConnectorListProps } from './ConnectorList.tsx';

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
  parameters: { layout: 'padded', canvas: 'N-Conn-12-Chat' },
} satisfies Meta<typeof ConnectorList>;

export default meta;

type Story = StoryObj<typeof meta>;

const NAMES = ['Quotes', 'Bookings', 'Leads and callbacks', 'Verification', 'Documents', 'Payments', 'Stripe'];

export const RiveraHub: Story = {
  parameters: { canvasNote: 'Turner keeps Documents, so the hub has six built-in connectors.' },
  play: async ({ args, canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
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
  parameters: { canvas: 'none', canvasNote: 'No current board draws the Rules page on a phone; this is the archived first phone Rules board’s layout.' },
  play: async ({ canvas, canvasElement }) => {
    // phone_hides_descriptions: at 390 px the summary and the last button go, as the archived phone
    // Rules board drew them, and nothing scrolls sideways.
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

export const OnTheRulesPage: Story = {
  args: { onAddConnector: undefined },
  parameters: { canvasNote: 'The Rules page adds no connectors: they are added from the Connectors page, so the list ends with its last section.' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('list', { name: 'Connectors' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Add a connector' })).toBeNull();
  },
};

/** The Rules page's summary for rules version `n`. */
const versionLine = (n: number) => `Version ${n} of your rules, checked against the always-on rules`;

/** The list drawn at version 7, then at 8 once it is on screen, as a confirmed change lands. */
function VersionLands(args: ConnectorListProps) {
  const [version, setVersion] = useState(7);
  useEffect(() => setVersion(8), []);
  return <ConnectorList {...args} summary={versionLine(version)} />;
}

export const VersionChanges: Story = {
  args: { onAddConnector: undefined },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <VersionLands {...args} />
    </div>
  ),
  parameters: {
    canvasNote:
      'The signed board draws the summary at rest; the review board UXC-P701-After draws the version number cross-fading as a confirmed change lands. Storybook shows the motion your system asks for: under reduced motion the new number is there at once.',
  },
  play: async ({ canvasElement }) => {
    const line = canvasElement.querySelector<HTMLElement>('.cd-connector-list__summary');
    if (!line) throw new Error('no summary');
    // Only the number moves; once it has, the line reads the new version.
    await Promise.all(line.getAnimations({ subtree: true }).map((fade) => fade.finished));
    await waitFor(() => expect(line.textContent).toBe(versionLine(8)));
    await expect(line.querySelector('.cd-cross-fade')).toBeNull();
  },
};
