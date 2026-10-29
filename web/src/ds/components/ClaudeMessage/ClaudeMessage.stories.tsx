import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import type { EvMessage, SseEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
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
const askOwner = rivera.blocks.prose.askOwner.en;

const meta = {
  title: 'Conversation/ClaudeMessage',
  component: ClaudeMessage,
  args: { blocks: [askOwner], language: 'en', ownerName: rivera.business.ownerName },
  parameters: { layout: 'padded', canvas: 'N-Conv-Live' },
} satisfies Meta<typeof ClaudeMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ProseOnly: Story = {
  parameters: {
    canvas: 'N-Public-Handoff',
    canvasNote: "The board sets Claude's public replies at 16/25; the design system's reply style is 15/23 on every surface.",
  },
  play: async ({ canvas, canvasElement }) => {
    // prose_is_serif_people_are_sans: Claude speaks in serif, with no bubble and no avatar.
    const prose = canvas.getByText(askOwner.text);
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
        await expect(part.tagName).toBe('P');
        await expect(part).toHaveClass('cd-type-reply');
        await expect(part.textContent).toBe(block.text);
      } else {
        await expect(part).toHaveClass('cd-reply-card');
        await expect(part.querySelectorAll('.cd-card')).toHaveLength(1);
      }
    }
    await expect(canvasElement.querySelectorAll('p.cd-type-reply')).toHaveLength(1);
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
    canvas: 'N-Conv-Agent',
    canvasNote:
      "The board shows the paid deposit as a receipt row; the kernel's own message (author desk) carries the payment_confirmed card, shown like Claude's.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(paid.author).toBe('desk');
    await expect(canvas.getByRole('article', { name: 'Paid' })).toBeVisible();
    await expect(canvas.getByText('Test payment, no money moves')).toBeVisible();
    await expect(canvasElement.querySelectorAll('p.cd-type-reply')).toHaveLength(0);
  },
};
