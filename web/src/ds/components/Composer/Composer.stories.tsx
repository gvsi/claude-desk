import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import { Composer } from './Composer.tsx';

/** The composer's raised box: the element that holds the text box. */
function boxOf(input: HTMLElement): HTMLElement {
  const box = input.closest<HTMLElement>('.cd-composer__box');
  if (!box) throw new Error('no composer box around the text box');
  return box;
}

/** The raised surface, the composer radius, the inset hairline and the composer's shadow. */
function expectComposerSurface(box: HTMLElement): void {
  expectComputed(box, {
    backgroundColor: 'rgb(42, 41, 39)',
    borderTopLeftRadius: '16px',
    boxShadow: /rgba\(250, 249, 245, 0\.12\) 0px 0px 0px 1px inset/,
  });
  expectComputed(box, { boxShadow: /rgba\(0, 0, 0, 0\.25\) 0px 4px 20px 0px/ });
}

const meta = {
  title: 'Controls/Composer',
  component: Composer,
  args: {
    variant: 'visitor',
    label: 'Message Rivera Plumbing',
    placeholder: 'Message Rivera Plumbing',
    onSend: fn(),
  },
  // As on the boards: the owner's composer spans the content column, a single-row one the reading column.
  decorators: [
    (Story, { args }) => (
      <div style={{ maxWidth: args.variant === 'owner' ? 'var(--size-content)' : 'var(--size-reading)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Public-Rivera-Run1' },
} satisfies Meta<typeof Composer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Owner: Story = {
  args: {
    variant: 'owner',
    label: 'Ask Claude about your Desk, or change a rule',
    placeholder: 'Ask Claude about your Desk, or change a rule',
    helper: 'Rule changes are shown to you before they apply.',
    onAttach: fn(),
    onSpeak: fn(),
  },
  parameters: { canvas: 'N-Today-Run1' },
  play: async ({ args, canvas, userEvent }) => {
    const input = canvas.getByRole('textbox', { name: 'Ask Claude about your Desk, or change a rule' });
    await expect(input.tagName).toBe('TEXTAREA');
    await expect(input).toHaveAttribute('placeholder', 'Ask Claude about your Desk, or change a rule');
    await expect(input).toHaveAccessibleDescription('Rule changes are shown to you before they apply.');
    expectComputed(input, { fontFamily: /Hanken Grotesk/, fontSize: '15px', lineHeight: '21px', fontWeight: '380' });
    const box = boxOf(input);
    expectComposerSurface(box);

    // Attach and speak are here because their handlers are; send waits for words.
    await userEvent.click(canvas.getByRole('button', { name: 'Add a photo or file' }));
    await expect(args.onAttach).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Speak instead' }));
    await expect(args.onSpeak).toHaveBeenCalledTimes(1);
    const send = canvas.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    expectComputed(send, { width: '32px', height: '32px', borderTopLeftRadius: '999px', backgroundColor: 'rgb(239, 236, 228)' });

    // The whole composer shows the focus ring while its text box has focus: 2 px accent blue, 2 px out.
    await userEvent.click(input);
    await expect(input).toHaveFocus();
    expectComputed(box, { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(126, 174, 218)', outlineOffset: '2px' });
    expectComputed(input, { outlineStyle: 'none' });

    // one_focus_ring: a control inside the composer shows its own ring, and the box shows none, so
    // there is never a ring inside a ring.
    await userEvent.tab();
    const attach = canvas.getByRole('button', { name: 'Add a photo or file' });
    await expect(attach).toHaveFocus();
    expectComputed(attach, { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(126, 174, 218)', outlineOffset: '2px' });
    expectComputed(box, { outlineStyle: 'none' });
    await userEvent.tab({ shift: true });
    await expect(input).toHaveFocus();
    expectComputed(box, { outlineStyle: 'solid', outlineColor: 'rgb(126, 174, 218)' });

    // enter_sends_shift_enter_newlines: Shift+Enter starts a new line; Enter sends the trimmed text and clears.
    await userEvent.keyboard('  Raise my cash discount limit');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await userEvent.keyboard('to 15%  ');
    await expect(input).toHaveValue('  Raise my cash discount limit\nto 15%  ');
    await expect(args.onSend).not.toHaveBeenCalled();
    await expect(send).toBeEnabled();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSend).toHaveBeenCalledTimes(1);
    await expect(args.onSend).toHaveBeenCalledWith('Raise my cash discount limit\nto 15%');
    await expect(input).toHaveValue('');
    await expect(input).toHaveFocus();
    await expect(send).toBeDisabled();

    // The text box grows with its text up to six lines, then scrolls.
    const oneLine = input.clientHeight;
    await expect(oneLine).toBe(21);
    await userEvent.keyboard('One{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three');
    await expect(input.clientHeight).toBe(3 * 21);
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}four{Shift>}{Enter}{/Shift}five{Shift>}{Enter}{/Shift}six');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}seven{Shift>}{Enter}{/Shift}eight');
    await expect(input.clientHeight).toBe(6 * 21);
    await expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    await expect(args.onSend).toHaveBeenCalledTimes(1);
  },
};

export const Visitor: Story = {
  parameters: {
    canvasNote: "The board's composer is the same single row; the footer beside it is the public shell's.",
  },
  play: async ({ args, canvas, userEvent }) => {
    const input = canvas.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    const send = canvas.getByRole('button', { name: 'Send' });
    const box = boxOf(input);
    expectComposerSurface(box);
    // One row, 52 px high, as on the board.
    expectComputed(box, { height: '52px' });

    // no_dead_controls: no attach or speak button without a handler.
    await expect(canvas.getAllByRole('button')).toEqual([send]);
    await expect(canvas.queryByRole('button', { name: 'Add a photo or file' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Speak instead' })).toBeNull();

    // empty_cannot_send: nothing to send while the text is empty or only spaces, by Enter or the button.
    await expect(send).toBeDisabled();
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');
    await expect(input).toHaveValue('');
    await userEvent.keyboard('   ');
    await expect(send).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSend).not.toHaveBeenCalled();

    // The send button sends too, and the text box keeps the focus for the next message.
    await userEvent.keyboard('How much to clear a clogged drain?');
    await expect(send).toBeEnabled();
    await userEvent.click(send);
    await expect(args.onSend).toHaveBeenCalledTimes(1);
    await expect(args.onSend).toHaveBeenCalledWith('How much to clear a clogged drain?');
    await expect(input).toHaveValue('');
    await expect(input).toHaveFocus();
  },
};

export const Whisper: Story = {
  args: {
    variant: 'whisper',
    label: "Whisper to Claude. Dana won't see it.",
    placeholder: "Whisper to Claude. Dana won't see it.",
  },
  parameters: {
    canvas: 'N-Conv-Run1',
    canvasNote: 'The board puts Take over beside the whisper composer; here the composer is on its own, and the take-over bar sits above it.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const input = canvas.getByRole('textbox', { name: "Whisper to Claude. Dana won't see it." });
    const send = canvas.getByRole('button', { name: 'Send whisper' });
    expectComputed(boxOf(input), { height: '52px' });
    await expect(send).toBeDisabled();

    await userEvent.click(input);
    await userEvent.keyboard('Offer the Thursday slot');

    // ime_composition_does_not_send: an Enter that confirms an IME word sends nothing.
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(args.onSend).not.toHaveBeenCalled();
    // Between compositionstart and compositionend, as Safari reports it, Enter sends nothing either.
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229 });
    await expect(args.onSend).not.toHaveBeenCalled();
    await expect(input).toHaveValue('Offer the Thursday slot');

    // Once the word is in, Enter sends.
    await userEvent.keyboard('{Enter}');
    await expect(args.onSend).toHaveBeenCalledTimes(1);
    await expect(args.onSend).toHaveBeenCalledWith('Offer the Thursday slot');
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  parameters: {
    canvasNote: 'The board shows the composer ready; disabled, nothing can be typed or sent.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const input = canvas.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    await expect(input).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    await userEvent.type(input, 'Hello');
    await expect(input).toHaveValue('');
    await expect(args.onSend).not.toHaveBeenCalled();
  },
};

/** The owner's answer the setup interview couldn't take, and the page's line about it, as N-R2-Setup-04-Answer-Failed writes them. */
const KEPT_ANSWER = '$500 is fine. Anything bigger, ask me.';
const FAILED_LINE = 'I couldn’t answer just now. Your answer is still here; try again.';

/** What the screen sends again when "Try again" is chosen. */
const retried = fn();

export const Failed: Story = {
  args: {
    variant: 'owner',
    label: 'Answer in your own words',
    placeholder: 'Answer in your own words',
    maxLength: 2000,
    failed: { text: KEPT_ANSWER, line: FAILED_LINE, onRetry: fn() },
  },
  parameters: { canvas: 'N-R2-Setup-04-Answer-Failed' },
  play: async ({ args, canvas, userEvent }) => {
    // failed_keeps_the_answer: the page's line as an alert, then the answer as it was written in
    // the composer's box, with "Try again" in it and nothing to type into.
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent(FAILED_LINE);
    await expect(alert.querySelector('.cd-status-dot--refused')).not.toBeNull();
    await expect(canvas.queryByRole('textbox')).toBeNull();
    const kept = canvas.getByText(KEPT_ANSWER);
    await expect(kept).toHaveAttribute('data-copy', 'user');
    expectComputed(kept, { fontFamily: /Hanken Grotesk/, fontSize: '14px', lineHeight: '20px', color: 'rgba(250, 249, 245, 0.92)' });
    const tryAgain = canvas.getByRole('button', { name: 'Try again' });
    await expect(canvas.getAllByRole('button')).toEqual([tryAgain]);
    expectComputed(tryAgain, { height: '32px', backgroundColor: 'rgb(239, 236, 228)', color: 'rgb(28, 27, 25)' });

    // The box is the composer's surface as the board draws it: no hairline, padded 12 px 14 px, 56 px
    // high around one line, the answer and the button 12 px apart, both on the box's bottom line.
    const box = boxOf(kept);
    await expect(box).toHaveAccessibleName('Answer in your own words');
    expectComputed(box, {
      backgroundColor: 'rgb(42, 41, 39)',
      borderTopLeftRadius: '16px',
      boxShadow: 'rgba(0, 0, 0, 0.25) 0px 4px 20px 0px',
      paddingTop: '12px',
      paddingRight: '14px',
      paddingBottom: '12px',
      paddingLeft: '14px',
      height: '56px',
    });
    const keptBox = kept.getBoundingClientRect();
    const buttonBox = tryAgain.getBoundingClientRect();
    await expect(buttonBox.left - keptBox.right).toBe(12);
    await expect(keptBox.bottom).toBe(buttonBox.bottom);
    // The line sits 20 px over the box.
    await expect(box.getBoundingClientRect().top - alert.getBoundingClientRect().bottom).toBe(20);

    await userEvent.click(tryAgain);
    await expect(args.failed?.onRetry).toHaveBeenCalledTimes(1);
    await expect(args.onSend).not.toHaveBeenCalled();
  },
};

/**
 * A screen whose answers fail until it tries again: "Fail the send" stands in for the request
 * coming back failed, clicked without moving focus, as a response arrives.
 */
function AnswerThatFails({ onSend, onRetry }: { onSend: (text: string) => void; onRetry: (text: string) => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-20)' }}>
      <Composer
        variant="owner"
        label="Answer in your own words"
        placeholder="Answer in your own words"
        onSend={(text) => {
          onSend(text);
          setSent(text);
        }}
        failed={
          failed && sent !== null
            ? {
                text: sent,
                line: FAILED_LINE,
                onRetry: () => {
                  onRetry(sent);
                  setFailed(false);
                },
              }
            : undefined
        }
      />
      <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
        <Button variant="secondary" onClick={() => setFailed(true)}>
          Fail the send
        </Button>
        <Button variant="secondary">Something else</Button>
      </div>
    </div>
  );
}

export const FailedThenTryAgain: Story = {
  args: { variant: 'owner', label: 'Answer in your own words', placeholder: 'Answer in your own words' },
  render: ({ onSend }) => <AnswerThatFails onSend={onSend} onRetry={retried} />,
  parameters: {
    canvas: 'N-R2-Setup-04-Answer-Failed',
    canvasNote: 'The board draws the failed state alone; here the answer is sent, fails, and is tried again, with two buttons standing in for the screen.',
  },
  play: async ({ args, canvas, userEvent }) => {
    retried.mockClear();
    const failSend = canvas.getByRole('button', { name: 'Fail the send' });

    // failed_send_moves_focus_to_try_again: the text box that had focus goes, so "Try again" takes it.
    await userEvent.click(canvas.getByRole('textbox', { name: 'Answer in your own words' }));
    await userEvent.keyboard(`${KEPT_ANSWER}{Enter}`);
    await expect(args.onSend).toHaveBeenCalledWith(KEPT_ANSWER);
    fireEvent.click(failSend);
    const tryAgain = await canvas.findByRole('button', { name: 'Try again' });
    await expect(canvas.getByText(KEPT_ANSWER)).toBeVisible();
    await expect(tryAgain).toHaveFocus();

    // try_again_returns_focus_to_the_text_box: the kept words go back to the screen, and the text
    // box comes back empty, with the focus.
    await userEvent.keyboard('{Enter}');
    await expect(retried).toHaveBeenCalledTimes(1);
    await expect(retried).toHaveBeenCalledWith(KEPT_ANSWER);
    const input = canvas.getByRole('textbox', { name: 'Answer in your own words' });
    await expect(input).toHaveValue('');
    await expect(input).toHaveFocus();

    // failed_send_leaves_focus_elsewhere_alone: focus the owner moved away stays where it is.
    await userEvent.keyboard('Anything over $500, ask me.{Enter}');
    const elsewhere = canvas.getByRole('button', { name: 'Something else' });
    await userEvent.click(elsewhere);
    fireEvent.click(failSend);
    await canvas.findByRole('button', { name: 'Try again' });
    await expect(elsewhere).toHaveFocus();
  },
};

const NEAR_LIMIT_MAX = 40;

export const NearLimit: Story = {
  args: { maxLength: NEAR_LIMIT_MAX },
  parameters: {
    canvasNote: 'No board shows a long message; the counter shows from 90% of the limit, in the line under the composer.',
  },
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    const counter = () => canvas.queryByText(new RegExp(`^\\d+ / ${NEAR_LIMIT_MAX}$`));

    const start = 'Can someone come out this week';
    await expect(start.length).toBeLessThan(NEAR_LIMIT_MAX * 0.9);
    await userEvent.click(input);
    await userEvent.keyboard(start);
    await expect(counter()).toBeNull();

    // From 90% of the limit the counter shows, and the text box names it in its description.
    const near = `${start} to look`;
    await expect(near.length).toBeGreaterThanOrEqual(NEAR_LIMIT_MAX * 0.9);
    await userEvent.keyboard(' to look');
    await expect(counter()).toHaveTextContent(`${near.length} / ${NEAR_LIMIT_MAX}`);
    await expect(input).toHaveAccessibleDescription(`${near.length} / ${NEAR_LIMIT_MAX}`);
    expectComputed(counter() as HTMLElement, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });

    // The limit caps the text: what is typed past it is dropped.
    const full = `${near} at the sink`;
    await userEvent.keyboard(' at the sink');
    await expect(input).toHaveValue(full.slice(0, NEAR_LIMIT_MAX));
    await expect(counter()).toHaveTextContent(`${NEAR_LIMIT_MAX} / ${NEAR_LIMIT_MAX}`);
  },
};
