import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import { ANSWERING_LINE, GeneralSettings, SettingsPage } from './parts.tsx';
import { SETTINGS_SECTION_NAMES, SPEC, expectFooter, one } from './spec.ts';

/** Settings › General on a phone: the top bar, then one column. */
function SettingsPhone() {
  return (
    <SettingsPage current="general">
      <GeneralSettings answering={ANSWERING_LINE} />
    </SettingsPage>
  );
}

const meta = {
  title: 'Boards/Settings, phone',
  render: () => <SettingsPhone />,
  // Drawn at a phone's width and its page's 900 px, so the play measures it there.
  globals: { viewport: { value: 'phone-900', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Phone',
    canvasNote: [
      'Signed on 2026-10-30.',
      'Settings › General at 390 px: SubNav as one line across the page’s gutters over a hairline, then the details, Claude acts for you and Delete this Desk, 16 px apart, and the footer under them.',
      'The board draws a ghost Change on each detail; the details are read-only, with no Change (owner decision, 2026-10-30), so the hours wrap at another word; Delete this Desk uses the red danger variant, as the board draws it (owner decision, 2026-11-02, replacing the earlier neutral-delete rule).',
      'The switch says “Claude acts for you” with “Within your rules” while on, the same on a laptop (owner decision, 2026-11-01). Every row from the top bar to the switch’s card sits where the render draws it.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([390, 900]);
    const main = canvas.getByRole('main');
    const page = within(main);
    const top = (el: Element) => Math.round(el.getBoundingClientRect().top);
    const bottom = (el: Element) => Math.round(el.getBoundingClientRect().bottom);

    // The title 16 px under the top bar, then SubNav 16 px under it, edge to edge over its hairline.
    const title = page.getByRole('heading', { level: 1, name: 'Settings' });
    expectComputed(title, SPEC.pageTitle);
    await expect(top(title) - bottom(one(canvasElement, '.cd-app-shell__topbar'))).toBe(16);
    const nav = page.getByRole('navigation', { name: 'Settings' });
    const links = within(nav).getAllByRole('link');
    await expect(links.map((link) => link.textContent)).toEqual([...SETTINGS_SECTION_NAMES]);
    await expect(within(nav).getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    await expect(top(links[0]!) - bottom(title)).toBe(16);
    await expect([Math.round(nav.getBoundingClientRect().left), Math.round(nav.getBoundingClientRect().width)]).toEqual([0, 390]);
    await expect(Math.round(links[0]!.getBoundingClientRect().left)).toBe(16);

    // Claude acts for you 16 px under, with the one short line.
    const answering = page.getByRole('region', { name: 'Claude acts for you' });
    await expect(top(answering) - bottom(nav)).toBe(16);
    await expect(page.getByRole('switch', { name: 'Claude acts for you' })).toHaveAccessibleDescription('Within your rules');
    const switchRow = within(answering).getByRole('switch', { name: 'Claude acts for you' });
    await expect(Math.round(answering.getBoundingClientRect().height)).toBe(73);
    await expect(top(switchRow) - top(answering)).toBe(11);
    await expect(bottom(answering) - bottom(switchRow)).toBe(11);

    // Delete this Desk 16 px under: the heading, the line 8 px under it, and the red button 8 px under that, at the left.
    const remove = page.getByRole('region', { name: 'Delete this Desk' });
    const heading = within(remove).getByRole('heading', { name: 'Delete this Desk' });
    const line = within(remove).getByText('Its public link stops working and its chats close. Its safety record is kept.');
    const button = within(remove).getByRole('button', { name: 'Delete this Desk' });
    await expect(top(heading) - bottom(answering)).toBe(16);
    await expect(top(line) - bottom(heading)).toBe(8);
    await expect(top(button) - bottom(line)).toBe(8);
    await expect(Math.round(button.getBoundingClientRect().left)).toBe(16);
    expectComputed(button, SPEC.dangerMain);

    // The footer 16 px under the button, and nothing scrolls sideways.
    await expectFooter(canvasElement);
    await expect(top(one(canvasElement, '[data-ds="concept-footer"]')) - bottom(button)).toBe(16);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
