import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { IntroDialog } from '../components/IntroDialog/IntroDialog.tsx';
import { expectComputed } from '../test/expectComputed.ts';
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
        intro="You’re Maria Rivera today, owner of Rivera Plumbing. Her Desk answers customers and their agents under her rules. Try it, then try to break it."
        thingsToTry={[
          { title: 'Chat as a customer', detail: 'Rivera’s public page opens in a new tab.', icon: 'person' },
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
      'The board draws the reply card’s mark at 18 px inside a dark 32 px tile; the owner dropped that frame on 2026-10-30, so the mark stands alone at 32 px.',
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
    await expect(canvas.getByRole('heading', { level: 1, name: 'Good morning, Maria', hidden: true })).toBeInTheDocument();
    expectComputed(within(dialog).getByRole('heading', { name: TITLE }), {
      fontFamily: /^"Source Serif 4"/,
      fontSize: '28px',
      lineHeight: '35px',
      fontWeight: '460',
    });

    // At this width the illustration fills the dialog's right side, 400 px of its 880.
    const illustration = one(dialog, '.cd-intro__illustration');
    const panel = one(dialog, '.cd-intro__panel').getBoundingClientRect();
    await expect(illustration).toBeVisible();
    await expect(panel.width).toBe(880);
    await expect(illustration.getBoundingClientRect().width).toBe(400);
    await expect(illustration.getBoundingClientRect().right).toBe(panel.right);

    // focus_order_is_logical: focus starts in the passcode field, and with the field empty (Start
    // the demo disabled) Tab stays on it: nothing behind the dialog is reachable.
    const field = within(dialog).getByLabelText('Passcode');
    await expect(field).toHaveFocus();
    await userEvent.tab();
    await expect(field).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(field).toHaveFocus();
    const start = within(dialog).getByRole('button', { name: 'Start the demo' });
    await expect(start).toBeDisabled();
    expectComputed(start, SPEC.primary);
    await expectFooter(dialog);
  },
};
