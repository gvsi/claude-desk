import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import type { EvMessage, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectSetOffName } from '../../test/expectSetOffName.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { Transcript } from '../Transcript/Transcript.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { WritingIndicator, type WritingIndicatorProps } from './WritingIndicator.tsx';

const dana = rivera.conversations.danaLive;
const danaFirstName = rivera.people.dana.name.split(' ')[0] ?? '';
const ownerFirstName = rivera.business.ownerName.split(' ')[0] ?? '';

/** A fixture part the stories need, or a thrown error naming what the fixture lost. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the Rivera fixture has no ${what}`);
  return value;
}

/** The opening of Dana's conversation: her question, Claude's quote and its receipts, her answer. */
const visitorTexts = dana.turns.flatMap((turn) => (turn.kind === 'visitor' ? [turn.text] : []));
const question = required(visitorTexts[0], 'first message');
const followUp = required(visitorTexts[1], 'second message');
const events: SseEvent[] = dana.turns.flatMap((turn) => (turn.kind === 'event' ? [turn.event] : []));
const quoteReceipt = required(
  events.find((event): event is StatusEvent => event.type === 'receipt'),
  'quote receipt',
);
const quoteReply = required(
  events.find((event): event is EvMessage => event.type === 'message'),
  'quote reply',
);
const receipts = [receiptFromEvent(quoteReceipt), receiptFromEvent(quoteReply)];

/** The owner's conversation with Dana while she types her next message, as on the signed board. */
function DanaTyping(props: WritingIndicatorProps) {
  return (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptRow>
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow
        margin={receipts.map((receipt) => (
          <MarginReceipt key={receipt.ledgerSeq} {...receipt} onOpenTrace={() => {}} />
        ))}
      >
        <ClaudeMessage blocks={quoteReply.blocks} language={quoteReply.language} ownerName={rivera.business.ownerName} />
      </TranscriptRow>
      <TranscriptRow>
        <VisitorMessage text={followUp} />
      </TranscriptRow>
      <TranscriptRow>
        <WritingIndicator {...props} />
      </TranscriptRow>
    </Transcript>
  );
}

const BUBBLE_NOTE =
  'N-Conv-Live writes "Dana is typing" as a line; this is the signed typing bubble that replaces it: three dots in her bubble\'s fill and radius, where her next message will appear.';

/** A phone: 390 px, with the 16 px gutter on each side. */
const PHONE = 390;

const meta = {
  title: 'Conversation/WritingIndicator',
  component: WritingIndicator,
  args: { language: 'en' },
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote: 'No board shows Claude writing; the indicator follows "Dana is typing" on N-Conv-Live, in the meta type the plan sets.',
  },
} satisfies Meta<typeof WritingIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * writing_state_shows_no_text: the indicator says who is writing and nothing more. No draft, no
 * partial reply: the canvas holds exactly the label.
 */
async function expectOnlyLabel(root: HTMLElement, status: HTMLElement, label: string) {
  await expect(status.textContent).toBe(label);
  await expect(root.textContent).toBe(label);
}

/** The bubble's parts: the live status, the drawn bubble and its three dots. */
function bubbleParts(status: HTMLElement) {
  const bubble = status.querySelector<HTMLElement>('.cd-writing-indicator__bubble');
  if (!bubble) throw new Error('no typing bubble in the status');
  const dots = [...bubble.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
  return { bubble, dots };
}

/**
 * typing_bubble_says_who_once: screen readers hear "{name} is typing" from the status, and the
 * drawn bubble is hidden from them, three empty dots and nothing else. The pulse is drawn by the
 * stylesheet alone, so the live region never changes while the dots pulse: over a whole loop of
 * the slowest dot nothing in it is added, removed or rewritten, and it is announced once.
 */
async function expectBubbleAnnouncedOnce(status: HTMLElement, label: string, name: string) {
  await expect(status.textContent).toBe(label);
  await expectSetOffName(status, name);
  const { bubble, dots } = bubbleParts(status);
  await expect(bubble).toHaveAttribute('aria-hidden', 'true');
  await expect(bubble.textContent).toBe('');
  await expect(dots).toHaveLength(3);

  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => changes.push(...records));
  observer.observe(status, { subtree: true, childList: true, characterData: true, attributes: true });
  const seconds = (value: string) => Number.parseFloat(value) * (value.endsWith('ms') ? 0.001 : 1);
  const last = getComputedStyle(dots[2] as HTMLElement);
  const loop = Math.max(seconds(last.animationDuration), 0) + Math.max(seconds(last.animationDelay), 0);
  await new Promise((resolve) => setTimeout(resolve, loop * 1000 + 100));
  observer.disconnect();
  await expect(changes).toEqual([]);
}

/** The bubble in the visitor bubble's fill and radius, one message line tall, with 6 px round dots. */
function expectBubbleLook(status: HTMLElement) {
  const { bubble, dots } = bubbleParts(status);
  expectComputed(bubble, { backgroundColor: 'rgba(250, 249, 245, 0.06)', borderTopLeftRadius: '12px', height: '37px' });
  for (const dot of dots) expectComputed(dot, { width: '6px', height: '6px', borderTopLeftRadius: '999px' });
}

/** The bubble ends where the visitor's bubbles end: on her side, where her next message appears. */
async function expectOnVisitorSide(root: HTMLElement, status: HTMLElement) {
  const { bubble } = bubbleParts(status);
  const theirs = [...root.querySelectorAll<HTMLElement>('.cd-visitor-message__bubble')];
  await expect(theirs.length).toBeGreaterThan(0);
  const box = bubble.getBoundingClientRect();
  for (const message of theirs) {
    await expect(Math.abs(box.right - message.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
  }
  const row = status.closest('.cd-transcript-row')?.getBoundingClientRect();
  if (!row) throw new Error('the typing bubble is not in a transcript row');
  await expect(box.left).toBeGreaterThan(row.left + row.width / 2);
}

export const Claude: Story = {
  play: async ({ canvas, canvasElement }) => {
    const status = canvas.getByRole('status');
    await expectOnlyLabel(canvasElement, status, 'Claude is writing');
    expectComputed(status, { fontFamily: /Hanken Grotesk/, fontSize: '13px', lineHeight: '18px' });
    // writing_indicator_animates: it pulses, so the reduced-motion check has something to stop.
    expectComputed(status, { animationName: /^(?!none$).+/, animationDuration: '1.6s', animationIterationCount: 'infinite' });
  },
};

export const ClaudeEs: Story = {
  args: { language: 'es' },
  play: async ({ canvas }) => {
    const status = canvas.getByRole('status');
    await expect(status.textContent).toBe('Claude está escribiendo');
    await expect(status).toHaveAttribute('lang', 'es');
  },
};

export const VisitorTyping: Story = {
  args: { who: danaFirstName },
  play: async ({ canvas, canvasElement }) => {
    const status = canvas.getByRole('status');
    await expectOnlyLabel(canvasElement, status, 'Dana is typing');
    // The name came from a person, so it is set off as their words; the rest is interface copy.
    await expectSetOffName(status, 'Dana');
  },
};

export const VisitorNamedClaude: Story = {
  args: { who: 'Claude' },
  parameters: {
    canvasNote: 'No board shows a visitor who calls themselves Claude; their name is set off as their own words, so the line never reads as Claude writing.',
  },
  play: async ({ canvas, canvasElement }) => {
    const status = canvas.getByRole('status');
    await expectOnlyLabel(canvasElement, status, 'Claude is typing');
    await expectSetOffName(status, 'Claude');
  },
};

export const DanaTypingBubble: Story = {
  args: { variant: 'bubble', who: danaFirstName },
  render: (args) => (
    <div style={{ maxWidth: 'var(--size-reading)' }}>
      <DanaTyping {...args} />
    </div>
  ),
  parameters: { canvas: 'N-Conv-Live', canvasNote: BUBBLE_NOTE },
  play: async ({ canvas, canvasElement }) => {
    // The owner's conversation at 1280: the bubble is in the log, on Dana's side.
    const log = canvas.getByRole('log', { name: `Conversation with ${dana.name}` });
    const status = canvas.getByRole('status');
    await expect(status.parentElement?.closest('[aria-live]')).toBe(log);
    expectBubbleLook(status);
    await expectOnVisitorSide(canvasElement, status);
    // The dots pulse one after another on the writing loop, motion-stagger apart.
    const { dots } = bubbleParts(status);
    for (const [index, dot] of dots.entries()) {
      expectComputed(dot, {
        animationName: /^(?!none$).+/,
        animationDuration: '1.6s',
        animationIterationCount: 'infinite',
        animationDelay: ['0s', '0.15s', '0.3s'][index] as string,
      });
    }
    await expectBubbleAnnouncedOnce(status, 'Dana is typing', 'Dana');
  },
};

export const DanaTypingBubblePhone: Story = {
  args: { variant: 'bubble', who: danaFirstName },
  render: (args) => (
    <div data-testid="phone" style={{ width: PHONE, padding: '0 var(--space-16)', boxSizing: 'border-box' }}>
      <DanaTyping {...args} />
    </div>
  ),
  parameters: { canvas: 'N-Conv-Live', canvasNote: `${BUBBLE_NOTE} On a phone, 390 px wide.` },
  play: async ({ canvas, canvasElement }) => {
    const phone = canvas.getByTestId('phone');
    const status = canvas.getByRole('status');
    expectBubbleLook(status);
    await expectOnVisitorSide(canvasElement, status);
    // Nothing reaches past the phone's line.
    await expect(phone.scrollWidth).toBeLessThanOrEqual(PHONE);
    await expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(phone.getBoundingClientRect().right - 16 + 0.5);
  },
};

export const ReducedMotion: Story = {
  args: { variant: 'bubble', who: danaFirstName },
  render: (args) => (
    <div style={{ width: 240 }}>
      <WritingIndicator {...args} />
    </div>
  ),
  parameters: {
    canvas: 'N-Conv-Live',
    canvasNote: `${BUBBLE_NOTE} Under reduced motion the dots stay still in text-secondary; Storybook shows the motion your system asks for, and the design system's browser tests render this story under reduced motion.`,
  },
  play: async ({ canvas }) => {
    const status = canvas.getByRole('status');
    await expect(status.textContent).toBe('Dana is typing');
    const { dots } = bubbleParts(status);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // typing_bubble_still_under_reduced_motion: no pulse, every dot in text-secondary.
      for (const dot of dots) expectComputed(dot, { animationName: 'none', backgroundColor: 'rgba(250, 249, 245, 0.64)' });
    } else {
      for (const dot of dots) expectComputed(dot, { animationName: /^(?!none$).+/ });
    }
  },
};

export const PersonSide: Story = {
  args: { variant: 'bubble', who: ownerFirstName, side: 'person', language: 'es' },
  render: (args) => (
    <div style={{ maxWidth: 'var(--size-reading)' }}>
      <Transcript label="Conversación con Rivera Plumbing">
        <TranscriptRow>
          <WritingIndicator {...args} />
        </TranscriptRow>
      </Transcript>
    </div>
  ),
  parameters: {
    canvas: 'N-Public-Handoff',
    canvasNote:
      "The board shows Maria joining, not Maria typing; after a take-over a visitor reading in Spanish sees her typing bubble on the left, where her words will appear, in the same bubble fill.",
  },
  play: async ({ canvas }) => {
    const status = canvas.getByRole('status');
    await expect(status).toHaveAttribute('lang', 'es');
    await expect(status.textContent).toBe('Maria está escribiendo');
    await expectSetOffName(status, 'Maria');
    expectBubbleLook(status);
    // On the left: the bubble starts where the row starts.
    const { bubble } = bubbleParts(status);
    const row = status.closest('.cd-transcript-row')?.getBoundingClientRect();
    if (!row) throw new Error('the typing bubble is not in a transcript row');
    await expect(Math.abs(bubble.getBoundingClientRect().left - row.left)).toBeLessThanOrEqual(0.5);
  },
};

export const BlankNameBubble: Story = {
  args: { variant: 'bubble', who: '  ' },
  parameters: {
    canvasNote: 'No board shows a typing bubble without a name; it is only for a named person, so with no name nothing shows, never "Claude is writing".',
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[role="status"]')).toBeNull();
    await expect(canvasElement.textContent).toBe('');
  },
};
