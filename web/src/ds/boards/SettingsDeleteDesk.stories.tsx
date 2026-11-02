import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Dialog } from '../components/Dialog/Dialog.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { ANSWERING_LINE, DELETE_DESK_LINE, GeneralSettings, SettingsPage } from './parts.tsx';
import { SPEC, expectSettingsPage } from './spec.ts';

/** Settings › General with "Delete this Desk" pressed: the general Dialog over the page. */
function SettingsDeleteDesk() {
  return (
    <>
      <SettingsPage current="general">
        <GeneralSettings answering={ANSWERING_LINE} />
      </SettingsPage>
      <Dialog
        title={`Delete ${rivera.business.deskName} for ${rivera.business.name}?`}
        body={DELETE_DESK_LINE}
        confirmLabel="Delete Desk"
        cancelLabel="Keep it"
        onConfirm={fn()}
        onCancel={fn()}
      />
    </>
  );
}

const meta = {
  title: 'Boards/Settings, delete this Desk',
  render: () => <SettingsDeleteDesk />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-DeleteDesk',
    canvasNote: [
      'Signed on 2026-10-30.',
      'The board\'s title is “Delete Main line?”; the title names the Desk and then its business, “Delete Main line for Turner Plumbing?” (owner decision, 2026-11-02).',
      "The general Dialog over Settings › General: “Delete Main line for Turner Plumbing?”, the body, and “Keep it” focused beside “Delete Desk”, fitted to this board (24 px padding, the body 12 px under the title, the answers at a screen’s main size).",
      'The board draws a refused dot beside the title and both delete buttons red; deleting a Desk is a neutral button over the general Dialog, not a danger dialog (owner decision, 2026-10-30), so there is no dot and the buttons are neutral.',
      'The board dims the page with rgba(20, 20, 19, 0.64); the dialog keeps the scrim token, rgba(0, 0, 0, 0.5), as every dialog does.',
      'The page behind is Boards/Settings, general.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectSettingsPage(canvasElement, 'General');
    const dialog = canvas.getByRole('dialog', { name: "Delete Main line for Turner Plumbing?" });
    await expect(dialog).toHaveAccessibleDescription(DELETE_DESK_LINE);
    // Where the board draws it: 440 by 182 px, centered on the window.
    const box = dialog.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]).toEqual([536, 400, 440, 182]);
    expectComputed(dialog, { paddingTop: '24px', backgroundColor: 'rgb(42, 41, 39)' });
    // The general Dialog, not a danger one (owner decision, 2026-10-30): no refused dot, and Delete Desk the neutral primary.
    await expect(dialog.querySelector('.cd-status-dot')).toBeNull();
    const keep = within(dialog).getByRole('button', { name: 'Keep it' });
    await expect(keep).toHaveFocus();
    const remove = within(dialog).getByRole('button', { name: 'Delete Desk' });
    expectComputed(remove, SPEC.primary);
    await expect([Math.round(remove.getBoundingClientRect().top), Math.round(box.right - remove.getBoundingClientRect().right)]).toEqual([517, 25]);
  },
};
