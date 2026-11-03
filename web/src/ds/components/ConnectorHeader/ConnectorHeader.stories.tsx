import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ConnectorHeader } from './ConnectorHeader.tsx';

const { views } = rivera.connectors;

const meta = {
  title: 'Connectors/ConnectorHeader',
  component: ConnectorHeader,
  args: { connector: views.payments, status: 'on' },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConnectorHeader {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-02-Payments' },
} satisfies Meta<typeof ConnectorHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

/** connector_status_in_words: the status in words at the right, beside a dot of its tone. */
async function expectStatus(root: HTMLElement, words: string, tone: 'handled' | 'info') {
  const status = within(root).getByText(words, { selector: '.cd-connector-header__status span' });
  const label = status.closest('.cd-status-label');
  if (label === null) throw new Error(`"${words}" has no dot beside it`);
  const dot = label.querySelector(`.cd-status-dot--${tone}`);
  await expect(dot).not.toBeNull();
  await expect(dot).toHaveAttribute('aria-hidden', 'true');
}

export const Payments: Story = {
  play: async ({ canvas, canvasElement }) => {
    // The connector's name is the page's h1, in serif page-title type, with "Built in" beside it.
    const title = canvas.getByRole('heading', { level: 1, name: 'Payments Built in' });
    expectComputed(title.querySelector('.cd-connector-name__name') as Element, { fontSize: '26px', fontFamily: '"Source Serif 4", Georgia, serif' });
    // Its 48 px tile, then the description under the name.
    expectComputed(canvasElement.querySelector('.cd-connector-icon') as Element, { width: '48px', height: '48px' });
    const description = canvas.getByText(views.payments.description);
    expectComputed(description, { fontSize: '15px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(description.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom);
    await expectStatus(canvasElement, 'On', 'handled');
    // The status sits at the right of the title's line.
    const status = canvasElement.querySelector('.cd-connector-header__status');
    if (!status) throw new Error('No status');
    await expect(status.getBoundingClientRect().left).toBeGreaterThan(description.getBoundingClientRect().right);
    await expect(canvas.queryByRole('region')).toBeNull();
  },
};

export const Verification: Story = {
  args: { connector: views.verification, status: 'always_on' },
  parameters: {
    canvas: 'none',
    canvasNote: "No board draws Verification's page; the owner decided its words. It follows the Payments header on N-Conn-02-Payments.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Verification Built in' })).toBeVisible();
    await expectStatus(canvasElement, 'Always on', 'handled');
  },
};

export const Stripe: Story = {
  args: { connector: views.stripe, status: 'connected' },
  parameters: { canvas: 'N-Conn-03-Stripe' },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Stripe Mock' })).toBeVisible();
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expectStatus(canvasElement, 'Connected', 'handled');
    // Stripe's mark with no tile, in white on the dark page (owner, 2026-10-30).
    const icon = canvasElement.querySelector('.cd-connector-icon') as Element;
    expectComputed(icon, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    expectComputed(icon.querySelector('path') as Element, { fill: 'rgb(255, 255, 255)' });
  },
};

export const GoogleCalendar: Story = {
  args: { connector: rivera.googleCalendar.view, status: 'connected', promise: rivera.googleCalendar.promise },
  parameters: {
    canvas: 'N-Conn-04-GoogleCalendar',
    canvasNote: 'Google Calendar is catalog-only in the demo, so this shows what the header supports once it works.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Google Calendar Mock' })).toBeVisible();
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expectStatus(canvasElement, 'Connected', 'handled');
    // The promise under the header: a card with a lock, its title in weight 520 and its detail in meta.
    const promise = canvas.getByRole('group', { name: rivera.googleCalendar.promise.title });
    expectComputed(promise, { borderTopLeftRadius: '12px', paddingTop: '16px' });
    await expect(promise.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expectComputed(within(promise).getByText(rivera.googleCalendar.promise.title), { fontWeight: '520', fontSize: '15px' });
    expectComputed(within(promise).getByText(rivera.googleCalendar.promise.detail), { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    const header = canvas.getByRole('heading', { level: 1 });
    await expect(promise.getBoundingClientRect().top).toBeGreaterThan(header.getBoundingClientRect().bottom);
  },
};

export const Off: Story = {
  args: { connector: views.payments, status: 'off' },
  parameters: { canvasNote: 'A built-in connector after it was turned off; no board draws it, so it shows its status as "Off" with an info dot.' },
  play: async ({ canvasElement }) => {
    await expectStatus(canvasElement, 'Off', 'info');
  },
};
