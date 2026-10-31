import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { ChannelList } from '../components/ChannelList/ChannelList.tsx';
import { VisionBar } from '../components/VisionBar/VisionBar.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { PUBLIC_LINK, SettingsPage } from './parts.tsx';
import { expectFooter, expectFooterAtFoot, expectSettingsPage, expectTabOrder, expectVisionBar, one } from './spec.ts';

const LEAD = 'Where visitors reach this Desk. Each place proves who someone is in its own way; your rules apply everywhere.';

/** Settings › Channels: what a channel is, then where visitors reach this Desk and how each knows who they are. */
function SettingsChannels({ vision = false }: { vision?: boolean }) {
  return (
    <SettingsPage current="channels" banner={vision ? <VisionBar backHref="#today" /> : undefined}>
      <p className="board-quiet cd-type-body">{LEAD}</p>
      <ChannelList publicLink={PUBLIC_LINK} />
    </SettingsPage>
  );
}

const meta = {
  title: 'Boards/Settings, channels',
  render: () => <SettingsChannels />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Channels',
    canvasNote: [
      'Signed on 2026-10-30.',
      'Settings › Channels: one line on what a channel is, then the ChannelList: the public link on, five channels coming later, each saying how someone is known there.',
      'The board centers a 1000 px column; Settings keeps the app’s 960 px content width, like every other owner page (owner decision, 2026-10-30), so it sits 20 px right of the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The content's checks, the same with or without the vision bar. */
async function expectChannelsContent(content: HTMLElement): Promise<void> {
  // The lead in secondary body type, then the channels 20 px under it.
  const lead = within(content).getByText(LEAD);
  expectComputed(lead, { fontSize: '14px', lineHeight: '20px', color: 'rgba(250, 249, 245, 0.64)' });
  const channels = within(content).getByRole('region', { name: 'Channels' });
  await expect(Math.round(channels.getBoundingClientRect().top - lead.getBoundingClientRect().bottom)).toBe(20);
  await expect(Math.round(channels.getBoundingClientRect().width)).toBe(720);
  const rows = within(channels).getAllByRole('listitem');
  await expect(rows.map((row) => one(row, '.cd-channel-list__name').textContent)).toEqual([
    'Public link',
    'Email',
    'Website embed',
    'WhatsApp and iMessage',
    'Slack',
    'Voice',
  ]);
  await expect(within(rows[0] as HTMLElement).getByText('On')).toBeVisible();
  await expect(within(channels).getAllByText('Coming later')).toHaveLength(5);
  // The board's rows: 68 px for one line under the name, 86 px where it wraps (Email, WhatsApp), and
  // a 1 px hairline over every row but the first.
  await expect(rows.map((row) => Math.round(row.getBoundingClientRect().height))).toEqual([68, 87, 69, 87, 69, 69]);
  // Nothing in Channels is a control.
  await expect(within(content).queryByRole('button')).toBeNull();
  await expect(within(content).queryByRole('switch')).toBeNull();
}

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const content = await expectSettingsPage(canvasElement, 'Channels');
    await expect(canvas.queryByRole('note', { name: 'Vision' })).toBeNull();
    await expectChannelsContent(content);
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // focus_order_is_logical: the sidebar, then Settings' sections; Channels has nothing to tab to.
    const nav = within(canvas.getByRole('main')).getByRole('navigation', { name: 'Settings' });
    const reached = await expectTabOrder(userEvent, [
      canvas.getByRole('button', { name: 'Switch business, current: Rivera Plumbing' }),
      canvas.getByRole('switch', { name: 'Answering' }),
      ...within(nav).getAllByRole('link'),
    ]);
    await expect(reached.at(-1)).toBe(within(nav).getByRole('link', { name: 'Billing' }));
  },
};

/** The same page under the vision bar, as N-R2-Vision-Channels draws it. */
export const UnderTheVisionBar: Story = {
  render: () => <SettingsChannels vision />,
  parameters: {
    canvas: 'N-R2-Vision-Channels',
    canvasNote: [
      'Signed on 2026-10-30: N-Run2-Settings-Channels under the vision bar, its content word for word the same.',
      'The bar is AppShell’s banner, so the sidebar and the page start under it and the footer stays at the window’s foot.',
      'The board centers a 1000 px column; Settings keeps the app’s 960 px content width, so it sits 20 px right of the render.',
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const bar = await expectVisionBar(canvasElement, '#today');
    const content = await expectSettingsPage(canvasElement, 'Channels');
    // The app starts under the bar.
    const sidebar = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(sidebar.getBoundingClientRect().top).toBe(bar.getBoundingClientRect().bottom);
    await expectChannelsContent(content);
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // The bar's link is the first stop, then the app as before.
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to your Desk' }),
      canvas.getByRole('button', { name: 'Switch business, current: Rivera Plumbing' }),
      canvas.getByRole('switch', { name: 'Answering' }),
    ]);
  },
};
