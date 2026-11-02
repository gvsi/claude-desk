import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import { Dialog, type DialogProps } from './Dialog.tsx';

const TITLE = "Delete Turner Plumbing's Emergencies?";
const BODY = 'Its public link stops working and its chats close. Its safety record is kept.';

/**
 * The dialog as Settings › General opens it, in the default tone: a neutral question with neutral
 * buttons, as deleting a Desk asks (owner decision, 2026-10-30). "Delete this Desk" opens it,
 * "Keep it" or Escape closes it, and "Delete Desk" waits for the screen's answer. It starts open,
 * so the story shows the dialog.
 */
function Settings(props: DialogProps) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  return (
    <div style={{ padding: 'var(--space-24) var(--space-40)' }}>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Delete this Desk
      </Button>
      {open ? (
        <Dialog
          {...props}
          pending={pending}
          onConfirm={() => {
            props.onConfirm();
            setPending(true);
          }}
          onCancel={() => {
            props.onCancel();
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

const meta = {
  title: 'Layout/Dialog',
  component: Dialog,
  args: {
    title: TITLE,
    body: BODY,
    confirmLabel: 'Delete Desk',
    cancelLabel: 'Keep it',
    onConfirm: fn(),
    onCancel: fn(),
  },
  render: (args) => <Settings {...args} />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-DeleteDesk',
    canvasNote:
      'N-Run2-Settings-DeleteDesk draws this dialog over Settings › General (Boards/Settings, delete this Desk); here a lone "Delete this Desk" button opens it. "Start over" in the reviewer bar on N-Today-Run1 opens one too. The board draws a refused dot and red buttons; deleting a Desk uses the default tone with neutral buttons (owner decision, 2026-10-30). The board dims the page with rgba(20, 20, 19, 0.64); the dialog keeps the scrim token, rgba(0, 0, 0, 0.5), as every dialog does.',
  },
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // A modal dialog named by its title and described by its body.
    const dialog = canvas.getByRole('dialog', { name: TITLE });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription(BODY);
    expectComputed(dialog, {
      backgroundColor: 'rgb(42, 41, 39)',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      boxShadow: 'none',
      // dialog_fits_the_delete_desk_board: padded 24 px, as N-Run2-Settings-DeleteDesk draws it.
      paddingTop: '24px',
      paddingLeft: '24px',
    });
    // dialog_backdrop_is_the_scrim: the page behind is dimmed by the scrim token at full strength.
    // N-Run2-Settings-DeleteDesk dims it a little more, with rgba(20, 20, 19, 0.64); the token stays.
    const backdrop = getComputedStyle(dialog, '::backdrop');
    await expect(backdrop.backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
    await expect(backdrop.opacity).toBe('1');
    // 440 px wide, the body 12 px under the title, and the answers at a screen's main size.
    await expect(dialog.getBoundingClientRect().width).toBe(440);
    const heading = within(dialog).getByRole('heading', { name: TITLE });
    const body = dialog.querySelector('.cd-dialog__body')!;
    await expect(Math.round(body.getBoundingClientRect().top - heading.getBoundingClientRect().bottom)).toBe(12);
    for (const button of within(dialog).getAllByRole('button')) expectComputed(button, { height: '40px' });

    // The default tone: no dot beside the title, and neutral buttons.
    await expect(dialog.querySelector('.cd-status-dot')).toBeNull();
    const keep = within(dialog).getByRole('button', { name: 'Keep it' });
    const remove = within(dialog).getByRole('button', { name: 'Delete Desk' });
    expectComputed(remove, { backgroundColor: 'rgb(239, 236, 228)' });
    expectComputed(keep, { backgroundColor: 'rgba(250, 249, 245, 0.1)' });

    // dialog_traps_focus_and_escapes: focus starts on the least destructive answer, and Tab and
    // Shift+Tab cycle between the two buttons without leaving the dialog.
    await expect(keep).toHaveFocus();
    await userEvent.tab();
    await expect(remove).toHaveFocus();
    await userEvent.tab();
    await expect(keep).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(remove).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(keep).toHaveFocus();

    // Escape cancels once, and the dialog goes.
    await userEvent.keyboard('{Escape}');
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole('dialog')).toBeNull();

    // Opened from its button, it returns focus there when it closes.
    const opener = canvas.getByRole('button', { name: 'Delete this Desk' });
    await userEvent.click(opener);
    const reopened = canvas.getByRole('dialog', { name: TITLE });
    await expect(within(reopened).getByRole('button', { name: 'Keep it' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(args.onCancel).toHaveBeenCalledTimes(2);
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(opener).toHaveFocus();

    // Pending: neither button can be pressed, focus stays put, and Escape does nothing.
    await userEvent.keyboard('{Enter}');
    const waiting = canvas.getByRole('dialog', { name: TITLE });
    await userEvent.click(within(waiting).getByRole('button', { name: 'Delete Desk' }));
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    await expect(waiting).toHaveAttribute('aria-busy', 'true');
    const confirm = within(waiting).getByRole('button', { name: 'Delete Desk' });
    const cancel = within(waiting).getByRole('button', { name: 'Keep it' });
    for (const button of [confirm, cancel]) await expect(button).toHaveAttribute('aria-disabled', 'true');
    // spinner_on_the_pressed_button: Delete Desk, the one pressed, shows the busy spinner; Keep it
    // steps to its busy colors with no spinner, as the answer a held request's owner didn't choose.
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(confirm.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    await expect(cancel).not.toHaveAttribute('aria-busy');
    await expect(cancel.querySelector('.cd-button__spinner')).toBeNull();
    await waitFor(() => expectComputed(cancel, { color: 'rgba(250, 249, 245, 0.64)', backgroundColor: 'rgba(250, 249, 245, 0.1)', opacity: '1' }));
    await expect(confirm).toHaveFocus();
    await userEvent.click(confirm);
    await userEvent.click(cancel);
    await userEvent.keyboard('{Escape}');
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    await expect(args.onCancel).toHaveBeenCalledTimes(2);
    await expect(canvas.getByRole('dialog', { name: TITLE })).toBeVisible();
  },
};

export const Danger: Story = {
  args: { tone: 'danger' },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No signed screen uses the danger tone: deleting a Desk asks in the default tone (owner decision, 2026-10-30). Nearest is N-Run2-Settings-DeleteDesk, which drew the dot before that decision.',
  },
  play: async ({ canvas }) => {
    // Danger adds a refused dot beside the title, hidden from screen readers; the buttons stay neutral.
    const dialog = canvas.getByRole('dialog', { name: TITLE });
    const dot = within(dialog).getByRole('heading', { name: TITLE }).querySelector('.cd-status-dot--refused');
    await expect(dot).not.toBeNull();
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    expectComputed(within(dialog).getByRole('button', { name: 'Delete Desk' }), { backgroundColor: 'rgb(239, 236, 228)' });
    expectComputed(within(dialog).getByRole('button', { name: 'Keep it' }), { backgroundColor: 'rgba(250, 249, 245, 0.1)' });
  },
};

/** Lets a queued close event, if any, arrive before the next check. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

export const ClosedByTheBrowser: Story = {
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws the browser closing a dialog itself, as a back gesture on Android can, and the screen hearing about it. N-Run2-Settings-DeleteDesk draws the dialog open.',
  },
  play: async ({ args, canvas, userEvent }) => {
    // dialog_reports_a_browser_close: a close the screen didn't ask for calls onCancel once, so
    // the screen removes the dialog and its opener works again.
    const dialog = canvas.getByRole('dialog', { name: TITLE }) as HTMLDialogElement;
    dialog.close();
    await nextTask();
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole('dialog')).toBeNull();

    // The browser's own close request (a cancel event that isn't a key press) cancels like Escape.
    const opener = canvas.getByRole('button', { name: 'Delete this Desk' });
    await userEvent.click(opener);
    const reopened = (await canvas.findByRole('dialog', { name: TITLE })) as HTMLDialogElement;
    reopened.dispatchEvent(new Event('cancel', { cancelable: true }));
    await nextTask();
    await expect(args.onCancel).toHaveBeenCalledTimes(2);
    await expect(canvas.queryByRole('dialog')).toBeNull();

    // Escape, and the close when the screen removes the dialog, still cancel only once.
    await userEvent.click(opener);
    await canvas.findByRole('dialog', { name: TITLE });
    await userEvent.keyboard('{Escape}');
    await nextTask();
    await expect(args.onCancel).toHaveBeenCalledTimes(3);
    await expect(canvas.queryByRole('dialog')).toBeNull();
  },
};
