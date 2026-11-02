import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { AlertList, type AlertListItem } from '../components/AlertList/AlertList.tsx';
import { SectionHeader } from '../components/SectionHeader/SectionHeader.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { SettingsPage, VisionNote } from './parts.tsx';
import { expectFooter, expectFooterAtFoot, expectSettingsPage, one } from './spec.ts';

const LEAD = 'Held requests and paused chats arrive in Notifications right away. Other alerts wait for your briefing.';

/** The alerts set for a plumber, in the board's words. */
const PLUMBER: AlertListItem[] = [
  { when: 'Right away', what: 'Held requests, paused chats and emergencies', how: 'Notifications' },
  { when: 'In your briefing', what: 'New leads, bookings and payments', how: 'Each morning at 7:00 am' },
  { when: 'Not at all', what: 'Messages Claude answered on its own' },
];

/** Settings › Alerts: a vision note, what reaches the owner when, and the alerts set for the business type. */
function SettingsNotifications() {
  return (
    <SettingsPage current="alerts">
      <VisionNote>In this prototype, alerts arrive in Notifications.</VisionNote>
      <p className="cd-type-body">{LEAD}</p>
      <section aria-labelledby="board-settings-alerts" className="board-settings__section">
        <SectionHeader id="board-settings-alerts" title="Set for a plumber" caption="From your business type" />
        <AlertList label="Set for a plumber" items={PLUMBER} />
      </section>
    </SettingsPage>
  );
}

const meta = {
  title: 'Boards/Settings, notifications',
  render: () => <SettingsNotifications />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Notifications',
    canvasNote: [
      'Signed on 2026-10-30.',
      'Settings › Notifications: a Pill marks it as vision, then the alerts set for a plumber as an AlertList, read-only.',
      'The section is named Alerts, and its words say alerts arrive in Notifications, as REV-NOTIF-Aset draws them: the owner’s Demo inbox became the sidebar’s Notifications page (owner decision, 2026-11-02).',
      'The board centers a 1000 px column; Settings keeps the app’s 960 px content width, like every other owner page (owner decision, 2026-10-30), so it sits 20 px right of the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const content = await expectSettingsPage(canvasElement, 'Alerts');
    const page = within(canvas.getByRole('main'));

    // The vision note first: the Pill, then its line 12 px after it.
    const vision = one(content, '.board-settings__vision');
    const pill = one(vision, '.cd-pill');
    await expect(pill).toHaveTextContent(/^Mock$/);
    const note = page.getByText('In this prototype, alerts arrive in Notifications.');
    expectComputed(note, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(Math.round(note.getBoundingClientRect().left - pill.getBoundingClientRect().right)).toBe(12);

    // The lead 20 px under it, then the alerts' heading 20 px under that, with its caption at the right.
    const lead = page.getByText(LEAD);
    expectComputed(lead, { fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(Math.round(lead.getBoundingClientRect().top - vision.getBoundingClientRect().bottom)).toBe(20);
    const alerts = page.getByRole('region', { name: 'Set for a plumber' });
    await expect(Math.round(alerts.getBoundingClientRect().top - lead.getBoundingClientRect().bottom)).toBe(20);
    await expect(within(alerts).getByText('From your business type')).toBeVisible();

    // The alerts, read-only, in the board's words, the card 8 px under its heading.
    const list = within(alerts).getByRole('list', { name: 'Set for a plumber' });
    const rows = within(list).getAllByRole('listitem');
    await expect(rows.map((row) => row.textContent)).toEqual(PLUMBER.map(({ when, what, how }) => `${when}${what}${how ?? ''}`));
    const card = one(alerts, '.cd-card');
    await expect(Math.round(card.getBoundingClientRect().top - one(alerts, 'h2').getBoundingClientRect().bottom)).toBe(8);
    await expect(Math.round(card.getBoundingClientRect().height)).toBe(196);
    await expect(within(content).queryByRole('button')).toBeNull();

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
  },
};
