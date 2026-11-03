import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { CHANNELS_LEAD, ChannelsSettings } from './parts.tsx';
import { expectChannelsContent, expectFooter, expectFooterAtFoot, expectSettingsPage, expectTabOrder, footerLink } from './spec.ts';

const meta = {
  title: 'Boards/Settings, channels',
  render: () => <ChannelsSettings />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Channels',
    canvasNote: [
      'Signed on 2026-10-30. The Channels page the web app builds (coordinator’s ruling, 2026-10-30): no vision bar. Boards/Vision, channels draws the same page under the bar, as a vision story only.',
      'Settings › Channels: one line on what a channel is, then the ChannelList: the public link on, five channels coming later, each saying how someone is known there.',
      'The board centers a 1000 px column; Settings keeps the app’s 960 px content width, like every other owner page (owner decision, 2026-10-30), so it sits 20 px right of the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const content = await expectSettingsPage(canvasElement, 'Channels');
    await expect(canvas.queryByRole('note', { name: 'Vision' })).toBeNull();
    await expectChannelsContent(content, CHANNELS_LEAD);
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // The sidebar's author link comes before its acting switch, then Settings' sections.
    const nav = within(canvas.getByRole('main')).getByRole('navigation', { name: 'Settings' });
    const reached = await expectTabOrder(userEvent, [
      canvas.getByRole('button', { name: 'Switch business, current: Turner Plumbing' }),
      footerLink(canvasElement),
      canvas.getByRole('switch', { name: 'Claude acts for you' }),
      ...within(nav).getAllByRole('link'),
    ]);
    await expect(reached.at(-1)).toBe(within(nav).getByRole('link', { name: 'Billing' }));
    await expect(canvas.getByRole('complementary', { name: 'Claude Desk' }).contains(footerLink(canvasElement))).toBe(true);
  },
};
