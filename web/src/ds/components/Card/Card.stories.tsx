import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';
import { Card } from './Card.tsx';

const meta = {
  title: 'Layout/Card',
  component: Card,
  args: { children: null },
  parameters: { layout: 'padded', canvas: 'N-Rules-Rivera' },
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

// The canvas card: a 3% fill, a 1 px border at 14% and a 12 px radius.
const CARD_LOOK = {
  backgroundColor: 'rgba(250, 249, 245, 0.03)',
  borderTopWidth: '1px',
  borderTopStyle: 'solid',
  borderTopColor: 'rgba(250, 249, 245, 0.14)',
  borderTopLeftRadius: '12px',
} as const;

export const Default: Story = {
  args: {
    as: 'article',
    label: 'Quotes',
    padding: 16,
    children: (
      <>
        <h3 className="cd-type-section" style={{ margin: 0 }}>
          Quotes
        </h3>
        <p className="cd-type-caption" style={{ margin: 'var(--space-2) 0 0', color: 'var(--text-secondary)' }}>
          Commits to a price. Can be revised.
        </p>
        <p className="cd-type-caption" style={{ margin: 'var(--space-12) 0 0', color: 'var(--text-secondary)' }}>
          Anything else here: ask me.
        </p>
      </>
    ),
  },
  render: (args) => (
    <div style={{ maxWidth: 360 }}>
      <Card {...args} />
    </div>
  ),
  parameters: { canvasNote: 'A capability card from the board with its rule rows left out; those are Plan 03b components.' },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('article', { name: 'Quotes' });
    expectComputed(card, { ...CARD_LOOK, paddingTop: '16px', paddingLeft: '16px' });
  },
};

export const WithStatusHeader: Story = {
  args: {
    as: 'article',
    label: 'Live handoff: customer in Rockridge',
    children: (
      <>
        <div className="cd-type-caption" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)', color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 520 }}>
            <StatusLabel tone="held">Wants you live</StatusLabel>
          </span>
          <span style={{ marginLeft: 'auto' }}>Waiting 0:48</span>
        </div>
        <p className="cd-type-summary" style={{ margin: 'var(--space-12) 0 0' }}>
          A customer in Rockridge wants to talk to you before booking.
        </p>
        <p className="cd-type-caption" style={{ margin: 'var(--space-10) 0 0', color: 'var(--text-secondary)' }}>
          Public visitor, web chat.
        </p>
      </>
    ),
  },
  render: (args) => (
    <div style={{ maxWidth: 320 }}>
      <Card {...args} />
    </div>
  ),
  parameters: {
    canvas: 'N-Today-NeedsYou',
    canvasNote: 'The live handoff card without its two buttons, which the Today screen adds.',
  },
  play: async ({ canvas, canvasElement }) => {
    const card = canvas.getByRole('article', { name: 'Live handoff: customer in Rockridge' });
    // The roomy padding is the default.
    expectComputed(card, { ...CARD_LOOK, paddingTop: '20px', paddingLeft: '20px' });
    // The status is the words; the dot beside them is hidden from screen readers.
    await expect(canvas.getByText('Wants you live')).toBeVisible();
    const dot = canvasElement.querySelector('.cd-status-dot');
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
  },
};
