import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { MoneyLimit, type MoneyLimitProps } from '../MoneyLimit/MoneyLimit.tsx';
import { PRESET_CAPTIONS, type RulesPreset } from '../OutcomeMenu/outcomeWords.ts';
import { HowClaudeWorks, type HowClaudeWorksProps } from './HowClaudeWorks.tsx';

const { capLine, capHelp, capHint } = rivera.rulesMode;

/** Rivera's money limit as the Rules page passes it, reading or with the field open. */
function limit(props: Partial<MoneyLimitProps> = {}) {
  return (
    <MoneyLimit
      line={capLine}
      help={capHelp}
      editing={false}
      value=""
      hint={capHint}
      onEdit={fn()}
      onChange={fn()}
      onReview={fn()}
      onCancel={fn()}
      {...props}
    />
  );
}

const meta = {
  title: 'Rules/HowClaudeWorks',
  component: HowClaudeWorks,
  args: { preset: rivera.rulesMode.preset, onPreset: fn(), children: limit() },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <HowClaudeWorks {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-17-Mode' },
} satisfies Meta<typeof HowClaudeWorks>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The switch, its options and the card's caption. */
function parts(canvasElement: HTMLElement) {
  const card = within(canvasElement).getByRole('region', { name: 'How Claude works' });
  const group = within(card).getByRole('radiogroup', { name: 'How Claude works' });
  const option = (name: string) => within(group).getByRole('radio', { name });
  return { card, group, option };
}

/** current_preset_is_checked: the passed preset is the one checked, and the caption is its own. */
async function expectPreset(canvasElement: HTMLElement, preset: RulesPreset, label: string) {
  const { card, group } = parts(canvasElement);
  const checked = within(group)
    .getAllByRole('radio')
    .filter((radio) => radio.getAttribute('aria-checked') === 'true');
  await expect(checked.map((radio) => radio.textContent)).toEqual([label]);
  await expect(within(card).getByText(PRESET_CAPTIONS[preset])).toBeVisible();
}

export const Custom: Story = {
  play: async ({ args, canvasElement }) => {
    const { card, group, option } = parts(canvasElement);
    await expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Ask me first', 'Automatic', 'Custom']);
    await expectPreset(canvasElement, 'custom', 'Custom');
    // The card pads 16 px; the title is the section's h2, the caption in secondary meta under it.
    expectComputed(card, { paddingTop: '0px', borderTopLeftRadius: '12px', backgroundColor: 'rgba(250, 249, 245, 0.03)' });
    const title = within(card).getByRole('heading', { level: 2, name: 'How Claude works' });
    expectComputed(title, { fontSize: '15px', lineHeight: '20px', fontWeight: '520' });
    const caption = within(card).getByText(PRESET_CAPTIONS.custom);
    expectComputed(caption, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    const box = card.getBoundingClientRect();
    await expect(title.getBoundingClientRect().left - box.left).toBe(17);
    await expect(title.getBoundingClientRect().top - box.top).toBe(17);
    // The switch at the right, level with the title.
    await expect(box.right - group.getBoundingClientRect().right).toBe(17);
    await expect(group.getBoundingClientRect().top).toBe(title.getBoundingClientRect().top);
    // The money limit follows a hairline 14 px under the caption, 14 px under it.
    const limitBlock = card.querySelector<HTMLElement>('.cd-how-claude-works__limit');
    if (limitBlock === null) throw new Error('No money limit');
    expectComputed(limitBlock, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)', paddingTop: '14px' });
    await expect(limitBlock.getBoundingClientRect().top - caption.getBoundingClientRect().bottom).toBe(14);
    await expect(within(limitBlock).getByText(capLine)).toBeVisible();
    // preset_pick_calls_once: "Automatic" asks the screen once to draft it, even pressed twice, and
    // the switch keeps showing Custom until the screen passes a new preset.
    await option('Automatic').click();
    await option('Automatic').click();
    await expect(args.onPreset).toHaveBeenCalledTimes(1);
    await expect(args.onPreset).toHaveBeenCalledWith('auto');
    await expectPreset(canvasElement, 'custom', 'Custom');
  },
};

export const AskMeFirst: Story = {
  args: { preset: 'ask_first' },
  parameters: { canvasNote: 'The switch at Ask me first, with its caption; the board draws it at Custom.' },
  play: async ({ args, canvasElement, userEvent }) => {
    const { option } = parts(canvasElement);
    await expectPreset(canvasElement, 'ask_first', 'Ask me first');
    // custom_drafts_nothing: Custom is what the rules become when one changes, so choosing it
    // drafts nothing, by pointer or by keyboard, and the switch stays at Ask me first.
    await userEvent.click(option('Custom'));
    await expect(args.onPreset).not.toHaveBeenCalled();
    await expectPreset(canvasElement, 'ask_first', 'Ask me first');
    await userEvent.click(option('Ask me first'));
    await userEvent.keyboard('{End}');
    await expect(args.onPreset).not.toHaveBeenCalled();
    await expectPreset(canvasElement, 'ask_first', 'Ask me first');
  },
};

export const Automatic: Story = {
  args: { preset: 'auto' },
  parameters: { canvasNote: 'The switch at Automatic, with its caption; the board draws it at Custom.' },
  play: async ({ args, canvasElement, userEvent }) => {
    const { option } = parts(canvasElement);
    await expectPreset(canvasElement, 'auto', 'Automatic');
    // The current preset is already in place: choosing it again drafts nothing; the other one drafts once.
    await userEvent.click(option('Automatic'));
    await expect(args.onPreset).not.toHaveBeenCalled();
    await userEvent.click(option('Ask me first'));
    await expect(args.onPreset).toHaveBeenCalledTimes(1);
    await expect(args.onPreset).toHaveBeenCalledWith('ask_first');
  },
};

export const Drafting: Story = {
  args: { disabled: true, children: limit({ disabled: true }) },
  parameters: { canvasNote: 'A preset draft in flight; the board draws the switch at rest.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // drafting_disables_the_switch: every option says it is disabled, and nothing drafts, by pointer or keyboard.
    const { group, option } = parts(canvasElement);
    await expect(group).toHaveAttribute('aria-disabled', 'true');
    for (const radio of within(group).getAllByRole('radio')) await expect(radio).toHaveAttribute('aria-disabled', 'true');
    expectComputed(group, { opacity: '0.4' });
    await userEvent.click(option('Automatic'));
    await expect(args.onPreset).not.toHaveBeenCalled();
    // The arrow keys neither move nor choose.
    await userEvent.click(option('Custom'));
    await userEvent.keyboard('{ArrowLeft}');
    await expect(option('Custom')).toHaveFocus();
    await expect(args.onPreset).not.toHaveBeenCalled();
    await expectPreset(canvasElement, 'custom', 'Custom');
    // The money limit's button waits too.
    await expect(canvas.getByRole('button', { name: 'Change' })).toHaveAttribute('aria-disabled', 'true');
  },
};

/** A Rules page whose preset draft fails: it disables the switch while drafting, then gives it back. */
function DraftFails(props: HowClaudeWorksProps) {
  const [drafting, setDrafting] = useState(false);
  return (
    <HowClaudeWorks
      {...props}
      disabled={drafting}
      onPreset={(next) => {
        props.onPreset(next);
        setDrafting(true);
        setTimeout(() => setDrafting(false), 0);
      }}
    />
  );
}

export const DraftFailed: Story = {
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <DraftFails {...args} />
    </div>
  ),
  parameters: { canvasNote: 'A preset draft that failed, so the switch takes a pick again; no board draws it.' },
  play: async ({ args, canvasElement, userEvent }) => {
    // Once the draft has come and gone, the switch takes the next pick.
    const { group, option } = parts(canvasElement);
    await userEvent.click(option('Automatic'));
    await expect(args.onPreset).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(group).not.toHaveAttribute('aria-disabled'));
    await userEvent.click(option('Ask me first'));
    await expect(args.onPreset).toHaveBeenCalledTimes(2);
    await expect(args.onPreset).toHaveBeenLastCalledWith('ask_first');
    await expectPreset(canvasElement, 'custom', 'Custom');
  },
};

export const EditingLimit: Story = {
  args: { children: limit({ editing: true, value: '1000' }) },
  parameters: { canvas: 'N-Conn-19-Money-Cap' },
  play: async ({ canvas, canvasElement }) => {
    // The field opens in the card, under the hairline, with the switch still above it.
    const { card } = parts(canvasElement);
    const limitBlock = card.querySelector<HTMLElement>('.cd-how-claude-works__limit');
    if (limitBlock === null) throw new Error('No money limit');
    const field = within(limitBlock).getByRole('textbox', { name: 'Most I take without asking, in dollars' });
    await expect(field).toHaveValue('1000');
    await expect(field.getBoundingClientRect().width).toBe(360);
    await expect(within(limitBlock).getByText(capHint)).toBeVisible();
    const review = canvas.getByRole('button', { name: 'Review change' });
    const cancel = canvas.getByRole('button', { name: 'Cancel' });
    await expect(review.getBoundingClientRect().top - field.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(12);
    await expect(cancel.getBoundingClientRect().left - review.getBoundingClientRect().right).toBe(8);
    await expect(card.getBoundingClientRect().bottom - review.getBoundingClientRect().bottom).toBe(17);
    await expectPreset(canvasElement, 'custom', 'Custom');
  },
};

const TOO_HIGH = 'No single payment can be above $10,000.';

export const LimitTooHigh: Story = {
  args: { children: limit({ editing: true, value: '20000', error: TOO_HIGH }) },
  parameters: { canvas: 'N-Conn-19-Money-Cap', canvasNote: "The screen's check of an amount above the per-payment limit; the board draws the field without an error." },
  play: async ({ canvas }) => {
    // limit_error_is_announced: the screen's error marks the field invalid, describes it, and sits
    // in a live region, so it is read out when it appears.
    const field = canvas.getByRole('textbox', { name: 'Most I take without asking, in dollars' });
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription(`${TOO_HIGH} ${capHint}`);
    const error = canvas.getByText(TOO_HIGH);
    await expect(error).toBeVisible();
    await expect(error.closest('[aria-live="polite"]')).not.toBeNull();
    // The field keeps what was typed.
    await expect(field).toHaveValue('20000');
  },
};

const UNSET = 'Nothing: every charge and payout asks you';

export const UnsetLimit: Story = {
  args: { children: limit({ line: UNSET }) },
  parameters: { canvasNote: 'A Desk with no money limit set, so every charge and payout asks; the board draws Rivera at $500.' },
  play: async ({ canvasElement }) => {
    // unset_limit_never_says_zero: no limit reads as what it means, never as an amount of nothing.
    const { card } = parts(canvasElement);
    await expect(within(card).getByText(UNSET)).toBeVisible();
    await expect(card).not.toHaveTextContent('$0');
    await expect(card.textContent ?? '').not.toMatch(/\b0\b/);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-Conn-22-Phone-Mode' },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(390);
    const { card, group } = parts(canvasElement);
    const caption = within(card).getByText(PRESET_CAPTIONS.custom);
    // switch_wraps_on_phone: the switch sits 12 px under the caption, at its own width, at the left.
    await expect(group.getBoundingClientRect().top - caption.getBoundingClientRect().bottom).toBe(12);
    await expect(group.getBoundingClientRect().left).toBe(caption.getBoundingClientRect().left);
    await expect(group.getBoundingClientRect().width).toBeLessThan(caption.getBoundingClientRect().width);
    // The card pads 14 px on a phone, and "Change" sits under the money limit's help.
    const box = card.getBoundingClientRect();
    await expect(caption.getBoundingClientRect().left - box.left).toBe(15);
    const help = within(card).getByText(capHelp);
    const change = canvas.getByRole('button', { name: 'Change' });
    await expect(change.getBoundingClientRect().top - help.getBoundingClientRect().bottom).toBe(10);
    await expect(change.getBoundingClientRect().left).toBe(help.getBoundingClientRect().left);
    // Nothing scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > window.innerWidth);
    await expect(tooWide).toEqual([]);
  },
};
