import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, waitFor } from 'storybook/test';

import type { EvMessage, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectSetOffName } from '../../test/expectSetOffName.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { PersonMessage } from '../PersonMessage/PersonMessage.tsx';
import { PublicShell } from '../PublicShell/PublicShell.tsx';
import { SystemLine } from '../SystemLine/SystemLine.tsx';
import { Transcript } from '../Transcript/Transcript.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { WritingIndicator, type WritingIndicatorProps } from './WritingIndicator.tsx';

const dana = rivera.conversations.danaLive;
const danaFirstName = rivera.people.dana.name.split(' ')[0] ?? '';
const ownerFirstName = rivera.business.ownerName.split(' ')[0] ?? '';

/** A fixture part the stories need, or a thrown error naming what the fixture lost. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the Turner fixture has no ${what}`);
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
  'The signed typing bubble: "Dana is typing" as three dots in her bubble\'s fill and radius, where her next message will appear.';

/** A phone: 390 px, with the 16 px gutter on each side. */
const PHONE = 390;

const meta = {
  title: 'Conversation/WritingIndicator',
  component: WritingIndicator,
  args: { language: 'en' },
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote: 'Claude writing is three clay dots that bounce gently on Claude’s side, where its reply will appear, with the words for screen readers only. A person’s typing line stays in the meta type.',
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
  await expectAnnouncedOnce(status, dots);
}

/** Over a whole loop of the slowest dot, nothing in the live line is added, removed or rewritten. */
async function expectAnnouncedOnce(status: HTMLElement, dots: readonly HTMLElement[]) {
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
  name: 'Claude writing dots',
  parameters: {
    docs: { description: { story: 'Three clay dots bounce gently on Claude’s side, 4 px over motion-dots, and stay still under reduced motion. “Claude is writing” is announced once, for screen readers only.' } },
  },
  play: async ({ canvas, canvasElement }) => {
    const status = canvas.getByRole('status');
    await expectOnlyLabel(canvasElement, status, 'Claude is writing');
    await expectClaudeDots(status, 'Claude is writing');
    const dots = [...status.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
    // The bounce animates the drawing, never the live region's words.
    for (const [index, dot] of dots.entries()) {
      expectComputed(dot, { backgroundColor: 'rgb(224, 137, 104)' });
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        expectComputed(dot, { animationName: 'none' });
      } else {
        expectComputed(dot, { animationName: 'cd-writing-bounce', animationDuration: '1.2s', animationDelay: `${index * 0.15}s`, animationIterationCount: 'infinite' });
      }
    }
    await expectAnnouncedOnce(status, dots);
  },
};

export const ClaudeEs: Story = {
  name: 'Claude writing dots in Spanish',
  args: { language: 'es' },
  play: async ({ canvas }) => {
    const status = canvas.getByRole('status');
    await expectClaudeDots(status, 'Claude está escribiendo');
    await expect(status).toHaveAttribute('lang', 'es');
  },
};

/** Claude's words are only for screen readers; the drawing takes exactly one reply line. */
async function expectClaudeDots(status: HTMLElement, label: string) {
  await expect(status).toHaveTextContent(label);
  await expect(status).toHaveClass('cd-writing-indicator--claude', 'cd-type-reply');
  const words = status.querySelector<HTMLElement>('.cd-sr-only');
  await expect(words).toHaveTextContent(label);
  const dots = status.querySelector<HTMLElement>('.cd-writing-indicator__dots') as HTMLElement;
  await expect(dots).toHaveAttribute('aria-hidden', 'true');
  await expect(dots.textContent).toBe('');
  await expect(dots.children).toHaveLength(3);
  expectComputed(status, { fontFamily: /Source Serif 4/, fontSize: '17px', lineHeight: '26px', animationName: 'none' });
  await expect(dots.getBoundingClientRect().height).toBe(Number.parseFloat(getComputedStyle(status).lineHeight));
  await expect(dots.getBoundingClientRect().left).toBe(status.getBoundingClientRect().left);
}

export const VisitorTyping: Story = {
  args: { who: danaFirstName },
  play: async ({ canvas, canvasElement }) => {
    const status = canvas.getByRole('status');
    await expectOnlyLabel(canvasElement, status, 'Dana is typing');
    expectComputed(status, { fontFamily: /Hanken Grotesk/, fontSize: '14px', lineHeight: '19px' });
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      expectComputed(status, { animationName: 'cd-writing-pulse', animationDuration: '1.6s' });
    }
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
  parameters: { canvas: 'N-Typing-Bubble-Run1', canvasNote: BUBBLE_NOTE },
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
  parameters: { canvas: 'N-Typing-Bubble-Run1', canvasNote: `${BUBBLE_NOTE} On a phone, 390 px wide.` },
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
    canvas: 'N-Typing-Bubble-Run1',
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

/** The owner, as the public page names him when he takes over. */
const OWNER = rivera.business.ownerName;
/** Mike's say once it lands: author `owner`, one `owner_said` block. */
const said = required(
  rivera.events.takeOver.find((event: SseEvent): event is EvMessage => event.type === 'message'),
  'owner message',
);

const PERSON_NOTE =
  'The signed owner-typing board (N-Typing-Owner-Busy): after Mike takes over, the visitor sees his initials and name, as on his messages, and three dots where his words will start, with no fill and no bubble.';

/** The event a story sends to deliver Mike's message in place of his typing. */
const MARIA_SENDS = 'cd-story:maria-sends';

/**
 * Dana's chat on Turner's public page after she asked for Mike: Mike joined and is typing, until
 * a story sends MARIA_SENDS and his message takes the typing's place.
 */
function MariaTakesOver({ language }: { language: 'en' | 'es' }) {
  const [sent, setSent] = useState(false);
  useEffect(() => {
    const send = () => setSent(true);
    window.addEventListener(MARIA_SENDS, send);
    return () => window.removeEventListener(MARIA_SENDS, send);
  }, []);
  return (
    <PublicShell
      brand={{
        name: rivera.publicDesk.en.business_name,
        tagline: rivera.publicDesk.en.desk_name,
        monogram: Array.from(rivera.publicDesk.en.business_name)[0] ?? '',
        field: rivera.publicDesk.en.brand.primary ?? '',
        ink: 'var(--text-on-brand)',
        inkSecondary: 'var(--text-on-brand-secondary)',
        statusHandled: 'var(--status-handled-on-brand)',
        accent: rivera.publicDesk.en.brand.accent ?? '',
      }}
      ownerName={OWNER}
      language={language}
      onAskForOwner={fn()}
      composer={<Composer variant="visitor" label="Message Turner Plumbing" placeholder="Message Turner Plumbing" maxLength={2000} onSend={fn()} />}
    >
      <Transcript label="Conversation with Turner Plumbing">
        <TranscriptRow>
          <VisitorMessage text={`I'd like to talk to ${OWNER}.`} />
        </TranscriptRow>
        <SystemLine text={`${OWNER} joined the chat`} initials="MT" />
        <TranscriptRow>
          {sent ? (
            <PersonMessage name={OWNER} blocks={said.blocks} language={said.language} />
          ) : (
            <WritingIndicator variant="person" who={OWNER} language={language} />
          )}
        </TranscriptRow>
      </Transcript>
    </PublicShell>
  );
}

/** The person form's parts: its live line, the initials, the name and the dots. */
function personParts(root: HTMLElement, label: string) {
  const status = [...root.querySelectorAll<HTMLElement>('[role="status"]')].find((el) => el.textContent === label);
  if (!status) throw new Error(`no status line reading "${label}"`);
  const frame = status.closest<HTMLElement>('.cd-writing-indicator');
  const avatar = frame?.querySelector<HTMLElement>('.cd-person-message__avatar');
  const name = status.querySelector<HTMLElement>('.cd-user-name');
  const dots = frame?.querySelector<HTMLElement>('.cd-writing-indicator__dots');
  if (!frame || !avatar || !name || !dots) throw new Error('the person form is missing a part');
  return { frame, status, avatar, name, dots, each: [...dots.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')] };
}

/**
 * person_typing_draws_their_frame: their initials, hidden from screen readers, and their name, as
 * on their messages, then three dots where their first line of words will start, with no fill and
 * no bubble. Screen readers hear "{name} is typing" from the line that names them.
 */
async function expectPersonTyping(root: HTMLElement, label: string, name: string) {
  const parts = personParts(root, label);
  await expectSetOffName(parts.status, name);
  await expect(parts.avatar).toHaveAttribute('aria-hidden', 'true');
  await expect(parts.avatar.textContent).toBe('MT');
  expectComputed(parts.avatar, { width: '28px', height: '28px', borderTopLeftRadius: '999px', backgroundColor: 'rgb(60, 57, 47)' });
  // The words after the name are for screen readers only; the name is what shows.
  const hidden = parts.status.querySelector<HTMLElement>('.cd-sr-only');
  await expect(hidden?.textContent?.trim()).toBe(label.slice(name.length).trim());
  expectComputed(parts.status, { fontSize: '14px', lineHeight: '19px' });
  // The dots: hidden, three 6 px dots in one message line, no fill or padding around them.
  await expect(parts.dots).toHaveAttribute('aria-hidden', 'true');
  await expect(parts.dots.textContent).toBe('');
  await expect(parts.each).toHaveLength(3);
  for (const dot of parts.each) expectComputed(dot, { width: '6px', height: '6px', borderTopLeftRadius: '999px' });
  for (const el of [parts.frame, parts.dots]) expectComputed(el, { backgroundColor: 'rgba(0, 0, 0, 0)', paddingLeft: '0px' });
  expectComputed(parts.dots, { height: '21px', marginTop: '4px' });
  // The dots start where the name starts, under it, and the frame starts at the row's left edge.
  const nameBox = parts.name.getBoundingClientRect();
  const first = parts.each[0]?.getBoundingClientRect();
  if (!first) throw new Error('no first dot');
  await expect(Math.abs(first.left - nameBox.left)).toBeLessThanOrEqual(0.5);
  const row = parts.frame.closest('.cd-transcript-row')?.getBoundingClientRect();
  if (!row) throw new Error('the person form is not in a transcript row');
  await expect(Math.abs(parts.avatar.getBoundingClientRect().left - row.left)).toBeLessThanOrEqual(0.5);
  return parts;
}

export const MariaTyping: Story = {
  args: { variant: 'person', who: OWNER },
  render: () => <MariaTakesOver language="en" />,
  parameters: { layout: 'fullscreen', canvas: 'N-Typing-Owner-Busy', canvasNote: PERSON_NOTE },
  play: async ({ canvasElement }) => {
    // The public page at 1280: in the log, under "Mike Turner joined the chat".
    await expect(document.documentElement.clientWidth).toBe(1280);
    const parts = await expectPersonTyping(canvasElement, `${OWNER} is typing`, OWNER);
    await expect(parts.frame.closest('[role="log"]')).not.toBeNull();
    // The dots pulse one after another on the writing loop, motion-stagger apart.
    for (const [index, dot] of parts.each.entries()) {
      expectComputed(dot, {
        animationName: /^(?!none$).+/,
        animationDuration: '1.6s',
        animationIterationCount: 'infinite',
        animationDelay: ['0s', '0.15s', '0.3s'][index] as string,
      });
    }
    await expectAnnouncedOnce(parts.status, parts.each);
  },
};

export const MariaTypingPhone: Story = {
  args: { variant: 'person', who: OWNER },
  render: () => (
    <div data-testid="phone" style={{ width: PHONE }}>
      <MariaTakesOver language="en" />
    </div>
  ),
  parameters: { layout: 'fullscreen', canvas: 'N-Typing-Owner-Busy', canvasNote: `${PERSON_NOTE} On a phone, 390 px wide.` },
  play: async ({ canvas, canvasElement }) => {
    const phone = canvas.getByTestId('phone');
    const parts = await expectPersonTyping(canvasElement, `${OWNER} is typing`, OWNER);
    // Nothing reaches past the phone's width, and the frame keeps its 16 px gutter.
    await expect(phone.scrollWidth).toBeLessThanOrEqual(PHONE);
    await expect(parts.avatar.getBoundingClientRect().left - phone.getBoundingClientRect().left).toBeGreaterThanOrEqual(16 - 0.5);
  },
};

export const MariaTypingEs: Story = {
  args: { variant: 'person', who: OWNER, language: 'es' },
  render: () => <MariaTakesOver language="es" />,
  parameters: { layout: 'fullscreen', canvas: 'N-Typing-Owner-Busy', canvasNote: `${PERSON_NOTE} For a visitor reading in Spanish.` },
  play: async ({ canvasElement }) => {
    const parts = await expectPersonTyping(canvasElement, `${OWNER} está escribiendo`, OWNER);
    await expect(parts.status).toHaveAttribute('lang', 'es');
  },
};

export const MariaMessageLands: Story = {
  args: { variant: 'person', who: OWNER },
  render: () => <MariaTakesOver language="en" />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Typing-Owner-Busy',
    canvasNote: `${PERSON_NOTE} Her message then takes the typing's place, from the same left edge, so nothing jumps.`,
  },
  play: async ({ canvasElement }) => {
    const parts = await expectPersonTyping(canvasElement, `${OWNER} is typing`, OWNER);
    const before = {
      avatar: parts.avatar.getBoundingClientRect(),
      name: parts.name.getBoundingClientRect(),
      dots: parts.dots.getBoundingClientRect(),
    };

    // person_message_replaces_typing_in_place: her message lands where the typing was.
    window.dispatchEvent(new Event(MARIA_SENDS));
    const words = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>('.cd-person-message__text');
      if (!found) throw new Error('her message has not landed');
      return found;
    });
    await expect(canvasElement.querySelector('.cd-writing-indicator')).toBeNull();
    const message = words.closest<HTMLElement>('.cd-person-message');
    const avatar = message?.querySelector<HTMLElement>('.cd-person-message__avatar');
    const name = message?.querySelector<HTMLElement>('.cd-person-message__name');
    if (!avatar || !name) throw new Error('her message has no initials or name');
    const range = document.createRange();
    range.selectNodeContents(words);
    const firstLine = range.getClientRects()[0];
    if (!firstLine) throw new Error('her message has no line');
    // The initials and the name don't move, and her first line starts where the dots were.
    const same = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(0.5);
    await same(avatar.getBoundingClientRect().left, before.avatar.left);
    await same(avatar.getBoundingClientRect().top, before.avatar.top);
    await same(name.getBoundingClientRect().left, before.name.left);
    await same(name.getBoundingClientRect().top, before.name.top);
    await same(firstLine.left, before.dots.left);
    await same(words.getBoundingClientRect().top, before.dots.top);
  },
};

export const PersonReducedMotion: Story = {
  args: { variant: 'person', who: OWNER },
  render: (args) => (
    <div style={{ maxWidth: 'var(--size-reading)' }}>
      <Transcript label="Conversation with Turner Plumbing">
        <TranscriptRow>
          <WritingIndicator {...args} />
        </TranscriptRow>
      </Transcript>
    </div>
  ),
  parameters: {
    canvas: 'N-Typing-Owner-Busy',
    canvasNote: `${PERSON_NOTE} Under reduced motion the dots stay still in text-secondary; Storybook shows the motion your system asks for, and the design system's browser tests render this story under reduced motion.`,
  },
  play: async ({ canvasElement }) => {
    const parts = await expectPersonTyping(canvasElement, `${OWNER} is typing`, OWNER);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // person_typing_still_under_reduced_motion: no pulse, every dot in text-secondary.
      for (const dot of parts.each) expectComputed(dot, { animationName: 'none', backgroundColor: 'rgba(250, 249, 245, 0.64)' });
    } else {
      for (const dot of parts.each) expectComputed(dot, { animationName: /^(?!none$).+/ });
    }
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
