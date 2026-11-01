import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { EvMessage, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { executedLine } from '../../fixtures/receipts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { AgentMessage } from '../AgentMessage/AgentMessage.tsx';
import { Button } from '../Button/Button.tsx';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { MarginNote } from '../MarginNote/MarginNote.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { Notice } from '../Notice/Notice.tsx';
import { Transcript } from '../Transcript/Transcript.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { TranscriptHeader, TranscriptRow } from './TranscriptRow.tsx';

const dana = rivera.conversations.danaLive;
const ownerName = rivera.business.ownerName;

/** A fixture part the stories need, or a thrown error naming what the fixture lost. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the Turner fixture has no ${what}`);
  return value;
}

/** Dana's stored turns, in order: what she typed, the quote's receipt and Claude's checked reply. */
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

/** Alex Kim's assistant's first request, and the receipt for the quote it asked for. */
const alex = rivera.conversations.alexAgent;
const agentRequest = required(
  alex.turns.flatMap((turn) => (turn.kind === 'agent' ? [turn.text] : []))[0],
  'agent request',
);
const agentReceipt = receiptFromEvent(
  required(
    alex.turns.flatMap((turn) => (turn.kind === 'event' && turn.event.type === 'receipt' ? [turn.event] : []))[0],
    'agent quote receipt',
  ),
);
const LEAD_SAVED = 'Name and phone saved to Customers as a new lead.';
/** The public page's line for a message that didn't send, and its next step. */
const NOT_SENT = "That didn't send. Your message is still here.";
const TRY_AGAIN = 'Try again';

/**
 * The opening of Dana's conversation as the owner reads it: her question, then the reply and its
 * receipts. With `live`, the reply arrives live, as on an open page.
 */
function DanaOpening({ onOpenTrace, live = false }: { onOpenTrace: (ledgerSeq: number) => void; live?: boolean }) {
  return (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptHeader
        left="Today at 12:04, web chat from the Turner Plumbing page"
        right="Notes from the checks. Select one for the full trace."
      />
      <TranscriptRow>
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow
        live={live}
        margin={receipts.map((receipt) => (
          <MarginReceipt key={receipt.ledgerSeq} {...receipt} onOpenTrace={onOpenTrace} />
        ))}
      >
        <ClaudeMessage blocks={quoteReply.blocks} language={quoteReply.language} ownerName={ownerName} />
      </TranscriptRow>
    </Transcript>
  );
}

/** The parts of the one row in the story that holds `selector`. */
function rowParts(root: HTMLElement, selector: string) {
  const inner = root.querySelector<HTMLElement>(selector);
  const row = inner?.closest<HTMLElement>('.cd-transcript-row');
  const main = row?.querySelector<HTMLElement>(':scope > .cd-transcript-row__main');
  const margin = row?.querySelector<HTMLElement>(':scope > .cd-transcript-row__margin');
  if (!inner || !row || !main || !margin) throw new Error(`no row with a margin holds ${selector}`);
  return { inner, row, main, margin };
}

const meta = {
  title: 'Conversation/TranscriptRow',
  component: TranscriptRow,
  args: { children: null },
  // The owner app's content column.
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 'var(--size-content)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof TranscriptRow>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * receipts_attach_under_message: the row is the reading column, and what is attached sits
 * `space-8` under the message, on the message's side: from its left edge under Claude's and the
 * owner's words, and ending at its right edge, no wider than a bubble (85%), under a visitor's or
 * an agent's bubble on the right. `selector` is the message element it lines up with. Nothing
 * overflows.
 */
async function expectAttachedUnder(root: HTMLElement, selector: string, side: 'start' | 'end', readingWidth: number) {
  const { inner, row, main, margin } = rowParts(root, selector);
  const rowBox = row.getBoundingClientRect();
  const mainBox = main.getBoundingClientRect();
  const marginBox = margin.getBoundingClientRect();
  const message = inner.getBoundingClientRect();
  await expect(rowBox.width).toBe(readingWidth);
  await expect(mainBox.width).toBe(rowBox.width);
  await expect(marginBox.top - mainBox.bottom).toBe(8);
  if (side === 'start') {
    await expect(marginBox.left).toBe(message.left);
  } else {
    await expect(marginBox.right).toBe(message.right);
    await expect(marginBox.width).toBeLessThanOrEqual(rowBox.width * 0.85 + 0.5);
  }
  for (const el of [row, main, margin]) await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
}

export const ReplyWithReceipts: Story = {
  render: () => <DanaOpening onOpenTrace={fn()} />,
  parameters: {
    canvasNote:
      "The board's quote is in Claude's prose and its notes sit in a margin column; here the quote is a card, and the kernel's lines for the quote and its reply check are attached under the reply, at every width.",
  },
  play: async ({ canvas, canvasElement }) => {
    const log = canvas.getByRole('log', { name: `Conversation with ${dana.name}` });
    const shown = [...canvasElement.querySelectorAll<HTMLElement>('.cd-margin-receipt')];
    await expect(shown).toHaveLength(receipts.length);
    for (const [index, receipt] of shown.entries()) {
      await expect(receipt).toHaveAccessibleName(`${receipts[index]?.plain} Open the full trace.`);
    }

    // receipts_are_announced: every receipt is inside the transcript's live log.
    for (const receipt of shown) await expect(receipt.parentElement?.closest('[aria-live]')).toBe(log);

    // In the owner's 960 px content column, the row is still the 640 px reading column, and the
    // receipts are under the reply, one above the other.
    await expect(log.getBoundingClientRect().width).toBe(960);
    await expectAttachedUnder(canvasElement, '.cd-claude-message__prose', 'start', 640);
    const [first, second] = shown as [HTMLElement, HTMLElement];
    await expect(second.getBoundingClientRect().top).toBeGreaterThan(first.getBoundingClientRect().bottom);
    await expect(second.getBoundingClientRect().left).toBe(first.getBoundingClientRect().left);

    // The header's two captions stack in the same column, the receipts' caption second.
    const header = canvasElement.querySelector<HTMLElement>('.cd-transcript-header');
    if (!header) throw new Error('no transcript header');
    const [left, right] = [...header.children] as HTMLElement[];
    const reply = rowParts(canvasElement, '.cd-claude-message__prose').row.getBoundingClientRect();
    await expect(left?.getBoundingClientRect().left).toBe(reply.left);
    await expect(right?.getBoundingClientRect().left).toBe(reply.left);
    await expect(right?.getBoundingClientRect().top).toBeGreaterThanOrEqual(left?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY);
    await expect(right).toHaveTextContent('Notes from the checks. Select one for the full trace.');
  },
};

/** `motion-stagger` as the page reads it, in ms. */
function staggerMs(): number {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--motion-stagger').trim();
  if (!/^\d+ms$/.test(token)) throw new Error(`motion-stagger reads "${token}", not a time in ms`);
  return Number.parseInt(token, 10);
}

/** An animation delay of `ms`, as the browser computes it. */
const delayOf = (ms: number) => `${ms / 1000}s`;

/** The look of the moment a reply lands: `motion-base`, on `motion-ease-emphasis`, held at its start until its delay. */
const LANDING = { animationDuration: '0.2s', animationTimingFunction: 'cubic-bezier(0.165, 0.84, 0.44, 1)', animationFillMode: 'backwards', animationIterationCount: '1' };

/** Nothing under `root` moves. */
function expectStill(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('*')) expectComputed(el, { animationName: 'none' });
}

export const LiveReply: Story = {
  render: () => <DanaOpening onOpenTrace={fn()} live />,
  parameters: {
    canvasNote:
      "Boards are still frames. Here Claude's reply arrives live: it rises into place, and its receipts land one by one, motion-stagger apart, with the kernel's lines unchanged. Storybook shows the motion your system asks for; the design system's browser tests render this story under reduced motion.",
  },
  play: async ({ canvas, canvasElement }) => {
    const log = canvas.getByRole('log', { name: `Conversation with ${dana.name}` });
    const { row, main, margin } = rowParts(canvasElement, '.cd-claude-message__prose');
    const lines = [...margin.children] as HTMLElement[];
    // The motion is visual only: the same lines, in the same order, inside the live log.
    await expect(lines).toHaveLength(receipts.length);
    for (const [index, line] of lines.entries()) {
      await expect(line).toHaveAccessibleName(`${receipts[index]?.plain} Open the full trace.`);
      await expect(line.closest('[aria-live]')).toBe(log);
    }
    const asked = canvasElement.querySelector<HTMLElement>('.cd-visitor-message')?.closest<HTMLElement>('.cd-transcript-row');
    if (!asked) throw new Error("no row holds Dana's question");

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // live_reply_still_under_reduced_motion: the reply and its receipts show at once.
      expectStill(row);
      return;
    }
    // live_reply_lands: the reply rises in at once, and each receipt lands one motion-stagger after
    // the one before, its dot growing with its line.
    expectComputed(main, { ...LANDING, animationName: /^(?!none$).+/, animationDelay: '0s' });
    const stagger = staggerMs();
    await expect(stagger).toBe(150);
    for (const [index, line] of lines.entries()) {
      const delay = delayOf(stagger * (index + 1));
      expectComputed(line, { ...LANDING, animationName: /^(?!none$).+/, animationDelay: delay });
      const dot = line.querySelector<HTMLElement>('.cd-status-dot');
      if (!dot) throw new Error('no dot on a receipt');
      expectComputed(dot, { ...LANDING, animationName: /^(?!none$).+/, animationDelay: delay });
    }
    // A row that didn't arrive live (Dana's question, read from the conversation) is still.
    expectStill(asked);
  },
};

export const BubbleWithNote: Story = {
  render: () => (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptRow margin={<MarginNote text={LEAD_SAVED} onOpen={fn()} />}>
        <VisitorMessage text={followUp} />
      </TranscriptRow>
      <TranscriptRow margin={<MarginReceipt {...agentReceipt} onOpenTrace={fn()} />}>
        <AgentMessage agentName={alex.name} signed title="Quote the service call deposit" meta="Request 1" text={agentRequest} />
      </TranscriptRow>
    </Transcript>
  ),
  parameters: {
    canvasNote:
      "Dana's second message and Alex Kim's assistant's request are the fixture's; the board's message under the note also gave her name and phone, and its notes sit in a margin column.",
  },
  play: async ({ canvasElement }) => {
    // Under a bubble on the right, what is attached sits on the right too, ending where it ends.
    await expectAttachedUnder(canvasElement, '.cd-visitor-message__bubble', 'end', 640);
    await expectAttachedUnder(canvasElement, '.cd-agent-message__bubble', 'end', 640);
    for (const line of canvasElement.querySelectorAll<HTMLElement>('.cd-margin-line')) {
      const bubble = line.closest('.cd-transcript-row')?.querySelector<HTMLElement>('.cd-visitor-message__bubble, .cd-agent-message__bubble');
      await expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(bubble?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY);
    }
  },
};

export const Stacked: Story = {
  render: () => <DanaOpening onOpenTrace={fn()} />,
  decorators: [
    (Story) => (
      <div style={{ width: 600, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvasNote: 'The board is wide; in a column narrower than the reading width, as on a phone or the public page, the same rows take the full width, with the receipts attached under each message.',
  },
  play: async ({ canvas, canvasElement }) => {
    // stacks_when_narrow: the same layout in a narrower column, where the row takes its full width.
    await expectAttachedUnder(canvasElement, '.cd-claude-message__prose', 'start', 600);
    const log = canvas.getByRole('log');
    await expect(log.scrollWidth).toBeLessThanOrEqual(log.clientWidth);
  },
};

export const NothingAttached: Story = {
  render: () => (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptRow margin={[]}>
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow margin={[null, false]}>
        <VisitorMessage text={followUp} />
      </TranscriptRow>
    </Transcript>
  ),
  parameters: {
    canvasNote: "The boards show receipts under most messages; these are Dana's two messages before any receipt arrives, with an empty list attached.",
  },
  play: async ({ canvasElement }) => {
    // An empty list of receipts attaches nothing: no empty block, and no gap under the message.
    await expect(canvasElement.querySelectorAll('.cd-transcript-row')).toHaveLength(2);
    await expect(canvasElement.querySelector('.cd-transcript-row__margin')).toBeNull();
    for (const row of canvasElement.querySelectorAll<HTMLElement>('.cd-transcript-row')) {
      const main = row.querySelector<HTMLElement>(':scope > .cd-transcript-row__main');
      await expect(main?.getBoundingClientRect().height).toBe(row.getBoundingClientRect().height);
    }
  },
};

/** Dana's question that didn't send: the page's error line attached under it, with "Try again". */
function DanaNotSent({ onRetry }: { onRetry: () => void }) {
  return (
    <Transcript label={`Conversation with ${dana.name}`}>
      <TranscriptRow
        margin={
          <Notice
            tone="error"
            action={
              <Button variant="ghost" onClick={onRetry}>
                {TRY_AGAIN}
              </Button>
            }
          >
            {NOT_SENT}
          </Notice>
        }
      >
        <VisitorMessage text={question} />
      </TranscriptRow>
    </Transcript>
  );
}

/** Where `el`'s text is drawn, rather than the box it sits in. */
function textBox(el: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect();
}

/**
 * A message that didn't send keeps the rule for what is attached under a bubble on the right: the
 * error line ends where the bubble ends, and so does its next step, under the line rather than
 * beside it, at every width. The line is only as wide as its words, so nothing attached is wider
 * than its lines.
 */
async function expectNotSentUnderTheBubble(root: HTMLElement, readingWidth: number) {
  await expectAttachedUnder(root, '.cd-visitor-message__bubble', 'end', readingWidth);
  const { inner, margin } = rowParts(root, '.cd-visitor-message__bubble');
  const bubble = inner.getBoundingClientRect();
  const alert = within(root).getByRole('alert');
  const words = textBox(within(alert).getByText(NOT_SENT, { exact: true }));
  const button = within(alert).getByRole('button', { name: TRY_AGAIN }).getBoundingClientRect();
  await expect(Math.abs(words.right - bubble.right)).toBeLessThanOrEqual(1);
  await expect(Math.abs(button.right - bubble.right)).toBeLessThanOrEqual(1);
  await expect(button.top).toBeGreaterThanOrEqual(words.bottom);
  // The dot starts the line at the margin's left: the margin is as wide as the line.
  const dot = alert.querySelector<HTMLElement>('.cd-status-dot')?.getBoundingClientRect();
  await expect(dot?.left).toBe(margin.getBoundingClientRect().left);
  // "Try again" keeps the control height, a target a finger can hit.
  await expect(button.height).toBe(32);
}

export const BubbleNotSent: Story = {
  render: () => <DanaNotSent onRetry={fn()} />,
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board draws a visitor's message that didn't send. Here the public page's error Notice and its ghost Try again are attached under Dana's bubble by N-Conv-Run1's rule for a bubble on the right: they end where the bubble ends, the button under the line.",
  },
  play: async ({ canvasElement }) => {
    await expectNotSentUnderTheBubble(canvasElement, 640);
  },
};

export const BubbleNotSentNarrow: Story = {
  render: () => <DanaNotSent onRetry={fn()} />,
  decorators: [
    (Story) => (
      <div style={{ width: 358, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board draws a visitor's message that didn't send. On a phone's column (358 px, a 390 px window's), the line and Try again still end where Dana's bubble ends, as they do in the reading column.",
  },
  play: async ({ canvasElement }) => {
    await expectNotSentUnderTheBubble(canvasElement, 358);
  },
};

/**
 * A Spanish visitor's question that didn't send, under the quote receipt its turn settled there.
 * The receipt is the wider line, as the kernel's Spanish lines often are.
 */
const PREGUNTA = '¿Cuánto cuesta destapar un desagüe?';
const NO_SE_ENVIO = 'No se envió. Tu mensaje sigue aquí.';
const INTENTAR = 'Intentar de nuevo';
const COTIZADO = executedLine('native.quote', 'es', ownerName);

function NotSentUnderAReceipt({ onRetry }: { onRetry: () => void }) {
  return (
    <div lang="es">
      <Transcript label="Conversación con Turner Plumbing">
        <TranscriptRow
          margin={[
            <MarginReceipt key="quote" source={{ kind: 'decision', state: 'executed' }} plain={COTIZADO} ledgerSeq={41} />,
            <Notice
              key="failed"
              tone="error"
              action={
                <Button variant="ghost" onClick={onRetry}>
                  {INTENTAR}
                </Button>
              }
            >
              {NO_SE_ENVIO}
            </Notice>,
          ]}
        >
          <VisitorMessage text={PREGUNTA} />
        </TranscriptRow>
      </Transcript>
    </div>
  );
}

export const BubbleNotSentUnderAReceipt: Story = {
  render: () => <NotSentUnderAReceipt onRetry={fn()} />,
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board draws a visitor's message that didn't send. Here a quote receipt wider than the error line is attached above it, in Spanish: the line starts with the receipt, so their dots stay in one column, and Intentar de nuevo still ends where the bubble ends.",
  },
  play: async ({ canvasElement }) => {
    await expectAttachedUnder(canvasElement, '.cd-visitor-message__bubble', 'end', 640);
    const { inner } = rowParts(canvasElement, '.cd-visitor-message__bubble');
    const bubble = inner.getBoundingClientRect();
    const receipt = within(canvasElement).getByText(COTIZADO, { exact: true });
    const alert = within(canvasElement).getByRole('alert');
    const words = within(alert).getByText(NO_SE_ENVIO, { exact: true });
    // The receipt is the widest line attached, so it is the one that ends at the bubble.
    await expect(textBox(receipt).width).toBeGreaterThan(textBox(words).width);
    await expect(Math.abs(textBox(receipt).right - bubble.right)).toBeLessThanOrEqual(1);
    // The error line starts with the receipt: one column of dots.
    const receiptDot = receipt.closest('.cd-margin-line')?.querySelector<HTMLElement>('.cd-status-dot')?.getBoundingClientRect();
    const noticeDot = alert.querySelector<HTMLElement>('.cd-status-dot')?.getBoundingClientRect();
    await expect(noticeDot?.left).toBe(receiptDot?.left);
    // Its next step, under it, still ends where the bubble ends.
    const button = within(alert).getByRole('button', { name: INTENTAR }).getBoundingClientRect();
    await expect(Math.abs(button.right - bubble.right)).toBeLessThanOrEqual(1);
    await expect(button.top).toBeGreaterThanOrEqual(textBox(words).bottom);
  },
};
