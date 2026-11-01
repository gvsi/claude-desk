import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import type { EvMessage, SseEvent } from '../../../api/contracts.ts';
import { proseBlock, rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ClaudeMessage } from './ClaudeMessage.tsx';

/** The one message in a stored SSE sequence. */
function messageIn(events: readonly SseEvent[]): EvMessage {
  const found = events.filter((event): event is EvMessage => event.type === 'message');
  if (found.length !== 1) throw new Error(`expected one message event, found ${found.length}`);
  return found[0] as EvMessage;
}

const quote = messageIn(rivera.events.quoteTurn);
const quoteEs = messageIn(rivera.events.quoteTurnEs);
const paid = messageIn(rivera.events.paymentConfirmed);
/** Claude asking which open time works: prose that claims nothing done, in the reply style. */
const bookingAsk = rivera.blocks.prose.bookingAsk.en;
/** A reply in Markdown: a bold lead-in on each item of a list, between two plain paragraphs. */
const MARKDOWN_ITEMS = ['Drain clearing, for kitchen and bathroom sinks', 'Water heaters, repaired or replaced'];
const markdown = proseBlock(
  `Here is what Rivera Plumbing can help with:\n\n- **Drain clearing**, for kitchen and bathroom sinks\n- **Water heaters**, repaired or replaced\n\nWhich one is closest to what you need?`,
);

/** A plain reply of two short paragraphs, a blank line between them and no Markdown marks. */
const TWO_PARAGRAPHS = [
  'Maria clears kitchen and bathroom drains, and she repairs and replaces water heaters.',
  "Tell me a little about what's happening, and I can look for a time she's free to come by.",
];
const twoParagraphs = proseBlock(TWO_PARAGRAPHS.join('\n\n'));

const meta = {
  title: 'Conversation/ClaudeMessage',
  component: ClaudeMessage,
  args: { blocks: [bookingAsk], language: 'en', ownerName: rivera.business.ownerName },
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof ClaudeMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ProseOnly: Story = {
  parameters: {
    canvasNote:
      "The board's replies carry their facts in prose; this is the fixture's prose on its own, Claude asking which open time works, without the booking options card that follows it.",
  },
  play: async ({ canvas, canvasElement }) => {
    // prose_is_serif_people_are_sans: Claude speaks in serif, with no bubble and no avatar.
    const prose = canvas.getByText(bookingAsk.text);
    expectComputed(prose, {
      fontFamily: /Source Serif 4/,
      fontSize: '15px',
      lineHeight: '23px',
      fontWeight: '360',
      color: 'rgba(250, 249, 245, 0.92)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      paddingLeft: '0px',
    });
    expectComputed(canvasElement.querySelector('.cd-claude-message') as Element, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    await expect(canvasElement.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  },
};

export const WithQuoteCard: Story = {
  args: { blocks: quote.blocks, language: quote.language },
  parameters: {
    canvasNote:
      "The board states the price in Claude's prose; a reply check blocks prices in prose, so the price arrives as the quote card under it.",
  },
  play: async ({ canvas, canvasElement }) => {
    // claude_message_renders_only_blocks: one serif paragraph per prose block, one card per card
    // block, in the blocks' order, and nothing else.
    const root = canvasElement.querySelector('.cd-claude-message') as HTMLElement;
    const parts = [...root.children];
    await expect(parts).toHaveLength(quote.blocks.length);
    for (const [index, block] of quote.blocks.entries()) {
      const part = parts[index] as HTMLElement;
      if (block.kind === 'prose') {
        await expect(part).toHaveClass('cd-claude-message__prose', 'cd-type-reply');
        await expect(part.textContent).toBe(block.text);
      } else {
        await expect(part).toHaveClass('cd-reply-card');
        await expect(part.querySelectorAll('.cd-card')).toHaveLength(1);
      }
    }
    await expect(canvasElement.querySelectorAll('.cd-claude-message__prose')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('.cd-reply-card')).toHaveLength(1);
    await expect(canvas.getByRole('article', { name: 'Quote' })).toBeVisible();
    // The card's words are the block's: its title and lines, under the fixed label.
    await expect(root.textContent).toBe(`${quote.blocks[0]?.text}Quote${quote.blocks[1]?.text.replaceAll('\n', '')}`);
  },
};

export const Spanish: Story = {
  args: { blocks: quoteEs.blocks, language: quoteEs.language },
  parameters: {
    canvas: 'N-Conv-TakeOver',
    canvasNote: "The board opens after Claude's earlier quote to Lucía, summarised in one line; this is that quote as she read it, in Spanish.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector('.cd-claude-message')).toHaveAttribute('lang', 'es');
    await expect(canvas.getByText(rivera.blocks.prose.quoteIntro.es.text)).toBeVisible();
    // The card's chrome follows the event's language.
    await expect(canvas.getByRole('article', { name: 'Presupuesto' })).toBeVisible();
  },
};

export const PaymentConfirmed: Story = {
  args: { blocks: paid.blocks, language: paid.language },
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote:
      "The board shows the paid deposit as a receipt row; the kernel's own message (author desk) carries the payment_confirmed card, shown like Claude's.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(paid.author).toBe('desk');
    await expect(canvas.getByRole('article', { name: 'Paid' })).toBeVisible();
    await expect(canvas.getByText('Test payment, no money moves')).toBeVisible();
    await expect(canvasElement.querySelectorAll('.cd-claude-message__prose')).toHaveLength(0);
  },
};

export const Markdown: Story = {
  args: { blocks: [markdown] },
  parameters: {
    canvas: 'none',
    canvasNote:
      'N-MD-01-Reply-Markdown (signed 2026-11-01, not yet a reference board) draws Markdown in a reply; this is a visitor reply in the same type, with bold, a list and paragraphs. Nearest reference board: N-Conv-Run1.',
  },
  play: async ({ canvasElement }) => {
    // Claude's prose renders as Markdown in the reply type: bold as bold, the list as a list, and
    // none of the marks left over.
    const prose = canvasElement.querySelector('.cd-claude-message__prose') as HTMLElement;
    expectComputed(prose, { fontFamily: /Source Serif 4/, fontSize: '15px', lineHeight: '23px', fontWeight: '360' });
    await expect([...prose.querySelectorAll('strong')].map((el) => el.textContent)).toEqual(['Drain clearing', 'Water heaters']);
    await expect([...prose.querySelectorAll('li')].map((el) => el.textContent)).toEqual(MARKDOWN_ITEMS);
    await expect(prose.querySelectorAll('p')).toHaveLength(2);
    await expect(prose.textContent).not.toMatch(/\*|^- /m);
  },
};

export const TwoParagraphs: Story = {
  args: { blocks: [twoParagraphs] },
  parameters: {
    canvasNote:
      "The board's replies are one paragraph each; this is a plain reply of two. A blank line in a plain reply is a paragraph break, at the boards' 10 px gap between paragraphs (owner decision, 2026-11-01).",
  },
  play: async ({ canvasElement }) => {
    const prose = canvasElement.querySelector('.cd-claude-message__prose') as HTMLElement;
    const paragraphs = [...prose.querySelectorAll('p')];
    await expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual(TWO_PARAGRAPHS);
    // The two paragraphs sit space-10 apart, the gap the boards draw between a reply's paragraphs.
    const gap = Number.parseFloat(getComputedStyle(prose).getPropertyValue('--space-10'));
    await expect(gap).toBe(10);
    const first = paragraphs[0] as HTMLElement;
    const second = paragraphs[1] as HTMLElement;
    await expect(second.getBoundingClientRect().top - first.getBoundingClientRect().bottom).toBe(gap);
    expectComputed(second, { marginTop: '10px' });
  },
};

export const Link: Story = {
  args: { blocks: [proseBlock('You can see our hours on [our website](https://riveraplumbing.example/hours).')] },
  parameters: {
    canvasNote:
      "The board's replies carry no link; this is a reply with one Markdown link to the business's own site. Links in Claude's prose show their text only and open in a new tab. The kernel's reply check reads Markdown links and holds every link to the business's contact.",
  },
  play: async ({ canvasElement }) => {
    const prose = canvasElement.querySelector('.cd-claude-message__prose') as HTMLElement;
    await expect(prose.querySelectorAll('a')).toHaveLength(1);
    const link = prose.querySelector('a');
    await expect(link?.textContent).toBe('our website');
    await expect(link?.getAttribute('href')).toBe('https://riveraplumbing.example/hours');
    await expect(link?.getAttribute('target')).toBe('_blank');
    await expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    await expect(prose.textContent).toBe('You can see our hours on our website.');
    await expect(prose.textContent).not.toContain('https://riveraplumbing.example/hours');
  },
};

export const PlainProse: Story = {
  args: { blocks: [proseBlock('Text as written, **marks** and all.')], plainProse: true },
  parameters: {
    canvasNote: 'The Vision pages only: their prose is shown exactly as written, never as Markdown.',
  },
  play: async ({ canvas, canvasElement }) => {
    const prose = canvas.getByText('Text as written, **marks** and all.');
    await expect(prose.tagName).toBe('P');
    await expect(prose).toHaveClass('cd-claude-message__prose', 'cd-type-reply');
    await expect(canvasElement.querySelectorAll('strong')).toHaveLength(0);
  },
};
