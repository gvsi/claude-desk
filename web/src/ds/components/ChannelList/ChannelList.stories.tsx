import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { ChannelList } from './ChannelList.tsx';

/** Each row's name and how someone is known there, word for word as both Channels boards write them. */
const ROWS = [
  ['Public link', 'desk.example/rivera. Visitors confirm who they are with a code sent to their contact on record.'],
  ['Email', 'Replies to your business address. The sender’s address is a hint, never proof: private data still needs a code.'],
  ['Website embed', 'The same chat on your own site, with the same rules and the same disclosure.'],
  ['WhatsApp and iMessage', 'The phone number is the contact on record when it matches; otherwise a code goes to the number you have.'],
  ['Slack', 'For team Desks. A workspace member is known by their Slack account, within the rules you set.'],
  ['Voice', 'Calls answered by Claude, an AI, which says so first. Private data still needs a code.'],
] as const;

const meta = {
  title: 'Settings/ChannelList',
  component: ChannelList,
  args: { publicLink: 'desk.example/rivera' },
  // Settings' content column, 720 px, as the Channels boards draw it.
  render: (args) => (
    <div style={{ width: 720 }}>
      <ChannelList {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Run2-Settings-Channels' },
} satisfies Meta<typeof ChannelList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Rivera: Story = {
  play: async ({ canvas, canvasElement }) => {
    // channel_rows_say_how_identity_works: one card named "Channels", a row per channel, in order.
    const section = canvas.getByRole('region', { name: 'Channels' });
    expectComputed(section, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      paddingTop: '0px',
    });
    const rows = within(section).getAllByRole('listitem');
    await expectListsKeepTheirRole(canvasElement);
    await expect(rows.map((row) => within(row).getByText(/./, { selector: '.cd-channel-list__name' }).textContent)).toEqual(ROWS.map(([name]) => name));
    for (const [index, [name, how]] of ROWS.entries()) {
      const row = rows[index] as HTMLElement;
      const nameLine = within(row).getByText(name);
      const howLine = within(row).getByText(how);
      expectComputed(nameLine, { fontSize: '15px', lineHeight: '21px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
      expectComputed(howLine, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)', marginTop: '2px' });
      // Each row padded 14 px 16 px; a hairline above every row but the first.
      expectComputed(row, {
        paddingTop: '14px',
        paddingRight: '16px',
        paddingBottom: '14px',
        paddingLeft: '16px',
        borderTopWidth: index === 0 ? '0px' : '1px',
        ...(index === 0 ? {} : { borderTopColor: 'rgba(250, 249, 245, 0.12)' }),
      });
    }

    // The public link is on: a sage dot beside "On". Every other channel is "Coming later", in a Pill.
    const [link, ...later] = rows as [HTMLElement, ...HTMLElement[]];
    const on = within(link).getByText('On');
    expectComputed(on, { fontSize: '14px', columnGap: '8px', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(link.querySelector('.cd-status-dot--handled')).toHaveAttribute('aria-hidden', 'true');
    await expect(within(link).queryByText('Coming later')).toBeNull();
    for (const row of later) {
      const pill = within(row).getByText('Coming later');
      await expect(pill).toHaveClass('cd-pill');
      await expect(row.querySelector('.cd-status-dot')).toBeNull();
      // The status sits at the row's right edge, 16 px in, its words on one line.
      await expect(Math.round(row.getBoundingClientRect().right - pill.getBoundingClientRect().right)).toBe(16);
    }
    // The rows are statements: nothing to press.
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('switch')).toBeNull();
  },
};

/** At a phone's width the words wrap and the status keeps its place at the right. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: (args) => <ChannelList {...args} />,
  parameters: {
    canvas: 'none',
    canvasNote: 'Both Channels boards draw a laptop; on a phone the rows keep their status at the right and the words wrap beside it.',
  },
  play: async ({ canvas }) => {
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    for (const row of canvas.getAllByRole('listitem')) {
      await expect(row.scrollWidth).toBe(row.clientWidth);
    }
  },
};
