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
        title={
          <>
            Delete “<bdi data-copy="user">{rivera.business.deskName}</bdi>” for <bdi data-copy="user">{rivera.business.name}</bdi>?
          </>
        }
        body={DELETE_DESK_LINE}
        confirmLabel="Delete Desk"
        confirmVariant="danger"
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
      'Signed on 2026-10-30, and redrawn on 2026-11-02: the title quotes the Desk name and then names its business, and both delete buttons are red, with no dot beside the title (owner decisions).',
      "The general Dialog over Settings › General: Delete “Main line” for Turner Plumbing?, the body, and “Keep it” focused beside “Delete Desk”, fitted to this board (24 px padding, the body 12 px under the title, the answers at a screen’s main size).",
      'Both delete buttons use the red danger variant (replacing the earlier neutral-delete rule); the general Dialog keeps the default tone, with no dot.',
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
    const dialog = canvas.getByRole('dialog', { name: "Delete “Main line” for Turner Plumbing?" });
    await expect(dialog).toHaveAccessibleDescription(DELETE_DESK_LINE);
    // Where the board draws it: 440 by 182 px, centered on the window.
    const box = dialog.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]).toEqual([536, 400, 440, 182]);
    expectComputed(dialog, { paddingTop: '24px', backgroundColor: 'rgb(42, 41, 39)' });
    // Red confirm button, independent of the default tone: no refused dot (owner decision, 2026-11-02).
    await expect(dialog.querySelector('.cd-status-dot')).toBeNull();
    const keep = within(dialog).getByRole('button', { name: 'Keep it' });
    await expect(keep).toHaveFocus();
    const remove = within(dialog).getByRole('button', { name: 'Delete Desk' });
    expectComputed(remove, SPEC.dangerMain);
    await expect([Math.round(remove.getBoundingClientRect().top), Math.round(box.right - remove.getBoundingClientRect().right)]).toEqual([517, 25]);
  },
};
