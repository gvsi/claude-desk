import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { VisionBar } from '../components/VisionBar/VisionBar.tsx';
import { CHANNELS_LEAD, ChannelsSettings } from './parts.tsx';
import { expectChannelsContent, expectFooter, expectFooterAtFoot, expectNoFactsInProse, expectSettingsPage, expectTabOrder, expectVisionBar } from './spec.ts';
import { VISION_BACK_HREF } from './vision.tsx';

const meta = {
  title: 'Boards/Vision, channels',
  render: () => <ChannelsSettings banner={<VisionBar backHref={VISION_BACK_HREF} />} />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Vision-Channels',
    canvasNote: [
      'Signed on 2026-10-30. A vision story only: Settings › Channels under the vision bar, its content word for word that of N-Run2-Settings-Channels.',
      'The Channels page the web app builds is N-Run2-Settings-Channels, with no vision bar (coordinator’s ruling, 2026-10-30): see Boards/Settings, channels.',
      'The bar is AppShell’s banner, so the sidebar and the page start under it and the footer stays at the window’s foot.',
      'The board centers a 1000 px column; Settings keeps the app’s 960 px content width, so it sits 20 px right of the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const bar = await expectVisionBar(canvasElement, VISION_BACK_HREF);
    const content = await expectSettingsPage(canvasElement, 'Channels');
    // The app starts under the bar.
    const sidebar = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(sidebar.getBoundingClientRect().top).toBe(bar.getBoundingClientRect().bottom);
    await expectChannelsContent(content, CHANNELS_LEAD);
    // A Settings page: Claude says nothing on it.
    await expect(await expectNoFactsInProse(canvasElement)).toEqual({ prose: 0, receipts: 0 });
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // The bar's link is the first stop, then the app as on the Channels page.
    await expectTabOrder(userEvent, [
      within(bar).getByRole('link', { name: 'Back to Vision' }),
      canvas.getByRole('button', { name: 'Switch business, current: Rivera Plumbing' }),
      canvas.getByRole('switch', { name: 'Claude acts for you' }),
    ]);
  },
};
