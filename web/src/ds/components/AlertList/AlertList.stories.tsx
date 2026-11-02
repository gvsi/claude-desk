import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { AlertList, type AlertListItem } from './AlertList.tsx';

/** The alerts set for a plumber, as REV-NOTIF-Aset writes them on N-Run2-Settings-Notifications' card. */
const PLUMBER: AlertListItem[] = [
  { when: 'Right away', what: 'Held requests, paused chats and emergencies', how: 'Notifications' },
  { when: 'In your briefing', what: 'New leads, bookings and payments', how: 'Each morning at 7:00 am' },
  { when: 'Not at all', what: 'Messages Claude answered on its own' },
];

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';
const HAIRLINE = 'rgba(250, 249, 245, 0.12)';

const meta = {
  title: 'Settings/AlertList',
  component: AlertList,
  args: { label: 'Set for a plumber', items: PLUMBER },
  render: (args) => (
    <div style={{ maxWidth: 720 }}>
      <AlertList {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Run2-Settings-Notifications' },
} satisfies Meta<typeof AlertList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Plumber: Story = {
  parameters: { canvasNote: 'Alerts’ card at the content column’s 720 px, under the page’s own heading, which the board draws over it.' },
  play: async ({ canvas, canvasElement }) => {
    // list_semantics_kept: a list named by its label, one item per alert setting, its role kept with its markers gone.
    await expect(expectListsKeepTheirRole(canvasElement)).toBe(1);
    const list = canvas.getByRole('list', { name: 'Set for a plumber' });
    const rows = within(list).getAllByRole('listitem');
    await expect(rows.map((row) => row.querySelector('.cd-alert-list__when')?.textContent)).toEqual(['Right away', 'In your briefing', 'Not at all']);
    await expect(rows.map((row) => row.querySelector('.cd-alert-list__what')?.textContent)).toEqual(PLUMBER.map((item) => item.what));
    // How each reaches the owner at the right; nothing for alerts that don't.
    await expect(rows.map((row) => row.querySelector('.cd-alert-list__how')?.textContent ?? null)).toEqual(['Notifications', 'Each morning at 7:00 am', null]);
    // Read-only: nothing here can be pressed or changed.
    await expect(canvasElement.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);

    // A card of rows: each padded 12 px by 16 px, a hairline over every row but the first; 64 px, 65 with its hairline.
    const card = list.closest<HTMLElement>('.cd-card')!;
    expectComputed(card, { backgroundColor: 'rgba(250, 249, 245, 0.03)', borderTopColor: 'rgba(250, 249, 245, 0.14)', borderTopLeftRadius: '12px', paddingTop: '0px' });
    for (const [index, row] of rows.entries()) {
      expectComputed(row, { paddingTop: '12px', paddingRight: '16px', paddingBottom: '12px', paddingLeft: '16px' });
      expectComputed(row, index === 0 ? { borderTopWidth: '0px' } : { borderTopWidth: '1px', borderTopColor: HAIRLINE });
      await expect(Math.round(row.getBoundingClientRect().height)).toBe(index === 0 ? 64 : 65);
    }
    await expect(Math.round(card.getBoundingClientRect().height)).toBe(196);

    // When, in body type at weight 520; what 2 px under it in meta, secondary; how in meta, secondary,
    // centered on the row and ending 16 px from its right edge.
    const [first] = rows as [HTMLElement];
    const when = first.querySelector<HTMLElement>('.cd-alert-list__when')!;
    const what = first.querySelector<HTMLElement>('.cd-alert-list__what')!;
    const how = first.querySelector<HTMLElement>('.cd-alert-list__how')!;
    expectComputed(when, { fontSize: '16px', lineHeight: '22px', fontWeight: '520', color: PRIMARY });
    expectComputed(what, { fontSize: '14px', lineHeight: '19px', color: SECONDARY });
    expectComputed(how, { fontSize: '14px', lineHeight: '19px', color: SECONDARY });
    await expect(Math.round(what.getBoundingClientRect().top - when.getBoundingClientRect().bottom)).toBe(2);
    const box = first.getBoundingClientRect();
    const howBox = how.getBoundingClientRect();
    await expect(Math.round(box.right - howBox.right)).toBe(16);
    await expect(Math.round(howBox.top + howBox.height / 2)).toBe(Math.round(box.top + box.height / 2));
  },
};

/** A "how" longer than a phone's row (60 characters), which must wrap rather than push the page sideways. */
const LONG_HOW = 'Every Monday at 8:00 am, by email to the address on your Desk';

export const Phone: Story = {
  args: { items: [...PLUMBER, { when: 'In a weekly summary', what: 'Quotes sent and payments taken', how: LONG_HOW }] },
  render: (args) => (
    <div style={{ padding: '0 var(--space-16)' }}>
      <AlertList {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'none',
    canvasNote: 'No board draws Alerts on a phone, so this follows N-Run2-Settings-Notifications: in a 358 px card, how an alert reaches the owner goes under what it is when the two don’t fit on a line.',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    const rows = within(canvas.getByRole('list', { name: 'Set for a plumber' })).getAllByRole('listitem');
    const briefing = rows[1] as HTMLElement;
    const what = briefing.querySelector<HTMLElement>('.cd-alert-list__what')!;
    const how = briefing.querySelector<HTMLElement>('.cd-alert-list__how')!;
    // Under the words, from their left edge, and nothing scrolls sideways.
    await expect(how.getBoundingClientRect().top).toBeGreaterThanOrEqual(what.getBoundingClientRect().bottom);
    await expect(Math.round(how.getBoundingClientRect().left)).toBe(Math.round(what.getBoundingClientRect().left));
    // alert_how_wraps_inside_its_row: a long how wraps within the row's padding, and nothing scrolls sideways.
    const weekly = rows[3] as HTMLElement;
    const long = weekly.querySelector<HTMLElement>('.cd-alert-list__how')!;
    await expect(long).toHaveTextContent(LONG_HOW);
    await expect(Math.round(long.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(weekly.getBoundingClientRect().right) - 16);
    await expect(long.getBoundingClientRect().height).toBeGreaterThan(18);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
