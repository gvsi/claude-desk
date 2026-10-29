import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import type { ApprovalAnswer, Decision } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard.tsx';

const ANSWER_NAMES = ['Allow this time', 'Deny this time', 'Allow only for this person', 'Deny always'];
const ERROR_LINE = "We couldn't confirm your answer. Try again, or reload to see where it stands.";
const RULE_LINE_DENY = "Deny always also saves a rule, so Claude declines requests like this on its own. You'll see the rule before it applies.";
const RULE_LINE_BOTH =
  "Allow only for this person and Deny always also save a rule, so Claude handles requests like this on its own. You'll see the rule before it applies.";

/** Each answer's look on the signed-off boards: neutral, soft red, quiet neutral, red words. */
const SECONDARY = { backgroundColor: 'rgba(250, 249, 245, 0.1)', color: 'rgba(250, 249, 245, 0.92)', height: '40px' };
const DANGER = { backgroundColor: 'rgba(220, 130, 144, 0.16)', color: 'rgb(235, 163, 174)', height: '40px' };
const GHOST = { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(250, 249, 245, 0.92)', height: '40px' };
const DANGER_GHOST = { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(235, 163, 174)', height: '40px' };
const ANSWERS_BOARDS =
  'The answers follow the signed-off answer boards (N-Answers-Final, N-Answers-Verified), which replace the four secondary answers on this board.';

const held = rivera.decisions.held;
const heldVerified = rivera.heldVerified;

/** The visitor's own words, quoted as Plan 04's Today does, and marked as someone else's text. */
const fromTheVisitor = (
  <>
    From the visitor: “<span data-copy="user">How much to clear a clogged drain? Can I get 15% off if I pay cash?</span>”
  </>
);

/** The card's answer buttons, in the order shown. */
function answerButtons(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="group"][aria-label="Your answer"] button')];
}

/** The top edge of each element, to the pixel: equal tops share a row. */
function tops(elements: readonly HTMLElement[]): number[] {
  return elements.map((el) => Math.round(el.getBoundingClientRect().top));
}

/** A 390 px phone's line: the screen less two 16 px gutters. */
const PHONE_LINE = 358;

/** The card's thin divider between the one-time answers and the rule answers, if it shows. */
function dividerIn(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.cd-approval-card__divider');
}

/** The card's one status dot. */
function dotIn(root: HTMLElement): HTMLElement {
  const dots = root.querySelectorAll<HTMLElement>('.cd-status-dot');
  if (dots.length !== 1) throw new Error(`expected one status dot, found ${dots.length}`);
  return dots[0] as HTMLElement;
}

/** A final state: its line and dot, and no answer by any name, though the fixture still carries them. */
async function expectFinal(root: HTMLElement, decision: Decision, line: string, tone: string): Promise<void> {
  await expect(decision.answers?.length ?? 0).toBeGreaterThan(0);
  const card = root.querySelector('article');
  if (!card) throw new Error('no card');
  await expect(card).toHaveAccessibleName(`Held for you: ${decision.reason_plain}`);
  await expect(root).toHaveTextContent(line);
  await expect(root).not.toHaveTextContent('Waiting for your answer');
  await expect(dotIn(root)).toHaveClass(`cd-status-dot--${tone}`);
  await expect(root.querySelector('[role="group"]')).toBeNull();
  await expect(root.querySelectorAll('button')).toHaveLength(0);
  for (const name of ANSWER_NAMES) await expect(root).not.toHaveTextContent(name);
  for (const words of ['saves a rule', 'save a rule', "You'll see the rule"]) await expect(root).not.toHaveTextContent(words);
  await expect(root.querySelector('.cd-approval-card__divider')).toBeNull();
}

/** The card as Today holds it once an answer is sent and no result has come back yet. */
function SendingScreen(props: ApprovalCardProps) {
  const [pending, setPending] = useState(false);
  return (
    <ApprovalCard
      {...props}
      pending={pending}
      onAnswer={(answer: ApprovalAnswer) => {
        props.onAnswer(answer);
        setPending(true);
      }}
    />
  );
}

/**
 * The card as Today holds it while an answer is sent: each answer is pending a moment, the first
 * fails with no word on whether it went through, and the next one lands in its final state.
 */
function RetryingScreen(props: ApprovalCardProps) {
  const [decision, setDecision] = useState(props.decision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(props.error);
  const [tries, setTries] = useState(0);
  return (
    <ApprovalCard
      {...props}
      decision={decision}
      pending={pending}
      error={error}
      onAnswer={(answer: ApprovalAnswer) => {
        props.onAnswer(answer);
        setPending(true);
        setError(undefined);
        setTries(tries + 1);
        setTimeout(() => {
          setPending(false);
          if (tries === 0) setError(true);
          else setDecision(answer.startsWith('allow') ? rivera.decisions.executed : rivera.decisions.denied);
        }, 150);
      }}
    />
  );
}

/**
 * A screen that never sets `pending` and leaves `error` on between tries: every answer is sent as
 * a promise that fails a moment later, and the screen says so with the same `error={true}`.
 */
function AlwaysFailingScreen(props: ApprovalCardProps) {
  const [error, setError] = useState<boolean | undefined>(undefined);
  return (
    <ApprovalCard
      {...props}
      error={error}
      onAnswer={(answer: ApprovalAnswer) => {
        props.onAnswer(answer);
        const sent = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('the answer was lost')), 100);
        });
        sent.catch(() => setError(true));
        return sent;
      }}
    />
  );
}

const meta = {
  title: 'Owner decisions/ApprovalCard',
  component: ApprovalCard,
  args: {
    decision: held,
    heldBy: rivera.ruleCards['rv-quote'].reason,
    context: fromTheVisitor,
    waiting: 'Web chat, 2 min ago',
    onAnswer: fn(),
  },
  // As wide as the board's held card.
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 'var(--size-reading)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'padded',
    canvas: 'N-Today-NeedsYou',
    canvasNote:
      "The board's 50% cash discount is the Rivera fixture's held quote; its held-by line names the rule card's reason, and the counter-offer row is static vision.",
  },
} satisfies Meta<typeof ApprovalCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ThreeAnswersOnOneRow: Story = {
  parameters: {
    canvasNote: `${ANSWERS_BOARDS} The unverified visitor gets three: Allow only for this person needs a verified person. The counter-offer row is static vision.`,
  },
  play: async ({ canvas, canvasElement }) => {
    const card = canvas.getByRole('article', { name: `Held for you: ${held.reason_plain}` });
    await expect(card).toHaveTextContent('Waiting for your answer');
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--held');
    await expect(canvas.getByText('Web chat, 2 min ago')).toBeVisible();
    // Claude's summary of the request is in serif; the rule that held it follows.
    expectComputed(canvas.getByText(held.reason_plain), { fontFamily: /Source Serif 4/, fontSize: '18px', lineHeight: '27px' });
    await expect(card).toHaveTextContent(`Held by your rule: ${rivera.ruleCards['rv-quote'].reason}`);
    await expect(card).toHaveTextContent('From the visitor: “How much to clear a clogged drain? Can I get 15% off if I pay cash?”');

    // only_offered_answers: the kernel offered three, so three show, in order.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    const buttons = answerButtons(canvasElement);
    await expect(buttons.map((button) => button.textContent)).toEqual(['Allow this time', 'Deny this time', 'Deny always']);
    await expect(canvas.queryByRole('button', { name: 'Allow only for this person' })).toBeNull();

    // Allow stays neutral, Deny this time takes the soft red fill, and Deny always is red words
    // after a thin divider, all on one row.
    const [allow, deny, denyAlways] = buttons as [HTMLElement, HTMLElement, HTMLElement];
    expectComputed(allow, SECONDARY);
    expectComputed(deny, DANGER);
    expectComputed(denyAlways, DANGER_GHOST);
    await expect(new Set(tops(buttons)).size).toBe(1);
    const divider = dividerIn(canvasElement);
    if (!divider) throw new Error('no divider between the answers');
    await expect(divider).toHaveAttribute('aria-hidden', 'true');
    expectComputed(divider, { width: '1px', height: '20px', backgroundColor: 'rgba(250, 249, 245, 0.12)' });
    await expect(deny.getBoundingClientRect().right).toBeLessThan(divider.getBoundingClientRect().left);
    await expect(divider.getBoundingClientRect().right).toBeLessThan(denyAlways.getBoundingClientRect().left);
    await expect(group).not.toHaveTextContent('Or save a rule');
    await expect(card).toHaveTextContent(RULE_LINE_DENY);
    await expect(card).not.toHaveTextContent('Allow only for this person');
    await expect(group).not.toHaveAttribute('aria-busy');
  },
};

export const FourAnswersOnTwoRows: Story = {
  args: { decision: heldVerified, heldBy: rivera.ruleCards['rv-book-sat'].reason, context: undefined, waiting: 'Web chat, just now' },
  parameters: {
    canvasNote: `${ANSWERS_BOARDS} Layout B of N-Answers-Verified: Dana's Saturday afternoon booking, from a verified customer, so all four answers show. The counter-offer row is static vision.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // only_offered_answers: all four, in their fixed order.
    const buttons = answerButtons(canvasElement);
    await expect(buttons.map((button) => button.textContent)).toEqual(ANSWER_NAMES);
    const [allow, deny, allowPerson, denyAlways] = buttons as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expectComputed(allow, SECONDARY);
    expectComputed(deny, DANGER);
    expectComputed(allowPerson, GHOST);
    expectComputed(denyAlways, DANGER_GHOST);

    // The one-time answers on the first row; the answers that save a rule on a second row, after
    // its label, which names them as a group. No divider.
    const [firstRow, secondRow] = [tops([allow, deny]), tops([allowPerson, denyAlways])];
    await expect(firstRow[0]).toBe(firstRow[1]);
    await expect(secondRow[0]).toBe(secondRow[1]);
    await expect(secondRow[0]).toBeGreaterThan(firstRow[0] ?? 0);
    const ruleRow = canvas.getByRole('group', { name: 'Or save a rule:' });
    await expect(ruleRow).toContainElement(allowPerson);
    await expect(ruleRow).toContainElement(denyAlways);
    const label = canvas.getByText('Or save a rule:');
    await expect(label).toBeVisible();
    expectComputed(label, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(label.getBoundingClientRect().right).toBeLessThan(allowPerson.getBoundingClientRect().left);
    await expect(dividerIn(canvasElement)).toBeNull();
    const group = canvas.getByRole('group', { name: 'Your answer' });
    await expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth);

    // The line under them names both answers that save a rule.
    await expect(canvas.getByRole('article')).toHaveTextContent(RULE_LINE_BOTH);
  },
};

export const PersonRuleOnOneRow: Story = {
  args: {
    decision: { ...heldVerified, answers: ['allow_once', 'deny_once', 'allow_person'] },
    heldBy: rivera.ruleCards['rv-book-sat'].reason,
    context: undefined,
    waiting: 'Web chat, just now',
  },
  parameters: {
    canvasNote: `${ANSWERS_BOARDS} No board offers Allow only for this person without Deny always; alone, it follows the one-time answers after the divider, as Deny always does on N-Answers-Final.`,
  },
  play: async ({ canvas, canvasElement }) => {
    const buttons = answerButtons(canvasElement);
    await expect(buttons.map((button) => button.textContent)).toEqual(['Allow this time', 'Deny this time', 'Allow only for this person']);
    const [deny, allowPerson] = buttons.slice(1) as [HTMLElement, HTMLElement];
    expectComputed(allowPerson, GHOST);
    await expect(new Set(tops(buttons)).size).toBe(1);
    const divider = dividerIn(canvasElement);
    if (!divider) throw new Error('no divider between the answers');
    await expect(deny.getBoundingClientRect().right).toBeLessThan(divider.getBoundingClientRect().left);
    await expect(canvas.queryByText('Or save a rule:')).toBeNull();
    await expect(canvas.getByRole('article')).toHaveTextContent(
      "Allow only for this person also saves a rule, so Claude allows requests like this from this person on its own. You'll see the rule before it applies.",
    );
  },
};

export const OneColumnOnAPhone: Story = {
  render: (args) => (
    <div data-testid="phone-line" style={{ width: PHONE_LINE, maxWidth: '100%', display: 'grid', rowGap: 'var(--space-16)' }}>
      <ApprovalCard {...args} />
      <ApprovalCard {...args} decision={heldVerified} heldBy={rivera.ruleCards['rv-book-sat'].reason} context={undefined} waiting="Web chat, just now" />
    </div>
  ),
  parameters: {
    canvasNote: `${ANSWERS_BOARDS} The phone columns of both boards: under about 480 px of card, the answers become one column of full-width buttons in the same order, with no divider and no label.`,
  },
  play: async ({ canvas }) => {
    const line = canvas.getByTestId('phone-line');
    await expect(line.getBoundingClientRect().width).toBe(PHONE_LINE);
    await expect(line.scrollWidth).toBeLessThanOrEqual(PHONE_LINE);

    const cards = canvas.getAllByRole('article');
    await expect(cards).toHaveLength(2);
    const expected = [
      { names: ['Allow this time', 'Deny this time', 'Deny always'], looks: [SECONDARY, DANGER, DANGER_GHOST], line: RULE_LINE_DENY },
      { names: ANSWER_NAMES, looks: [SECONDARY, DANGER, GHOST, DANGER_GHOST], line: RULE_LINE_BOTH },
    ];
    for (const [i, card] of cards.entries()) {
      const want = expected[i];
      if (!want) throw new Error(`no expectation for card ${i}`);
      const group = within(card).getByRole('group', { name: 'Your answer' });
      const buttons = answerButtons(card);
      await expect(buttons.map((button) => button.textContent)).toEqual(want.names);
      for (const [j, button] of buttons.entries()) expectComputed(button, want.looks[j] ?? {});

      // One column, in order, each answer as wide as the answers.
      const box = group.getBoundingClientRect();
      for (const button of buttons) {
        const edge = button.getBoundingClientRect();
        await expect(edge.left).toBe(box.left);
        await expect(edge.width).toBe(box.width);
      }
      const rowTops = tops(buttons);
      for (let j = 1; j < rowTops.length; j += 1) await expect(rowTops[j]).toBe((rowTops[j - 1] ?? 0) + 48);

      // No divider and no label on a phone; the line under the answers stays.
      const divider = dividerIn(card);
      if (divider) await expect(divider).not.toBeVisible();
      const label = within(card).queryByText('Or save a rule:');
      if (label) await expect(label).not.toBeVisible();
      await expect(card).toHaveTextContent(want.line);
    }
    // The three-answer card had a divider to hide, and the four-answer card a label.
    await expect(dividerIn(cards[0] as HTMLElement)).not.toBeNull();
    await expect(within(cards[1] as HTMLElement).queryByText('Or save a rule:')).not.toBeNull();
  },
};

export const SendingYourAnswer: Story = {
  args: { decision: heldVerified, heldBy: rivera.ruleCards['rv-book-sat'].reason, context: undefined, waiting: 'Web chat, just now' },
  render: (args) => <SendingScreen {...args} />,
  parameters: {
    canvasNote: `${ANSWERS_BOARDS} No board shows an answer being sent; every answer waits, faded a little, and a line under them says so.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const [allow, deny, allowPerson, denyAlways] = answerButtons(canvasElement) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];

    // keyboard_answers: Tab into the group, on to Deny always (the label is not a stop), and
    // Enter answers.
    await userEvent.tab();
    await expect(allow).toHaveFocus();
    await userEvent.tab();
    await expect(deny).toHaveFocus();
    await userEvent.tab();
    await expect(allowPerson).toHaveFocus();
    await userEvent.tab();
    await expect(denyAlways).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await expect(args.onAnswer).toHaveBeenCalledWith('deny_always');
    // Focus stays on the answer while it is sent.
    await expect(denyAlways).toHaveFocus();

    // answers_once: while it is sent, a second Enter or a click on any answer sends nothing.
    await userEvent.keyboard('{Enter}');
    await userEvent.click(allow);
    await userEvent.click(deny);
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);

    // Every answer waits, and a line under them says so.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    await expect(group).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getByText('Sending your answer').closest('[role="status"]')).not.toBeNull();
    for (const button of answerButtons(canvasElement)) await expect(button).toHaveAttribute('aria-disabled', 'true');

    // Each answer keeps its look, faded: the neutral ones to 60%, the red ones only to 80%, so
    // their words still read at 4.5:1 in the card.
    expectComputed(allow, { ...SECONDARY, opacity: '0.6' });
    expectComputed(deny, { ...DANGER, opacity: '0.8' });
    expectComputed(allowPerson, { ...GHOST, opacity: '0.6' });
    expectComputed(denyAlways, { ...DANGER_GHOST, opacity: '0.8' });
  },
};

export const CouldNotConfirmYourAnswer: Story = {
  args: { error: true },
  parameters: {
    canvasNote: `${ANSWERS_BOARDS} No board shows a lost answer; the line sits under the answers, which stay as they were and can be tried again, because the kernel resolves a request once.`,
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent(ERROR_LINE);
    const buttons = answerButtons(canvasElement);
    for (const button of buttons) {
      await expect(button).toBeEnabled();
      await expect(button).not.toHaveAttribute('aria-disabled');
    }
    const [allow, deny, denyAlways] = buttons as [HTMLElement, HTMLElement, HTMLElement];
    expectComputed(allow, { ...SECONDARY, opacity: '1' });
    expectComputed(deny, { ...DANGER, opacity: '1' });
    expectComputed(denyAlways, { ...DANGER_GHOST, opacity: '1' });
    await expect(canvas.getByRole('article')).toHaveTextContent(RULE_LINE_DENY);
  },
};

export const DeniedOnTheSecondTry: Story = {
  args: { error: true },
  render: (args) => <RetryingScreen {...args} />,
  parameters: {
    canvasNote: `${ANSWERS_BOARDS} No board shows a lost answer; after it, the owner answers again and the card ends on its final line.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // error_allows_retry: the line is an alert, and every answer can be tried again.
    await expect(canvas.getByRole('alert')).toHaveTextContent(ERROR_LINE);
    for (const button of answerButtons(canvasElement)) {
      await expect(button).toBeEnabled();
      await expect(button).not.toHaveAttribute('aria-disabled');
    }

    // A retry waits like any answer, and a second failure re-enables the answers again.
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this time' }));
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await expect(canvas.getByText('Sending your answer')).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
    for (const button of answerButtons(canvasElement)) await expect(button).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent(ERROR_LINE));
    for (const button of answerButtons(canvasElement)) await expect(button).not.toHaveAttribute('aria-disabled');

    // The next answer lands: the answers go, and focus moves to the card's new status line.
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Deny this time' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenCalledTimes(2);
    await expect(args.onAnswer).toHaveBeenLastCalledWith('deny_once');
    await waitFor(() => expect(canvas.getByText('You denied this.')).toHaveFocus());
    await expect(canvas.queryByRole('group', { name: 'Your answer' })).toBeNull();
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};

export const FailsTwice: Story = {
  render: (args) => <AlwaysFailingScreen {...args} />,
  parameters: {
    canvasNote:
      'No board shows a lost answer; here the screen keeps the same error on and never sets pending, and the answers come back after each failure.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const enabled = async () => {
      for (const button of answerButtons(canvasElement)) await expect(button).not.toHaveAttribute('aria-disabled');
    };
    const waiting = async () => {
      for (const button of answerButtons(canvasElement)) await expect(button).toHaveAttribute('aria-disabled', 'true');
    };

    // The first answer fails: the card's line, and every answer can be tried again.
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this time' }));
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await waiting();
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent(ERROR_LINE));
    await waitFor(enabled);

    // answer_lock_releases_on_repeated_failure: the second fails with the same error, and the
    // answers still come back, because the rejected promise releases them.
    await userEvent.click(canvas.getByRole('button', { name: 'Deny this time' }));
    await expect(args.onAnswer).toHaveBeenCalledTimes(2);
    await waiting();
    await waitFor(enabled);
    await expect(canvas.getByRole('alert')).toHaveTextContent(ERROR_LINE);
    await expect(canvas.queryByText('Sending your answer')).toBeNull();

    // A third try goes out.
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this time' }));
    await expect(args.onAnswer).toHaveBeenCalledTimes(3);
    await expect(args.onAnswer).toHaveBeenLastCalledWith('allow_once');
  },
};

export const Executed: Story = {
  args: { decision: rivera.decisions.executed, waiting: 'Web chat, 4 min ago' },
  parameters: { canvasNote: "No board shows an answered request; the final line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    await expectFinal(canvasElement, rivera.decisions.executed, "You allowed this. It's done.", 'handled');
  },
};

export const Failed: Story = {
  args: { decision: rivera.decisions.failed, waiting: 'Web chat, 4 min ago' },
  parameters: { canvasNote: "No board shows an answered request; the final line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    await expectFinal(canvasElement, rivera.decisions.failed, "You allowed this, but it didn't go through. Nothing was done.", 'refused');
  },
};

export const Unknown: Story = {
  args: { decision: rivera.decisions.unknown, waiting: 'Web chat, 4 min ago' },
  parameters: { canvasNote: "No board shows an answered request; the final line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    await expectFinal(canvasElement, rivera.decisions.unknown, 'You allowed this. Still confirming whether it went through.', 'held');
  },
};

export const RulesChanged: Story = {
  args: { decision: rivera.decisions.refused_at_execution, waiting: 'Web chat, 4 min ago' },
  parameters: { canvasNote: "No board shows an answered request; the final line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    // rules_changed_has_no_answers
    await expectFinal(canvasElement, rivera.decisions.refused_at_execution, "Your rules changed before this ran, so it wasn't done.", 'refused');
  },
};

export const Denied: Story = {
  args: { decision: rivera.decisions.denied, waiting: 'Web chat, 4 min ago' },
  parameters: { canvasNote: "No board shows an answered request; the final line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    await expectFinal(canvasElement, rivera.decisions.denied, 'You denied this.', 'refused');
  },
};

export const Expired: Story = {
  args: { decision: rivera.decisions.expired, waiting: 'Web chat, 1 hr ago' },
  parameters: { canvasNote: "No board shows an expired request; the final line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    // expired_has_no_answers
    await expectFinal(canvasElement, rivera.decisions.expired, 'This request expired before you answered. Nothing was done.', 'info');
  },
};

export const Cancelled: Story = {
  args: { decision: rivera.decisions.cancelled, waiting: 'Web chat, 6 min ago' },
  parameters: { canvasNote: "No board shows a cancelled request; the final line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    // cancelled_has_no_answers
    await expectFinal(canvasElement, rivera.decisions.cancelled, 'The visitor cancelled before you answered. Nothing was done.', 'info');
  },
};
