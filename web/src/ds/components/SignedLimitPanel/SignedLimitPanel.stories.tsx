import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Card } from '../Card/Card.tsx';
import { SignedLimitPanel } from './SignedLimitPanel.tsx';

/** The built-in agent's signed mandate, as `POST /agents/demo` returns it: $20 a charge, $100 in all, for one hour. */
const mandate = rivera.demoAgentIssued.mandate;

/**
 * Stands in for the web app's `formatCents` ("$20", "$40.50"): the design system formats no money
 * itself, so the page passes its own. These amounts are whole dollars.
 */
function dollars(cents: number): string {
  return `$${cents / 100}`;
}

const SOURCE = 'Signed limit from Alex Kim’s demo wallet';

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

const meta = {
  title: 'Agents/SignedLimitPanel',
  component: SignedLimitPanel,
  args: {
    perChargeCents: mandate.per_charge_cents,
    totalCents: mandate.total_cents,
    formatCents: fn(dollars),
    duration: 'One hour',
    source: SOURCE,
  },
  // In the "Send an agent" card at the agents page's 760 px, as the board nests it.
  render: (args) => (
    <div style={{ maxWidth: 760 }}>
      <Card as="section" label="Send an agent" padding={16}>
        <SignedLimitPanel {...args} />
      </Card>
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Agents-03-Send' },
} satisfies Meta<typeof SignedLimitPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Each term as a screen reader pairs it: its name, then its value. */
function terms(panel: HTMLElement): string[][] {
  return [...panel.querySelectorAll('dl > div')].map((term) => [term.querySelector('dt')?.textContent ?? '', term.querySelector('dd')?.textContent ?? '']);
}

export const SendAnAgent: Story = {
  name: 'Send an agent',
  parameters: { canvasNote: 'The panel in the “Send an agent” card, as N-R2-Agents-03 and -05 draw it: the mandate’s amounts and how long it lasts, and who signed it at the right.' },
  play: async ({ args, canvas }) => {
    // signed_limit_reads_the_mandate: the amounts are the mandate's own cents, written by the page's
    // formatter; how long it lasts and who signed it are the page's words. Nothing else is shown.
    const panel = canvas.getByRole('region', { name: 'Signed limit' });
    await expect(terms(panel)).toEqual([
      ['Per charge', '$20'],
      ['In total', '$100'],
      ['For', 'One hour'],
    ]);
    await expect(args.formatCents).toHaveBeenCalledWith(2000);
    await expect(args.formatCents).toHaveBeenCalledWith(10000);
    await expect(args.formatCents).toHaveBeenCalledTimes(2);
    const source = within(panel).getByText(SOURCE);

    // The board's inset: the card look, padded 12 px 16 px, 63 px tall, the terms 16 px apart, each
    // name in secondary caption type over its value in body type at 520.
    expectComputed(panel, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      paddingTop: '12px',
      paddingRight: '16px',
      paddingBottom: '12px',
      paddingLeft: '16px',
    });
    await expect(Math.round(panel.getBoundingClientRect().height)).toBe(63);
    const parts = [...panel.querySelectorAll<HTMLElement>('dl > div')];
    for (const part of parts) {
      expectComputed(part.querySelector('dt') as HTMLElement, { fontSize: '12px', lineHeight: '17px', color: SECONDARY, marginLeft: '0px' });
      expectComputed(part.querySelector('dd') as HTMLElement, { fontSize: '14px', lineHeight: '20px', fontWeight: '520', color: PRIMARY, marginLeft: '0px' });
    }
    for (const [index, part] of parts.slice(1).entries()) {
      await expect(Math.round(part.getBoundingClientRect().left - (parts[index] as HTMLElement).getBoundingClientRect().right)).toBe(16);
    }
    // Who signed it, in secondary caption type at the right, centered on the panel.
    expectComputed(source, { fontSize: '12px', lineHeight: '17px', color: SECONDARY });
    const panelBox = panel.getBoundingClientRect();
    const sourceBox = source.getBoundingClientRect();
    await expect(Math.round(panelBox.right - sourceBox.right)).toBe(17);
    await expect(Math.round(sourceBox.top + sourceBox.height / 2)).toBe(Math.round(panelBox.top + panelBox.height / 2));
  },
};

export const NotWholeCents: Story = {
  name: 'Not whole cents',
  args: { perChargeCents: 20.5 },
  parameters: { canvas: 'none', canvasNote: 'A guard for N-R2-Agents-03’s panel: an amount that isn’t a whole number of cents draws no panel at all.' },
  play: async ({ args, canvasElement }) => {
    // signed_limit_fails_closed: a limit it can't show exactly isn't shown, and nothing is formatted.
    await expect(canvasElement.querySelector('[aria-label="Signed limit"]')).toBeNull();
    await expect(args.formatCents).not.toHaveBeenCalled();
  },
};

export const Phone: Story = {
  render: (args) => (
    <div style={{ maxWidth: 358 }}>
      <Card as="section" label="Send an agent" padding={16}>
        <SignedLimitPanel {...args} />
      </Card>
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-06-Phone draws no panel; N-R2-Agents-03’s panel in a phone’s card: who signed it takes its own line under the terms.' },
  play: async ({ canvas }) => {
    const panel = canvas.getByRole('region', { name: 'Signed limit' });
    const source = within(panel).getByText(SOURCE);
    const first = panel.querySelector('dl > div') as HTMLElement;
    await expect(Math.round(source.getBoundingClientRect().left)).toBe(Math.round(first.getBoundingClientRect().left));
    await expect(source.getBoundingClientRect().top).toBeGreaterThanOrEqual(first.getBoundingClientRect().bottom);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
