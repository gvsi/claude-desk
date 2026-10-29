import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor } from 'storybook/test';

import type { ApprovalAnswer, Decision } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard.tsx';

// (No `new Error` in this file: the Error story's export shadows the global.)

const ANSWER_NAMES = ['Allow this time', 'Deny this time', 'Allow only for this person', 'Deny always'];
const ERROR_LINE = "We couldn't confirm your answer. Try again, or reload to see where it stands.";

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

/** The card's one status dot. */
function dotIn(root: HTMLElement): HTMLElement {
  const dots = root.querySelectorAll<HTMLElement>('.cd-status-dot');
  if (dots.length !== 1) throw new globalThis.Error(`expected one status dot, found ${dots.length}`);
  return dots[0] as HTMLElement;
}

/** A final state: its line and dot, and no answer by any name, though the fixture still carries them. */
async function expectFinal(root: HTMLElement, decision: Decision, line: string, tone: string): Promise<void> {
  await expect(decision.answers?.length ?? 0).toBeGreaterThan(0);
  const card = root.querySelector('article');
  if (!card) throw new globalThis.Error('no card');
  await expect(card).toHaveAccessibleName(`Held for you: ${decision.reason_plain}`);
  await expect(root).toHaveTextContent(line);
  await expect(root).not.toHaveTextContent('Waiting for your answer');
  await expect(dotIn(root)).toHaveClass(`cd-status-dot--${tone}`);
  await expect(root.querySelector('[role="group"]')).toBeNull();
  await expect(root.querySelectorAll('button')).toHaveLength(0);
  for (const name of ANSWER_NAMES) await expect(root).not.toHaveTextContent(name);
  await expect(root).not.toHaveTextContent('saves a rule');
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

export const Waiting: Story = {
  parameters: {
    canvasNote:
      "The board's four answers become three for an unverified visitor: Allow only for this person needs a verified person. The counter-offer row is static vision.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const card = canvas.getByRole('article', { name: `Held for you: ${held.reason_plain}` });
    await expect(card).toHaveTextContent('Waiting for your answer');
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--held');
    await expect(canvas.getByText('Web chat, 2 min ago')).toBeVisible();
    // Claude's summary of the request is in serif; the rule that held it follows.
    expectComputed(canvas.getByText(held.reason_plain), { fontFamily: /Source Serif 4/, fontSize: '18px', lineHeight: '27px' });
    await expect(card).toHaveTextContent(`Held by your rule: ${rivera.ruleCards['rv-quote'].reason}`);
    await expect(card).toHaveTextContent('From the visitor: “How much to clear a clogged drain? Can I get 15% off if I pay cash?”');

    // only_offered_answers: the kernel offered three, so three show, in order, as main secondary buttons.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    await expect(answerButtons(canvasElement).map((button) => button.textContent)).toEqual([
      'Allow this time',
      'Deny this time',
      'Deny always',
    ]);
    await expect(canvas.queryByRole('button', { name: 'Allow only for this person' })).toBeNull();
    expectComputed(answerButtons(canvasElement)[0] as HTMLElement, { height: '40px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    await expect(card).toHaveTextContent("Deny always also saves a rule. You'll see it before it applies.");
    await expect(card).not.toHaveTextContent('Allow only for this person');

    // answers_once: a second click sends nothing, and every answer waits for the result.
    const allow = canvas.getByRole('button', { name: 'Allow this time' });
    await userEvent.click(allow);
    await userEvent.click(allow);
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await expect(args.onAnswer).toHaveBeenCalledWith('allow_once');
    for (const button of answerButtons(canvasElement)) await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(group).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Deny always' }));
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
  },
};

export const WaitingVerified: Story = {
  args: { decision: heldVerified, heldBy: rivera.ruleCards['rv-book-sat'].reason, context: undefined, waiting: 'Web chat, just now' },
  parameters: {
    canvasNote:
      "The board's discount request is Dana's Sunday booking here, from a verified customer, so all four answers show. The counter-offer row is static vision.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // only_offered_answers: all four, in their fixed order, and the line names both that save a rule.
    await expect(answerButtons(canvasElement).map((button) => button.textContent)).toEqual(ANSWER_NAMES);
    await expect(canvas.getByRole('article')).toHaveTextContent(
      "Allow only for this person and Deny always also save a rule. You'll see it before it applies.",
    );

    // keyboard_answers: Tab into the group, on to Deny always, and Enter answers.
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Allow this time' })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    const denyAlways = canvas.getByRole('button', { name: 'Deny always' });
    await expect(denyAlways).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await expect(args.onAnswer).toHaveBeenCalledWith('deny_always');
    // Focus stays on the answer while it is sent.
    await expect(denyAlways).toHaveFocus();
  },
};

export const Sending: Story = {
  args: { pending: true },
  parameters: { canvasNote: 'No board shows an answer being sent; the answers wait, and a line says so under them.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const group = canvas.getByRole('group', { name: 'Your answer' });
    await expect(group).toHaveAttribute('aria-busy', 'true');
    const progress = canvas.getByText('Sending your answer');
    await expect(progress.closest('[role="status"]')).not.toBeNull();
    for (const button of answerButtons(canvasElement)) await expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Deny this time' }));
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const Error: Story = {
  args: { error: true },
  render: (args) => <RetryingScreen {...args} />,
  parameters: {
    canvasNote:
      'No board shows a lost answer; the static line sits under the answers, which stay enabled, because the kernel resolves a request once.',
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
