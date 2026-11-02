import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { contrastRatio } from '../../contrast.ts';
import { chen } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ReplyCard } from '../ReplyCard/ReplyCard.tsx';
import { VerifiedLine } from './VerifiedLine.tsx';
import { VerifyCodeForm, type VerifyCodeFormProps, type VerifyCodeState } from './VerifyCodeForm.tsx';

/** The one line for a wrong, expired or used-up code. */
const FAILED_LINE = 'That code didn’t work. Check the newest code, or ask me for a new one.';

const BOARD = 'N-Public-Verify-Run1';

/** The verify card above the form: the fixture's `verify_prompt` block, in the form's language. */
function UnderTheCard(args: VerifyCodeFormProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-16)', maxWidth: 'var(--size-reading)' }}>
      <ReplyCard block={chen.blocks.verify_prompt[args.language]} language={args.language} ownerName={chen.business.ownerName} />
      <VerifyCodeForm {...args} />
    </div>
  );
}

/** The event a story sends the screen below, carrying the form's next state. */
const SCREEN_STATE = 'cd-story-verify-state';

/** The form as a screen holds it, moved to whatever state the story sends. */
function UpdatingScreen(args: VerifyCodeFormProps) {
  const [state, setState] = useState(args.state);
  useEffect(() => {
    const onState = (event: Event) => {
      if (event instanceof CustomEvent) setState(event.detail as VerifyCodeState);
    };
    window.addEventListener(SCREEN_STATE, onState);
    return () => window.removeEventListener(SCREEN_STATE, onState);
  }, []);
  return <UnderTheCard {...args} state={state} />;
}

/** Moves the screen's form to `state`, as the verify route's answer would. */
function updateScreen(root: HTMLElement, state: VerifyCodeState): void {
  root.ownerDocument.defaultView?.dispatchEvent(new CustomEvent(SCREEN_STATE, { detail: state }));
}

const meta = {
  title: 'Verification/VerifyCodeForm',
  component: VerifyCodeForm,
  args: { state: 'idle', language: 'en', onSubmit: fn(), onAskForOwner: fn() },
  render: (args) => <UnderTheCard {...args} />,
  parameters: {
    layout: 'padded',
    canvas: BOARD,
    canvasNote:
      "The board's left column (Chen & Co. CPA, while the code is on its way) draws this form from TextField and Button under the verify card, in a dashed box from before the form was built. The field's outline is line-field (rgba(250, 249, 245, 0.36), 3.2:1 against the page), where the board draws rgba(250, 249, 245, 0.22) (2.0:1): an empty field's boundary needs 3:1, as every text field's does.",
  },
} satisfies Meta<typeof VerifyCodeForm>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The first ground under an element: the color its own transparent box shows. */
function groundOf(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const ground = getComputedStyle(node).backgroundColor;
    if (ground !== 'rgba(0, 0, 0, 0)' && ground !== 'transparent') return ground;
  }
  throw new Error('no ground under the element');
}

/** The field's outline: line-field, 3:1 against the ground it sits on, and no fill of its own. */
async function expectFieldBoundary(field: HTMLElement): Promise<void> {
  expectComputed(field, { borderTopColor: 'rgba(250, 249, 245, 0.36)', backgroundColor: 'rgba(0, 0, 0, 0)' });
  await expect(contrastRatio(getComputedStyle(field).borderTopColor, groundOf(field))).toBeGreaterThanOrEqual(3);
}

/** The form itself, without the card above it. */
function formOf(root: HTMLElement): HTMLFormElement {
  const form = root.querySelector('form');
  if (!form) throw new Error('the verification form did not render');
  return form;
}

export const Idle: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const form = formOf(canvasElement);
    const field = canvas.getByLabelText('6-digit code') as HTMLInputElement;
    const confirm = canvas.getByRole('button', { name: 'Confirm' });
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    // No character limit of the browser's, which would cut a code before its spaces are dropped:
    // the form keeps six digits itself (pastes_spaced_code, below).
    await expect(field).not.toHaveAttribute('maxlength');
    await expect(field).toHaveValue('');

    // The board's parts: the label above a main-height field, and Confirm beside it on the same
    // line, as tall as the field. "I can't get the code" is a ghost button under them, and the
    // whole form is no wider than the reply card above it.
    const label = canvasElement.querySelector(`label[for="${field.id}"]`) as HTMLElement;
    expectComputed(label, { fontSize: '16px', lineHeight: '22px', fontWeight: '420', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(field.getBoundingClientRect().top - label.getBoundingClientRect().bottom).toBe(6);
    expectComputed(field, { height: '40px', borderTopWidth: '1px', borderTopLeftRadius: '8px', fontSize: '15px' });
    // field_boundary_meets_contrast: an empty field has no words of its own to say what it is, so
    // its outline is its boundary, line-field at 3:1 against the page, at rest and on hover, as
    // every text field's is. The signed board draws it fainter; see the canvas note.
    await expectFieldBoundary(field);
    await userEvent.hover(field);
    await expectFieldBoundary(field);
    await userEvent.unhover(field);
    const fieldBox = field.getBoundingClientRect();
    const confirmBox = confirm.getBoundingClientRect();
    await expect(confirm).toHaveClass('cd-button--primary', 'cd-button--main');
    await expect([confirmBox.top, confirmBox.height]).toEqual([fieldBox.top, fieldBox.height]);
    await expect(confirmBox.left - fieldBox.right).toBe(8);
    const help = canvas.getByRole('button', { name: 'I can’t get the code' });
    await expect(help).toHaveClass('cd-button--ghost');
    await expect(help.getBoundingClientRect().top - fieldBox.bottom).toBe(10);
    await expect(help.getBoundingClientRect().left).toBe(fieldBox.left);
    await expect(form.getBoundingClientRect().width).toBe(520);

    // form_does_not_repeat_the_card: the card's words show once, in the card, and the form says
    // nothing of the kernel's uniform message either: only its label and its two buttons.
    const cardTitle = chen.blocks.verify_prompt.en.text;
    await expect(canvas.getAllByText(cardTitle)).toHaveLength(1);
    await expect(form.textContent).not.toContain(cardTitle);
    await expect(form.textContent).not.toContain(chen.verifyStarted.en.message);
    await expect(within(form).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Confirm',
      'I can’t get the code',
    ]);

    // rejects_non_digits: only digits enter the field, however they arrive. Letters, spaces and
    // dashes typed are dropped; full-width digits from some keyboards count as digits.
    await userEvent.type(field, '4a8-2 9b');
    await expect(field).toHaveValue('4829');
    await expect(confirm).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, '４８２');
    await expect(field).toHaveValue('482');
    await userEvent.clear(field);
    await userEvent.type(field, 'code me');
    await expect(field).toHaveValue('');
    await expect(confirm).toBeDisabled();
    // A pasted code keeps its six digits, even when it comes with words and spaces around it that
    // are longer than the field allows.
    await userEvent.click(field);
    await userEvent.paste('Code: 615 204.');
    await expect(field).toHaveValue('615204');
    await userEvent.clear(field);
    // pastes_spaced_code: a code written with spaces or a dash keeps all six digits, as a paste or
    // as one insertion with no paste event, the way a phone keyboard's clipboard suggestion, a
    // dropped text or a filling tool brings it in. Still six digits at most.
    for (const spaced of ['482 913', '48 29 13', '482-913']) {
      await userEvent.click(field);
      await userEvent.paste(spaced);
      await expect(field).toHaveValue('482913');
      await userEvent.clear(field);
      field.focus();
      document.execCommand('insertText', false, spaced);
      await expect(field).toHaveValue('482913');
      await userEvent.clear(field);
    }
    field.focus();
    document.execCommand('insertText', false, '48 29 13 77');
    await expect(field).toHaveValue('482913');
    await userEvent.clear(field);
    // keeps_a_whole_code: a digit typed into six digits, at the start, in the middle or at the end,
    // is refused, and the six and the caret stay as they were.
    await userEvent.type(field, '482913');
    await userEvent.type(field, '7', { initialSelectionStart: 0, initialSelectionEnd: 0 });
    await expect(field).toHaveValue('482913');
    await userEvent.type(field, '7', { initialSelectionStart: 3, initialSelectionEnd: 3 });
    await expect(field).toHaveValue('482913');
    await expect(field.selectionStart).toBe(3);
    await userEvent.type(field, '7');
    await expect(field).toHaveValue('482913');
    // Nor does a short paste with nothing selected: "7" at the start, "77" in the middle.
    field.setSelectionRange(0, 0);
    await userEvent.paste('7');
    await expect(field).toHaveValue('482913');
    field.setSelectionRange(3, 3);
    await userEvent.paste('77');
    await expect(field).toHaveValue('482913');
    // What goes over a selection replaces it, and the digits around it stay: "77" over the 9.
    field.setSelectionRange(3, 4);
    await userEvent.paste('77');
    await expect(field).toHaveValue('482771');
    // A new code over the whole one selected, as after a failed try, keeps its six digits, written
    // with a space or a dash, pasted or inserted.
    for (const next of ['615 204', '615-204']) {
      await userEvent.clear(field);
      await userEvent.type(field, '482913');
      field.setSelectionRange(0, 6);
      await userEvent.paste(next);
      await expect(field).toHaveValue('615204');
      await userEvent.clear(field);
      await userEvent.type(field, '482913');
      field.select();
      document.execCommand('insertText', false, next);
      await expect(field).toHaveValue('615204');
    }
    field.select();
    document.execCommand('insertText', false, '61 52 04 99');
    await expect(field).toHaveValue('615204');
    // A whole new code is the code, wherever it goes in: pasted or inserted with the caret at the
    // end of the old one, it takes its place rather than being dropped after it.
    await userEvent.clear(field);
    await userEvent.type(field, '482913');
    field.setSelectionRange(6, 6);
    await userEvent.paste('615204');
    await expect(field).toHaveValue('615204');
    // A phone keyboard's clipboard suggestion inserts the whole text as one typed insertion.
    // (`execCommand` sends no `beforeinput`, so the keyboard's event is sent as it would send it.)
    field.setSelectionRange(6, 6);
    field.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '48 29 13', bubbles: true, cancelable: true }));
    await waitFor(() => expect(field).toHaveValue('482913'));
    await userEvent.clear(field);
    await expect(args.onSubmit).not.toHaveBeenCalled();

    // submits_six_digits: nothing goes until all six digits are in, by Enter or by the button.
    await expect(confirm).toBeDisabled();
    await userEvent.type(field, '48291{Enter}');
    await expect(confirm).toBeDisabled();
    await expect(args.onSubmit).not.toHaveBeenCalled();
    // The sixth digit, then Enter: the six digits typed, once. A second Enter or a click before the
    // screen says it is checking sends nothing more.
    await userEvent.type(field, '3{Enter}');
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith('482913');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(confirm);
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onAskForOwner).not.toHaveBeenCalled();
  },
};

export const Checking: Story = {
  args: { state: 'checking' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const field = canvas.getByLabelText('6-digit code');
    await userEvent.type(field, '482913');
    // A busy button keeps its words: Confirm says it is busy, and stays focusable but inert.
    const confirm = canvas.getByRole('button', { name: 'Confirm' });
    await expect(confirm).toHaveTextContent(/^Confirm$/);
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await expect(confirm).toBeEnabled();
    await expect(formOf(canvasElement)).toHaveAttribute('aria-busy', 'true');
    // Nothing more goes while the code is checked, by Enter or by the button.
    await userEvent.type(field, '{Enter}');
    await userEvent.click(confirm);
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await expect(canvas.queryByRole('alert')).toBeNull();
    // The way out stays open.
    await userEvent.click(canvas.getByRole('button', { name: 'I can’t get the code' }));
    await expect(args.onAskForOwner).toHaveBeenCalledTimes(1);
  },
};

export const Failed: Story = {
  args: { state: 'failed' },
  render: (args) => <UpdatingScreen {...args} />,
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const field = canvas.getByLabelText('6-digit code') as HTMLInputElement;
    const help = canvas.getByRole('button', { name: 'I can’t get the code' });
    // One line, alike for a wrong, expired or used-up code: an alert under the field that
    // describes it, and the field takes focus, ready for the next code.
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent(FAILED_LINE);
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription(FAILED_LINE);
    await expect(field).toHaveFocus();
    await expect(alert.getBoundingClientRect().top).toBeGreaterThanOrEqual(field.getBoundingClientRect().bottom);
    await expect(help.getBoundingClientRect().top).toBeGreaterThanOrEqual(alert.getBoundingClientRect().bottom);
    // It says nothing of why: no status, code or reason from the verify route.
    await expect(formOf(canvasElement).textContent).not.toMatch(/invalid|expired|exhausted|422/i);

    // Another code goes, and while it is checked the line is gone, so the next failure is a new
    // alert that is read out again.
    await userEvent.type(field, '615204{Enter}');
    await expect(args.onSubmit).toHaveBeenCalledWith('615204');
    updateScreen(canvasElement, 'checking');
    await waitFor(() => expect(canvas.queryByRole('alert')).toBeNull());
    await expect(field).not.toHaveAttribute('aria-invalid');
    await expect(field).not.toHaveAccessibleDescription();
    updateScreen(canvasElement, 'failed');
    const again = await canvas.findByRole('alert');
    await expect(again).not.toBe(alert);
    await expect(again).toHaveTextContent(FAILED_LINE);
    // The field has focus again with its code selected, so the next one types over it.
    await expect(field).toHaveFocus();
    await expect([field.selectionStart, field.selectionEnd]).toEqual([0, 6]);
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
  },
};

export const Spanish: Story = {
  args: { language: 'es' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const form = formOf(canvasElement);
    // spanish_labels: the form's own words in Spanish, and no English one.
    await expect(form).toHaveAttribute('lang', 'es');
    const field = canvas.getByLabelText('Código de 6 dígitos');
    await expect(within(form).getAllByRole('button').map((button) => button.textContent)).toEqual(['Confirmar', 'No me llega el código']);
    for (const english of ['6-digit code', 'Confirm', 'I can’t get the code', 'code']) {
      await expect(form.textContent).not.toMatch(new RegExp(`\\b${english}\\b`));
    }
    // Under the Spanish card, whose words show once.
    await expect(canvas.getAllByText(chen.blocks.verify_prompt.es.text)).toHaveLength(1);
    await expect(form.textContent).not.toContain(chen.verifyStarted.es.message);
    await userEvent.type(field, '482913{Enter}');
    await expect(args.onSubmit).toHaveBeenCalledWith('482913');
  },
};

/** No clock time, in any form: no contract carries one, and visitor surfaces show none. */
const CLOCK = /\d{1,2}:\d{2}|\b(?:am|pm)\b/i;

/** The line the screen shows once the code works, with what a screen reader reads in it. */
async function expectVerifiedLine(root: HTMLElement, words: string, language: 'en' | 'es') {
  const line = within(root).getByRole('status');
  await expect(line).toHaveTextContent(words, { normalizeWhitespace: true });
  await expect(line.querySelector('.cd-system-line__text')?.textContent).toBe(words);
  await expect(line.closest('[lang]')).toHaveAttribute('lang', language);
  await expect(line.textContent).not.toMatch(CLOCK);
  // The form is gone by then; only the line shows.
  await expect(root.querySelector('form')).toBeNull();
}

export const VerifiedSimulated: Story = {
  render: () => <VerifiedLine text={`Verified with a code sent to ${chen.people.raj.maskedContact}`} assurance="demo_code" language="en" />,
  parameters: {
    canvasNote: "The board's right column (Chen & Co. CPA, after the code), where the board adds the label by hand.",
  },
  play: async ({ canvasElement }) => {
    // demo_code_is_labelled_simulated: a code from the Demo inbox proves the routing, not the
    // contact, so the line says the verification was simulated.
    await expectVerifiedLine(canvasElement, 'Verified with a code sent to •••• 0142. Simulated verification', 'en');
  },
};

export const VerifiedSimulatedEs: Story = {
  render: () => (
    <VerifiedLine text={`Verificado con un código enviado a ${chen.people.raj.maskedContact}`} assurance="demo_code" language="es" />
  ),
  parameters: {
    canvasNote: `${BOARD} in Spanish, which no board shows: the visitor's own words come from the screen, the label from the form.`,
  },
  play: async ({ canvasElement }) => {
    await expectVerifiedLine(canvasElement, 'Verificado con un código enviado a •••• 0142. Verificación simulada', 'es');
  },
};
