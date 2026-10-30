/**
 * The page tests' check against the signed boards, so real pages can't drift from them. It runs
 * the design system's board helpers (`ds/boards/spec.ts`, the checks the `Boards/*` stories run)
 * on a page the app rendered, in test code only.
 */
import { userEvent } from 'vitest/browser';

import {
  SPEC,
  expectCards,
  expectConversationType,
  expectFooter,
  expectOwnerFrame,
  expectReceiptsUnderMessages,
  expectTabOrder,
} from '../ds/boards/spec.ts';
import { expectComputed } from '../ds/test/expectComputed.ts';

export interface OwnerBoardOptions {
  /** The sidebar row that is the current page: "Conversations". */
  current: string;
  /** The page fills the main area, as the conversation boards draw it. */
  fill?: boolean;
  /** The page shows a conversation: its type, and receipts under at least one message. */
  transcript?: boolean;
  /** Elements Tab reaches in this order from the top of the page. */
  tabStops?: HTMLElement[];
  /** Presses Tab; the browser's own by default. */
  user?: { tab: () => Promise<void> };
}

/** Where a conversation's reply cards sit: in Claude's messages. */
const IN_A_MESSAGE = '.cd-claude-message';

/**
 * An owner page as its signed board draws it: the frame with `current` as the current page, the
 * concept footer, every card in the card look, a conversation's type and receipts, and the order
 * Tab takes through `tabStops`.
 *
 * In a conversation, the cards in Claude's messages are the chat's reply cards, in their own look
 * (`ReplyCard`, as the design system's conversation boards draw and check them), so the card look
 * is checked on every other card there, such as a held request's.
 */
export async function expectOwnerBoard(root: HTMLElement, { current, fill = false, transcript = false, tabStops, user }: OwnerBoardOptions): Promise<void> {
  await expectOwnerFrame(root, current, { fill });
  await expectFooter(root);
  if (transcript) {
    for (const card of root.querySelectorAll<HTMLElement>('.cd-card')) {
      if (card.closest(IN_A_MESSAGE) === null) expectComputed(card, SPEC.card);
    }
    expectConversationType(root);
    const rows = await expectReceiptsUnderMessages(root);
    if (rows < 1) throw new Error('expected receipts under at least one message');
  } else {
    expectCards(root);
  }
  if (tabStops !== undefined) await expectTabOrder(user ?? userEvent, tabStops);
}
