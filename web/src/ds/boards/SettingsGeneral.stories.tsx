import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import { ANSWERING_LINE, GENERAL_DETAILS, GeneralSettings, SettingsPage } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectSettingsPage, one } from './spec.ts';

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
      'Delete this Desk is a neutral secondary button where the board draws it red (owner decision, 2026-10-30).',
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

    // The details, read-only: each label over its value, in the board's words, with no Change.
    const business = page.getByRole('region', { name: 'Your business' });
    const terms = within(business).getAllByRole('term').map((term) => term.textContent);
    const values = within(business).getAllByRole('definition').map((value) => value.textContent);
    await expect(terms.map((term, index) => [term, values[index]])).toEqual(GENERAL_DETAILS.map(({ label, value }) => [label, value]));
    await expect(within(business).queryByRole('button')).toBeNull();
    const card = one(business, '.cd-card');
    // The card 8 px under its heading, as wide as the content column.
    await expect(Math.round(card.getBoundingClientRect().top - one(business, 'h2').getBoundingClientRect().bottom)).toBe(8);
    await expect(Math.round(card.getBoundingClientRect().width)).toBe(720);
    await expect(Math.round(card.getBoundingClientRect().height)).toBe(326);

    // Claude acts for you, on, in its own card 20 px under the details.
    const answering = page.getByRole('switch', { name: 'Claude acts for you' });
    await expect(answering).toHaveAttribute('aria-checked', 'true');
    // The short line everywhere, as the phone board writes it (owner decision, 2026-10-30).
    await expect(answering).toHaveAccessibleDescription('Within your rules');
    const answeringCard = page.getByRole('region', { name: 'Claude acts for you' });
    // The words line up with Business; the switch keeps its vertical inset and the card's height.
    const label = within(answering).getByText('Claude acts for you', { exact: true });
    await expect(Math.round(label.getBoundingClientRect().left)).toBe(
      Math.round(within(business).getByText('Business', { exact: true }).getBoundingClientRect().left),
    );
    await expect(Math.round(answeringCard.getBoundingClientRect().height)).toBe(91);
    await expect(Math.round(answering.getBoundingClientRect().top - answeringCard.getBoundingClientRect().top)).toBe(21);
    await expect(Math.round(answeringCard.getBoundingClientRect().bottom - answering.getBoundingClientRect().bottom)).toBe(21);
    expectComputed(answeringCard, { ...SPEC.card, paddingTop: '0px', paddingLeft: '0px' });
    await expect(Math.round(answeringCard.getBoundingClientRect().top - card.getBoundingClientRect().bottom)).toBe(20);

    // Delete this Desk: its heading 28 px under Claude acts for you, the line, and the neutral button at the column's right.
    const remove = page.getByRole('region', { name: 'Delete this Desk' });
    await expect(Math.round(within(remove).getByRole('heading').getBoundingClientRect().top - answeringCard.getBoundingClientRect().bottom)).toBe(28);
    await expect(within(remove).getByText('Its public link stops working and its chats close. Its safety record is kept.')).toBeVisible();
    const button = within(remove).getByRole('button', { name: 'Delete this Desk' });
    expectComputed(button, SPEC.secondaryMain);
    await expect(Math.round(button.getBoundingClientRect().right)).toBe(Math.round(content.getBoundingClientRect().right));

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
  },
};
