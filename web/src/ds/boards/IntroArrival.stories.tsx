import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { IntroDialog } from '../components/IntroDialog/IntroDialog.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { settled } from '../test/settled.ts';
import { TodayNeedsYou } from './parts.tsx';
import { SPEC, expectFooter, one } from './spec.ts';

const TITLE = 'A Claude front desk for your business';

/** The first visit: the intro dialog over a still Today, which it blocks until the passcode is in. */
function IntroArrival() {
  return (
    <>
      <TodayNeedsYou reviewer={false} />
      <IntroDialog
        title={TITLE}
        intro="You’re Mike Turner today, owner of Turner Plumbing. His Desk answers customers and their agents under his rules. Try it, then try to break it."
        thingsToTry={[
          { title: 'Chat as a customer', detail: 'Turner’s public page opens in a new tab.', icon: 'person' },
          { title: 'Try to break it', detail: 'Ask for a discount or someone else’s details.', icon: 'safety' },
          { title: 'Answer a held request', detail: 'One is waiting for you on Today.', icon: 'check' },
          { title: 'Create your own Desk', detail: 'It gets a live link you can share.', icon: 'plus' },
        ]}
        submitLabel="Start the demo"
        onSubmit={fn(async () => {})}
      />
    </>
  );
}

const meta = {
  title: 'Boards/First visit, intro',
  render: () => <IntroArrival />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Intro-D',
    canvasNote: [
      'The dialog with the board’s copy, over a still Today: the web app (plan 04) draws that preview behind it, and here it is the signed Today board (N-Today-Run1) without its reviewer bar, where the board shows an earlier Today with a composer and a Desk picker.',
      'The board draws no reviewer bar behind the dialog; the reviewer bar comes with Today once the passcode is in.',
      'The board draws the reply card’s mark at 18 px inside a dark 32 px tile; the owner dropped that frame on 2026-10-30, so the mark stands alone at 32 px with no tile, in its dark ink (N-Explore-Mark-Decided).',
      'The board’s brand row ends in a “Demo” pill; the owner replaced it on 2026-10-30 with the Wordmark’s “Preview” badge, the sidebar lockup’s one label.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    // A modal dialog named by its title, over Today, which it makes inert.
    const dialog = canvas.getByRole('dialog', { name: TITLE });
    await expect(dialog.matches(':modal')).toBe(true);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Good morning, Mike', hidden: true })).toBeInTheDocument();
    expectComputed(within(dialog).getByRole('heading', { name: TITLE }), {
      fontFamily: /^"Source Serif 4"/,
      fontSize: '28px',
      lineHeight: '35px',
      fontWeight: '460',
    });

    // The brand row: the mark and the Wordmark with its Preview badge, as in the sidebar's lockup
    // (owner, 2026-10-30), where the board draws a "Demo" pill.
    await expect(one(dialog, '.cd-intro__brand').textContent).toBe('Claude DeskPreview');

    // At this width the illustration fills the dialog's right side, 400 px of its 880, once the
    // panel has arrived and the illustration has played.
    await settled(dialog);
    const illustration = one(dialog, '.cd-intro__illustration');
    const panel = one(dialog, '.cd-intro__panel').getBoundingClientRect();
    await expect(illustration).toBeVisible();
    await expect(panel.width).toBe(880);
    await expect(illustration.getBoundingClientRect().width).toBe(400);
    await expect(illustration.getBoundingClientRect().right).toBe(panel.right);

    // focus_order_is_logical: focus starts in the passcode field, and with the field empty (Start
    // the demo disabled) Tab goes only to the footer's author link and back: nothing behind the
    // dialog is reachable.
    const field = within(dialog).getByLabelText('Passcode');
    const author = dialog.querySelector<HTMLElement>('[data-ds="concept-footer"] a');
    await expect(field).toHaveFocus();
    await userEvent.tab();
    await expect(author).toHaveFocus();
    await userEvent.tab();
    await expect(field).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(author).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(field).toHaveFocus();
    const start = within(dialog).getByRole('button', { name: 'Start the demo' });
    await expect(start).toBeDisabled();
    expectComputed(start, SPEC.primary);
    await expectFooter(dialog);
  },
};
