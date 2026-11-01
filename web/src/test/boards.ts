/**
 * The page tests' check against the signed boards, so real pages can't drift from them. It runs
 * the design system's board helpers (`ds/boards/spec.ts`, the checks the `Boards/*` stories run)
 * on a page the app rendered, in test code only.
 */
import { expect, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import {
  CONNECTORS_SPEC,
  SPEC,
  expectConnectorSections,
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
  /** The board draws no card (the Customers list): the page has none. With cards, each is in the card look. */
  cards?: boolean;
  /** Elements Tab reaches in this order from the top of the page. */
  tabStops?: HTMLElement[];
  /** Presses Tab; the browser's own by default. */
  user?: { tab: () => Promise<void> };
}

/** Where a conversation's reply cards sit: in Claude's messages. */
const IN_A_MESSAGE = '.cd-claude-message';

/** A connector's section on Rules: a card of rows that pad themselves, in the section look. */
const CONNECTOR_SECTION = '.cd-connector-section';

/** Where a rules change's cards sit: in the change review, which draws its two cards compact. */
const IN_A_CHANGE_REVIEW = '.cd-change-review';

/** The change review's cards: the card look at the compact 16 px padding the design system gives them. */
const CHANGE_REVIEW_CARD = { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' } as const;

/** Where Rules lists the Desk's own jobs: a tool's rules card for each (`ToolRulesCard`), as All rules draws them. */
const IN_THE_JOBS = '.cd-business-jobs';

/** A tool's rules card: the card look at the 16 px padding `ToolRulesCard` gives itself. */
const TOOL_RULES_CARD = { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' } as const;

/** A card of rows that pad themselves (`Card` `padding={0}`, such as a `DetailList` or an `AlertList`). */
const CARD_OF_ROWS = 'cd-card--padding-0';

/** Such a card's look: the card's, with no padding of its own. */
const ROWS_CARD = { ...SPEC.card, paddingTop: '0px', paddingLeft: '0px' } as const;

/** A part's loading shapes, laid out, shown or fading over it. */
const SKELETON_LAYER = '.cd-skeleton-screen__layer';

/** Long enough for a fading layer to go on a busy browser, past its one-second fallback. */
const SKELETON_GONE_MS = 3_000;

/**
 * An owner page as its signed board draws it, once its loading shapes have gone: the frame with
 * `current` as the current page, the concept footer, every card in the card look (or, with
 * `cards: false`, no card at all), a conversation's type and receipts, and the order Tab takes
 * through `tabStops`.
 *
 * In a conversation, the cards in Claude's messages are the chat's reply cards, in their own look
 * (`ReplyCard`, as the design system's conversation boards draw and check them), so the card look
 * is checked on every other card there, such as a held request's. On a rules change's review, the
 * change review's own two cards are checked at the compact padding `ChangeReview` gives them; on
 * the Rules page, each connector's section in the section look the connectors boards give it, and
 * each of the Desk's own jobs at the padding `ToolRulesCard` gives itself. A card of rows has the
 * card look with no padding of its own, since each of its rows pads itself.
 */
export async function expectOwnerBoard(
  root: HTMLElement,
  { current, fill = false, transcript = false, cards = true, tabStops, user }: OwnerBoardOptions,
): Promise<void> {
  // A board draws the page at rest. Loading shapes take their parts' own classes for their sizes
  // (a connector's section, its icon, a card), so while a layer of them is still there, fading
  // over the part that arrived, its shapes would be checked as the part.
  await vi.waitFor(() => expect(root.querySelector(SKELETON_LAYER), 'loading shapes still on the page').toBeNull(), { timeout: SKELETON_GONE_MS });
  await expectOwnerFrame(root, current, { fill });
  await expectFooter(root);
  if (transcript) {
    for (const card of root.querySelectorAll<HTMLElement>('.cd-card')) {
      if (card.closest(IN_A_MESSAGE) === null) expectComputed(card, SPEC.card);
    }
    expectConversationType(root);
    const rows = await expectReceiptsUnderMessages(root);
    if (rows < 1) throw new Error('expected receipts under at least one message');
  } else if (!cards) {
    const found = root.querySelectorAll('.cd-card').length;
    if (found > 0) throw new Error(`expected no card on the page, found ${found}`);
  } else if (root.querySelector(IN_A_CHANGE_REVIEW) !== null) {
    // A rules change's review (N-Conn-10, N-Conn-18, N-Conn-20): its "Changes" and checks cards are
    // compact, as `ChangeReview` draws them; every other card is in the card look.
    for (const card of root.querySelectorAll<HTMLElement>('.cd-card')) {
      expectComputed(card, card.closest(IN_A_CHANGE_REVIEW) === null ? SPEC.card : CHANGE_REVIEW_CARD);
    }
  } else if (root.querySelector(CONNECTOR_SECTION) !== null) {
    // The Rules page (N-Conn-17): each connector's section is a card with no padding of its own,
    // in the section look, its header and rows as the board draws them; each of the Desk's own
    // jobs is a tool's rules card, as All rules draws it; every other card is in the card look.
    expectConnectorSections(root);
    for (const card of root.querySelectorAll<HTMLElement>('.cd-card')) {
      const look = card.querySelector(CONNECTOR_SECTION) !== null ? CONNECTORS_SPEC.section : card.closest(IN_THE_JOBS) !== null ? TOOL_RULES_CARD : SPEC.card;
      expectComputed(card, look);
    }
  } else {
    const cards = [...root.querySelectorAll<HTMLElement>('.cd-card')];
    if (cards.length === 0) throw new Error('expected at least one .cd-card');
    for (const card of cards) expectComputed(card, card.classList.contains(CARD_OF_ROWS) ? ROWS_CARD : SPEC.card);
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
