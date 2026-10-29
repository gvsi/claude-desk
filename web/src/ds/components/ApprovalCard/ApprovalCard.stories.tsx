import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import type { ApprovalAnswer, Decision } from '../../../api/contracts.ts';
import { chen, rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard.tsx';

/** Words that only an offered answer shows: its button, its menu items and their lines. */
const ANSWER_WORDS = ['Allow this time', 'Deny this time', 'This time', 'Only for', 'Always', 'Nothing is saved', 'Saves a rule'];
const ERROR_LINE = "We couldn't confirm your answer. Try again, or reload to see where it stands.";
const ONCE_LINE = 'Only this request. Nothing is saved.';
const RULE_LINE = "Saves a rule. You'll see it first.";

/** Each side's look on the signed board: Allow the secondary button, Deny the soft red fill. */
const SECONDARY = { backgroundColor: 'rgba(250, 249, 245, 0.1)', color: 'rgba(250, 249, 245, 0.92)', height: '40px' };
const DANGER = { backgroundColor: 'rgba(220, 130, 144, 0.16)', color: 'rgb(235, 163, 174)', height: '40px' };
/** A menu on the raised surface, with the card's border and radius, lifted by the dialog shadow. */
const MENU = { backgroundColor: 'rgb(42, 41, 39)', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.14)', borderRadius: '12px' };
/** Deny's items say what they refuse in red words; Allow's are plain; each item's line is quieter. */
const RED_WORDS = { color: 'rgb(235, 163, 174)' };
const PLAIN_WORDS = { color: 'rgba(250, 249, 245, 0.92)' };
const QUIET_LINE = { color: 'rgba(250, 249, 245, 0.64)', fontSize: '12px' };
const ANSWERS_BOARD =
  'The answers follow the signed-off answer board N-Answers-TwoButtons, option 2 (menu buttons), which replaces the four secondary answers on this board.';

const held = rivera.decisions.held;
const heldVerified = rivera.heldVerified;
const heldRefund = rivera.heldRefund;
const heldConsultation = chen.heldConsultation;
const DANA = rivera.people.dana.name;

/** The visitor's own words, quoted as Plan 04's Today does, and marked as someone else's text. */
const fromTheVisitor = (
  <>
    From the visitor: “<span data-copy="user">How much to clear a clogged drain? Can I get 15% off if I pay cash?</span>”
  </>
);

/** Each held request with its rule, as Today passes them, with the person's name when she is verified. */
const consultationArgs = {
  decision: heldConsultation,
  heldBy: chen.ruleCards['cc-consult'].reason,
  context: undefined,
  waiting: 'Web chat, 5 min ago',
} satisfies Partial<ApprovalCardProps>;
const saturdayArgs = {
  decision: heldVerified,
  heldBy: rivera.ruleCards['rv-book-sat'].reason,
  context: undefined,
  waiting: 'Web chat, just now',
  personName: DANA,
} satisfies Partial<ApprovalCardProps>;
const refundArgs = {
  decision: heldRefund,
  heldBy: rivera.ruleCards['rv-refund'].reason,
  context: undefined,
  waiting: 'Web chat, 1 min ago',
  personName: DANA,
} satisfies Partial<ApprovalCardProps>;

/** The card's answer buttons, in the order shown, without the items of an open menu. */
function answerButtons(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="group"][aria-label="Your answer"] button:not([role="menuitem"])')];
}

/** An open menu's items, in order. */
function itemsOf(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole('menuitem');
}

/** What an open menu offers: each item's name and its quieter line. */
async function expectItems(menu: HTMLElement, items: readonly [string, string][]): Promise<void> {
  const found = itemsOf(menu);
  await expect(found).toHaveLength(items.length);
  for (const [i, [name, line]] of items.entries()) {
    await expect(found[i]).toHaveAccessibleName(name);
    await expect(found[i]).toHaveAccessibleDescription(line);
  }
}

/** The top edge of each element, to the pixel: equal tops share a row. */
function tops(elements: readonly HTMLElement[]): number[] {
  return elements.map((el) => Math.round(el.getBoundingClientRect().top));
}

/** A 390 px phone's line: the screen less two 16 px gutters. */
const PHONE_LINE = 358;

/** A verified person's long name, on Allow's only answer: a plain button with long words. */
const LONG_NAME = 'María Guadalupe Fernández de la Torre';
const longNameArgs = {
  ...saturdayArgs,
  decision: { ...heldVerified, answers: ['allow_person', 'deny_once'] },
  personName: LONG_NAME,
} satisfies Partial<ApprovalCardProps>;

/** Every answer's words stay inside its button, and every button inside the card's answers. */
async function expectAnswersInside(card: HTMLElement): Promise<void> {
  const group = within(card).getByRole('group', { name: 'Your answer' });
  const row = group.querySelector<HTMLElement>('.cd-approval-card__row');
  if (!row) throw new Error('no answer row');
  const edge = group.getBoundingClientRect();
  await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  await expect(edge.right).toBeLessThanOrEqual(card.getBoundingClientRect().right);
  for (const button of answerButtons(card)) {
    const box = button.getBoundingClientRect();
    await expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
    await expect(button.scrollHeight).toBeLessThanOrEqual(button.clientHeight);
    await expect(box.left).toBeGreaterThanOrEqual(edge.left - 0.5);
    await expect(box.right).toBeLessThanOrEqual(edge.right + 0.5);
    const range = document.createRange();
    range.selectNodeContents(button);
    for (const line of [...range.getClientRects()].filter((rect) => rect.width > 0)) {
      await expect(line.left).toBeGreaterThanOrEqual(box.left - 0.5);
      await expect(line.right).toBeLessThanOrEqual(box.right + 0.5);
      await expect(line.top).toBeGreaterThanOrEqual(box.top - 0.5);
      await expect(line.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
    }
  }
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
  await expect(root.querySelector('[role="menu"]')).toBeNull();
  await expect(root.querySelectorAll('button')).toHaveLength(0);
  for (const words of ANSWER_WORDS) await expect(root).not.toHaveTextContent(words);
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

/** A screen whose every answer comes back unconfirmed at once, so the card takes the next try. */
function UnconfirmedScreen(props: ApprovalCardProps) {
  return (
    <ApprovalCard
      {...props}
      onAnswer={(answer: ApprovalAnswer) => {
        props.onAnswer(answer);
        return Promise.reject(new Error('the answer was not confirmed'));
      }}
    />
  );
}

/** The event a story sends the screen below, carrying new props for its card. */
const SCREEN_UPDATE = 'cd-story-screen-update';

/**
 * The card as a screen holds it, re-rendered with whatever props the story sends: `pending` when an
 * answer starts to be sent from elsewhere, or the decision as the kernel re-read it.
 */
function UpdatingScreen(props: ApprovalCardProps) {
  const [update, setUpdate] = useState<Partial<ApprovalCardProps>>({});
  useEffect(() => {
    const onUpdate = (event: Event) => {
      if (event instanceof CustomEvent) setUpdate((current) => ({ ...current, ...(event.detail as Partial<ApprovalCardProps>) }));
    };
    window.addEventListener(SCREEN_UPDATE, onUpdate);
    return () => window.removeEventListener(SCREEN_UPDATE, onUpdate);
  }, []);
  return <ApprovalCard {...props} {...update} />;
}

/** Sends the screen new props for its card. */
function updateScreen(root: HTMLElement, update: Partial<ApprovalCardProps>): void {
  root.ownerDocument.defaultView?.dispatchEvent(new CustomEvent(SCREEN_UPDATE, { detail: update }));
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

export const TwoPlainButtons: Story = {
  parameters: {
    canvasNote: `${ANSWERS_BOARD} The quote card's discount limit holds this request, not the tool, and the visitor isn't verified, so each side has one answer and shows it as a plain button. The counter-offer row is static vision.`,
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

    // only_offered_answers: one answer on each side, so two plain buttons with their full words.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    const buttons = answerButtons(canvasElement);
    await expect(buttons.map((button) => button.textContent)).toEqual(['Allow this time', 'Deny this time']);
    const [allow, deny] = buttons as [HTMLElement, HTMLElement];
    await expect(allow).toHaveAccessibleName('Allow this time');
    await expect(deny).toHaveAccessibleName('Deny this time');
    for (const button of buttons) {
      await expect(button).not.toHaveAttribute('aria-haspopup');
      await expect(button).not.toHaveAttribute('aria-expanded');
      await expect(button.querySelector('svg')).toBeNull();
    }

    // Allow is the secondary button, Deny the soft red fill, side by side.
    expectComputed(allow, SECONDARY);
    expectComputed(deny, DANGER);
    await expect(new Set(tops(buttons)).size).toBe(1);
    await expect(allow.getBoundingClientRect().right + 8).toBe(deny.getBoundingClientRect().left);

    // Nothing else: no menu, and no line about rules under the answers.
    await expect(canvas.queryByRole('menu')).toBeNull();
    for (const words of ['saves a rule', 'save a rule', "You'll see", 'Or save a rule']) await expect(card).not.toHaveTextContent(words);
    await expect(group).not.toHaveAttribute('aria-busy');
  },
};

export const DenyMenu: Story = {
  args: consultationArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} Its three answers come from Chen & Co.: an ask card holds every booking, so the tool itself is held and Deny always is offered; the visitor isn't verified, so Allow has one answer.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // Linda's card holds every booking, whoever asks, and its reason says no less.
    await expect(chen.ruleCards['cc-consult'].who).toBe('anyone');
    await expect(canvas.getByRole('article')).toHaveTextContent('Held by your rule: Bookings wait for your answer.');

    // Allow has one answer, a plain button; Deny has two, so it opens a menu: its word, then a chevron.
    const buttons = answerButtons(canvasElement);
    await expect(buttons.map((button) => button.textContent)).toEqual(['Allow this time', 'Deny']);
    const [allow, deny] = buttons as [HTMLElement, HTMLElement];
    await expect(allow).not.toHaveAttribute('aria-haspopup');
    await expect(deny).toHaveAccessibleName('Deny');
    await expect(deny).toHaveAttribute('aria-haspopup', 'menu');
    await expect(deny).toHaveAttribute('aria-expanded', 'false');
    await expect(deny.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expectComputed(allow, SECONDARY);
    expectComputed(deny, { ...DANGER, paddingRight: '10px' });
    await expect(new Set(tops(buttons)).size).toBe(1);

    // Closed, the menu isn't drawn at all.
    await expect(canvas.queryByRole('menu')).toBeNull();
    for (const words of ['Always', RULE_LINE, ONCE_LINE]) await expect(canvasElement).not.toHaveTextContent(words);
  },
};

export const DenyMenuOpen: Story = {
  args: consultationArgs,
  // Over the next held request, as on Today's list, so the menu shows it floats above it.
  render: (args) => (
    <div style={{ display: 'grid', rowGap: 'var(--space-12)' }}>
      <ApprovalCard {...args} />
      <ApprovalCard {...args} decision={held} heldBy={rivera.ruleCards['rv-quote'].reason} waiting="Web chat, 2 min ago" />
    </div>
  ),
  parameters: {
    canvasNote: `${ANSWERS_BOARD} Deny's menu, open over the next held request: This time and Always, each with its quieter line. The board's Always line names its rule; the card keeps the line generic, because the design system never composes rule text, and the rule is shown before it applies.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const [card, next] = canvas.getAllByRole('article') as [HTMLElement, HTMLElement];
    const cardHeight = card.getBoundingClientRect().height;
    const deny = canvas.getByRole('button', { name: 'Deny' });
    await userEvent.click(deny);

    // The menu is named by its button, which keeps its hover fill while it is open, and focus
    // moves to its first item.
    await expect(deny).toHaveAttribute('aria-expanded', 'true');
    await userEvent.unhover(deny);
    await waitFor(() => expectComputed(deny, { backgroundColor: 'rgba(220, 130, 144, 0.24)' }));
    const menu = canvas.getByRole('menu', { name: 'Deny' });
    await expectItems(menu, [
      ['This time', ONCE_LINE],
      ['Always', RULE_LINE],
    ]);
    const items = itemsOf(menu);
    await expect(items[0]).toHaveFocus();

    // A popover under the button, on the raised surface, above the card: the card keeps its height.
    expectComputed(menu, { ...MENU, position: 'absolute', boxShadow: /rgba/ });
    const [box, under] = [menu.getBoundingClientRect(), deny.getBoundingClientRect()];
    await expect(Math.round(box.left)).toBe(Math.round(under.left));
    await expect(Math.round(box.top)).toBe(Math.round(under.bottom) + 6);
    await expect(box.bottom).toBeGreaterThan(card.getBoundingClientRect().bottom);
    await expect(card.getBoundingClientRect().height).toBe(cardHeight);
    // It covers the next card's top, and nothing of that card shows through it.
    await expect(box.bottom).toBeGreaterThan(next.getBoundingClientRect().top);
    for (const y of [box.top + 8, next.getBoundingClientRect().top + 8, box.bottom - 8]) {
      const top = canvasElement.ownerDocument.elementFromPoint(box.left + 12, y);
      await expect(menu.contains(top)).toBe(true);
    }

    // Deny's items say what they refuse in red words, each over its quieter line.
    for (const item of items) {
      expectComputed(item.firstElementChild as HTMLElement, RED_WORDS);
      expectComputed(item.lastElementChild as HTMLElement, QUIET_LINE);
    }
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const AllowMenu: Story = {
  args: saturdayArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} Dana's Saturday afternoon request, held by the Saturday card's hours: a limit, not the tool, so Deny always isn't offered; she is verified, so Allow has two answers and opens a menu.`,
  },
  play: async ({ canvas, canvasElement }) => {
    const buttons = answerButtons(canvasElement);
    await expect(buttons.map((button) => button.textContent)).toEqual(['Allow', 'Deny this time']);
    const [allow, deny] = buttons as [HTMLElement, HTMLElement];
    await expect(allow).toHaveAccessibleName('Allow');
    await expect(allow).toHaveAttribute('aria-haspopup', 'menu');
    await expect(allow).toHaveAttribute('aria-expanded', 'false');
    await expect(deny).not.toHaveAttribute('aria-haspopup');
    expectComputed(allow, { ...SECONDARY, paddingRight: '10px' });
    expectComputed(deny, DANGER);
    await expect(new Set(tops(buttons)).size).toBe(1);
    await expect(canvas.queryByRole('menu')).toBeNull();
  },
};

export const AllowMenuOpen: Story = {
  args: saturdayArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} Allow's menu, open, naming the verified person as the board does; its rule line stays generic.`,
  },
  play: async ({ canvas, userEvent }) => {
    const allow = canvas.getByRole('button', { name: 'Allow' });
    await userEvent.click(allow);
    await expect(allow).toHaveAttribute('aria-expanded', 'true');
    const menu = canvas.getByRole('menu', { name: 'Allow' });
    await expectItems(menu, [
      ['This time', ONCE_LINE],
      [`Only for ${DANA}, always`, RULE_LINE],
    ]);
    const items = itemsOf(menu);
    await expect(items[0]).toHaveFocus();

    // The name is the person's own, set apart as user text; Allow's items are plain words.
    const name = within(menu).getByText(DANA);
    await expect(name).toHaveAttribute('data-copy', 'user');
    for (const item of items) {
      expectComputed(item.firstElementChild as HTMLElement, PLAIN_WORDS);
      expectComputed(item.lastElementChild as HTMLElement, QUIET_LINE);
    }
    expectComputed(menu, { ...MENU, position: 'absolute' });
    await expect(Math.round(menu.getBoundingClientRect().left)).toBe(Math.round(allow.getBoundingClientRect().left));
  },
};

export const AllowAndDenyMenus: Story = {
  args: refundArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} Dana's refund: the refund card asks about every refund, so the tool itself is held, and she is verified with an amount within the rules' money cap, so all four answers show, two on each side. One menu opens at a time.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const buttons = answerButtons(canvasElement);
    await expect(buttons.map((button) => button.textContent)).toEqual(['Allow', 'Deny']);
    const [allow, deny] = buttons as [HTMLElement, HTMLElement];
    expectComputed(allow, SECONDARY);
    expectComputed(deny, DANGER);
    for (const button of buttons) await expect(button).toHaveAttribute('aria-haspopup', 'menu');

    // She is verified, so Allow's rule answer names her.
    await userEvent.click(allow);
    await expectItems(canvas.getByRole('menu', { name: 'Allow' }), [
      ['This time', ONCE_LINE],
      [`Only for ${DANA}, always`, RULE_LINE],
    ]);

    // One menu at a time: opening Deny closes Allow.
    await userEvent.click(deny);
    await expect(allow).toHaveAttribute('aria-expanded', 'false');
    await expect(deny).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getAllByRole('menu')).toHaveLength(1);
    await expectItems(canvas.getByRole('menu', { name: 'Deny' }), [
      ['This time', ONCE_LINE],
      ['Always', RULE_LINE],
    ]);

    // A click outside closes it, and leaves focus alone.
    await userEvent.click(canvas.getByText(heldRefund.reason_plain));
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveAttribute('aria-expanded', 'false');

    // A second click on its button closes it too.
    await userEvent.click(deny);
    await expect(canvas.getByRole('menu', { name: 'Deny' })).toBeVisible();
    await userEvent.click(deny);
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const KeyboardThroughTheMenus: Story = {
  args: refundArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows the keys; this is the menu button pattern, through both menus, ending on Allow only for Dana.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const allow = canvas.getByRole('button', { name: 'Allow' });
    const deny = canvas.getByRole('button', { name: 'Deny' });
    const open = () => itemsOf(canvas.getByRole('menu'));

    // Down opens Allow's menu on its first item; Down and Up move and wrap, End and Home jump.
    await userEvent.tab();
    await expect(allow).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(allow).toHaveAttribute('aria-expanded', 'true');
    let items = open();
    await expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(items[1]).toHaveFocus();

    // Escape closes it and gives focus back to its button.
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(allow).toHaveFocus();
    await expect(allow).toHaveAttribute('aria-expanded', 'false');

    // Enter opens it again; Tab closes it and gives focus back to its button too.
    await userEvent.keyboard('{Enter}');
    await expect(open()[0]).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(allow).toHaveFocus();

    // On to Deny: Space opens its menu, and Escape closes it; Up opens it on its last item.
    await userEvent.tab();
    await expect(deny).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(deny).toHaveAttribute('aria-expanded', 'true');
    await expect(open()[0]).toHaveAccessibleName('This time');
    await expect(open()[0]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(deny).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(open()[1]).toHaveAccessibleName('Always');
    await expect(open()[1]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(deny).toHaveFocus();
    await expect(args.onAnswer).not.toHaveBeenCalled();

    // Back to Allow, down to Only for Dana, always, and Enter chooses it: one answer, allow_person.
    await userEvent.tab({ shift: true });
    await expect(allow).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    items = open();
    await userEvent.keyboard('{ArrowDown}');
    await expect(items[1]).toHaveAccessibleName(`Only for ${DANA}, always`);
    await expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await expect(args.onAnswer).toHaveBeenCalledWith('allow_person');

    // The menu goes, and focus waits on Allow while the answer is sent.
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(allow).toHaveFocus();
    await expect(allow).toHaveAttribute('aria-disabled', 'true');
  },
};

export const ThisTimeOnEachSide: Story = {
  args: refundArgs,
  render: (args) => <UnconfirmedScreen {...args} />,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} Both menus offer "This time", and each sends its own side's answer, by click and by Enter. Here every answer comes back unconfirmed at once, so the next can be tried.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const allow = canvas.getByRole('button', { name: 'Allow' });
    const deny = canvas.getByRole('button', { name: 'Deny' });
    const thisTime = (menu: 'Allow' | 'Deny') => within(canvas.getByRole('menu', { name: menu })).getByRole('menuitem', { name: 'This time' });
    // The answer comes back unconfirmed, and the answers can be tried again.
    const answersBack = () =>
      waitFor(async () => {
        for (const button of answerButtons(canvasElement)) await expect(button).not.toHaveAttribute('aria-disabled');
      });

    // By click: This time in Allow's menu allows once, and in Deny's denies once.
    await userEvent.click(allow);
    await userEvent.click(thisTime('Allow'));
    await expect(args.onAnswer).toHaveBeenLastCalledWith('allow_once');
    await answersBack();
    await userEvent.click(deny);
    await userEvent.click(thisTime('Deny'));
    await expect(args.onAnswer).toHaveBeenLastCalledWith('deny_once');
    await answersBack();

    // By Enter: Enter opens each menu on This time, and Enter again chooses it.
    await userEvent.tab({ shift: true });
    await expect(allow).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(thisTime('Allow')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenLastCalledWith('allow_once');
    await answersBack();
    await userEvent.tab();
    await expect(deny).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(thisTime('Deny')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenLastCalledWith('deny_once');

    await expect(args.onAnswer).toHaveBeenCalledTimes(4);
    for (const [n, answer] of (['allow_once', 'deny_once', 'allow_once', 'deny_once'] as const).entries()) {
      await expect(args.onAnswer).toHaveBeenNthCalledWith(n + 1, answer);
    }
  },
};

export const HoldingEnter: Story = {
  args: refundArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows the keys; Enter held a moment too long on a menu button opens its menu and never answers.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const allow = canvas.getByRole('button', { name: 'Allow' });
    const deny = canvas.getByRole('button', { name: 'Deny' });

    // Enter goes down on Allow and repeats before it comes up: the menu opens on its first item.
    await userEvent.tab();
    await expect(allow).toHaveFocus();
    await userEvent.keyboard('{Enter>3/}');
    await expect(allow).toHaveAttribute('aria-expanded', 'true');
    await expect(itemsOf(canvas.getByRole('menu', { name: 'Allow' }))[0]).toHaveFocus();
    await expect(args.onAnswer).not.toHaveBeenCalled();

    // The same on Deny.
    await userEvent.keyboard('{Escape}');
    await userEvent.tab();
    await expect(deny).toHaveFocus();
    await userEvent.keyboard('{Enter>3/}');
    await expect(deny).toHaveAttribute('aria-expanded', 'true');
    await expect(itemsOf(canvas.getByRole('menu', { name: 'Deny' }))[0]).toHaveFocus();
    await expect(args.onAnswer).not.toHaveBeenCalled();

    // A fresh Enter in the menu still chooses.
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await expect(args.onAnswer).toHaveBeenCalledWith('deny_once');
  },
};

export const MenuOnAPhone: Story = {
  render: (args) => (
    <div data-testid="phone-line" style={{ width: PHONE_LINE, maxWidth: '100%', display: 'grid', rowGap: 'var(--space-16)' }}>
      <ApprovalCard {...args} />
      <ApprovalCard {...args} {...refundArgs} />
    </div>
  ),
  parameters: {
    canvasNote: `${ANSWERS_BOARD} The board's phone note: under about 480 px of card, Allow and Deny stay side by side, each half the line and 44 px tall, and a menu opens inline as a full-width list under them, its items 48 px, pushing the card down.`,
  },
  play: async ({ canvas, userEvent }) => {
    const line = canvas.getByTestId('phone-line');
    await expect(line.getBoundingClientRect().width).toBe(PHONE_LINE);
    const cards = canvas.getAllByRole('article');
    await expect(cards).toHaveLength(2);

    // Both cards: two controls side by side, sharing the line, each 44 px tall.
    for (const card of cards) {
      const group = within(card).getByRole('group', { name: 'Your answer' });
      const buttons = answerButtons(card);
      await expect(buttons).toHaveLength(2);
      const [left, right] = buttons.map((button) => button.getBoundingClientRect()) as [DOMRect, DOMRect];
      const box = group.getBoundingClientRect();
      await expect(left.height).toBe(44);
      await expect(right.height).toBe(44);
      await expect(left.top).toBe(right.top);
      await expect(left.left).toBe(box.left);
      await expect(right.right).toBe(box.right);
      await expect(Math.abs(left.width - right.width)).toBeLessThan(1);
    }
    await expect(answerButtons(cards[0] as HTMLElement).map((button) => button.textContent)).toEqual(['Allow this time', 'Deny this time']);

    // Deny's menu opens inline: a full-width list under both controls, inside the card, which grows.
    const card = cards[1] as HTMLElement;
    const before = card.getBoundingClientRect().height;
    const [allow, deny] = answerButtons(card) as [HTMLElement, HTMLElement];
    await userEvent.click(deny);
    const menu = within(card).getByRole('menu', { name: 'Deny' });
    expectComputed(menu, { ...MENU, position: 'static', boxShadow: 'none' });
    const group = within(card).getByRole('group', { name: 'Your answer' }).getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    await expect(box.left).toBe(group.left);
    await expect(box.width).toBe(group.width);
    await expect(box.top).toBeGreaterThanOrEqual(deny.getBoundingClientRect().bottom);
    await expect(box.top).toBeGreaterThanOrEqual(allow.getBoundingClientRect().bottom);
    await expect(card.getBoundingClientRect().bottom).toBeGreaterThan(box.bottom);
    await expect(card.getBoundingClientRect().height).toBeGreaterThan(before);
    for (const item of itemsOf(menu)) await expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    await expect(itemsOf(menu)[0]).toHaveFocus();
    await expect(line.scrollWidth).toBeLessThanOrEqual(PHONE_LINE);
  },
};

export const LongNameOnAPhone: Story = {
  args: longNameArgs,
  render: (args) => (
    <div data-testid="phone-line" style={{ width: PHONE_LINE, maxWidth: '100%' }}>
      <ApprovalCard {...args} />
    </div>
  ),
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows a long name on a plain answer; on a phone it can't share the line, so Allow takes a line of its own, as many lines of words tall as it needs, and Deny the next, and nothing leaves its button or the card.`,
  },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('article');
    const group = within(card).getByRole('group', { name: 'Your answer' }).getBoundingClientRect();
    const [allow, deny] = answerButtons(card) as [HTMLElement, HTMLElement];
    await expect(allow).toHaveAccessibleName(`Allow only for ${LONG_NAME}, always`);
    await expect(deny).toHaveAccessibleName('Deny this time');

    // long_answer_stays_in_its_button: each answer is a full-width line; the long one wraps its
    // words and grows, and Deny keeps 44 px.
    const [left, right] = [allow.getBoundingClientRect(), deny.getBoundingClientRect()];
    await expect(right.top).toBeGreaterThanOrEqual(left.bottom);
    await expect(left.width).toBe(group.width);
    await expect(right.width).toBe(group.width);
    await expect(left.height).toBeGreaterThan(44);
    await expect(right.height).toBe(44);
    await expectAnswersInside(card);
    await expect(canvas.getByTestId('phone-line').scrollWidth).toBeLessThanOrEqual(PHONE_LINE);
  },
};

export const LongNameInAWideCard: Story = {
  args: longNameArgs,
  render: (args) => (
    <div data-testid="wide-card" style={{ width: 500, maxWidth: '100%' }}>
      <ApprovalCard {...args} />
    </div>
  ),
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows a long name on a plain answer; in a 500 px card it can't sit beside Deny this time, so Deny moves to the next line instead of past the card.`,
  },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('article');
    const [allow, deny] = answerButtons(card) as [HTMLElement, HTMLElement];
    await expect(allow).toHaveAccessibleName(`Allow only for ${LONG_NAME}, always`);
    // long_answer_stays_in_its_button: Deny goes under Allow, at the start of the line, and keeps
    // its one-line height.
    const [left, right] = [allow.getBoundingClientRect(), deny.getBoundingClientRect()];
    await expect(right.top).toBeGreaterThanOrEqual(left.bottom);
    await expect(right.left).toBe(left.left);
    expectComputed(deny, { height: '40px' });
    await expectAnswersInside(card);
    await expect(canvas.getByTestId('wide-card').scrollWidth).toBeLessThanOrEqual(500);
  },
};

export const DragOffTheButton: Story = {
  args: consultationArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows a press dragged off a menu button; the menu stays open with focus on its button, Down goes back into it, and focus leaving the button closes it.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const allow = canvas.getByRole('button', { name: 'Allow this time' });
    const deny = canvas.getByRole('button', { name: 'Deny' });
    const summary = canvas.getByText(heldConsultation.reason_plain);
    const dragOff = () =>
      userEvent.pointer([{ keys: '[MouseLeft>]', target: deny }, { target: summary }, { keys: '[/MouseLeft]', target: summary }]);
    await userEvent.click(deny);
    await expect(itemsOf(canvas.getByRole('menu', { name: 'Deny' }))[0]).toHaveFocus();

    // A press on the open menu's button, dragged off and let go over the summary, is no click: the
    // menu stays open, and focus is on its button.
    await dragOff();
    await expect(canvas.getByRole('menu', { name: 'Deny' })).toBeVisible();
    await expect(deny).toHaveFocus();
    await expect(deny).toHaveAttribute('aria-expanded', 'true');

    // Down on the button moves focus back into its open menu.
    await userEvent.keyboard('{ArrowDown}');
    await expect(itemsOf(canvas.getByRole('menu', { name: 'Deny' }))[0]).toHaveFocus();

    // Once more, then focus leaves the button for Allow: the menu closes.
    await dragOff();
    await expect(deny).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(allow).toHaveFocus();
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveAttribute('aria-expanded', 'false');
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const EscapeOnTheButton: Story = {
  args: consultationArgs,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows the keys; with focus on a menu button whose menu is open, Escape closes the menu and leaves focus on the button.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const deny = canvas.getByRole('button', { name: 'Deny' });
    await userEvent.click(deny);
    // A press dragged off the button leaves its menu open with focus on the button.
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: deny },
      { target: canvas.getByText(heldConsultation.reason_plain) },
      { keys: '[/MouseLeft]' },
    ]);
    await expect(deny).toHaveFocus();
    await expect(deny).toHaveAttribute('aria-expanded', 'true');

    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveAttribute('aria-expanded', 'false');
    await expect(deny).toHaveFocus();
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const OneMenuAcrossCards: Story = {
  args: refundArgs,
  render: (args) => (
    <div style={{ display: 'grid', rowGap: 'var(--space-12)' }}>
      <ApprovalCard {...args} />
      <ApprovalCard {...args} {...consultationArgs} personName={undefined} />
    </div>
  ),
  parameters: {
    canvasNote: `${ANSWERS_BOARD} Two held requests on Today's list: one menu is open on the page at a time, however the next one opens, here by assistive tech activating a button with no pointer press while focus is outside the open menu.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const [first, second] = canvas.getAllByRole('article') as [HTMLElement, HTMLElement];
    const allow = within(first).getByRole('button', { name: 'Allow' });
    const deny = within(second).getByRole('button', { name: 'Deny' });
    await userEvent.click(allow);
    const menu = within(first).getByRole('menu', { name: 'Allow' });
    // A press on the menu's own padding is inside it, so the menu stays open, though focus leaves it.
    await userEvent.pointer({ keys: '[MouseLeft]', target: menu });
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainElement(menu.ownerDocument.activeElement as HTMLElement | null);

    // Deny's button on the next card is activated directly: a click, and nothing else.
    deny.click();
    await waitFor(() => expect(within(second).getByRole('menu', { name: 'Deny' })).toBeVisible());
    await expect(canvas.getAllByRole('menu')).toHaveLength(1);
    await expect(allow).toHaveAttribute('aria-expanded', 'false');
    await expect(deny).toHaveAttribute('aria-expanded', 'true');
    await expect(itemsOf(within(second).getByRole('menu'))[0]).toHaveFocus();
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const SendingStartsWhileOpen: Story = {
  args: refundArgs,
  render: (args) => <UpdatingScreen {...args} />,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows an answer sent from elsewhere while a menu is open; the menu closes and focus waits on its button, never on the page.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const deny = canvas.getByRole('button', { name: 'Deny' });
    await userEvent.click(deny);
    await expect(itemsOf(canvas.getByRole('menu', { name: 'Deny' }))[0]).toHaveFocus();

    // The screen starts sending an answer given elsewhere, say on the same request in its conversation.
    updateScreen(canvasElement, { pending: true });
    await waitFor(() => expect(canvas.getByText('Sending your answer')).toBeVisible());
    // The menu goes, and focus moves to its button, where it waits.
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveFocus();
    await expect(deny).toHaveAttribute('aria-expanded', 'false');
    await expect(deny).toHaveAttribute('aria-disabled', 'true');

    // That answer fails and the answers come back: the menu stays closed until the owner opens it.
    updateScreen(canvasElement, { pending: false, error: true });
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent(ERROR_LINE));
    await expect(deny).not.toHaveAttribute('aria-disabled');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveFocus();
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const AnswersChangeWhileOpen: Story = {
  args: refundArgs,
  render: (args) => <UpdatingScreen {...args} />,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows the answers changing under an open menu. Maria lowers her money cap below the refund in another tab, so a re-read drops Allow only for Dana, then raises it again; the menu stays closed until she opens it, and focus stays on Allow.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const labels = () => answerButtons(canvasElement).map((button) => button.textContent);
    const allow = canvas.getByRole('button', { name: 'Allow' });
    await userEvent.tab();
    await expect(allow).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    const last = itemsOf(canvas.getByRole('menu', { name: 'Allow' }))[1];
    await expect(last).toHaveAccessibleName(`Only for ${DANA}, always`);
    await expect(last).toHaveFocus();

    // The re-read drops allow_person: Allow has one answer, a plain button, and focus stays on it.
    updateScreen(canvasElement, { decision: { ...heldRefund, answers: ['allow_once', 'deny_once', 'deny_always'] } });
    await waitFor(() => expect(labels()).toEqual(['Allow this time', 'Deny']));
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Allow this time' })).toHaveFocus();

    // It comes back: Allow opens a menu again, closed, and focus doesn't jump into it.
    updateScreen(canvasElement, { decision: heldRefund });
    await waitFor(() => expect(labels()).toEqual(['Allow', 'Deny']));
    await expect(canvas.queryByRole('menu')).toBeNull();
    const again = canvas.getByRole('button', { name: 'Allow' });
    await expect(again).toHaveAttribute('aria-expanded', 'false');
    await expect(again).toHaveFocus();
    await expect(args.onAnswer).not.toHaveBeenCalled();
  },
};

export const SendingYourAnswer: Story = {
  args: refundArgs,
  render: (args) => <SendingScreen {...args} />,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows an answer being sent; both controls wait in their busy colors, and a line under them says so.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const [allow, deny] = answerButtons(canvasElement) as [HTMLElement, HTMLElement];

    // A click on Deny opens its menu, and a click on Always answers.
    await userEvent.click(deny);
    await userEvent.click(within(canvas.getByRole('menu', { name: 'Deny' })).getByRole('menuitem', { name: 'Always' }));
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);
    await expect(args.onAnswer).toHaveBeenCalledWith('deny_always');
    // The menu goes, and focus waits on Deny while the answer is sent.
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveFocus();

    // answers_once: while it is sent, nothing opens a menu and nothing answers.
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(' ');
    await userEvent.click(allow);
    await userEvent.click(deny);
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveAttribute('aria-expanded', 'false');
    await expect(args.onAnswer).toHaveBeenCalledTimes(1);

    // Both controls wait, and a line under them says so.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    await expect(group).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getByText('Sending your answer').closest('[role="status"]')).not.toBeNull();
    for (const button of answerButtons(canvasElement)) await expect(button).toHaveAttribute('aria-disabled', 'true');

    // Each steps to its busy colors, never dimmed, so its words still read at 4.5:1 in the card:
    // Allow's label turns text-secondary on its fill, and the red Deny keeps its words on its hover
    // fill. Both keep their chevrons. They step over the instant color transition, so wait for it
    // to end.
    const BUSY_LABEL = 'rgba(250, 249, 245, 0.64)';
    await waitFor(() => {
      expectComputed(allow, { ...SECONDARY, color: BUSY_LABEL, opacity: '1' });
      expectComputed(deny, { ...DANGER, backgroundColor: 'rgba(220, 130, 144, 0.24)', opacity: '1' });
    });
    for (const button of [allow, deny]) await expect(button.querySelector('.cd-button__chevron')).not.toBeNull();
  },
};

export const CouldNotConfirmYourAnswer: Story = {
  args: { ...refundArgs, error: true },
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows a lost answer; the line sits under the answers, which stay as they were and can be tried again, because the kernel resolves a request once.`,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent(ERROR_LINE);
    const buttons = answerButtons(canvasElement);
    for (const button of buttons) {
      await expect(button).toBeEnabled();
      await expect(button).not.toHaveAttribute('aria-disabled');
    }
    const [allow, deny] = buttons as [HTMLElement, HTMLElement];
    expectComputed(allow, { ...SECONDARY, opacity: '1' });
    expectComputed(deny, { ...DANGER, opacity: '1' });

    // The menus still open, so the owner can answer again.
    await userEvent.click(deny);
    await expect(canvas.getByRole('menu', { name: 'Deny' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveFocus();
  },
};

export const DeniedOnTheSecondTry: Story = {
  args: { error: true },
  render: (args) => <RetryingScreen {...args} />,
  parameters: {
    canvasNote: `${ANSWERS_BOARD} No board shows a lost answer; after it, the owner answers again and the card ends on its final line.`,
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
