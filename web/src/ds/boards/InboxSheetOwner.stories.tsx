import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { DemoInboxItem } from '../components/DemoInboxPanel/DemoInboxPanel.tsx';
import { DemoInboxSheet } from '../components/DemoInboxSheet/DemoInboxSheet.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { requestHrefOf } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { RiveraFrame } from './parts.tsx';
import { expectOwnerFrame } from './spec.ts';

/**
 * Two alerts about held requests, as the kernel writes them to the owner, newest last, each titled
 * with the alert's preview line and with the request link the screen builds from the decision it
 * names.
 */
const ALERTS: DemoInboxItem[] = (
  [
    {
      notice: { entry_id: 'inbox-alert-saturday', to: 'owner', preview: 'A request needs your answer' },
      entry: {
        entry_id: 'inbox-alert-saturday',
        to: 'owner',
        kind: 'alert',
        body: 'A visitor asked for Saturday morning. Held by your rule: Saturday bookings ask you first.',
        created_at: '2026-10-30T09:58:00Z',
        decision_id: 'dec-rivera-saturday',
        title: 'A request needs your answer',
      },
      time: 'Today, 9:58 am',
    },
    {
      notice: { entry_id: 'inbox-alert-discount', to: 'owner', preview: 'A request needs your answer' },
      entry: {
        entry_id: 'inbox-alert-discount',
        to: 'owner',
        kind: 'alert',
        body: 'Dana Whitfield asked for 10% off a drain clearing. Held by your rule: Quotes from your price list, at list price.',
        created_at: '2026-10-30T10:46:00Z',
        decision_id: 'dec-rivera-discount',
        title: 'A request needs your answer',
      },
      time: 'Today, 10:46 am',
    },
  ] satisfies DemoInboxItem[]
).map((item) => ({ ...item, requestHref: requestHrefOf(item.entry) }));

/** Today, short, with the owner's Demo inbox opened beside it from its button. */
function InboxSheetOwner() {
  return (
    <RiveraFrame current="today" fill counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}>
      <div className="board-filled-page board-inbox-today">
        <PageHeader title="Good morning, Mike" subtitle="2 requests need you." />
        <DemoInboxSheet viewer="owner" items={ALERTS} language="en" onRetry={fn()} />
      </div>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Demo inbox sheet, owner',
  render: () => <InboxSheetOwner />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Inbox-Sheet-Owner',
    canvasNote: [
      'Built against the board in review; sign-off pending.',
      'The owner’s Demo inbox on Today: DemoInboxSheet as a 400 px side sheet over the dimmed, inert page, opened from its button under the greeting, which the board doesn’t draw; Today behind it is only its header, as the board draws it.',
      'Close keeps its focus edge, since focus moves to it when the sheet opens; the board draws it at rest.',
      'Each alert reads as DemoInboxPanel draws an owner’s alert, “To owner”, the time, the alert’s title (its preview line, “A request needs your answer”) and the kernel’s body, then “Open the request” as the board draws it; the board’s held dot and its own headline aren’t drawn, since a DemoInboxEntry carries only its kind, title and body.',
      'The sidebar’s Connectors row belongs to another change.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Today', { fill: true });
    await userEvent.click(canvas.getByRole('button', { name: 'Demo inbox 2 entries' }));
    const sheet = canvas.getByRole('dialog', { name: 'Demo inbox' });
    const box = sheet.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.width), Math.round(box.top), Math.round(box.height)]).toEqual([1112, 400, 0, 982]);
    expectComputed(sheet, { backgroundColor: 'rgb(42, 41, 39)', borderLeftColor: 'rgba(250, 249, 245, 0.14)' });
    // Padded 24 px: the first entry starts where the board draws it, 24 px in from the rule.
    const entries = within(sheet).getAllByRole('listitem');
    await expect(Math.round(entries[0]!.getBoundingClientRect().left)).toBe(1137);
    await expect(entries.map((entry) => entry.querySelector('.cd-demo-inbox__time')?.textContent)).toEqual(['Today, 10:46 am', 'Today, 9:58 am']);
    // Each alert reads under the kernel's title for it, its preview line.
    await expect(entries.map((entry) => entry.querySelector('.cd-demo-inbox__kind')?.textContent)).toEqual([
      'A request needs your answer',
      'A request needs your answer',
    ]);
    // Each alert opens the held request it is about, as the board draws it.
    await expect(entries.map((entry) => within(entry).getByRole('link', { name: 'Open the request' }).getAttribute('href'))).toEqual([
      '#request-dec-rivera-discount',
      '#request-dec-rivera-saturday',
    ]);
    await expect(within(sheet).getByRole('button', { name: 'Close' })).toHaveFocus();
  },
};
