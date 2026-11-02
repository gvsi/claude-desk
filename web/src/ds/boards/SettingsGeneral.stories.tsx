import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import { ANSWERING_LINE, GeneralSettings, SettingsPage } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectSettingsPage } from './spec.ts';

/** Settings › General: the business's details, Claude acts for you, and deleting this Desk. */
function SettingsGeneral() {
  return (
    <SettingsPage current="general">
      <GeneralSettings answering={ANSWERING_LINE} />
    </SettingsPage>
  );
}

const meta = {
  title: 'Boards/Settings, general',
  render: () => <SettingsGeneral />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-General',
    canvasNote: [
      'Signed on 2026-10-30.',
      'Settings › General: SubNav at the left, the business’s details as a DetailList, Claude acts for you as a Switch in a Card, and Delete this Desk.',
      'The board draws a ghost Change at the right of each detail; the details are read-only, with no Change (owner decision, 2026-10-30).',
      'The switch says “Claude acts for you” with “Within your rules” while on, the same as on a phone (owner decision, 2026-11-01).',
      'Delete this Desk uses the red danger variant, as the board draws it (owner decision, 2026-11-02, replacing the earlier neutral-delete rule).',
      'The board centers a 1000 px column; Settings keeps the app’s 960 px content width, like every other owner page (owner decision, 2026-10-30), so it sits 20 px right of the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const content = await expectSettingsPage(canvasElement, 'General');
    // The page's own: the sidebar has an Claude acts for you switch too.
    const page = within(canvas.getByRole('main'));

    const answering = page.getByRole('switch', { name: 'Claude acts for you' });
    await expect(answering).toHaveAttribute('aria-checked', 'true');
    // The short line everywhere, as the phone board writes it (owner decision, 2026-10-30).
    await expect(answering).toHaveAccessibleDescription('Within your rules');
    const answeringCard = page.getByRole('region', { name: 'Claude acts for you' });
    await expect(Math.round(answeringCard.getBoundingClientRect().height)).toBe(71);
    await expect(Math.round(answering.getBoundingClientRect().top - answeringCard.getBoundingClientRect().top)).toBe(11);
    await expect(Math.round(answeringCard.getBoundingClientRect().bottom - answering.getBoundingClientRect().bottom)).toBe(11);
    expectComputed(answeringCard, { ...SPEC.card, paddingTop: '0px', paddingLeft: '0px' });

    // Delete this Desk: its heading 28 px under Claude acts for you, the line, and the red button at the column's right.
    const remove = page.getByRole('region', { name: 'Delete this Desk' });
    await expect(Math.round(within(remove).getByRole('heading').getBoundingClientRect().top - answeringCard.getBoundingClientRect().bottom)).toBe(28);
    await expect(within(remove).getByText('Its public link stops working and its chats close. Its safety record is kept.')).toBeVisible();
    const button = within(remove).getByRole('button', { name: 'Delete this Desk' });
    expectComputed(button, SPEC.dangerMain);
    await expect(Math.round(button.getBoundingClientRect().right)).toBe(Math.round(content.getBoundingClientRect().right));

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
  },
};
