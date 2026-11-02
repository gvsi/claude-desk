import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { chenBusinessTools } from '../../../mocks/businessTools.ts';
import { businessGlyph, businessLine } from '../../../owner/connectors/businessWords.ts';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { SetupToolsList, type SetupJobRow, type SetupToolsRow } from './SetupToolsList.tsx';

const { views } = rivera.connectors;

const onAddDocuments = fn();
const onAddPayments = fn();
const onConnectStripe = fn();

/** Turner Plumbing's tools step as N-R2-Setup-05-Tools draws it: four built in, two to add, Stripe to connect. */
const BUILT_IN: SetupToolsRow[] = [
  { connector: views.quotes, state: 'on' },
  { connector: views.bookings, state: 'on' },
  { connector: views.leads, state: 'on' },
  { connector: views.verification, state: 'always_on' },
  { connector: views.documents, state: 'off', onChoose: onAddDocuments },
  { connector: views.payments, state: 'off', onChoose: onAddPayments },
];
// Stripe brings its two tools, as on the Connectors boards, where the tools board draws three.
const EXTERNAL: SetupToolsRow[] = [{ connector: views.stripe, state: 'off', tools: 2, onChoose: onConnectStripe }];

const meta = {
  title: 'Setup/SetupToolsList',
  component: SetupToolsList,
  args: { builtIn: BUILT_IN, external: EXTERNAL },
  // The setup column's 720 px, as on the board.
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-R2-Setup-05-Tools' },
} satisfies Meta<typeof SetupToolsList>;

export default meta;

type Story = StoryObj<typeof meta>;

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

/** Each row of the group named `name`, in order. */
function rowsOf(canvas: ReturnType<typeof within>, name: string): HTMLElement[] {
  return within(canvas.getByRole('list', { name })).getAllByRole('listitem');
}

/** What a row shows at its right: its status's words, or its button's drawn words (not the name read out). */
function endOf(row: HTMLElement): string | null {
  const end = row.querySelector('.cd-setup-tools__end');
  if (!end) return null;
  const drawn = end.cloneNode(true) as HTMLElement;
  for (const hidden of drawn.querySelectorAll('.cd-sr-only')) hidden.remove();
  return drawn.textContent;
}

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    onAddDocuments.mockClear();
    onAddPayments.mockClear();
    onConnectStripe.mockClear();

    // setup_tools_lists_two_groups: "Built in" and "Connect your own", each a card named by its heading.
    const builtIn = canvas.getByRole('region', { name: 'Built in' });
    const yours = canvas.getByRole('region', { name: 'Connect your own' });
    await expect(within(builtIn).getByRole('heading', { level: 2, name: 'Built in' })).toBeVisible();
    await expect(within(yours).getByRole('heading', { level: 2, name: 'Connect your own' })).toBeVisible();
    expectComputed(builtIn, {
      paddingTop: '16px',
      paddingLeft: '16px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
    });
    expectComputed(within(builtIn).getByRole('heading', { level: 2 }), { fontSize: '16px', lineHeight: '22px', fontWeight: '420', color: PRIMARY });
    await expect(Math.round(yours.getBoundingClientRect().top - builtIn.getBoundingClientRect().bottom)).toBe(20);

    // Each row: its name over its line, and at the right where it stands or what to do.
    const rows = rowsOf(canvas, 'Built in');
    await expect(rows.map((row) => row.querySelector('.cd-connector-name__name')?.textContent)).toEqual([
      'Quotes',
      'Bookings',
      'Leads and callbacks',
      'Verification',
      'Documents',
      'Payments',
    ]);
    await expect(rows.map(endOf)).toEqual(['On', 'On', 'On', 'Always on', 'Add', 'Add']);
    // The group says these are built in, so no row repeats it.
    await expect(builtIn.querySelector('.cd-connector-name__built-in')).toBeNull();

    // A row is 12 px above and below its 36 px tile and two lines, under a hairline: 65 px.
    const [quotes] = rows as [HTMLElement];
    expectComputed(quotes, { paddingTop: '12px', paddingBottom: '12px', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    await expect(new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))).toEqual(new Set([65]));
    await expect(Math.round(rows[0]!.getBoundingClientRect().top - within(builtIn).getByRole('heading').getBoundingClientRect().bottom)).toBe(10);
    const tile = quotes.querySelector<HTMLElement>('.cd-connector-icon')!;
    await expect(tile.getBoundingClientRect().width).toBe(36);
    await expect(Math.round(quotes.querySelector('.cd-connector-summary')!.getBoundingClientRect().left - tile.getBoundingClientRect().right)).toBe(14);
    expectComputed(within(quotes).getByText('Quotes'), { fontSize: '16px', lineHeight: '22px', fontWeight: '520', color: PRIMARY });
    expectComputed(within(quotes).getByText('Prices jobs from your price list.'), { fontSize: '14px', lineHeight: '19px', color: SECONDARY });

    // setup_tools_status_in_words: "On" beside a handled dot in primary ink; "Always on" in secondary.
    const on = quotes.querySelector<HTMLElement>('.cd-setup-tools__end')!;
    expectComputed(on, { fontSize: '14px', lineHeight: '19px', color: PRIMARY, columnGap: '6px' });
    await expect(on.querySelector('.cd-status-dot--handled')).toHaveAttribute('aria-hidden', 'true');
    const always = rows[3]!.querySelector<HTMLElement>('.cd-setup-tools__end')!;
    expectComputed(always, { color: SECONDARY });
    await expect(always.querySelector('.cd-status-dot--handled')).not.toBeNull();
    await expect(Math.round(on.getBoundingClientRect().right)).toBe(Math.round(quotes.getBoundingClientRect().right));

    // setup_tools_rows_are_not_links: the only controls are the buttons, each naming its connector.
    await expect(canvas.queryAllByRole('link')).toEqual([]);
    const buttons = canvas.getAllByRole('button');
    await expect(buttons.map((button) => button.textContent)).toEqual(['AddAdd Documents', 'AddAdd Payments', 'ConnectConnect Stripe']);
    await expect(buttons.map((button) => within(button).getByText(/^(Add|Connect)$/).getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true']);
    const addDocuments = canvas.getByRole('button', { name: 'Add Documents' });
    expectComputed(addDocuments, { height: '32px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    await userEvent.click(addDocuments);
    await userEvent.click(canvas.getByRole('button', { name: 'Add Payments' }));
    await expect(onAddDocuments).toHaveBeenCalledTimes(1);
    await expect(onAddPayments).toHaveBeenCalledTimes(1);

    // An app: its Mock badge beside its name, then how many tools it brings before "Connect".
    const [stripe] = rowsOf(canvas, 'Connect your own') as [HTMLElement];
    await expect(expectMockBesideExternalNames(stripe)).toBe(1);
    // The badge 8 px from the name, as the board and ConnectorPicker draw it.
    const name = stripe.querySelector<HTMLElement>('.cd-connector-name__name')!;
    const badge = stripe.querySelector<HTMLElement>('.cd-pill')!;
    await expect(Math.round(badge.getBoundingClientRect().left - name.getBoundingClientRect().right)).toBe(8);
    const count = within(stripe).getByText('2 tools');
    expectComputed(count, { fontSize: '14px', lineHeight: '19px', color: SECONDARY });
    const connect = within(stripe).getByRole('button', { name: 'Connect Stripe' });
    await expect(Math.round(connect.getBoundingClientRect().left - count.getBoundingClientRect().right)).toBe(14);
    await userEvent.click(connect);
    await expect(onConnectStripe).toHaveBeenCalledTimes(1);

    await expect(expectListsKeepTheirRole(canvasElement)).toBe(2);
  },
};

export const AfterTurningOn: Story = {
  args: {
    builtIn: BUILT_IN.map((row) => (row.state === 'off' ? { connector: row.connector, state: 'on' } : row)),
    external: [{ connector: views.stripe, state: 'on' }],
  },
  parameters: { canvasNote: 'The board before anything is added; here Documents, Payments and Stripe were turned on after their reviews, so every row says where it stands and nothing is left to press.' },
  play: async ({ canvas }) => {
    await expect(rowsOf(canvas, 'Built in').map(endOf)).toEqual(['On', 'On', 'On', 'Always on', 'On', 'On']);
    await expect(rowsOf(canvas, 'Connect your own').map(endOf)).toEqual(['On']);
    await expect(canvas.queryAllByRole('button')).toEqual([]);
    await expect(canvas.queryByText('2 tools')).toBeNull();
  },
};

const onReviewStripe = fn();

/**
 * Stripe's row once connected, its tools waiting: how many it brings, then "Needs review" beside a
 * held dot, then "Review" named for Stripe, 14 px apart, with nothing offering to connect it again.
 */
async function reviewsStripe({ canvas, userEvent }: Parameters<NonNullable<Story['play']>>[0]): Promise<HTMLElement> {
  onReviewStripe.mockClear();
  await expect(rowsOf(canvas, 'Built in').map(endOf)).toEqual(['On', 'On', 'On', 'Always on', 'Add', 'Add']);
  const [stripe] = rowsOf(canvas, 'Connect your own') as [HTMLElement];
  await expect(endOf(stripe)).toBe('2 toolsNeeds reviewReview');
  // An app's row, as before connecting: the tile, the name with its Mock badge, the line.
  await expect(stripe.className).toBe('cd-setup-tools__row');
  await expect(expectMockBesideExternalNames(stripe)).toBe(1);

  const count = within(stripe).getByText('2 tools');
  const status = within(stripe).getByText('Needs review');
  await expect(status).toHaveClass('cd-setup-tools__job-status');
  await expect(status.querySelector('.cd-status-dot')).toHaveClass('cd-status-dot--held');
  expectComputed(status, { fontSize: '14px', lineHeight: '19px', color: SECONDARY, columnGap: '6px' });
  const review = within(stripe).getByRole('button', { name: 'Review Stripe' });
  await expect(within(review).getByText('Review')).toHaveAttribute('aria-hidden', 'true');
  await expect(Math.round(status.getBoundingClientRect().left - count.getBoundingClientRect().right)).toBe(14);
  await expect(Math.round(review.getBoundingClientRect().left - status.getBoundingClientRect().right)).toBe(14);
  // All three on one line.
  for (const part of [count, status]) {
    const box = part.getBoundingClientRect();
    const button = review.getBoundingClientRect();
    await expect(Math.abs(box.top + box.height / 2 - (button.top + button.height / 2))).toBeLessThanOrEqual(1);
  }

  await expect(canvas.queryByRole('button', { name: 'Connect Stripe' })).toBeNull();
  await userEvent.click(review);
  await expect(onReviewStripe).toHaveBeenCalledTimes(1);
  return stripe;
}

export const ConnectedNeedsReview: Story = {
  args: { external: [{ connector: views.stripe, state: 'needs_review', tools: 2, onReview: onReviewStripe }] },
  parameters: {
    canvas: 'none',
    canvasNote: 'Signed boards N-Live-REV-560-1512 and N-Live-REV-560-390, not yet in the reference registry: Stripe connected from the setup chat, its two tools listed and none on, so its row says they need review and its button opens that review instead of connecting it again.',
  },
  play: async (context) => {
    const stripe = await reviewsStripe(context);
    const review = within(stripe).getByRole('button', { name: 'Review Stripe' });
    await expect(Math.round(review.getBoundingClientRect().right)).toBe(Math.round(stripe.getBoundingClientRect().right));
  },
};

export const ConnectedNeedsReviewPhone: Story = {
  ...ConnectedNeedsReview,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'Signed board N-Live-REV-560-390, not yet in the reference registry: under 480 px the count, "Needs review" and "Review" go under the line together, still on one line.',
  },
  play: async (context) => {
    const stripe = await reviewsStripe(context);
    const text = stripe.querySelector<HTMLElement>('.cd-connector-summary')!;
    const end = stripe.querySelector<HTMLElement>('.cd-setup-tools__end')!;
    await expect(Math.round(end.getBoundingClientRect().left)).toBe(Math.round(text.getBoundingClientRect().left));
    await expect(end.getBoundingClientRect().top).toBeGreaterThanOrEqual(text.getBoundingClientRect().bottom);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const NoAppsToConnect: Story = {
  args: { external: [] },
  parameters: { canvasNote: 'The board lists Stripe to connect; with no app to connect, "Connect your own" is left out.' },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual(['Built in']);
    await expect(canvas.queryByRole('heading', { name: 'Connect your own' })).toBeNull();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'No board draws the tools step on a phone (N-R2-Setup-05-Tools is a laptop): under 480 px each row’s status or button goes under its line, from the same edge.',
  },
  play: async ({ canvas }) => {
    const rows = [...rowsOf(canvas, 'Built in'), ...rowsOf(canvas, 'Connect your own')];
    for (const row of rows) {
      const text = row.querySelector<HTMLElement>('.cd-connector-summary')!;
      const end = row.querySelector<HTMLElement>('.cd-setup-tools__end')!;
      await expect(Math.round(end.getBoundingClientRect().left)).toBe(Math.round(text.getBoundingClientRect().left));
      await expect(end.getBoundingClientRect().top).toBeGreaterThanOrEqual(text.getBoundingClientRect().bottom);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

const onReviewJob = fn();
const JOBS: SetupJobRow[] = chenBusinessTools.map((row) => {
  if (!row.business) throw new Error('A job has its definition');
  const line = businessLine(row.business);
  const glyph = businessGlyph(row.business.config);
  if (!line || !glyph) throw new Error('A job has a supported configuration');
  const job = { key: row.tool, title: row.business.title, line, glyph };
  return row.status === 'enabled' ? { ...job, state: 'on' } : { ...job, state: 'needs_review', onReview: onReviewJob };
});

export const BusinessJobs: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { jobs: JOBS, builtIn: [{ connector: views.verification, state: 'always_on' }] },
  parameters: { canvas: 'none', canvasNote: 'Signed D4 board p09-d4tools-1512; intake is already on to show both states. The board is not yet in the reference registry.' },
  play: async ({ canvas, userEvent }) => {
    onReviewJob.mockClear();
    const groups = canvas.getAllByRole('region');
    await expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Your Desk’s jobs', 'Built in', 'Connect your own']);
    const jobs = within(groups[0]!);
    await expect(jobs.getByText('Needs review')).toBeVisible();
    await expect(jobs.getByText('On', { exact: true })).toBeVisible();
    const review = jobs.getByRole('button', { name: 'Review Book a free intro call' });
    review.focus();
    await expect(review).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(onReviewJob).toHaveBeenCalledTimes(1);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const BusinessJobsPhone: Story = {
  ...BusinessJobs,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'Signed D4 board p09-d4tools-390, not yet in the reference registry.' },
  play: async (context) => {
    await BusinessJobs.play?.(context);
    for (const row of rowsOf(context.canvas, 'Your Desk’s jobs')) {
      const text = row.querySelector('.cd-connector-summary')!;
      const end = row.querySelector('.cd-setup-tools__end')!;
      await expect(end.getBoundingClientRect().left).toBe(text.getBoundingClientRect().left);
      await expect(end.getBoundingClientRect().top).toBeGreaterThanOrEqual(text.getBoundingClientRect().bottom);
    }
  },
};
