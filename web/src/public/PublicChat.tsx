/**
 * The public chat: a Desk's page as a stranger sees it, inside the design system's PublicShell.
 * Every message, card and receipt is the kernel's; chats outside the owner's preview omit only
 * the reply check's own receipt. The page adds only its own chrome (copy.ts) and the design system's error lines.
 * A reply shows whole once the kernel has
 * checked it, with its receipts attached under it; while Claude writes, only "Claude is writing".
 *
 * Reused by setup's preview (`embedded`), which sits inside an owner screen.
 */
import { Component, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import type { RenderedBlock, SessionState } from '../api/contracts.ts';
import {
  Button,
  CHAT_ENDED_COPY,
  ClaudeMessage,
  Composer,
  ConceptFooter,
  EmptyState,
  MarginReceipt,
  NEW_CHAT_LABEL,
  Notice,
  PUBLIC_SHELL_SCROLLER_EVENT,
  PersonMessage,
  PublicShell,
  PublicShellSkeleton,
  RATE_LIMITED_COPY,
  StatusDot,
  SystemLine,
  SkeletonScreen,
  Transcript,
  TranscriptRow,
  UNREACHABLE_COPY,
  VisitorMessage,
  WritingIndicator,
  evErrorCopy,
  receiptTone,
  type CopyLanguage,
  type ReceiptView,
} from '../ds/index.ts';
import { breakItIdea, type BreakItIdea } from '../lib/breakItIdeas.ts';
import { fillComposer } from '../lib/composer.ts';
import { browserLanguage } from '../lib/language.ts';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { brandFrom } from './brand.ts';
import type { ChatRow, ChatState, SendFailure } from './chatReducer.ts';
import { usePaymentLinks } from './usePaymentLinks.ts';
import { PUBLIC_COPY, type PublicCopy } from './copy.ts';
import { VisitorInbox, inboxShown, useVisitorInbox, useWideWindow } from './inbox/VisitorInbox.tsx';
import { messageReceiptVisible } from './messageReceipt.ts';
import { useVisitorChat, type ChatStatus } from './PublicChatProvider.tsx';
import { useOpenStatus } from './useOpenStatus.ts';
import { useVisitorTyping } from './useVisitorTyping.ts';
import { VerifyInline } from './verify/VerifyInline.tsx';

import './PublicChat.css';

/** Plan 02's limit on a visitor's message. */
export const MESSAGE_MAX_LENGTH = 2000;

export interface PublicChatProps {
  slug: string;
  /** Inside an owner screen, which has its own footer and landmarks. */
  embedded?: boolean;
  /** The owner's own preview of this Desk (setup's Live step or Today's "Chat as a customer"). */
  previewDeskId?: string;
  /** Called with the chat's session once it is open. */
  onSession?: (session: SessionState) => void;
  /** Links under "For AI agents" in the about column, on the public page itself. */
  aboutLinks?: { label: string; href: string }[];
  /**
   * The key of one of "Try to break it"'s fixed ideas, which this browser's Today handed to the page
   * (`takeBreakItHandoff`): worded for this Desk's own owner (`breakItIdea`) and typed into the
   * composer once the chat can be written in, as plain text, then sent only by the visitor's own
   * Send, as typed words are, under the same limit and checks. Read on mount only. Never words
   * from a link: the page passes only an idea it looked up from the hand-off.
   */
  idea?: BreakItIdea['key'];
}

/** Words to put in the composer once the chat can be used, and whether they take focus there. */
interface Carried {
  /** The words, or the idea Today handed over, by its key, to be worded once the Desk is read. */
  text: string | { idea: BreakItIdea['key'] };
  /** `always`: they do. `if_free`: only when nothing else on the page has focus. */
  focus: 'always' | 'if_free';
}

/** Cards that report something done: their executed receipt draws the check. */
const DONE_CARDS: ReadonlySet<string> = new Set(['booking_confirmed', 'payment_confirmed']);

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  const last = words.length > 1 ? words.at(-1) : undefined;
  return [first, last].map((word) => (word === undefined ? '' : (Array.from(word)[0] ?? ''))).join('');
}

function failureLine(failure: SendFailure | undefined, language: CopyLanguage, copy: PublicCopy): string {
  if (failure === 'rate_limited') return RATE_LIMITED_COPY[language];
  if (failure === 'too_long') return copy.tooLong;
  return copy.notSent;
}

/**
 * The receipts a row shows under its message, in order: all of them, but the reply check's own on a
 * message that doesn't show it (`messageReceiptVisible`). Filtered after grouping, for live and
 * history alike: the message still settles its turn and keeps every action receipt. Pending
 * receipts and the writing line are never filtered.
 */
function shownReceipts(row: ChatRow, ownerPreview: boolean): readonly ReceiptView[] {
  const { item } = row;
  return item.kind === 'message' && !messageReceiptVisible(item.ev, ownerPreview)
    ? row.receipts.filter((receipt) => receipt.source.kind !== 'reply')
    : row.receipts;
}

interface RowProps {
  paymentBlock: (block: RenderedBlock) => RenderedBlock;
  row: ChatRow;
  ownerPreview: boolean;
  /** `owner_display_name` as served, for the owner's own messages and a card's "{owner} said". */
  ownerName: string;
  language: CopyLanguage;
  onResend: (id: string) => void;
  /** What goes under the row's receipts: "Cancel this request" for each open hold it holds. */
  after?: ReactNode[];
}

/** One row: the message and its visible receipts, exactly as the kernel wrote them. */
function ChatRowView({ row, ownerPreview, ownerName, language, onResend, paymentBlock, after = [] }: RowProps) {
  const { item } = row;
  const copy = PUBLIC_COPY[language];
  const done = item.kind === 'message' && item.ev.blocks.some((block) => block.kind === 'card' && DONE_CARDS.has(block.template ?? ''));
  const receipts = [
    ...shownReceipts(row, ownerPreview).map((receipt: ReceiptView, index) => (
      <MarginReceipt
        key={`${receipt.ledgerSeq}-${index}`}
        source={receipt.source}
        plain={receipt.plain}
        ledgerSeq={receipt.ledgerSeq}
        drawCheck={done && receipt.source.kind === 'decision' && receipt.source.state === 'executed'}
      />
    )),
    ...after,
  ];

  if (item.kind === 'visitor') {
    // A message that ended the chat says nothing of its own: the chat's notice does.
    const failed = item.status === 'failed' && item.failure !== 'session';
    const retry =
      item.failure === 'too_long' ? undefined : (
        <Button variant="ghost" onClick={() => onResend(item.id)}>
          {copy.tryAgain}
        </Button>
      );
    const margin = failed
      ? [
          ...receipts,
          <Notice key="failed" tone="error" action={retry}>
            {failureLine(item.failure, language, copy)}
          </Notice>,
        ]
      : receipts;
    return (
      <TranscriptRow margin={margin}>
        <VisitorMessage text={item.text} />
      </TranscriptRow>
    );
  }
  if (item.kind === 'system') {
    const line =
      item.ev.type === 'owner_joined' ? (
        <SystemLine text={copy.joined(item.ev.name)} initials={initialsOf(item.ev.name)} />
      ) : (
        <SystemLine text={copy.claudeIsBack} />
      );
    return (
      <TranscriptRow margin={receipts} live={row.live}>
        {line}
      </TranscriptRow>
    );
  }
  const { ev } = item;
  // A reply that arrived on the stream lands, its receipts one by one.
  return (
    <TranscriptRow margin={receipts} live={row.live}>
      {ev.author === 'owner' ? (
        <PersonMessage name={ownerName} blocks={ev.blocks} language={ev.language} />
      ) : (
        <ClaudeMessage blocks={ev.blocks.map(paymentBlock)} language={ev.language} ownerName={ownerName} />
      )}
    </TranscriptRow>
  );
}

/** How far above the composer the visitor can be and still count as reading the newest message. */
const AT_THE_END_PX = 48;

/** The element whose scrolling moves `el`: its nearest scrolling ancestor, or the page. */
function scrollerOf(el: Element): Element {
  for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * Where the conversation is scrolled: the element whose scrolling moves it, how far down, and the
 * size of the shell around it ("390x844"), which tells whether the page has changed size since.
 */
interface ScrollerAt {
  scroller: Element;
  top: number;
  shellSize: string;
}

/** Where the element whose scrolling moves `el` stands now. */
function scrollerAt(el: Element): ScrollerAt {
  const scroller = scrollerOf(el);
  const shell = el.closest(SHELL)?.getBoundingClientRect();
  return { scroller, top: scroller.scrollTop, shellSize: shell ? `${Math.round(shell.width)}x${Math.round(shell.height)}` : '' };
}

/** The design system's classes for the shell around the page and its composer area, which stays at the bottom of the window. */
const SHELL = '.cd-public-shell';
const COMPOSER_AREA = '.cd-public-shell__composer';

/**
 * Whether a visitor who was at the end, where the page last knew they were (`seen`), has moved
 * away from it to stand where the conversation is now: only by moving it up, in the same scroller,
 * with the shell the same size. The page changing size moves the conversation too, before the page
 * hears of the new size: the browser's scroll anchoring moves it down or up as the rows rewrap, and
 * the shell switching scrollers leaves it where the new scroller was. Nothing lies below the end.
 */
function leftTheEnd(seen: ScrollerAt, now: ScrollerAt): boolean {
  return now.scroller === seen.scroller && now.shellSize === seen.shellSize && now.top < seen.top;
}

/**
 * How much of the conversation, up to `end`, is hidden under the composer that stays at the bottom
 * of the window: measured to the top of the shell's composer area around `composer`, whose top
 * padding counts.
 */
function hiddenUnderComposer(end: HTMLElement, composer: HTMLElement): number {
  const area = composer.closest(COMPOSER_AREA) ?? composer;
  return end.getBoundingClientRect().bottom - area.getBoundingClientRect().top;
}

/**
 * Renders nothing, and calls `before` each time the component that renders it renders again, as
 * React is about to change the page and while the page is still as the visitor sees it. Only a
 * class has that moment (React's getSnapshotBeforeUpdate); function components have no equivalent.
 */
class BeforeEachChange extends Component<{ before: () => void }> {
  override getSnapshotBeforeUpdate(): null {
    this.props.before();
    return null;
  }

  // Without componentDidUpdate, React warns in development that getSnapshotBeforeUpdate is used alone.
  override componentDidUpdate(): void {}

  override render(): null {
    return null;
  }
}

interface NewestInView {
  /** Call when the visitor sends: the end of the conversation comes back into view. */
  follow: () => void;
  /** For a BeforeEachChange rendered with the conversation. */
  beforeChange: () => void;
}

/**
 * Keeps the newest message in view, as a chat does: while the visitor is at the end of the
 * conversation, whatever arrives (a reply, its receipts, "Claude is writing", a notice) scrolls up
 * to sit just above the composer, and so does the end when the page changes size (the window
 * narrows and the rows rewrap, the composer grows). A visitor who has scrolled back to read stays
 * where they are until they send.
 *
 * Where the visitor is comes from the page's scroll events, and again just before each change the
 * page makes (`beforeChange`) if the conversation has scrolled since the page last knew: a scroll
 * the page makes at once, such as focus moving up with the keyboard, sends its event only with the
 * next frame, and a reply arriving in between would otherwise take the visitor back down to the
 * end. The page changing size moves the end under the composer, and doesn't count as the visitor
 * moving away. It can scroll the conversation too, and that scroll's event can come before the page
 * sees the new size: when the window narrows or widens the rows rewrap, and the browser's scroll
 * anchoring moves the conversation down or up to keep the rows on screen where they were. And the
 * shell can switch which of its parts scrolls the conversation (going short or tall), which leaves
 * it where the new scroller was; the shell says so with its own event, and the end comes back. So
 * while the visitor is at the end, only a move up of the same scroller, with the shell the same
 * size, counts as them leaving it (`leftTheEnd`); once they have moved back, any move counts. Only
 * the conversation's own scroller counts at all, looked up afresh each time: not the about column
 * beside the chat, the composer's text box, or a part of the shell that has just stopped scrolling
 * the conversation. The trade-off: a visitor's scroll up in the very frame the shell changes size,
 * before the page has seen the new size, is taken for the browser's and the end comes back once; a
 * scroll gesture goes on past that frame and is followed from there.
 *
 * Until the conversation has `started` there is no newest message to keep in view, so nothing is
 * pinned and the conversation's scroll region stays at its start: on a phone, where the about
 * column opens the region above the first message, a new chat opens with the column's heading in
 * view, not scrolled to the empty end below it. A chat that empties again (the visitor starts a new
 * one after theirs ended) goes back to its start the same way, rather than where the browser left
 * the region as the old rows went, and its end is followed again from its first message.
 */
function useNewestInView(
  end: RefObject<HTMLElement | null>,
  composer: RefObject<HTMLElement | null>,
  shown: boolean,
  started: boolean,
): NewestInView {
  const atTheEnd = useRef(true);
  /** Where the conversation's scroller stood when the page last knew where the visitor was. */
  const seenAt = useRef<ScrollerAt | null>(null);

  // The page knows where the visitor is, with the conversation scrolled as it is now.
  const noteSeen = useCallback(() => {
    seenAt.current = end.current ? scrollerAt(end.current) : null;
  }, [end]);

  // A conversation that had started and is empty again goes back to its start, at once, and its
  // end is followed again from its first message.
  const wasStarted = useRef(started);
  useLayoutEffect(() => {
    const emptied = wasStarted.current && !started;
    wasStarted.current = started;
    if (!emptied || !end.current) return;
    atTheEnd.current = true;
    const scroller = scrollerOf(end.current);
    if (scroller === document.scrollingElement) window.scrollTo({ top: 0, behavior: 'instant' });
    else scroller.scrollTo({ top: 0, behavior: 'instant' });
    noteSeen();
  }, [started, end, noteSeen]);

  // Brings the end of the conversation up to the composer, at once and never animated, while the
  // visitor is at the end of a conversation that has started, and notes that they still are.
  const pin = useCallback(() => {
    if (!started || !atTheEnd.current || !end.current || !composer.current) return;
    const hidden = hiddenUnderComposer(end.current, composer.current);
    if (hidden > 0) {
      const scroller = scrollerOf(end.current);
      if (scroller === document.scrollingElement) window.scrollBy({ top: hidden, behavior: 'instant' });
      else scroller.scrollBy({ top: hidden, behavior: 'instant' });
    }
    noteSeen();
  }, [started, end, composer, noteSeen]);

  // Whether the visitor is at the end, as the page stands now.
  const notePlace = useCallback(() => {
    if (end.current && composer.current) atTheEnd.current = hiddenUnderComposer(end.current, composer.current) <= AT_THE_END_PX;
    noteSeen();
  }, [end, composer, noteSeen]);

  // Whether the conversation has scrolled since the page last knew where the visitor was, in a way
  // that may have moved them. Its scroller changing is not the visitor moving: the shell switches
  // scrollers as it goes short or tall, and setup's preview scrolls the page until the conversation
  // overflows the panel around it, and the panel from then on. While the visitor is at the end, only
  // `leftTheEnd` counts.
  const scrolledSinceSeen = useCallback((): boolean => {
    const seen = seenAt.current;
    if (!seen || !end.current) return false;
    const now = scrollerAt(end.current);
    if (atTheEnd.current) return leftTheEnd(seen, now);
    return now.scroller === seen.scroller && now.top !== seen.top;
  }, [end]);

  // A scroll event, of the conversation's own scroller only. While the visitor is at the end, a
  // scroll that isn't them leaving it (`leftTheEnd`) keeps them there, and the resize or the shell's
  // switch that moved the conversation brings the end back; anything else is weighed by where the
  // end now is.
  const noteScroll = useCallback(
    (event: Event) => {
      if (!end.current) return;
      const now = scrollerAt(end.current);
      const scrolled = event.target === document ? document.scrollingElement : event.target;
      if (scrolled !== now.scroller) return;
      const seen = seenAt.current;
      if (atTheEnd.current && seen !== null && !leftTheEnd(seen, now)) noteSeen();
      else notePlace();
    },
    [end, noteSeen, notePlace],
  );

  useEffect(() => {
    // Captured on the document, so the page's scrolling and an embedding panel's both count.
    document.addEventListener('scroll', noteScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', noteScroll, { capture: true });
  }, [noteScroll]);

  // The page changing size moves the end without a render: the shell rewraps when the window or
  // the panel around it resizes, and the composer area grows with what is typed. So does the shell
  // switching which of its parts scrolls the conversation, which it says with its own event. Watched
  // while the shell is `shown`.
  useEffect(() => {
    const shell = shown ? end.current?.closest(SHELL) : null;
    const area = composer.current?.closest(COMPOSER_AREA);
    if (!shell) return undefined;
    shell.addEventListener(PUBLIC_SHELL_SCROLLER_EVENT, pin);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(pin);
    observer?.observe(shell);
    if (area) observer?.observe(area);
    return () => {
      shell.removeEventListener(PUBLIC_SHELL_SCROLLER_EVENT, pin);
      observer?.disconnect();
    };
  }, [shown, end, composer, pin]);

  // Just before each change, if the visitor may have moved.
  const beforeChange = useCallback(() => {
    if (scrolledSinceSeen()) notePlace();
  }, [scrolledSinceSeen, notePlace]);

  // After every render: the conversation may have grown under the composer.
  useLayoutEffect(pin);

  // Wherever the visitor is when they send, the end comes back, even if a scroll of theirs hasn't
  // sent its event yet.
  const follow = useCallback(() => {
    atTheEnd.current = true;
    noteSeen();
  }, [noteSeen]);

  return { follow, beforeChange };
}

/** The design system's classes for the chat's head, which stays at the top, and a row of the conversation. */
const CHAT_HEAD = '.cd-public-shell__chat-head';
const TRANSCRIPT_ROW = '.cd-transcript-row';

/**
 * Whether all of `el` is in view in the conversation: within what the element that scrolls it shows
 * of it on screen, under the chat's head and above the composer area, which both stay put.
 */
function inConversationView(el: Element): boolean {
  const box = el.getBoundingClientRect();
  const shell = el.closest(SHELL);
  const scroller = scrollerOf(el);
  const frame = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
  const top = Math.max(0, frame.top, shell?.querySelector(CHAT_HEAD)?.getBoundingClientRect().bottom ?? 0);
  const bottom = Math.min(innerHeight, frame.bottom, shell?.querySelector(COMPOSER_AREA)?.getBoundingClientRect().top ?? innerHeight);
  // A pixel either way for the rounding of fractional layout.
  return box.top >= top - 1 && box.bottom <= bottom + 1;
}

/** Where a held request's "Cancel this request" is drawn, attached under its message after the receipts. */
interface CancelPlace {
  /** The block that holds the button. */
  block: HTMLElement;
  /** Which of the lines attached under the message, from the first, is the request's receipt. */
  receipt: number;
}

/** The request's receipt: the line attached under its message at `receipt`, counting the first as 0. */
function receiptAt({ block, receipt }: CancelPlace): Element | null {
  return block.parentElement?.children.item(receipt) ?? null;
}

const NONE: ReadonlySet<string> = new Set();

interface WaitingRequests {
  /** The ref for hold `id`'s "Cancel this request" block, whose receipt is the `receipt`th line attached with it. */
  place: (id: string, receipt: number) => (block: HTMLDivElement | null) => void;
  /** The holds whose "Cancel this request" is drawn and whose receipt is out of view. */
  away: ReadonlySet<string>;
  /**
   * Brings hold `id`'s request into view at once, never animated, and puts focus on its "Cancel this
   * request", without scrolling again. It does nothing else.
   */
  view: (id: string) => void;
}

/**
 * Which held requests have their receipt out of view in the conversation, looked at again after
 * every render, every scroll, and each time the shell or its composer area changes size: the
 * visitor scrolling, the chat going on, a window or a draft changing size. The page draws a line
 * above the composer for each of those, which takes it back to the request (`view`).
 *
 * Call it after `useNewestInView`, so it looks once the newest message has been brought up to the
 * composer. Showing a line makes the composer area taller and hiding one makes it shorter, which
 * only moves a receipt further the way it went, so a line never flickers in and out.
 */
function useWaitingRequests(end: RefObject<HTMLElement | null>, composer: RefObject<HTMLElement | null>, shown: boolean): WaitingRequests {
  const places = useRef(new Map<string, CancelPlace>());
  const [away, setAway] = useState<ReadonlySet<string>>(NONE);

  const look = useCallback(() => {
    const now = new Set<string>();
    for (const [id, place] of places.current) {
      const receipt = receiptAt(place);
      if (receipt !== null && !inConversationView(receipt)) now.add(id);
    }
    setAway((was) => (was.size === now.size && [...now].every((id) => was.has(id)) ? was : now));
  }, []);

  // After every render: the conversation may have grown, or a request been drawn or taken away.
  useLayoutEffect(look);

  useEffect(() => {
    // Captured on the document, so the page's scrolling and an embedding panel's both count.
    document.addEventListener('scroll', look, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', look, { capture: true });
  }, [look]);

  useEffect(() => {
    const shell = shown ? end.current?.closest(SHELL) : null;
    const area = composer.current?.closest(COMPOSER_AREA);
    if (!shell) return undefined;
    shell.addEventListener(PUBLIC_SHELL_SCROLLER_EVENT, look);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(look);
    observer?.observe(shell);
    if (area) observer?.observe(area);
    return () => {
      shell.removeEventListener(PUBLIC_SHELL_SCROLLER_EVENT, look);
      observer?.disconnect();
    };
  }, [shown, end, composer, look]);

  const place = useCallback(
    (id: string, receipt: number) => (block: HTMLDivElement | null) => {
      if (block === null) places.current.delete(id);
      else places.current.set(id, { block, receipt });
    },
    [],
  );

  const view = useCallback(
    (id: string) => {
      const at = places.current.get(id);
      const receipt = at ? receiptAt(at) : null;
      if (!at || !receipt) return;
      // The request's message with its receipt and cancel, centred; a message too tall for that
      // brings its cancel up to the composer, with the receipt right above it.
      (at.block.closest(TRANSCRIPT_ROW) ?? receipt).scrollIntoView({ block: 'center', behavior: 'instant' });
      if (!inConversationView(receipt) || !inConversationView(at.block)) at.block.scrollIntoView({ block: 'end', behavior: 'instant' });
      at.block.querySelector<HTMLElement>(':scope > .cd-button')?.focus({ preventScroll: true });
      look();
    },
    [look],
  );

  return { place, away, view };
}

interface WaitingLineProps {
  /** The request's latest receipt: its dot and the kernel's line, as written. */
  receipt: ReceiptView;
  /** "View request", in the page's language. */
  label: string;
  onView: () => void;
  /** Called as the line leaves the page with focus on "View request". */
  onLeftWithFocus: () => void;
}

/**
 * A held request's line above the composer, while its receipt is out of view: the receipt's own dot
 * and line, never rewritten, and "View request", which goes back to it. It adds no words about the
 * request and no action on it.
 */
function WaitingLine({ receipt, label, onView, onLeftWithFocus }: WaitingLineProps) {
  const lineId = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  // React lets go of the button before it leaves the page, so whether it had focus can still be read.
  const buttonRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element === null && button.current !== null && button.current === button.current.ownerDocument.activeElement) onLeftWithFocus();
      button.current = element;
    },
    [onLeftWithFocus],
  );
  return (
    <div className="cd-public-chat__waiting-row">
      <span className="cd-status-label cd-type-caption cd-public-chat__waiting-line">
        <StatusDot tone={receiptTone(receipt.source)} />
        <span id={lineId}>{receipt.plain}</span>
      </span>
      <Button variant="ghost" describedBy={lineId} buttonRef={buttonRef} onClick={onView}>
        {label}
      </Button>
    </div>
  );
}

/**
 * Whether the conversation has anything in it yet: a row, receipts before the first message,
 * "Claude is writing", the owner typing, or a notice under it.
 */
function conversationStarted(state: ChatState, status: ChatStatus): boolean {
  if (state.rows.length > 0 || state.leading.length > 0 || state.writing || state.ownerTyping !== null) return true;
  return state.error !== null || status === 'unavailable' || state.connection !== 'open';
}

/** The latest row whose message carries the kernel's verify card, by its key, or null. */
function latestVerifyRow(rows: readonly ChatRow[]): string | null {
  const row = rows.findLast(
    ({ item }) => item.kind === 'message' && item.ev.blocks.some((block) => block.kind === 'card' && block.template === 'verify_prompt'),
  );
  return row === undefined ? null : rowKey(row);
}

/** The visitor's words that didn't send because the chat ended (a 401), in order. */
function unsentWhenEnded(rows: readonly ChatRow[]): string[] {
  return rows.flatMap(({ item }) => (item.kind === 'visitor' && item.status === 'failed' && item.failure === 'session' ? [item.text] : []));
}

/** A page without the chat: loading, a Desk that isn't there, or one that couldn't load. */
function PublicState({ embedded, language, children }: { embedded: boolean; language: CopyLanguage; children: ReactNode }) {
  const Main = embedded ? 'div' : 'main';
  return (
    <div className="cd-public-state" lang={language}>
      <Main className="cd-public-state__main">{children}</Main>
      {embedded ? null : (
        <footer className="cd-public-state__footer">
          <ConceptFooter poweredBy />
        </footer>
      )}
    </div>
  );
}

export function PublicChat({ slug, embedded = false, previewDeskId, onSession, aboutLinks, idea }: PublicChatProps) {
  // Setup and Today open the owner's own preview with a Desk id; its session is still a visitor.
  const ownerPreview = typeof previewDeskId === 'string' && previewDeskId.length > 0;
  const chat = useVisitorChat(slug, previewDeskId);
  // Page chrome follows the browser; each message's cards follow the message's own language.
  const [language] = useState(browserLanguage);
  const copy = PUBLIC_COPY[language];
  const { openStatus, desk } = useOpenStatus(slug, chat.desk);
  // The first session/history read shapes the opening view too. Keep the shell's first header
  // (including the served hours) together with that view rather than landing it in stages.
  const opening =
    (desk === null || (chat.session === null && chat.status === 'loading')) &&
    chat.status !== 'not_found' && chat.status !== 'unavailable';
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // The chat's own path, without the owner's `?preview=`: the visitor cookie the preview's chat
  // runs on is the one `/d/<slug>` resumes. Setup's preview sits inside an owner screen, so its
  // links note no chat to go back to.
  const paymentBlock = usePaymentLinks(chat.state.rows, chat.paymentLinks, composerRef, embedded ? undefined : `/d/${slug}`);
  const newest = useNewestInView(endRef, composerRef, !opening && desk !== null, conversationStarted(chat.state, chat.status));
  // After useNewestInView, so it looks once the newest message is in its place.
  const waiting = useWaitingRequests(endRef, composerRef, !opening && desk !== null);
  // While the visitor types, the owner's view of the chat shows that someone is, never what.
  const visitorTyping = useVisitorTyping(slug);
  // The chat can be written in: it loaded, and its session hasn't ended.
  const ready = chat.status === 'ready' && chat.state.error !== 'session';
  // The demo's codes: read while the chat can be used, a column of its own on a wide window.
  const inbox = useVisitorInbox(slug, chat.session?.session_id ?? null, chat.state.inbox, ready);
  const wide = useWideWindow();
  const inboxPlacement = wide && !embedded ? 'column' : 'sheet';

  useEffect(() => {
    if (chat.session !== null) onSession?.(chat.session);
  }, [chat.session, onSession]);

  // On its own page the tab names the business, as the header does and the kernel serves it; the
  // app's name comes back when the page closes. Inside an owner screen (setup's preview) the tab is
  // that screen's.
  useDocumentTitle(embedded ? null : (desk?.business_name ?? null));

  // A cancel that went through takes its button away: the visitor's place moves to the composer,
  // unless they have already moved on to something else.
  const lastCancel = useRef<string | null>(null);
  useEffect(() => {
    const cancelled = lastCancel.current;
    lastCancel.current = chat.cancelling;
    if (cancelled === null || chat.cancelling !== null) return;
    if (chat.state.openHolds.includes(cancelled) || chat.cancelFailed === cancelled) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    composerRef.current?.querySelector('textarea')?.focus();
  }, [chat.cancelling, chat.cancelFailed, chat.state.openHolds]);

  // A waiting line that goes with focus on its "View request" (the request was answered, or its
  // receipt came back into view) leaves the visitor's place in the composer, without scrolling.
  const waitingLeftWithFocus = useRef(false);
  const noteWaitingLeftWithFocus = useCallback(() => {
    waitingLeftWithFocus.current = true;
  }, []);
  useLayoutEffect(() => {
    if (!waitingLeftWithFocus.current) return;
    waitingLeftWithFocus.current = false;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    composerRef.current?.querySelector('textarea')?.focus({ preventScroll: true });
  });

  // A row that arrived live lands as it is first drawn. Once the transcript has drawn it, the chat
  // stops calling it live, so a remount (the visitor leaving the page and coming back) draws it still.
  const drawn = !opening && chat.status !== 'not_found' && desk !== null;
  const { shown } = chat;
  useEffect(() => {
    if (drawn && chat.state.rows.some((row) => row.live === true)) shown();
  }, [drawn, chat.state.rows, shown]);

  // The verify card whose form the visitor closed with "I can't get the code" while the owner was in
  // the chat, by its row's key. It stays closed only while she is in the chat: the form comes back
  // under its card in the same render that says she is out, and stays open if she joins again.
  const [verifyClosed, setVerifyClosed] = useState<string | null>(null);
  const ownerHere = chat.ownerInChat;
  useEffect(() => {
    if (!ownerHere) setVerifyClosed(null);
  }, [ownerHere]);

  // Words wait in the composer once it can be used: the link's idea as the page opens, and words
  // that didn't send when the chat ended, in the new chat's. Neither is sent without Send. Words
  // given back after "Start a new chat" take focus, which was on that button; the idea takes it only
  // when nothing else has it, so a visitor who moved on while the chat opened stays where they are.
  // The idea speaks as this Desk's owner, by the name the Desk carries; there is a composer to
  // type it into only once the Desk is read.
  const carried = useRef<Carried | null>(idea === undefined ? null : { text: { idea }, focus: 'if_free' });
  const ideaOwner = desk === null ? null : brandFrom(desk).ownerName;
  useEffect(() => {
    const words = carried.current;
    const box = composerRef.current?.querySelector('textarea');
    if (!ready || words === null || !box) return;
    carried.current = null;
    const text = typeof words.text === 'string' ? words.text : breakItIdea(words.text.idea, ideaOwner);
    if (text === null) return;
    const free = document.activeElement === null || document.activeElement === document.body;
    fillComposer(box, text, { focus: words.focus === 'always' || free });
  }, [ready, ideaOwner]);

  const present = (children?: ReactNode) => (
    <>
      {opening && !embedded ? (
        <main className="cd-sr-only"><h1>Claude Desk</h1></main>
      ) : null}
      <SkeletonScreen
        loading={opening}
        status={copy.opening}
        lang={language}
        skeleton={<PublicShellSkeleton language={language} footer={!embedded} />}
        className={`cd-public-chat-screen${embedded ? ' cd-public-chat-screen--embedded' : ''}`}
      >
        {children}
      </SkeletonScreen>
    </>
  );

  if (chat.status === 'not_found') {
    return present(
      <PublicState embedded={embedded} language={language}>
        <EmptyState title={copy.deskUnavailableTitle} body={copy.deskUnavailableBody} />
      </PublicState>
    );
  }
  if (opening) return present();
  if (desk === null) {
    return present(
      <PublicState embedded={embedded} language={language}>
        <Notice
          tone="error"
          action={
            <Button variant="secondary" onClick={chat.retry}>
              {copy.tryAgain}
            </Button>
          }
        >
          {UNREACHABLE_COPY[language]}
        </Notice>
      </PublicState>
    );
  }

  const { brand, ownerName } = brandFrom(desk);
  const { state } = chat;
  const ended = state.error === 'session';
  // "Cancel this request" under each message that holds an open hold's receipt, once it is there,
  // so it stays with the request however far the chat goes on. One cancel is out at a time: while
  // it is, the others wait, their words shown and their clicks ignored, so none goes unanswered.
  // `receipts` are the lines the message shows, in order, so each request's receipt is found by its
  // place among them.
  const cancelsUnder = (receipts: readonly ReceiptView[]): ReactNode[] => {
    if (!ready) return [];
    return state.openHolds
      .map((id) => {
        const held = state.latest.get(id);
        return { id, at: held === undefined ? -1 : receipts.indexOf(held) };
      })
      .filter(({ at }) => at >= 0)
      .map(({ id, at }) => (
        <div key={`cancel-${id}`} ref={waiting.place(id, at)} className="cd-public-chat__cancel">
          <Button
            variant="ghost"
            busy={chat.cancelling === id}
            waiting={chat.cancelling !== null && chat.cancelling !== id}
            onClick={() => chat.cancel(id)}
          >
            {copy.cancelRequest}
          </Button>
          {chat.cancelFailed === id ? <Notice tone="error">{UNREACHABLE_COPY[language]}</Notice> : null}
        </div>
      ));
  };

  const askForOwner = () => send(copy.askForOwner(ownerName));
  // Under the latest message with the kernel's verify card: the code form while the chat can be
  // written in and the visitor hasn't confirmed it's them, then the verified line.
  const verified = chat.session?.verified === true;
  const verifyRow = latestVerifyRow(state.rows);
  // "I can't get the code" asks for the owner. While she is in the chat she is already here, so it
  // asks for nobody: it closes that card's form, sends nothing, and the visitor's place moves to the
  // composer, without scrolling the conversation. The form comes back once she is out of the chat,
  // and a later verify card brings it back under that card.
  const closeVerify = () => {
    setVerifyClosed(verifyRow);
    composerRef.current?.querySelector('textarea')?.focus({ preventScroll: true });
  };
  const verifyUnder = (row: ChatRow): ReactNode[] =>
    verifyRow !== null && rowKey(row) === verifyRow && (verified || (ready && !(ownerHere && verifyClosed === verifyRow)))
      ? [
          <VerifyInline
            key="verify"
            status={chat.verifyStatus}
            verified={verified}
            assurance={chat.session?.assurance ?? 'none'}
            language={language}
            onSubmit={chat.verify}
            onAskForOwner={chat.ownerInChat ? closeVerify : askForOwner}
          />,
        ]
      : [];

  const startNewChat = () => {
    const unsent = unsentWhenEnded(state.rows);
    // Words that didn't send go back in the new chat's box; with none, an idea still waiting stays.
    carried.current = unsent.length > 0 ? { text: unsent.join('\n'), focus: 'always' } : carried.current;
    chat.newChat();
  };
  const tryAgain = (
    <Button variant="secondary" onClick={chat.retry}>
      {copy.tryAgain}
    </Button>
  );
  let connectionNotice: ReactNode = null;
  if (ended) {
    connectionNotice = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={startNewChat}>
            {NEW_CHAT_LABEL[language]}
          </Button>
        }
      >
        {CHAT_ENDED_COPY[language]}
      </Notice>
    );
  } else if (chat.status === 'unavailable' || state.connection === 'closed') {
    connectionNotice = (
      <Notice tone="error" action={tryAgain}>
        {UNREACHABLE_COPY[language]}
      </Notice>
    );
  } else if (state.connection === 'reconnecting') {
    connectionNotice = <Notice tone="waiting">{copy.reconnecting}</Notice>;
  }
  // Why the last turn ended without a reply, in the design system's words, never the code.
  const turnNotice =
    state.error !== null && !ended ? <Notice tone="error">{evErrorCopy({ code: state.error }, language)}</Notice> : null;
  // What the visitor sends brings the end of the conversation back into view.
  const send = (text: string) => {
    newest.follow();
    visitorTyping.sent();
    chat.send(text);
  };
  const resend = (id: string) => {
    newest.follow();
    chat.resend(id);
  };

  // Above the composer, a line for each held request whose receipt is out of view, oldest first,
  // while its "Cancel this request" is drawn: the request is the kernel's, still open.
  const waitingLines = ready
    ? state.openHolds.flatMap((id) => {
        const receipt = state.latest.get(id);
        if (receipt === undefined || !waiting.away.has(id)) return [];
        return [
          <WaitingLine key={id} receipt={receipt} label={copy.viewRequest} onView={() => waiting.view(id)} onLeftWithFocus={noteWaitingLeftWithFocus} />,
        ];
      })
    : [];

  // The code the chat asked for hasn't been confirmed yet: the inbox is where it arrives.
  const awaitingCode = verifyRow !== null && !verified;
  const inboxColumn = inboxPlacement === 'column' && inboxShown(inbox, awaitingCode);
  return present(
    // One wrapper whatever the inbox does, so the shell (and what is typed in it) never remounts.
    <div className={`cd-public-chat-page${inboxColumn ? ' cd-public-chat-page--with-inbox' : ''}`}>
      <PublicShell
        brand={brand}
        ownerName={ownerName}
        language={language}
        openStatus={openStatus}
        onAskForOwner={askForOwner}
        // While the owner has taken the chat over, the head says so in the disclosure's place, still
        // naming Claude as an AI, and Ask goes. The visitor chat's own value, from the kernel's
        // session mode, as it is: nothing on the page decides it.
        ownerInChat={chat.ownerInChat}
        // While a request is open, its waiting line can come and go above the composer: the shell keeps
        // the room it takes, so the line can't switch the shell between tall and short and the move
        // that switch makes can't bring the line back.
        keepComposerRoom={ready && state.openHolds.length > 0}
        about={desk.charter}
        aboutLinks={aboutLinks}
        footer={!embedded}
        firstView={!conversationStarted(state, chat.status)}
        starters={{
          words: (desk.starters ?? []).slice(0, 3),
          disabled: !ready,
          onPick: (text) => {
            if (document.activeElement?.matches('.cd-chip:focus-visible') || !window.matchMedia('(pointer: coarse)').matches) {
              composerRef.current?.querySelector('textarea')?.focus({ preventScroll: true });
            }
            send(text);
          },
        }}
        composer={
          <>
            {waitingLines.length > 0 ? <div className="cd-public-chat__waiting">{waitingLines}</div> : null}
            <div ref={composerRef} onInput={visitorTyping.onInput}>
              <Composer
                variant="visitor"
                label={copy.message(brand.name)}
                placeholder={copy.message(brand.name)}
                sendLabel={copy.send}
                maxLength={MESSAGE_MAX_LENGTH}
                disabled={!ready}
                onSend={send}
              />
            </div>
          </>
        }
      >
        <Transcript label={copy.conversation(brand.name)}>
          {state.leading.length > 0 ? (
            <TranscriptRow
              margin={[
                ...state.leading.map((receipt, index) => (
                  <MarginReceipt key={`${receipt.ledgerSeq}-${index}`} source={receipt.source} plain={receipt.plain} ledgerSeq={receipt.ledgerSeq} />
                )),
                ...cancelsUnder(state.leading),
              ]}
            >
              {null}
            </TranscriptRow>
          ) : null}
          {state.rows.map((row) => (
            <ChatRowView
              key={rowKey(row)}
              row={row}
              paymentBlock={paymentBlock}
              ownerPreview={ownerPreview}
              ownerName={desk.owner_display_name}
              language={language}
              onResend={resend}
              after={[...cancelsUnder(shownReceipts(row, ownerPreview)), ...verifyUnder(row)]}
            />
          ))}
          {state.writing ? <WritingIndicator language={language} /> : null}
          {/* The owner typing after a take-over: her initials, her name and three dots, until her words come. */}
          {state.ownerTyping !== null ? (
            <TranscriptRow>
              <WritingIndicator language={language} variant="person" who={state.ownerTyping.name} />
            </TranscriptRow>
          ) : null}
        </Transcript>
        {inboxPlacement === 'sheet' ? <VisitorInbox view={inbox} awaitingCode={awaitingCode} placement="sheet" language={language} /> : null}
        {connectionNotice || turnNotice ? (
          <div className="cd-public-chat__notices">
            {turnNotice}
            {connectionNotice}
          </div>
        ) : null}
        {/* The end of the conversation, which useNewestInView keeps above the composer. */}
        <div ref={endRef} />
        <BeforeEachChange before={newest.beforeChange} />
      </PublicShell>
      {inboxPlacement === 'column' ? <VisitorInbox view={inbox} awaitingCode={awaitingCode} placement="column" language={language} /> : null}
    </div>
  );
}

function rowKey({ item }: ChatRow): string {
  if (item.kind === 'visitor') return `v:${item.id}`;
  if (item.kind === 'message') return `m:${item.ev.message_id}`;
  return `s:${item.id}`;
}
