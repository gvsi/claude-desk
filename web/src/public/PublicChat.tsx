/**
 * The public chat: a Desk's page as a stranger sees it, inside the design system's PublicShell.
 * Every message, card and receipt is the kernel's, shown as it arrived; the page adds only its own
 * chrome (copy.ts) and the design system's error lines. A reply shows whole once the kernel has
 * checked it, with its receipts attached under it; while Claude writes, only "Claude is writing".
 *
 * Reused by setup's preview (`embedded`), which sits inside an owner screen.
 */
import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import type { SessionState } from '../api/contracts.ts';
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
  PersonMessage,
  PublicShell,
  RATE_LIMITED_COPY,
  SystemLine,
  Transcript,
  TranscriptRow,
  UNREACHABLE_COPY,
  VisitorMessage,
  WritingIndicator,
  evErrorCopy,
  type CopyLanguage,
  type ReceiptView,
} from '../ds/index.ts';
import { fillComposer } from '../lib/composer.ts';
import { browserLanguage } from '../lib/language.ts';
import { brandFrom } from './brand.ts';
import type { ChatRow, SendFailure } from './chatReducer.ts';
import { PUBLIC_COPY, type PublicCopy } from './copy.ts';
import { useVisitorChat } from './PublicChatProvider.tsx';
import { useOpenStatus } from './useOpenStatus.ts';
import { useVisitorTyping } from './useVisitorTyping.ts';

import './PublicChat.css';

/** Plan 02's limit on a visitor's message. */
export const MESSAGE_MAX_LENGTH = 2000;

export interface PublicChatProps {
  slug: string;
  /** Inside an owner screen, which has its own footer and landmarks. */
  embedded?: boolean;
  /** The owner's preview of this Desk (Today's "Chat as a customer"). */
  previewDeskId?: string;
  /** Called with the chat's session once it is open. */
  onSession?: (session: SessionState) => void;
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

interface RowProps {
  row: ChatRow;
  ownerName: string;
  language: CopyLanguage;
  onResend: (id: string) => void;
  /** What goes under the row's receipts: "Cancel this request" for each open hold it holds. */
  after?: ReactNode[];
}

/** One row: the message and, attached under it, its receipts exactly as the kernel wrote them. */
function ChatRowView({ row, ownerName, language, onResend, after = [] }: RowProps) {
  const { item } = row;
  const copy = PUBLIC_COPY[language];
  const done = item.kind === 'message' && item.ev.blocks.some((block) => block.kind === 'card' && DONE_CARDS.has(block.template ?? ''));
  const receipts = [
    ...row.receipts.map((receipt: ReceiptView, index) => (
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
    return <TranscriptRow margin={receipts}>{line}</TranscriptRow>;
  }
  const { ev } = item;
  return (
    <TranscriptRow margin={receipts}>
      {ev.author === 'owner' ? (
        <PersonMessage name={ownerName} blocks={ev.blocks} language={ev.language} />
      ) : (
        <ClaudeMessage blocks={ev.blocks} language={ev.language} ownerName={ownerName} />
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

/** Where the conversation is scrolled: the element whose scrolling moves it, and how far down. */
interface ScrollerAt {
  scroller: Element;
  top: number;
}

/** Where the element whose scrolling moves `el` stands now. */
function scrollerAt(el: Element): ScrollerAt {
  const scroller = scrollerOf(el);
  return { scroller, top: scroller.scrollTop };
}

/** The design system's classes for the shell around the page and its composer area, which stays at the bottom of the window. */
const SHELL = '.cd-public-shell';
const COMPOSER_AREA = '.cd-public-shell__composer';

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
 * moving away. It can scroll the conversation too: when the window narrows and the rows rewrap
 * taller, the browser's scroll anchoring moves the conversation down to keep the rows on screen
 * where they were. So while the visitor is at the end, only a move up counts as them leaving it;
 * once they have moved back, any move counts.
 */
function useNewestInView(end: RefObject<HTMLElement | null>, composer: RefObject<HTMLElement | null>, shown: boolean): NewestInView {
  const atTheEnd = useRef(true);
  /** Where the conversation's scroller stood when the page last knew where the visitor was. */
  const seenAt = useRef<ScrollerAt | null>(null);

  // The page knows where the visitor is, with the conversation scrolled as it is now.
  const noteSeen = useCallback(() => {
    seenAt.current = end.current ? scrollerAt(end.current) : null;
  }, [end]);

  // Brings the end of the conversation up to the composer, at once and never animated, while the
  // visitor is at the end, and notes that they still are.
  const pin = useCallback(() => {
    if (!atTheEnd.current || !end.current || !composer.current) return;
    const hidden = hiddenUnderComposer(end.current, composer.current);
    if (hidden > 0) {
      const scroller = scrollerOf(end.current);
      if (scroller === document.scrollingElement) window.scrollBy({ top: hidden, behavior: 'instant' });
      else scroller.scrollBy({ top: hidden, behavior: 'instant' });
    }
    noteSeen();
  }, [end, composer, noteSeen]);

  // Whether the visitor is at the end, as the page stands now.
  const notePlace = useCallback(() => {
    if (end.current && composer.current) atTheEnd.current = hiddenUnderComposer(end.current, composer.current) <= AT_THE_END_PX;
    noteSeen();
  }, [end, composer, noteSeen]);

  // Whether the conversation has scrolled since the page last knew where the visitor was, in a way
  // that may have moved them. Its scroller changing is not the visitor moving: setup's preview
  // scrolls the page until the conversation overflows the panel around it, and the panel from then
  // on. While the visitor is at the end, only a move up counts: nothing lies below the end, and the
  // browser's scroll anchoring moves the conversation down when the rows above grow.
  const scrolledSinceSeen = useCallback((): boolean => {
    const seen = seenAt.current;
    if (!seen || !end.current) return false;
    const now = scrollerAt(end.current);
    if (now.scroller !== seen.scroller) return false;
    return atTheEnd.current ? now.top < seen.top : now.top !== seen.top;
  }, [end]);

  useEffect(() => {
    // Captured on the document, so the page's scrolling and an embedding panel's both count.
    document.addEventListener('scroll', notePlace, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', notePlace, { capture: true });
  }, [notePlace]);

  // The page changing size moves the end without a render: the shell rewraps when the window or
  // the panel around it resizes, and the composer area grows with what is typed. Watched while the
  // shell is `shown`.
  useEffect(() => {
    const shell = shown ? end.current?.closest(SHELL) : null;
    const area = composer.current?.closest(COMPOSER_AREA);
    if (typeof ResizeObserver === 'undefined' || !shell) return undefined;
    const observer = new ResizeObserver(pin);
    observer.observe(shell);
    if (area) observer.observe(area);
    return () => observer.disconnect();
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

export function PublicChat({ slug, embedded = false, previewDeskId, onSession }: PublicChatProps) {
  const chat = useVisitorChat(slug, previewDeskId);
  // Page chrome follows the browser; each message's cards follow the message's own language.
  const [language] = useState(browserLanguage);
  const copy = PUBLIC_COPY[language];
  const { openStatus, desk } = useOpenStatus(slug, chat.desk);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const newest = useNewestInView(endRef, composerRef, desk !== null);
  // While the visitor types, the owner's view of the chat shows that someone is, never what.
  const visitorTyping = useVisitorTyping(slug);

  useEffect(() => {
    if (chat.session !== null) onSession?.(chat.session);
  }, [chat.session, onSession]);

  // On its own page the tab names the business, as the kernel serves it; the app's name comes back
  // when the page closes. Inside an owner screen the tab is the owner's. A layout effect, as every page that
  // names the tab uses, so each hands the title back in the commit that leaves it.
  const tabTitle = embedded ? null : (desk?.business_name ?? null);
  useLayoutEffect(() => {
    if (tabTitle === null) return undefined;
    const before = document.title;
    document.title = tabTitle;
    return () => {
      document.title = before;
    };
  }, [tabTitle]);

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

  // Words that didn't send when the chat ended wait in the new chat's composer once it can be used.
  const carried = useRef<string | null>(null);
  // The chat can be written in: it loaded, and its session hasn't ended.
  const ready = chat.status === 'ready' && chat.state.error !== 'session';
  useEffect(() => {
    const text = carried.current;
    const box = composerRef.current?.querySelector('textarea');
    if (!ready || text === null || !box) return;
    carried.current = null;
    fillComposer(box, text);
  }, [ready]);

  if (chat.status === 'not_found') {
    return (
      <PublicState embedded={embedded} language={language}>
        <EmptyState title={copy.deskUnavailableTitle} body={copy.deskUnavailableBody} />
      </PublicState>
    );
  }
  if (desk === null) {
    return (
      <PublicState embedded={embedded} language={language}>
        {chat.status === 'unavailable' ? (
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
        ) : (
          <p className="cd-public-state__opening cd-type-meta" role="status">
            {copy.opening}
          </p>
        )}
      </PublicState>
    );
  }

  const { brand, ownerName } = brandFrom(desk);
  const { state } = chat;
  const ended = state.error === 'session';
  // "Cancel this request" under each message that holds an open hold's receipt, once it is there,
  // so it stays with the request however far the chat goes on. One cancel is out at a time: while
  // it is, the others wait, their words shown and their clicks ignored, so none goes unanswered.
  const cancelsUnder = (receipts: readonly ReceiptView[]): ReactNode[] => {
    if (!ready) return [];
    return state.openHolds
      .filter((id) => {
        const held = state.holds.get(id);
        return held !== undefined && receipts.includes(held);
      })
      .map((id) => (
        <div key={`cancel-${id}`} className="cd-public-chat__cancel">
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

  const startNewChat = () => {
    const unsent = unsentWhenEnded(state.rows);
    carried.current = unsent.length > 0 ? unsent.join('\n') : null;
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

  return (
    <PublicShell
      brand={brand}
      ownerName={ownerName}
      language={language}
      openStatus={openStatus}
      onAskForOwner={() => send(copy.askForOwner(ownerName))}
      about={desk.charter}
      footer={!embedded}
      composer={
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
            ownerName={ownerName}
            language={language}
            onResend={resend}
            after={cancelsUnder(row.receipts)}
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
  );
}

function rowKey({ item }: ChatRow): string {
  if (item.kind === 'visitor') return `v:${item.id}`;
  if (item.kind === 'message') return `m:${item.ev.message_id}`;
  return `s:${item.seq}`;
}
