/**
 * The public chat: a Desk's page as a stranger sees it, inside the design system's PublicShell.
 * Every message, card and receipt is the kernel's, shown as it arrived; the page adds only its own
 * chrome (copy.ts) and the design system's error lines. A reply shows whole once the kernel has
 * checked it, with its receipts attached under it; while Claude writes, only "Claude is writing".
 *
 * Reused by setup's preview (`embedded`), which sits inside an owner screen.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

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
import { browserLanguage } from '../lib/language.ts';
import { brandFrom } from './brand.ts';
import type { ChatRow, SendFailure } from './chatReducer.ts';
import { PUBLIC_COPY, type PublicCopy } from './copy.ts';
import { useVisitorChat } from './PublicChatProvider.tsx';
import { useOpenStatus } from './useOpenStatus.ts';

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

/**
 * How much of the conversation, up to `end`, is hidden under the composer that stays at the bottom
 * of the window (`composer` is inside the shell's composer area, whose top padding counts).
 */
function hiddenUnderComposer(end: HTMLElement, composer: HTMLElement): number {
  const area = composer.parentElement ?? composer;
  return end.getBoundingClientRect().bottom - area.getBoundingClientRect().top;
}

/**
 * Keeps the newest message in view, as a chat does: while the visitor is at the end of the
 * conversation, whatever arrives (a reply, its receipts, "Claude is writing", a notice) scrolls up
 * to sit just above the composer. A visitor who has scrolled back to read stays where they are
 * until they send. Returns the function to call when they send.
 */
function useNewestInView(end: RefObject<HTMLElement | null>, composer: RefObject<HTMLElement | null>): () => void {
  const atTheEnd = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      if (end.current && composer.current) atTheEnd.current = hiddenUnderComposer(end.current, composer.current) <= AT_THE_END_PX;
    };
    // Captured on the document, so the page's scrolling and an embedding panel's both count.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [end, composer]);

  // After every render: the conversation may have grown under the composer.
  useLayoutEffect(() => {
    if (!atTheEnd.current || !end.current || !composer.current) return;
    const hidden = hiddenUnderComposer(end.current, composer.current);
    if (hidden <= 0) return;
    const scroller = scrollerOf(end.current);
    // At once, never animated: the words arrive in place.
    if (scroller === document.scrollingElement) window.scrollBy({ top: hidden, behavior: 'instant' });
    else scroller.scrollBy({ top: hidden, behavior: 'instant' });
  });

  return () => {
    atTheEnd.current = true;
  };
}

/**
 * Puts `text` in the composer's text box as if the visitor had typed it, so the design system's
 * Composer takes it as its own (it keeps its text itself and takes none from outside), then
 * focuses the box with the caret at the end.
 */
function fillComposer(box: HTMLTextAreaElement, text: string): void {
  // The prototype's setter, so React sees the change, then the input event it listens for.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
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
  const followTheEnd = useNewestInView(endRef, composerRef);

  useEffect(() => {
    if (chat.session !== null) onSession?.(chat.session);
  }, [chat.session, onSession]);

  // On its own page the tab names the business, as the kernel serves it; the app's name comes back
  // when the page closes. Inside an owner screen the tab is the owner's.
  const tabTitle = embedded ? null : (desk?.business_name ?? null);
  useEffect(() => {
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
  // so it stays with the request however far the chat goes on.
  const cancelsUnder = (receipts: readonly ReceiptView[]): ReactNode[] => {
    if (!ready) return [];
    return state.openHolds
      .filter((id) => {
        const held = state.holds.get(id);
        return held !== undefined && receipts.includes(held);
      })
      .map((id) => (
        <div key={`cancel-${id}`} className="cd-public-chat__cancel">
          <Button variant="ghost" busy={chat.cancelling === id} onClick={() => chat.cancel(id)}>
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
    followTheEnd();
    chat.send(text);
  };
  const resend = (id: string) => {
    followTheEnd();
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
        <div ref={composerRef}>
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
      </Transcript>
      {connectionNotice || turnNotice ? (
        <div className="cd-public-chat__notices">
          {turnNotice}
          {connectionNotice}
        </div>
      ) : null}
      {/* The end of the conversation, which useNewestInView keeps above the composer. */}
      <div ref={endRef} />
    </PublicShell>
  );
}

function rowKey({ item }: ChatRow): string {
  if (item.kind === 'visitor') return `v:${item.id}`;
  if (item.kind === 'message') return `m:${item.ev.message_id}`;
  return `s:${item.seq}`;
}
