import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';
import { Card } from './Card.tsx';

const meta = {
  title: 'Layout/Card',
  component: Card,
  args: { children: null },
  parameters: { layout: 'padded', canvas: 'N-Conn-23-Connectors' },
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
    label: 'Quote',
    padding: 16,
    children: (
      <>
        <h3 className="cd-type-section" style={{ margin: 0 }}>
          Quote
        </h3>
        <p className="cd-type-caption" style={{ margin: 'var(--space-2) 0 0', color: 'var(--text-secondary)' }}>
          Prices a job from your price list. Changes something. Can be undone.
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
  parameters: { canvasNote: "A tool's rules card with its rule rows left out; ToolRulesCard draws them." },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('article', { name: 'Quote' });
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
    canvas: 'N-Today-Run1',
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

/**
 * A card that holds cards: the agents page's "Send an agent" card holds the agent's run, and the
 * Desk's reply cards sit in it, one level deep (N-R2-Agents-04-Run).
 */
export const HoldsCards: Story = {
  name: 'Holds cards',
  args: {
    as: 'section',
    label: 'Send an agent',
    padding: 16,
    holdsCards: true,
    children: (
      <>
        <h2 className="cd-type-section" style={{ margin: 0 }}>
          Send an agent
        </h2>
        <p className="cd-type-meta" style={{ margin: 'var(--space-2) 0 var(--space-10)', color: 'var(--text-secondary)' }}>
          Book the earliest visit
        </p>
        <div style={{ maxWidth: 520 }}>
          <Card as="article" label="Booked" padding={16}>
            <p className="cd-type-body" style={{ margin: 0, fontWeight: 520 }}>
              Thursday, October 29
            </p>
            <p className="cd-type-meta" style={{ margin: 'var(--space-2) 0 0', color: 'var(--text-secondary)' }}>
              2:00 pm to 4:00 pm
            </p>
          </Card>
        </div>
      </>
    ),
  },
  render: (args) => (
    <div style={{ maxWidth: 760 }}>
      <Card {...args} />
    </div>
  ),
  parameters: {
    canvas: 'N-R2-Agents-04-Run',
    canvasNote: 'The “Send an agent” card holding one reply card, with the run’s messages and receipts left out; the board story draws them.',
  },
  play: async ({ canvas }) => {
    // Both are cards, in the card look; the held one sits inside the frame's 16 px.
    const frame = canvas.getByRole('region', { name: 'Send an agent' });
    const held = canvas.getByRole('article', { name: 'Booked' });
    expectComputed(frame, { ...CARD_LOOK, paddingTop: '16px', paddingLeft: '16px' });
    expectComputed(held, { ...CARD_LOOK, paddingTop: '16px', paddingLeft: '16px' });
    await expect(frame).toContainElement(held);
    await expect(Math.round(held.getBoundingClientRect().left - frame.getBoundingClientRect().left)).toBe(17);
  },
};
