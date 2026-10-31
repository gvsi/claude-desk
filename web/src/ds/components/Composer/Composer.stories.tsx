import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
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

/** On a vision page, which makes no requests: typing works, and Send sends nothing and keeps the text. */
export const InertSend: Story = {
  args: { inertSend: true },
  parameters: {
    canvas: 'N-R2-Vision-Phone',
    canvasNote: 'The visitor’s composer on the phone and Claude account vision pages: the words stay where they were typed.',
  },
  play: async ({ args, canvas, userEvent }) => {
    // inert_send_keeps_the_text: Send keeps its look, empty and not, but neither it nor Enter sends.
    const input = canvas.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    const send = canvas.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    await userEvent.click(input);
    await userEvent.keyboard('Thanks');
    await expect(send).toBeEnabled();
    await userEvent.keyboard('{Enter}');
    await expect(input).toHaveValue('Thanks');
    await userEvent.click(send);
    await expect(input).toHaveValue('Thanks');
    await expect(send).toBeEnabled();
    await expect(send).toHaveFocus();
    await expect(args.onSend).not.toHaveBeenCalled();
    // Clearing the words disables Send again, as on a real page.
    await userEvent.clear(input);
    await expect(send).toBeDisabled();
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
