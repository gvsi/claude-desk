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

/** Where a rules change's cards sit: in the change review, which draws its two cards compact. */
const IN_A_CHANGE_REVIEW = '.cd-change-review';

/** The change review's cards: the card look at the compact 16 px padding the design system gives them. */
const CHANGE_REVIEW_CARD = { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' } as const;

/**
 * An owner page as its signed board draws it: the frame with `current` as the current page, the
 * concept footer, every card in the card look, a conversation's type and receipts, and the order
 * Tab takes through `tabStops`.
 *
 * In a conversation, the cards in Claude's messages are the chat's reply cards, in their own look
 * (`ReplyCard`, as the design system's conversation boards draw and check them), so the card look
 * is checked on every other card there, such as a held request's. On a rules change's review, the
 * change review's own two cards are checked at the compact padding `ChangeReview` gives them.
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
  } else if (root.querySelector(IN_A_CHANGE_REVIEW) !== null) {
    // A rules change's review (N-Conn-10, N-Conn-18, N-Conn-20): its "Changes" and checks cards are
    // compact, as `ChangeReview` draws them; every other card is in the card look.
    for (const card of root.querySelectorAll<HTMLElement>('.cd-card')) {
      expectComputed(card, card.closest(IN_A_CHANGE_REVIEW) === null ? SPEC.card : CHANGE_REVIEW_CARD);
    }
  } else {
    expectCards(root);
  }
  if (tabStops !== undefined) await expectTabOrderFromTop(tabStops, user);
}

/**
 * The order Tab takes through `stops` from the top of the page. The browser's next Tab starts from
 * the element focused last, even once it's blurred, so a check that follows another (in the same
 * test, or an earlier test in the file) would start where focus was left. Focus goes to a mark at
 * the start of the document first, which Tab never stops on, and the mark goes once Tab is done.
 * While a modal dialog is open everything outside it is inert, so the mark can't take focus and
 * this throws rather than checking an order.
 */
export async function expectTabOrderFromTop(stops: HTMLElement[], user: { tab: () => Promise<void> } = userEvent): Promise<HTMLElement[]> {
  const start = document.createElement('span');
  start.tabIndex = -1;
  document.body.prepend(start);
  try {
    start.focus();
    if (document.activeElement !== start) throw new Error('focus could not be put at the start of the page');
    return await expectTabOrder(user, stops);
  } finally {
    start.remove();
  }
}
