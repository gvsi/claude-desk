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

/**
 * A page that leaves `error` set while it retries, then fails again with the same code: the line
 * has to be announced again all the same.
 */
function SameErrorPage(args: IntroDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <IntroDialog
      {...args}
      busy={busy}
      onSubmit={async (passcode) => {
        setBusy(true);
        await args.onSubmit(passcode);
        setBusy(false);
        throw new Error('The passcode route said no again.');
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
      { title: 'Chat as a customer', detail: 'Rivera’s public page opens in a new tab.', icon: 'person' },
      { title: 'Try to break it', detail: 'Ask for a discount or someone else’s details.', icon: 'safety' },
      { title: 'Answer a held request', detail: 'One is waiting for you on Today.', icon: 'check' },
      { title: 'Create your own Desk', detail: 'It gets a live link you can share.', icon: 'plus' },
    ],
    submitLabel: 'Start the demo',
    onSubmit: fn(async () => {}),
  },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Intro-D',
    canvasNote:
      'N-Intro-D draws the reply card’s mark at 18 px inside a dark 32 px tile; the owner dropped that frame on 2026-10-30, so the mark stands alone at 32 px, with no tile, in its dark ink (N-Explore-Mark-Decided), and the brand’s mark has no tile.',
  },
} satisfies Meta<typeof IntroDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
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
    // The page behind doesn't scroll while the dialog is open.
    expectComputed(document.documentElement, { overflowX: 'hidden', overflowY: 'hidden' });

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
    // list_role_survives_unstyled_markers: Safari announces the list only with role="list".
    await expect(within(dialog).getByRole('list')).toHaveAttribute('role', 'list');
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
    // Claude's line on the reply card is in serif, like everything Claude says.
    const reply = art?.querySelector('.cd-intro__reply') as HTMLElement;
    expectComputed(reply, { fontFamily: /Source Serif 4/, fontSize: '16px', lineHeight: '24px', fontWeight: '380' });

    // reply_avatar_is_the_mark_alone: the reply card's avatar is the Claude Desk mark at 32 px with no
    // tile and no frame, in the drawing's dark ink straight on the light card (owner, 2026-10-30), in
    // the place and at the size of Dana's initials on the card above. The name line keeps its place:
    // level with the mark's top, 12 px to its right.
    const cards = [...(art?.querySelectorAll<HTMLElement>(':scope > .cd-intro__card') ?? [])];
    await expect(cards).toHaveLength(2);
    const [request, replyCard] = cards as [HTMLElement, HTMLElement];
    const mark = replyCard.firstElementChild as SVGSVGElement;
    await expect(mark.getAttribute('class')).toBe('cd-mark cd-mark--light');
    await expect([mark.getAttribute('width'), mark.getAttribute('height')]).toEqual(['32', '32']);
    await expect(replyCard.querySelector('.cd-intro__tile')).toBeNull();
    await expect(mark.querySelector('rect')).toBeNull();
    expectComputed(mark.querySelector(':scope > g > g:last-child') as Element, { fill: 'rgb(20, 20, 19)' });
    expectComputed(mark, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    expectComputed(replyCard, { backgroundColor: 'rgb(250, 249, 245)' });
    // brand_mark_has_no_tile: the mark beside the wordmark at the top of the dialog is drawn without
    // its tile, in the light ink on the dialog's dark surface.
    const brandMark = dialog.querySelector('.cd-intro__brand > svg.cd-mark') as SVGSVGElement;
    await expect(brandMark.querySelector('rect')).toBeNull();
    expectComputed(brandMark.querySelector(':scope > g > g:last-child') as Element, { fill: 'rgb(250, 249, 245)' });
    /** Where `el` sits in `card` and how big it is: [left, top, width, height] in px. */
    const inCard = (el: Element | null, card: HTMLElement) => {
      const outer = card.getBoundingClientRect();
      const inner = (el as Element).getBoundingClientRect();
      return [inner.left - outer.left, inner.top - outer.top, inner.width, inner.height];
    };
    await expect(inCard(mark, replyCard)).toEqual([16, 14, 32, 32]);
    await expect(inCard(mark, replyCard)).toEqual(inCard(request.querySelector('.cd-intro__avatar'), request));
    await expect(inCard(replyCard.querySelector('.cd-intro__who'), replyCard).slice(0, 2)).toEqual([60, 14]);
  },
};

/**
 * The demo is starting: the button shows the busy spinner in place of its words, which still name
 * it, and a status line, seen only by screen readers, says so.
 */
async function expectStartingSpinner(button: HTMLElement, status: HTMLElement): Promise<void> {
  await expect(button.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
  expectComputed(button.querySelector('.cd-button__label') as HTMLElement, { opacity: '0' });
  await expect(status.textContent).toBe('Starting the demo');
  await expect(status).toHaveClass('cd-sr-only');
}

export const Busy: Story = {
  args: { busy: true },
  play: async ({ args, canvas, userEvent }) => {
    // busy_submits_once: while the demo starts the button shows the spinner, like every busy button,
    // is still named "Start the demo", stays focusable but inert, and nothing is sent.
    const button = canvas.getByRole('button', { name: 'Start the demo' });
    await expect(canvas.queryByRole('button', { name: 'Starting' })).toBeNull();
    await expectStartingSpinner(button, canvas.getByRole('status'));
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).not.toHaveAttribute('disabled');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button.closest('form')).toHaveAttribute('aria-busy', 'true');
    await userEvent.type(canvas.getByLabelText('Passcode'), 'rivera-demo');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(button);
    await expect(args.onSubmit).not.toHaveBeenCalled();
  },
};

export const StartingFlow: Story = {
  render: (args) => <StartingPage {...args} />,
  play: async ({ args, canvas, userEvent }) => {
    // busy_submits_once, from a click: the button then shows the spinner and keeps focus, still
    // reachable but inert (aria-disabled, not disabled), and nothing more is sent. The status line,
    // empty until then, says the demo is starting.
    const field = canvas.getByLabelText('Passcode');
    await userEvent.type(field, 'rivera-demo');
    const button = canvas.getByRole('button', { name: 'Start the demo' });
    const status = canvas.getByRole('status');
    await expect(status.textContent).toBe('');
    await expect(button.querySelector('.cd-button__spinner')).toBeNull();
    await userEvent.click(button);
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith('rivera-demo');

    await expect(canvas.getByRole('button', { name: 'Start the demo' })).toBe(button);
    await expectStartingSpinner(button, status);
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

export const WrongPasscodeAgain: Story = {
  args: { error: 'wrong_passcode' },
  render: (args) => <SameErrorPage {...args} />,
  play: async ({ args, canvas, userEvent }) => {
    // A second failure with the same code is a new alert, so it is announced again: the line isn't
    // shown while the try is out, even though the page kept `error` set.
    const first = canvas.getByRole('alert');
    await expectErrorOnTheField(canvas, 'wrong_passcode');
    const field = canvas.getByLabelText<HTMLInputElement>('Passcode');
    await userEvent.type(field, 'rivera');
    await userEvent.keyboard('{Enter}');
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith('rivera');
    await waitFor(() => expect(canvas.getByRole('alert')).not.toBe(first));
    await expect(first.isConnected).toBe(false);
    await expectErrorOnTheField(canvas, 'wrong_passcode');
    await expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'rivera'.length]);
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

export const Tablet: Story = {
  globals: { viewport: { value: 'tablet', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    // Below 960 px the panel can't hold both columns at full width, so the illustration goes and the
    // content keeps a comfortable measure: one column, at most 560 px wide, centered.
    await expect(window.innerWidth).toBe(768);
    const field = canvas.getByLabelText('Passcode');
    await expect(field.getBoundingClientRect().width).toBeGreaterThanOrEqual(200);
    await expect(canvasElement.querySelector('.cd-intro__illustration')).not.toBeVisible();
    const panel = canvasElement.querySelector('.cd-intro__panel') as HTMLElement;
    const panelBox = panel.getBoundingClientRect();
    await expect(panelBox.width).toBe(560);
    await expect(Math.abs(panelBox.left - (window.innerWidth - panelBox.right))).toBeLessThanOrEqual(1);
    // The field and the button still share a row at this width.
    const button = canvas.getByRole('button', { name: 'Start the demo' });
    await expect(button.getBoundingClientRect().top).toBe(field.getBoundingClientRect().top);
  },
};
