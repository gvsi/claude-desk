import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within, type Mock } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { INTRO_ERROR_COPY, type IntroErrorCode } from './introCopy.ts';
import { IntroDialog, type IntroDialogProps } from './IntroDialog.tsx';

/** Anything that could take focus. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable]';

/**
 * The page's side of a try that fails: busy while the passcode is checked, then the story's error
 * again, and the promise rejects, as the web app's does when the passcode route says no.
 */
function FailingPage(args: IntroDialogProps) {
  const [state, setState] = useState<{ busy: boolean; error?: IntroErrorCode }>({ busy: false, error: args.error });
  return (
    <IntroDialog
      {...args}
      busy={state.busy}
      error={state.error}
      onSubmit={async (passcode) => {
        setState({ busy: true });
        await args.onSubmit(passcode);
        setState({ busy: false, error: args.error });
        throw new Error('The passcode route said no.');
      }}
    />
  );
}

/**
 * The page's side of a try that starts the demo: `busy` goes on as the passcode is sent and stays
 * on while the demo opens. The promise settles at once, so only `busy` holds a second submit back.
 */
function StartingPage(args: IntroDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <IntroDialog
      {...args}
      busy={busy}
      onSubmit={async (passcode) => {
        setBusy(true);
        await args.onSubmit(passcode);
      }}
    />
  );
}

/** The error line, the field's state and its focus, for a dialog showing `code`. */
async function expectErrorOnTheField(canvas: ReturnType<typeof within>, code: IntroErrorCode): Promise<void> {
  const field = canvas.getByLabelText('Passcode');
  const alert = canvas.getByRole('alert');
  await expect(alert).toHaveTextContent(INTRO_ERROR_COPY[code]);
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(INTRO_ERROR_COPY[code]);
  await expect(field).toHaveFocus();
  // The line sits under the field, and the code itself is nowhere in the page.
  await expect(alert.getBoundingClientRect().top).toBeGreaterThanOrEqual(field.getBoundingClientRect().bottom);
  await expect(document.body.innerHTML).not.toContain(code);
}

const meta = {
  title: 'Intro/IntroDialog',
  component: IntroDialog,
  args: {
    title: 'A Claude front desk for your business',
    intro:
      'You’re Maria Rivera today, owner of Rivera Plumbing. Her Desk answers customers and their agents under her rules. Try it, then try to break it.',
    thingsToTry: [
      { title: 'Chat as a customer', detail: 'Rivera’s public page opens beside you.', icon: 'person' },
      { title: 'Try to break it', detail: 'Ask for a discount or someone else’s details.', icon: 'safety' },
      { title: 'Answer a held request', detail: 'One is waiting for you on Today.', icon: 'check' },
      { title: 'Create your own Desk', detail: 'It gets a live link you can share.', icon: 'plus' },
    ],
    submitLabel: 'Start the demo',
    onSubmit: fn(async () => {}),
  },
  parameters: {
    layout: 'fullscreen',
    canvas: 'none',
    canvasNote:
      'From the canvas board N-Intro-D on the Claude Desk · First visit page; the design system screens plan adds it to the reference boards.',
  },
} satisfies Meta<typeof IntroDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  // A link on the page behind, as the web app's preview of Today has, so Tab has somewhere to escape to.
  decorators: [
    (Story) => (
      <>
        <a href="#today">Today</a>
        <Story />
      </>
    ),
  ],
  play: async ({ args, canvas, userEvent }) => {
    const dialog = canvas.getByRole('dialog', { name: args.title });
    const field = canvas.getByLabelText('Passcode');
    const button = canvas.getByRole('button', { name: 'Start the demo' });

    // focuses_the_field_on_open: the passcode field has focus as soon as the dialog shows.
    await expect(field).toHaveFocus();
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    await expect(dialog).toHaveAccessibleDescription(args.intro);
    // A main-action-tall field whose outline, its boundary, reaches 3:1 (line-field).
    expectComputed(field, { height: '40px', borderTopLeftRadius: '8px', borderTopWidth: '1px' });
    expectComputed(field, { borderTopColor: 'rgba(250, 249, 245, 0.36)', borderBottomColor: 'rgba(250, 249, 245, 0.36)' });
    await expect(field).not.toHaveAttribute('aria-invalid');
    await expect(field).not.toHaveAttribute('aria-describedby');
    await expect(canvas.queryByRole('alert')).toBeNull();

    // empty_cannot_submit: nothing to send while the field is empty or only spaces, by Enter or the button.
    await expect(button).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('   ');
    await expect(button).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(field);

    // cannot_be_dismissed: Escape keeps it open, there is no close button, and the scrim does nothing.
    await userEvent.keyboard('{Escape}');
    await expect(dialog).toBeVisible();
    await expect((dialog as HTMLDialogElement).open).toBe(true);
    await expect(canvas.queryByRole('button', { name: /close|dismiss|cancel|skip|not now/i })).toBeNull();
    await expect(canvas.getAllByRole('button')).toEqual([button]);
    await userEvent.click(dialog);
    await expect(dialog).toBeVisible();
    await expect((dialog as HTMLDialogElement).open).toBe(true);
    await expect(field).toHaveFocus();
    await expect(args.onSubmit).not.toHaveBeenCalled();
    // The scrim fills the window behind the panel, at the board's half-black.
    expectComputed(dialog, { position: 'fixed', backgroundColor: 'rgba(0, 0, 0, 0.5)' });
    const scrim = dialog.getBoundingClientRect();
    await expect([scrim.left, scrim.top, scrim.width, scrim.height]).toEqual([0, 0, window.innerWidth, window.innerHeight]);

    // focus_stays_inside: Tab and Shift+Tab cycle between the field and the button, and nowhere else.
    await userEvent.type(field, 'rivera-demo');
    await expect(button).toBeEnabled();
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.tab();
    await expect(field).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(button).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(field).toHaveFocus();
    await expect(args.onSubmit).not.toHaveBeenCalled();

    // enter_submits_the_passcode: Enter sends the trimmed passcode, once. While that send is still
    // out, another Enter or a click sends nothing, even before the page says it is busy.
    (args.onSubmit as Mock<IntroDialogProps['onSubmit']>).mockImplementationOnce(() => new Promise<void>(() => {}));
    await userEvent.clear(field);
    await userEvent.type(field, ' rivera-demo ');
    await userEvent.keyboard('{Enter}');
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith('rivera-demo');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(button);
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);

    // title_is_the_voice: the title speaks in Claude's serif, balanced over its lines.
    const title = within(dialog).getByRole('heading', { level: 2, name: args.title });
    expectComputed(title, { fontFamily: /Source Serif 4/, fontSize: '28px', lineHeight: '35px', fontWeight: '460' });
    expectComputed(title, { letterSpacing: '-0.2px', textWrapStyle: 'balance' });

    // things_to_try_in_order: four items under their heading, each title with its detail.
    await expect(within(dialog).getByRole('heading', { level: 3, name: 'Things to try' })).toBeVisible();
    const items = within(within(dialog).getByRole('list')).getAllByRole('listitem');
    await expect(items.map((item) => within(item).getByText(/./, { selector: '.cd-intro__thing-title' }).textContent)).toEqual(
      args.thingsToTry.map((thing) => thing.title),
    );
    for (const [index, item] of items.entries()) {
      const thing = args.thingsToTry[index];
      await expect(item).toHaveTextContent(`${thing?.title}${thing?.detail}`);
      // Each line icon sits centered against its title and detail.
      const icon = item.querySelector('svg');
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      const iconBox = (icon as SVGElement).getBoundingClientRect();
      const itemBox = item.getBoundingClientRect();
      await expect(Math.abs(iconBox.top - itemBox.top - (itemBox.bottom - iconBox.bottom))).toBeLessThanOrEqual(1);
    }

    // illustration_is_hidden: the clay half is decoration, out of reach of assistive tech and the keyboard.
    const art = dialog.querySelector<HTMLElement>('.cd-intro__illustration');
    await expect(art).not.toBeNull();
    await expect(art).toHaveAttribute('aria-hidden', 'true');
    await expect(art?.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expectComputed(art as HTMLElement, { backgroundColor: 'rgb(224, 137, 104)', width: '400px' });
  },
};

export const Busy: Story = {
  render: (args) => <StartingPage {...args} />,
  play: async ({ args, canvas, userEvent }) => {
    // busy_submits_once: a click starts the demo. The button then reads "Starting" and keeps focus,
    // still reachable but inert (aria-disabled, not disabled), and nothing more is sent.
    const field = canvas.getByLabelText('Passcode');
    await userEvent.type(field, 'rivera-demo');
    const button = canvas.getByRole('button', { name: 'Start the demo' });
    await userEvent.click(button);
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith('rivera-demo');

    await expect(canvas.getByRole('button', { name: 'Starting' })).toBe(button);
    await expect(canvas.queryByRole('button', { name: 'Start the demo' })).toBeNull();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).not.toHaveAttribute('disabled');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button.closest('form')).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveFocus();

    // A second click, Enter on the button and Enter in the field all send nothing.
    await userEvent.click(button);
    await userEvent.keyboard('{Enter}');
    await expect(button).toHaveFocus();
    await userEvent.tab();
    await expect(field).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
  },
};

export const WrongPasscode: Story = {
  args: { error: 'wrong_passcode' },
  render: (args) => <FailingPage {...args} />,
  play: async ({ args, canvas, userEvent }) => {
    // error_is_an_alert_on_the_field: the line is an alert, and it describes the invalid field.
    await expectErrorOnTheField(canvas, 'wrong_passcode');

    // Another try that fails: the promise's rejection is ignored, and when the error comes back the
    // field has focus again with its text selected, ready to type over.
    const field = canvas.getByLabelText<HTMLInputElement>('Passcode');
    await userEvent.type(field, 'rivera');
    await userEvent.keyboard('{Enter}');
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith('rivera');
    await waitFor(() => expect(canvas.getByRole('alert')).toBeVisible());
    await expectErrorOnTheField(canvas, 'wrong_passcode');
    await expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'rivera'.length]);
    await expect(canvas.getByRole('button', { name: 'Start the demo' })).toBeEnabled();
  },
};

export const RateLimited: Story = {
  args: { error: 'rate_limited' },
  play: async ({ canvas }) => {
    await expectErrorOnTheField(canvas, 'rate_limited');
  },
};

export const Unreachable: Story = {
  args: { error: 'unreachable' },
  play: async ({ canvas }) => {
    await expectErrorOnTheField(canvas, 'unreachable');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ args, canvas }) => {
    // phone_fits: at 390 px nothing is wider than the window, and nothing scrolls sideways.
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const dialog = canvas.getByRole('dialog', { name: args.title });
    const tooWide = [dialog, ...dialog.querySelectorAll('*')].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > width || box.left < 0 || box.right > width;
    });
    await expect(tooWide).toEqual([]);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);

    // The panel fills the width with 16 px margins, and the illustration isn't drawn.
    const panel = dialog.querySelector('.cd-intro__panel') as HTMLElement;
    const panelBox = panel.getBoundingClientRect();
    await expect([panelBox.left, width - panelBox.right]).toEqual([16, 16]);
    await expect(dialog.querySelector('.cd-intro__illustration')).not.toBeVisible();

    // The field and the button stack, the button as wide as the field.
    const field = canvas.getByLabelText('Passcode');
    const button = canvas.getByRole('button', { name: 'Start the demo' });
    const fieldBox = field.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    await expect(buttonBox.top).toBeGreaterThanOrEqual(fieldBox.bottom);
    await expect([buttonBox.left, buttonBox.width]).toEqual([fieldBox.left, fieldBox.width]);
    await expect(field).toHaveFocus();
  },
};
