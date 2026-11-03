import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import type { ApprovalAnswer, Decision } from '../../../api/contracts.ts';
import { chen, rivera } from '../../fixtures/index.ts';
import { ANIMATION_DEADLINE_MS, animationLabel, animationWithin } from '../../test/animationWithin.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { VISION_INERT_LINE } from '../VisionBar/visionInert.tsx';
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
const QUIET_LINE = { color: 'rgba(250, 249, 245, 0.64)', fontSize: '13px' };
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

/**
 * A final state: its line and dot, and no answer by any name, though the fixture still carries them.
 * It is drawn still: one layer, and nothing in the card moving.
 */
async function expectFinal(root: HTMLElement, decision: Decision, line: string, tone: string): Promise<void> {
  await expect(decision.answers?.length ?? 0).toBeGreaterThan(0);
  const card = root.querySelector<HTMLElement>('article');
  if (!card) throw new Error('no card');
  await expect(card).toHaveAccessibleName(`Held for you: ${decision.reason_plain}`);
  await expect(card).toHaveTextContent(line);
  await expect(card).not.toHaveTextContent('Waiting for your answer');
  await expect(dotIn(card)).toHaveClass(`cd-status-dot--${tone}`);
  await expect(card.querySelector('[role="group"]')).toBeNull();
  await expect(card.querySelector('[role="menu"]')).toBeNull();
  await expect(card.querySelectorAll('button')).toHaveLength(0);
  for (const words of ANSWER_WORDS) await expect(card).not.toHaveTextContent(words);
  await expect(card.querySelectorAll('.cd-approval-card__layer')).toHaveLength(1);
  await expect(card.getAnimations({ subtree: true })).toHaveLength(0);
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

/**
 * The card as Today holds it while an answer is out: pending once it is sent, until the story lands
 * the answer's result (`land`), as the kernel returned it, with whatever the screen puts under the
 * card once it is answered.
 */
function LandingScreen(props: ApprovalCardProps) {
  const [pending, setPending] = useState(false);
  const [landed, setLanded] = useState<Partial<ApprovalCardProps>>({});
  useEffect(() => {
    const onLand = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      setPending(false);
      setLanded(event.detail as Partial<ApprovalCardProps>);
    };
    window.addEventListener(SCREEN_UPDATE, onLand);
    return () => window.removeEventListener(SCREEN_UPDATE, onLand);
  }, []);
  return (
    <ApprovalCard
      {...props}
      pending={pending}
      {...landed}
      onAnswer={(answer: ApprovalAnswer) => {
        props.onAnswer(answer);
        setPending(true);
      }}
    />
  );
}

const HELD_LINE = 'Waiting for your answer';

/** Whether this browser asks for reduced motion: the design system's browser tests do. */
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A motion token, in milliseconds, as the page reads it. */
function motionMs(token: '--motion-fast' | '--motion-base'): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
}

/** An element's drawn scale, from its computed transform. */
function scaleOf(el: Element | null | undefined): number {
  const transform = el ? getComputedStyle(el).transform : 'none';
  return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
}

/** The card at one moment of its settle. */
interface SettleFrame {
  at: number;
  /** The card and what follows it, together. */
  height: number;
  /** The card alone. */
  cardHeight: number;
  /** The outgoing layer's opacity, or null with none. */
  leaving: number | null;
  /** The answered layer's opacity. */
  live: number;
  /** What follows the card: its opacity, or null with nothing there. */
  after: number | null;
  /** The answered status dot's scale. */
  dotScale: number;
}

/** What the commit that lands an answer drew, read before the browser paints it. */
interface Landing {
  /** The outgoing layer then, or null with none. */
  leaving: { inert: boolean; hidden: string | null; statuses: number; focused: boolean } | null;
  /** The card's status line then. */
  status: Element;
  /** Where focus was then. */
  focus: Element | null;
  /** The settle at each moment asked for, its animations paused there in turn. */
  frames: SettleFrame[];
}

/** The animations of an answer landing: the card's own, not a busy spinner or a button's colors. */
function settleMotion(animation: Animation): boolean {
  if (animation instanceof CSSAnimation) return animation.animationName.startsWith('cd-approval-card');
  return animation instanceof CSSTransition && animation.transitionProperty === 'height';
}

function readLanding(root: HTMLElement, status: Element, moments: readonly number[]): Landing {
  const region = root.querySelector<HTMLElement>('.cd-approval-card');
  const card = root.querySelector<HTMLElement>('article');
  if (!region || !card) throw new Error('no card');
  const leaving = card.querySelector<HTMLElement>('.cd-approval-card__layer--leaving');
  const live = status.closest<HTMLElement>('.cd-approval-card__layer');
  const after = region.querySelector<HTMLElement>('.cd-approval-card__after');
  const dot = live?.querySelector<HTMLElement>('.cd-status-dot');
  const focus = document.activeElement;
  const opacity = (el: Element | null | undefined) => (el?.isConnected ? Number(getComputedStyle(el).opacity) : null);
  const settling = region.getAnimations({ subtree: true }).filter(settleMotion);
  for (const animation of settling) animation.pause();
  const frames = moments.map((at) => {
    for (const animation of settling) animation.currentTime = at;
    return {
      at,
      height: region.getBoundingClientRect().height,
      cardHeight: card.getBoundingClientRect().height,
      leaving: opacity(leaving),
      live: opacity(live) ?? 0,
      after: opacity(after),
      dotScale: scaleOf(dot),
    };
  });
  for (const animation of settling) animation.finish();
  return {
    leaving:
      leaving === null
        ? null
        : {
            inert: leaving.hasAttribute('inert'),
            hidden: leaving.getAttribute('aria-hidden'),
            statuses: leaving.querySelectorAll('[role="status"]').length,
            focused: leaving.contains(focus),
          },
    status,
    focus,
    frames,
  };
}

/**
 * Lands `update` on the screen and reads the commit that lands it, before the browser paints: the
 * card's outgoing layer, its status line and focus, then the settle at each of `moments` (ms from
 * its start), every animation of it paused there in turn. Then the settle finishes.
 */
async function land(root: HTMLElement, update: Partial<ApprovalCardProps>, moments: readonly number[]): Promise<Landing> {
  let observer: MutationObserver | undefined;
  try {
    return await animationWithin(
      new Promise<Landing>((resolve, reject) => {
        observer = new MutationObserver(() => {
          const status = root.querySelector('.cd-approval-card__status-line[role="status"]');
          if (status === null || status.textContent === HELD_LINE) return;
          observer?.disconnect();
          try {
            resolve(readLanding(root, status, moments));
          } catch (error) {
            reject(error);
          }
        });
        observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
        updateScreen(root, update);
      }),
      'cd-approval-card answer landing',
    );
  } finally {
    observer?.disconnect();
  }
}

/** The settle's moments: its start, mid-crossfade, the crossfade done, into the ease, the pulse at its widest, and its end. */
function settleMoments(): number[] {
  const fast = motionMs('--motion-fast');
  const base = motionMs('--motion-base');
  return [0, fast / 2, fast, fast + base / 4, fast + base / 2, fast + base];
}

const LANDS_NOTE =
  'UXC-P202-After (canvas page "UX craft proposals", signed 2026-10-30) draws an answer landing: the held card fades out as the answered one fades in, its dot pulses once as it leaves held, and the card eases to its answered height. No reference board draws it; the nearest is N-Today-Run1. Storybook shows the motion your system asks for; the design system\'s browser tests render this story under reduced motion.';

/**
 * An answer given on the card lands as `final`: the held and answered layers cross, the dot pulses
 * only if its tone leaves held, and the card eases from its held height to its answered height.
 * Under reduced motion, the answered card draws at once.
 */
async function expectLands(
  root: HTMLElement,
  final: Decision,
  { line, tone, pulse, after }: { line: string; tone: string; pulse: boolean; after?: ReactNode },
): Promise<Landing> {
  const card = root.querySelector<HTMLElement>('article');
  const region = root.querySelector<HTMLElement>('.cd-approval-card');
  if (!card || !region) throw new Error('no card');
  const status = card.querySelector('[role="status"]');
  await expect(status).toHaveTextContent(HELD_LINE);
  const heldHeight = region.getBoundingClientRect().height;

  const landing = await land(root, { decision: final, after }, settleMoments());

  // One status node says it, its words changed in place.
  await expect(landing.status).toBe(status);
  await expect(status).toHaveTextContent(line);
  const frames = landing.frames;
  if (reducedMotion()) {
    // Nothing crosses or eases: the answered card draws at once.
    await expect(landing.leaving).toBeNull();
  } else {
    // From the first frame, the outgoing layer is out of reach: inert, hidden from assistive tech,
    // with no status of its own.
    await expect(landing.leaving).toMatchObject({ inert: true, hidden: 'true', statuses: 0 });
    const [start, crossing, crossed, easing, widest, end] = frames as [SettleFrame, SettleFrame, SettleFrame, SettleFrame, SettleFrame, SettleFrame];
    // The held and answered layers cross, the held one out over motion-fast, and the card keeps its
    // held height until it has gone.
    await expect([start.leaving, start.live]).toEqual([1, 0]);
    await expect(crossing.leaving).toBeGreaterThan(0);
    await expect(crossing.leaving).toBeLessThan(1);
    await expect(crossing.live).toBeGreaterThan(0);
    await expect(crossing.live).toBeLessThan(1);
    await expect(crossed.leaving).toBe(0);
    for (const frame of [start, crossing, crossed]) {
      await expect(frame.height).toBeCloseTo(heldHeight, 0);
      await expect(frame.cardHeight).toBeCloseTo(heldHeight, 0);
    }
    // Then the card eases to its answered height, as the dot pulses (or doesn't)...
    const shrinks = Math.sign(start.cardHeight - end.cardHeight);
    await expect(shrinks).toBe(1);
    await expect(start.cardHeight - easing.cardHeight).toBeGreaterThan(0.5);
    await expect(easing.cardHeight - end.cardHeight).toBeGreaterThan(0.5);
    await expect(widest.dotScale).toBeCloseTo(pulse ? 1.8 : 1, 1);
    // ...and the card with what follows it moves one way only, so nothing under it jumps.
    const way = Math.sign(end.height - start.height);
    for (const [i, frame] of frames.entries()) {
      const step = frame.height - (frames[i - 1]?.height ?? frame.height);
      if (Math.abs(step) > 0.5) await expect(Math.sign(step)).toBe(way);
    }
    await expect([start.dotScale, end.dotScale, end.live]).toEqual([1, 1, 1]);
    // What came under the card with the answer fades in with the answered layer, inside the easing height.
    if (after !== undefined) {
      await expect(start.after).toBe(0);
      await expect(crossing.after).toBeGreaterThan(0);
      await expect(crossing.after).toBeLessThan(1);
      await expect(end.after).toBe(1);
      await expect(start.cardHeight).toBeCloseTo(start.height, 0);
    } else {
      await expect(frames.map((frame) => frame.after)).toEqual(frames.map(() => null));
    }
  }

  // At the end: one layer, the answers gone from the accessibility tree and from the height, the
  // final words and the tone of the returned decision.
  await waitFor(() => expect(card.querySelector('.cd-approval-card__layer--leaving')).toBeNull());
  await expect(region.style.height).toBe('');
  await expect(card.querySelector('.cd-approval-card__answers')).toBeNull();
  await expectFinal(root, final, line, tone);
  const answeredHeight = region.getBoundingClientRect().height;
  if (after === undefined) await expect(answeredHeight).toBeLessThan(heldHeight);
  await expect(frames.at(-1)?.height).toBeCloseTo(answeredHeight, 0);
  await expect(frames.at(-1)?.cardHeight).toBeCloseTo(card.getBoundingClientRect().height, 0);
  if (reducedMotion()) await expect(frames[0]?.height).toBeCloseTo(answeredHeight, 0);
  return landing;
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
    canvas: 'N-Today-Run1',
    canvasNote:
      "The board's held request is the Turner fixture's held quote, and its held-by line names the rule card's reason.",
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
    // The kernel's reason for the hold is in serif; the rule that held it follows.
    expectComputed(canvas.getByText(held.reason_plain), { fontFamily: /Source Serif 4/, fontSize: '20px', lineHeight: '30px' });
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
    // A real card has no vision line.
    await expect(canvasElement.querySelector('.cd-vision-inert-line')).toBeNull();
  },
};

/** A demo visitor's held request: its pill 8 px after where and when it was held, so it's never taken for a real customer's. */
export const DemoVisitorRequest: Story = {
  args: { demoVisitor: true, context: <>From the visitor: “<span data-copy="user">Could I get 10% off as a returning customer?</span>”</> },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The REV-DEMO boards in review draw no held card; the pill is the conversation\'s and the row\'s "Demo visitor" pill (N-Live-REV-DEMO-chat-1512, #artboard-4ae3b66fd4f0), beside where the request came from.',
  },
  play: async ({ canvas }) => {
    const waiting = canvas.getByText('Web chat, 2 min ago');
    const pill = canvas.getByText('Demo visitor');
    await expect(pill).toHaveClass('cd-pill');
    await expect(waiting.contains(pill)).toBe(true);
    await expect(pill.closest('.cd-approval-card__top')).not.toBeNull();
    // Only in the card's own words: the outgoing layer holds none until an answer lands.
    await expect(canvas.getAllByText('Demo visitor')).toHaveLength(1);
  },
};

/** On a vision page, which makes no requests: the answers look and focus as ever, and do nothing. */
export const InertAnswers: Story = {
  args: { inertAnswers: true },
  parameters: {
    canvas: 'N-R2-Vision-Phone',
    canvasNote: 'The held quote on the phone vision page: the answers keep their look and tab order, and pressing one sends nothing.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // inert_answers_send_nothing: a click and a key press each leave the card as it was.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    const [allow, deny] = answerButtons(canvasElement) as [HTMLElement, HTMLElement];
    expectComputed(allow, SECONDARY);
    expectComputed(deny, DANGER);
    await expect(canvas.queryByText(VISION_INERT_LINE)).toBeNull();
    await userEvent.click(allow);
    await expect(allow).toHaveFocus();
    // vision_inert_line_on_first_press: the first press shows the line in a polite live region, a
    // secondary caption 8 px under the answers' row.
    const line = canvas.getByText(VISION_INERT_LINE);
    await expect(line).toHaveAttribute('role', 'status');
    expectComputed(line, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    const row = canvasElement.querySelector<HTMLElement>('.cd-approval-card__row')!;
    await expect(Math.round(line.getBoundingClientRect().top - row.getBoundingClientRect().bottom)).toBe(8);
    await userEvent.tab();
    await expect(deny).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).not.toHaveBeenCalled();
    await expect(group).not.toHaveAttribute('aria-busy');
    for (const button of [allow, deny]) {
      await expect(button).not.toHaveAttribute('aria-disabled');
      await expect(button).not.toHaveAttribute('aria-busy');
      await expect(button).toBeEnabled();
    }
    await expect(canvasElement.querySelector('.cd-button__spinner')).toBeNull();
    await expect(canvas.queryByText('Sending your answer')).toBeNull();
    await expect(canvas.getByText('Waiting for your answer')).toBeVisible();
    await expect(answerButtons(canvasElement).map((button) => button.textContent)).toEqual(['Allow this time', 'Deny this time']);
    // The second press, Enter on Deny, changed nothing: still the one line.
    await expect(canvas.getAllByText(VISION_INERT_LINE)).toHaveLength(1);
  },
};

/** The same on a menu: the menu opens, and choosing in it does nothing but close it. */
export const InertAnswersMenu: Story = {
  args: {
    ...consultationArgs,
    decision: { ...heldConsultation, answers: ['allow_once', 'allow_person', 'deny_once', 'deny_always'] },
    inertAnswers: true,
  },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No vision board draws a held request with menus; this is Chen’s consultation with all four answers, as a vision page would draw it, so choosing in a menu goes nowhere.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // inert_menu_choice_sends_nothing: Allow opens its menu, "This time" closes it, and nothing is sent.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    const [allow] = answerButtons(canvasElement) as [HTMLElement, HTMLElement];
    await expect(allow).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(allow);
    const menu = canvas.getByRole('menu', { name: 'Allow' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'This time' }));
    await expect(args.onAnswer).not.toHaveBeenCalled();
    // A choice in a menu is a press too: the line shows, once.
    await expect(canvas.getByText(VISION_INERT_LINE)).toHaveAttribute('role', 'status');
    await userEvent.click(allow);
    await userEvent.click(within(canvas.getByRole('menu', { name: 'Allow' })).getByRole('menuitem', { name: 'This time' }));
    await expect(canvas.getAllByText(VISION_INERT_LINE)).toHaveLength(1);
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(allow).toHaveFocus();
    await expect(group).not.toHaveAttribute('aria-busy');
    for (const button of answerButtons(canvasElement)) {
      await expect(button).not.toHaveAttribute('aria-disabled');
      await expect(button).not.toHaveAttribute('aria-busy');
    }
    await expect(canvasElement.querySelector('.cd-button__spinner')).toBeNull();
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
    await waitFor(() => expect(canvas.getByText('Sending your answer').closest('[role="status"]')).not.toBeNull());
    // The menu goes, and focus moves to its button, where it waits.
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(deny).toHaveFocus();
    await expect(deny).toHaveAttribute('aria-expanded', 'false');
    await expect(deny).toHaveAttribute('aria-disabled', 'true');
    // No answer was chosen here, so neither button shows the busy spinner: both wait in their busy
    // colors, and the status region says what is happening.
    for (const button of answerButtons(canvasElement)) {
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).not.toHaveAttribute('aria-busy');
      await expect(button.querySelector('.cd-button__spinner')).toBeNull();
    }

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
    canvasNote: `${ANSWERS_BOARD} No board shows the answers changing under an open menu. Mike lowers his money cap below the refund in another tab, so a re-read drops Allow only for Dana, then raises it again; the menu stays closed until he opens it, and focus stays on Allow.`,
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
    canvasNote: `${ANSWERS_BOARD} The N-Typing-Owner-Busy board and the owner's spinner decision show an answer being sent: the chosen answer shows the busy spinner and the other waits in its busy colors without one. "Sending your answer" is read out from the status region, unseen, so the card keeps its height until the answer lands.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const [allow, deny] = answerButtons(canvasElement) as [HTMLElement, HTMLElement];
    const card = canvasElement.querySelector<HTMLElement>('.cd-approval-card__card');
    if (card === null) throw new Error('the card draws its box');
    const heldHeight = card.getBoundingClientRect().height;

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

    // Neither control can be pressed. The busy button carries the wait: "Sending your answer" is read
    // out from the status region, visually hidden, so the card's height doesn't change while it's sent.
    const group = canvas.getByRole('group', { name: 'Your answer' });
    await expect(group).toHaveAttribute('aria-busy', 'true');
    const sending = canvas.getByText('Sending your answer');
    await expect(sending.closest('[role="status"]')).not.toBeNull();
    await expect(sending.closest('.cd-sr-only')).not.toBeNull();
    await expect(card.getBoundingClientRect().height).toBe(heldHeight);
    for (const button of answerButtons(canvasElement)) await expect(button).toHaveAttribute('aria-disabled', 'true');

    // spinner_on_the_chosen_answer: Deny, the side chosen, shows the busy spinner in place of its word
    // and chevron, and stays named "Deny"; Allow waits without one, its word and chevron still shown.
    await expect(deny).toHaveAttribute('aria-busy', 'true');
    await expect(deny).toHaveAccessibleName('Deny');
    await expect(deny.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    expectComputed(deny.querySelector('.cd-button__label') as HTMLElement, { opacity: '0' });
    expectComputed(deny.querySelector('.cd-button__chevron') as SVGElement, { visibility: 'hidden' });
    await expect(allow).not.toHaveAttribute('aria-busy');
    await expect(allow.querySelector('.cd-button__spinner')).toBeNull();
    expectComputed(allow.querySelector('.cd-button__label') as HTMLElement, { opacity: '1' });
    expectComputed(allow.querySelector('.cd-button__chevron') as SVGElement, { visibility: 'visible' });

    // Each steps to its busy colors, never dimmed, so its words or spinner still read in the card:
    // Allow's label turns text-secondary on its fill, and the red Deny keeps its color on its hover
    // fill. They step over the instant color transition, so wait for it to end.
    const BUSY_LABEL = 'rgba(250, 249, 245, 0.64)';
    await waitFor(() => {
      expectComputed(allow, { ...SECONDARY, color: BUSY_LABEL, opacity: '1' });
      expectComputed(deny, { ...DANGER, backgroundColor: 'rgba(220, 130, 144, 0.24)', opacity: '1' });
    });
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
    await expect(canvas.getByText('Sending your answer')).toBeInTheDocument();
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

export const AnswerLands: Story = {
  render: (args) => <LandingScreen {...args} />,
  parameters: { canvas: 'none', canvasNote: LANDS_NOTE },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this time' }));
    await expect(args.onAnswer).toHaveBeenCalledWith('allow_once');
    await waitFor(() => expect(canvas.getByText('Sending your answer')).toBeInTheDocument());
    // Allow ends handled, with one pulse.
    await expectLands(canvasElement, rivera.decisions.executed, { line: "You allowed this. It's done.", tone: 'handled', pulse: true });
  },
};

export const DenyLands: Story = {
  render: (args) => <LandingScreen {...args} />,
  parameters: { canvas: 'none', canvasNote: `${LANDS_NOTE} Here Deny lands.` },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Deny this time' }));
    await expect(args.onAnswer).toHaveBeenCalledWith('deny_once');
    // Deny ends refused, with one pulse.
    await expectLands(canvasElement, rivera.decisions.denied, { line: 'You denied this.', tone: 'refused', pulse: true });
  },
};

export const UnknownLands: Story = {
  render: (args) => <LandingScreen {...args} />,
  parameters: { canvas: 'none', canvasNote: `${LANDS_NOTE} Here the outcome isn't known yet.` },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this time' }));
    // An outcome not yet known keeps its held dot, and gets no pulse.
    await expectLands(canvasElement, rivera.decisions.unknown, {
      line: 'You allowed this. Still confirming whether it went through.',
      tone: 'held',
      pulse: false,
    });
  },
};

export const LateAnswerLands: Story = {
  render: (args) => <LandingScreen {...args} />,
  parameters: {
    canvas: 'none',
    canvasNote: `${LANDS_NOTE} Here the answer came too late: the request had expired, and its final line lands with that state's dot.`,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this time' }));
    await expectLands(canvasElement, rivera.decisions.expired, {
      line: 'This request expired before you answered. Nothing was done.',
      tone: 'info',
      pulse: true,
    });
  },
};

/** What Today puts under a card answered "Always": the rule it drafted, then Dismiss. */
const DRAFTED_AND_DISMISS = (
  <>
    <Notice tone="info" action={<Button variant="secondary">Review the rule</Button>}>
      Your answer also drafted a rule. Review it before it applies.
    </Notice>
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Button variant="ghost">Dismiss</Button>
    </div>
  </>
);

export const AlwaysLandsWithItsRule: Story = {
  args: refundArgs,
  render: (args) => <LandingScreen {...args} />,
  parameters: {
    canvas: 'none',
    canvasNote: `${LANDS_NOTE} Here Deny always lands on Dana's refund, and what Today puts under an answered card comes with it: the rule the answer drafted, then Dismiss, fading in and settling inside the card's easing height.`,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Deny' }));
    await userEvent.click(within(canvas.getByRole('menu', { name: 'Deny' })).getByRole('menuitem', { name: 'Always' }));
    await waitFor(() => expect(canvas.getByText('Sending your answer')).toBeInTheDocument());
    await expectLands(
      canvasElement,
      { ...heldRefund, state: 'denied' },
      { line: 'You denied this.', tone: 'refused', pulse: true, after: DRAFTED_AND_DISMISS },
    );
    // Under the card, in order: the rule, then Dismiss, each reachable once settled.
    const card = canvas.getByRole('article');
    const review = canvas.getByRole('button', { name: 'Review the rule' });
    const dismiss = canvas.getByRole('button', { name: 'Dismiss' });
    await expect(card.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(review.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(card.contains(review)).toBe(false);
    await expect(review.getBoundingClientRect().top).toBeGreaterThan(card.getBoundingClientRect().bottom);
  },
};

export const InertCardNeverLands: Story = {
  args: { inertAnswers: true },
  render: (args) => <LandingScreen {...args} />,
  parameters: {
    canvas: 'none',
    canvasNote: `${LANDS_NOTE} Here the card is a vision page's (inertAnswers): pressing an answer sends nothing, so when the page draws the request answered, it draws it at once, with nothing landing.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this time' }));
    await expect(args.onAnswer).not.toHaveBeenCalled();
    await expect(canvas.getByText(VISION_INERT_LINE)).toBeVisible();
    const landing = await land(canvasElement, { decision: rivera.decisions.executed }, settleMoments());
    // No outgoing layer, no settle, and the answered height from the first frame.
    await expect(landing.leaving).toBeNull();
    await expect(canvasElement.querySelector('.cd-approval-card--settling')).toBeNull();
    const height = canvasElement.querySelector('.cd-approval-card')?.getBoundingClientRect().height ?? 0;
    for (const frame of landing.frames) await expect(frame.height).toBeCloseTo(height, 0);
    await expectFinal(canvasElement, rivera.decisions.executed, "You allowed this. It's done.", 'handled');
  },
};

export const EnterLands: Story = {
  render: (args) => <LandingScreen {...args} />,
  parameters: {
    canvas: 'none',
    canvasNote: `${LANDS_NOTE} Here the answer is given from the keyboard, and focus is checked once it has settled.`,
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const card = canvas.getByRole('article');
    const [status] = within(card).getAllByRole('status');
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Allow this time' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAnswer).toHaveBeenCalledWith('allow_once');
    updateScreen(canvasElement, { decision: rivera.decisions.executed });
    await waitFor(() => expect(status).toHaveTextContent("You allowed this. It's done."));
    // Once every animation of the settle is done, and a frame after: focus is on the status line,
    // where the answers' focus goes, never on the page or the outgoing layer.
    await Promise.all(
      card.getAnimations({ subtree: true }).filter(settleMotion).map((animation) =>
        animationWithin(animation.finished.catch(() => undefined), animationLabel(animation)),
      ),
    );
    await waitFor(() => expect(card.querySelector('.cd-approval-card__layer--leaving'), 'cd-approval-card leaving layer is removed').toBeNull(), { timeout: ANIMATION_DEADLINE_MS });
    let frame = 0;
    try {
      await animationWithin(new Promise((resolve) => {
        frame = requestAnimationFrame(resolve);
      }), 'cd-approval-card focus frame');
    } finally {
      cancelAnimationFrame(frame);
    }
    await expect(status).toHaveFocus();
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
  parameters: { canvasNote: "Signed owner refusal reason board: the kernel's owner-only line takes the place of 'Waiting for your answer'." },
  play: async ({ canvasElement }) => {
    // rules_changed_has_no_answers
    await expectFinal(canvasElement, rivera.decisions.refused_at_execution, "Your rules changed before this ran, so it wasn't done.", 'refused');
  },
};

export const NotShared: Story = {
  args: {
    decision: { ...rivera.decisions.refused_at_execution, owner_plain: 'Not shared: their session ended when their contact changed' },
    waiting: 'Web chat, 4 min ago',
  },
  play: async ({ canvasElement, args }) => {
    await expectFinal(canvasElement, args.decision, 'Not shared: their session ended when their contact changed', 'refused');
  },
};

export const RefusedWithoutOwnerReason: Story = {
  args: { decision: { ...rivera.decisions.refused_at_execution, owner_plain: null }, waiting: 'Web chat, 4 min ago' },
  play: async ({ canvasElement, args }) => {
    await expectFinal(canvasElement, args.decision, "Your rules changed before this ran, so it wasn't done.", 'refused');
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

export const CancelledByBooking: Story = {
  args: { decision: rivera.cancelledByBooking, waiting: 'Web chat, 6 min ago' },
  parameters: {
    canvasNote:
      "No board shows a request a booking closed; the kernel's owner-only line takes the place of 'Waiting for your answer', as on the cancelled card.",
  },
  play: async ({ canvasElement }) => {
    // booking_closed_has_no_answers
    await expectFinal(canvasElement, rivera.cancelledByBooking, 'The visitor booked before you answered, so this request closed.', 'info');
    await expect(canvasElement).not.toHaveTextContent('The visitor cancelled before you answered.');
  },
};
