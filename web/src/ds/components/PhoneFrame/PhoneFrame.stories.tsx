import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { PhoneFrame, PhoneTabBar, type PhoneTab } from './PhoneFrame.tsx';

const HREFS = { today: '#today', chats: '#chats', rules: '#rules', safety: '#safety', more: '#more' } satisfies Record<PhoneTab, string>;

/** A phone's screen as the owner's Today draws it: a page that scrolls, then the tab bar at its foot. */
function OwnerPhone({ current = 'today', label }: { current?: PhoneTab; label?: string }) {
  return (
    <PhoneFrame caption="Today, for the owner">
      <div style={{ flex: '1 1 auto', minHeight: 0, padding: '28px 20px 0' }}>
        <h2 className="cd-type-greeting" style={{ margin: 0 }}>
          Good morning, Mike
        </h2>
      </div>
      <PhoneTabBar current={current} hrefs={HREFS} label={label} />
    </PhoneFrame>
  );
}

const meta = {
  title: 'Layout/PhoneFrame',
  component: OwnerPhone,
  parameters: { layout: 'padded', canvas: 'N-R2-Vision-Phone' },
} satisfies Meta<typeof OwnerPhone>;

export default meta;

type Story = StoryObj<typeof meta>;

export const OwnerToday: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    // phone_frame_draws_a_phone: a figure captioned under the screen, the screen 390 by 780 px.
    const figure = canvas.getByRole('figure', { name: 'Today, for the owner' });
    const screen = canvasElement.querySelector<HTMLElement>('.cd-phone-frame__screen')!;
    expectComputed(screen, {
      width: '390px',
      height: '780px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '44px',
      backgroundColor: 'rgb(28, 27, 25)',
      overflowX: 'hidden',
      overflowY: 'hidden',
    });
    const caption = within(figure).getByText('Today, for the owner');
    expectComputed(caption, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(Math.round(caption.getBoundingClientRect().top - screen.getBoundingClientRect().bottom)).toBe(12);

    // phone_tab_bar_has_five_tabs: Today, Chats, Rules, Safety and More, at the screen's foot.
    // Named for what it is, so it doesn't claim to be the page's main navigation.
    const nav = within(screen).getByRole('navigation', { name: "The owner app's tabs" });
    const tabs = within(nav).getAllByRole('link');
    await expect(tabs.map((tab) => tab.textContent)).toEqual(['Today', 'Chats', 'Rules', 'Safety', 'More']);
    await expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual(['#today', '#chats', '#rules', '#safety', '#more']);
    await expect(Math.round(screen.getBoundingClientRect().bottom - nav.getBoundingClientRect().bottom)).toBe(1);
    expectComputed(nav, {
      paddingTop: '10px',
      paddingRight: '8px',
      paddingBottom: '22px',
      paddingLeft: '8px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.12)',
      backgroundColor: 'rgb(34, 34, 32)',
    });

    // The current tab in primary ink, marked as the page; the others secondary. Each a 20 px icon over a caption.
    const [today, ...rest] = tabs as [HTMLElement, ...HTMLElement[]];
    await expect(today).toHaveAttribute('aria-current', 'page');
    expectComputed(today, { color: 'rgba(250, 249, 245, 0.92)', rowGap: '2px' });
    for (const tab of rest) {
      await expect(tab).not.toHaveAttribute('aria-current');
      expectComputed(tab, { color: 'rgba(250, 249, 245, 0.64)' });
    }
    for (const tab of tabs) {
      const icon = tab.querySelector('svg')!;
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      await expect(icon.getBoundingClientRect().width).toBe(20);
      expectComputed(tab.querySelector('span')!, { fontSize: '12px', lineHeight: '17px' });
    }
    // The five tabs share the bar: spaced around its width, in a row.
    const tops = tabs.map((tab) => Math.round(tab.getBoundingClientRect().top));
    await expect(new Set(tops).size).toBe(1);

    // From the keyboard: Tab walks the tabs in order.
    for (const tab of tabs) {
      await userEvent.tab();
      await expect(tab).toHaveFocus();
    }
  },
};

/** Another tab current: only it is marked. */
export const OnSafety: Story = {
  args: { current: 'safety' },
  play: async ({ canvas }) => {
    const nav = canvas.getByRole('navigation', { name: "The owner app's tabs" });
    const current = within(nav)
      .getAllByRole('link')
      .filter((tab) => tab.getAttribute('aria-current') === 'page');
    await expect(current.map((tab) => tab.textContent)).toEqual(['Safety']);
  },
};

/** A page with two phones of the same app names each bar for its phone. */
export const OwnLabel: Story = {
  args: { label: 'Tabs on Mike’s phone' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('navigation', { name: 'Tabs on Mike’s phone' })).toBeVisible();
    await expect(canvas.queryByRole('navigation', { name: "The owner app's tabs" })).toBeNull();
  },
};

/** In a phone's own window, the frame keeps inside it: no sideways scroll. */
export const InAPhoneWindow: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-R2-Vision-Phone draws the phones inside a laptop page; on a phone’s own window the frame narrows to fit it.',
  },
  play: async ({ canvas }) => {
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    const figure = canvas.getByRole('figure', { name: 'Today, for the owner' });
    await expect(figure.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  },
};
