import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ConnectorName } from './ConnectorName.tsx';

const meta = {
  title: 'Connectors/ConnectorName',
  component: ConnectorName,
  args: { connector: rivera.connectors.views.payments, size: 'section' },
  parameters: { layout: 'padded', canvas: 'N-Conn-23-Connectors' },
} satisfies Meta<typeof ConnectorName>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The name at each size: the page's title, a section on the hub, and inline in a line of meta. */
function AllSizes(args: Parameters<typeof ConnectorName>[0]) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-16)' }}>
      <ConnectorName {...args} size="page" level={1} />
      <ConnectorName {...args} size="section" />
      <p className="cd-type-meta" style={{ margin: 0 }}>
        <span style={{ color: 'var(--text-secondary)' }}>
          From <ConnectorName {...args} size="inline" />
        </span>
      </p>
    </div>
  );
}

export const BuiltIn: Story = {
  render: (args) => <AllSizes {...args} />,
  play: async ({ canvas, canvasElement }) => {
    // The page size is the page's serif heading; the others are spans.
    const heading = canvas.getByRole('heading', { level: 1 });
    await expect(heading).toHaveTextContent('Payments Built in');
    const title = heading.querySelector('.cd-connector-name__name');
    if (title === null) throw new Error('No name in the heading');
    expectComputed(title, { fontFamily: /Source Serif 4/, fontSize: '26px', lineHeight: '34px' });
    // Beside each name, "Built in" in quiet caption type, and no Mock badge.
    const builtIn = canvas.getAllByText('Built in');
    await expect(builtIn).toHaveLength(3);
    for (const label of builtIn) expectComputed(label, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(canvas.queryByText('Mock')).toBeNull();
    // The section size is the section type; inline takes the line's own type.
    const names = [...canvasElement.querySelectorAll('.cd-connector-name__name')];
    expectComputed(names[1] ?? heading, { fontSize: '16px', fontWeight: '520' });
    expectComputed(names[2] ?? heading, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
  },
};

export const Mock: Story = {
  args: { connector: rivera.connectors.views.stripe },
  render: (args) => <AllSizes {...args} />,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Stripe Mock');
    // mock_badge_always_beside_external_names: an outlined "Mock" pill beside every "Stripe".
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(3);
    for (const pill of canvas.getAllByText('Mock')) await expect(pill).toHaveClass('cd-pill');
    await expect(canvas.queryByText('Built in')).toBeNull();
  },
};

export const WithoutBuiltIn: Story = {
  args: { hideBuiltIn: true },
  render: (args) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-16)' }}>
      <ConnectorName {...args} />
      <ConnectorName {...args} connector={rivera.connectors.views.stripe} />
    </div>
  ),
  parameters: {
    canvas: 'N-Conn-12-Chat',
    canvasNote: 'Where the page already groups connectors (the Rules page here, and the Connectors page), a built-in name stands alone; an app keeps its Mock badge.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByText('Built in')).toBeNull();
    await expect(canvas.getByText('Payments')).toBeVisible();
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
  },
};
