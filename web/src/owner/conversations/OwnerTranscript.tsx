/**
 * A stored conversation as the owner reads it: each message in its own row with its receipts
 * attached under it, the owner's own words as "You", whispers with their caption, a visiting
 * agent's signed requests, and each held request's card after the row its hold is under. The
 * receipt that reports what the kernel decided names its state and why (ownerReceipt.ts), and a
 * hold with its card right under it names only its state, since the card says why. A receipt opens
 * the full trace of its ledger entry under its row; Escape or the close button returns focus to the
 * receipt. A record that can't be read says so there, with "Try again" and "Close". A reply that
 * arrives while the owner has the chat open is revealed as on the public page: its words, then its
 * cards and receipts one by one, and then the card of a request it held, last.
 */
import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import type { EvMessage, RenderedBlock, StatusEvent } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import type { OwnerTranscriptItem, TranscriptItem } from '../../api/views.ts';
import {
  AgentMessage,
  Button,
  ClaudeMessage,
  FullTrace,
  MarginReceipt,
  Notice,
  PersonMessage,
  TranscriptRow,
  VisitorMessage,
  Whisper,
  clockNow,
  rowComingIn,
} from '../../ds/index.ts';
import { POLL_MS } from '../../app/poll.ts';
import { formatClock } from '../../lib/format.ts';
import { groupRows, opensAReply, type GroupedRow, type RowPart } from '../../lib/transcript.ts';
import { paymentLinkMemory } from '../../public/paymentLinks.ts';
import { usePaymentLinks } from '../../public/usePaymentLinks.ts';
import { ledgerQuery } from '../safety/queries.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { useOwnerReceipt } from './ownerReceipt.ts';

/** One receipt as the owner's transcript keeps it: its signed event, whether it is the first for its decision, and its item's place. */
interface OwnerReceiptSource {
  event: StatusEvent | EvMessage;
  first: boolean;
  ownerPlain?: string | null;
  n: number;
}

type OwnerRowItem =
  | { kind: 'visitor'; n: number; text: string; translation: string | null }
  | { kind: 'agent'; n: number; text: string; request: number }
  | { kind: 'whisper'; n: number; text: string; at: string }
  | { kind: 'message'; n: number; ev: EvMessage };

type OwnerRow = GroupedRow<OwnerRowItem, OwnerReceiptSource>;

export interface OwnerTranscriptProps {
  items: readonly OwnerTranscriptItem[];
  /** The transcript log, which takes focus when a focused payment action closes. */
  focusTarget: RefObject<HTMLElement | null>;
  /** Who an agent's requests come from, as the owner's screens name them. */
  agentName: string;
  /**
   * Who the owner is in the chat: Claude's messages name them, and their own messages show these
   * initials. Their display name, or the business's when they gave none, as the sidebar's owner row
   * shows it.
   */
  ownerName: string;
  /** The business's time zone, which a whisper's time is read in. */
  timezone: string;
  /** The Desk whose signed record a receipt's trace is read from. */
  deskId: string;
  /**
   * Held requests to answer here, each drawn by `renderHeld` after the row its hold is under, in a
   * slot that takes `slot`: after a reply coming in live, its card comes in last.
   */
  heldIds: readonly string[];
  renderHeld: (decisionId: string, slot: HeldSlot) => ReactNode;
  /** Recorded history replayed into this copy: no one adds to it, so nothing in it arrives live. */
  recorded?: boolean;
  /**
   * The conversation has been read since the chat was opened. Until then the page may show a read
   * it kept from before (coming back to the chat), and what the next read adds came while the owner
   * was away, so nothing arrives live.
   */
  readSinceOpened: boolean;
}

/** What the slot a held request's card is drawn in takes from the transcript, so the card can come in after a reply arriving live. */
export interface HeldSlot {
  ref: RefObject<HTMLDivElement>;
  /** Its classes after `cd-conversation__held`: waiting, or coming in. */
  className: string;
  'aria-busy': true | undefined;
}

/** Cards that report something done: their executed receipt draws the check. */
const DONE_CARDS: ReadonlySet<string> = new Set(['booking_confirmed', 'payment_confirmed', 'charge_confirmed']);

function isStatus(ev: TranscriptItem['event']): ev is StatusEvent {
  return ev !== null && (ev.type === 'receipt' || ev.type === 'held' || ev.type === 'resolved');
}

/** The first letter of the first and last words of a name, as the owner's own messages show them. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  const last = words.length > 1 ? words.at(-1) : undefined;
  return [first, last].map((word) => (word === undefined ? '' : (Array.from(word)[0] ?? ''))).join('');
}

/**
 * The rows for `items`, in order. Someone's own words (a visitor's, an agent's, a whisper) start a
 * turn; a delivered message ends it with its receipts under it; a status attaches where its
 * decision's first receipt is, and the first status of each decision is marked as its first.
 */
function rowsOf(items: readonly OwnerTranscriptItem[]) {
  const sorted = [...items].sort((a, b) => a.n - b.n);
  const firsts = new Map<string, OwnerReceiptSource>();
  let requests = 0;
  const partOf = (item: OwnerTranscriptItem): RowPart<OwnerRowItem, OwnerReceiptSource> | null => {
    const { event } = item;
    switch (item.kind) {
      case 'visitor_text':
        return { kind: 'turn', row: { kind: 'visitor', n: item.n, text: item.text ?? '', translation: item.owner_translation ?? null } };
      case 'agent_text':
        requests += 1;
        return { kind: 'turn', row: { kind: 'agent', n: item.n, text: item.text ?? '', request: requests } };
      case 'whisper':
        return { kind: 'turn', row: { kind: 'whisper', n: item.n, text: item.text ?? '', at: item.created_at } };
      case 'delivered':
        if (event?.type !== 'message') return null;
        return { kind: 'reply', row: { kind: 'message', n: item.n, ev: event }, receipt: { event, first: false, n: item.n } };
      case 'status': {
        if (!isStatus(event)) return null;
        const earlier = firsts.get(event.decision_id);
        const receipt: OwnerReceiptSource = { event, first: earlier === undefined, ownerPlain: item.owner_plain, n: item.n };
        if (earlier === undefined) firsts.set(event.decision_id, receipt);
        return { kind: 'receipt', receipt, beside: earlier };
      }
      default:
        return null;
    }
  };
  // A turn Claude started on its own (after the visitor confirmed it's them) explains its reply, as
  // in the visitor's chat: a stored conversation finds it by what follows a decision's status.
  return groupRows(sorted, partOf, { writingBefore: opensAReply });
}

/**
 * Whether a row arrived while the owner had the chat open: a message from Claude or the Desk that a
 * read after the first one taken since opening the chat brought. The owner's own words show still,
 * as she sent them. That first read is
 * what happened so far and draws still, and so does any read the page kept from before and shows
 * until then (coming back to the chat), as recorded history always does. A row is live only in the
 * render that first shows it; `TranscriptRow` keeps its motion from there.
 */
function useArrivals(
  items: readonly OwnerTranscriptItem[],
  rows: readonly OwnerRow[],
  recorded: boolean,
  readSinceOpened: boolean,
): { arrived: (row: OwnerRow) => boolean; liveAfter: number | null } {
  // The newest item this view has shown from a read taken since it opened, or null until then.
  const shownUpTo = useRef<number | null>(null);
  // The newest item of the first read taken since it opened: anything after it came while the
  // owner watched. Null until that read is shown, and for recorded history.
  const opened = useRef<number | null>(null);
  const newest = rows.reduce((max, row) => Math.max(max, row.item.n), 0);
  const newestItem = items.reduce((max, item) => Math.max(max, item.n), 0);
  useEffect(() => {
    if (!readSinceOpened) return;
    shownUpTo.current = Math.max(shownUpTo.current ?? 0, newest);
    opened.current ??= newestItem;
  }, [newest, newestItem, readSinceOpened]);
  const before = shownUpTo.current;
  return {
    arrived: (row) => !recorded && before !== null && row.item.kind === 'message' && row.item.ev.author !== 'owner' && row.item.n > before,
    liveAfter: recorded ? null : opened.current,
  };
}

/**
 * The receipts this view has shown, by ledger seq, as of its last draw. A turn's receipt shown
 * under the question while the reply was on its way moves under the reply when it comes, already
 * read, so it doesn't land with it (`MarginReceipt`'s `shownBefore`, read when the line is drawn).
 */
function useShownReceipts(groups: ReturnType<typeof rowsOf>): ReadonlySet<number> {
  const shown = useRef(new Set<number>());
  useEffect(() => {
    for (const source of [...groups.leading, ...groups.rows.flatMap((row) => row.receipts)]) shown.current.add(source.event.ledger_seq);
  }, [groups]);
  return shown.current;
}

/** The decisions held under `receipts`: the ones whose hold is among them. */
function holdsUnder(receipts: readonly OwnerReceiptSource[]): string[] {
  return receipts.flatMap(({ event }) => (event.type === 'held' ? [event.decision_id] : []));
}

/**
 * The held requests whose cards go right after each row, given each row's receipts in order: a
 * request after the row its hold is under, once, and only one of `heldIds`, the requests the screen
 * draws a card for.
 */
function cardsAfter(rows: readonly (readonly OwnerReceiptSource[])[], heldIds: readonly string[]): string[][] {
  const placed = new Set<string>();
  return rows.map((receipts) =>
    holdsUnder(receipts).filter((id) => {
      if (!heldIds.includes(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    }),
  );
}

/**
 * The longest a held card waits for the reply before it: longer than any reply takes to come in
 * (its words in at most about 3 s, then its cards and lines), so a reveal that never finishes
 * can't keep a request unseen.
 */
const LONGEST_WAIT_MS = 8_000;

/**
 * The longest a held card whose hold came in before its reply waits for that reply: one
 * conversation poll, the time the next read takes to bring it (owner, 2026-11-02).
 */
const REPLY_WAIT_MS = POLL_MS.conversation;

/** The row a held card's slot follows, and the held cards' slots between them; null when no row is before it. */
function partsBefore(slot: Element): { row: Element; held: Element[] } | null {
  const held: Element[] = [];
  for (let el = slot.previousElementSibling; el !== null; el = el.previousElementSibling) {
    if (el.classList.contains('cd-transcript-row')) return { row: el, held };
    if (el.classList.contains('cd-conversation__held')) held.push(el);
  }
  return null;
}

/**
 * Whether what comes before a held card's slot is still coming in: the reply's words, its cards
 * and the lines under it, playing or waiting for their beat (as its row says), or a held card
 * before this one, waiting or coming in (cd-conversation-held-follow, Conversations.css).
 */
function comingIn(slot: Element): boolean {
  const parts = partsBefore(slot);
  if (parts === null) return false;
  const { row, held } = parts;
  if (rowComingIn(row)) return true;
  if (held.some((el) => el.classList.contains('cd-conversation__held--waiting'))) return true;
  const now = clockNow();
  return held.some((el) =>
    el.getAnimations().some((animation) => {
      if (!(animation instanceof CSSAnimation) || animation.animationName !== 'cd-conversation-held-follow' || animation.playState === 'finished') return false;
      const start = animation.startTime === null ? now : Number(animation.startTime);
      return start + Number(animation.effect?.getComputedTiming().endTime ?? 0) > now;
    }),
  );
}

/** How a held card is drawn: the props `HeldAfter` takes from the transcript. */
interface HeldAfterProps {
  /** The card has been seen already: it never waits again. */
  seen: boolean;
  /** Its hold came in while the owner watched, before its turn's reply: it waits for that reply. */
  waitsForReply: boolean;
  /** When the card was first drawn, on `performance.now()`'s clock, which its waits count from. */
  since: number;
  /** Says the card is seen, once it shows. */
  onSeen: () => void;
  render: (slot: HeldSlot) => ReactNode;
}

/**
 * A held request's card after the row its hold is under. It comes in last, after the reply that
 * held it: it waits unseen in its place, not focusable and busy for assistive technology, until
 * that reply's words, cards and lines have all come in, then fades and rises in (Conversations.css).
 * When its hold came in while the owner watched but before the reply (after the visitor's
 * question), it waits there for the reply for at most `REPLY_WAIT_MS` from when it was first
 * drawn: the reply coming moves it after the reply, where it waits for it as above, and no reply
 * by then shows it at once where it is. Anything else shows it at once, and never later: a card
 * already seen, one from history, reduced motion, a hidden tab, where the browser can't list its
 * animations, and any wait past `LONGEST_WAIT_MS` from when it was first drawn. A reply replaced
 * or gone while it waits ends the wait: nothing before it is coming in.
 */
function HeldAfter({ seen, waitsForReply, since, onSeen, render }: HeldAfterProps) {
  const slot = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'shown' | 'waiting' | 'landing'>('shown');
  // Read once, when the card is first drawn, before it is painted: whether it waits, and for what.
  const [first] = useState(() => ({ seen, waitsForReply, since }));
  const forReply = useRef(false);
  const said = useRef(onSeen);
  said.current = onSeen;
  useLayoutEffect(() => {
    const el = slot.current;
    if (el === null) return;
    const waits = (): boolean => {
      if (first.seen || typeof el.getAnimations !== 'function' || typeof CSSAnimation === 'undefined') return false;
      if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      forReply.current = first.waitsForReply && performance.now() - first.since < REPLY_WAIT_MS;
      return forReply.current || (partsBefore(el)?.row.classList.contains('cd-transcript-row--live') === true && comingIn(el));
    };
    if (waits()) setPhase('waiting');
    else said.current();
  }, [first]);
  useEffect(() => {
    const el = slot.current;
    if (phase !== 'waiting' || el === null) return undefined;
    const come = (next: 'shown' | 'landing') => {
      said.current();
      setPhase(next);
    };
    let frame = 0;
    const step = () => {
      // Waiting for its reply, and for whatever before it is still coming in.
      if ((forReply.current && performance.now() - first.since < REPLY_WAIT_MS) || comingIn(el)) frame = requestAnimationFrame(step);
      // No reply came in time: it shows at once, where it is.
      else if (forReply.current) come('shown');
      else come('landing');
    };
    frame = requestAnimationFrame(step);
    // A hidden tab plays nothing, so the reply would never finish coming in.
    const hidden = () => {
      if (document.hidden) come('shown');
    };
    document.addEventListener('visibilitychange', hidden);
    const longest = window.setTimeout(() => come('shown'), Math.max(0, first.since + LONGEST_WAIT_MS - performance.now()));
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', hidden);
      window.clearTimeout(longest);
    };
  }, [phase, first]);
  // Once it has come in, it is like any other card.
  useEffect(() => {
    const el = slot.current;
    if (phase !== 'landing' || el === null) return undefined;
    const landed = (event: AnimationEvent) => {
      if (event.target === el) setPhase('shown');
    };
    el.addEventListener('animationend', landed);
    el.addEventListener('animationcancel', landed);
    return () => {
      el.removeEventListener('animationend', landed);
      el.removeEventListener('animationcancel', landed);
    };
  }, [phase]);
  return render({ ref: slot, className: phase === 'shown' ? '' : ` cd-conversation__held--${phase}`, 'aria-busy': phase === 'waiting' ? true : undefined });
}

/**
 * The held requests this view has shown, and when it first drew each: a card already seen never
 * waits again when it moves (after the reply, say), and one still waiting keeps counting from when
 * it was first drawn.
 */
function useHeldCards(): { seen: (id: string) => boolean; markSeen: (id: string) => void; since: (id: string) => number } {
  const shown = useRef(new Set<string>());
  const drawn = useRef(new Map<string, number>());
  return useMemo(
    () => ({
      seen: (id) => shown.current.has(id),
      markSeen: (id) => {
        shown.current.add(id);
      },
      since: (id) => {
        const at = drawn.current.get(id) ?? performance.now();
        drawn.current.set(id, at);
        return at;
      },
    }),
    [],
  );
}

interface ReceiptLineProps {
  source: OwnerReceiptSource;
  /** Its message reports something done, so an executed receipt draws the check. */
  done: boolean;
  /** The held requests whose cards are drawn right after this receipt's row. */
  cards: readonly string[];
  /** The owner has seen it already, under another row: it doesn't land with a reply that arrives. */
  shownBefore: boolean;
  onOpenTrace: (ledgerSeq: number) => void;
}

/** One receipt: the owner's line for it, a button that opens its trace. */
function ReceiptLine({ source, done, cards, shownBefore, onOpenTrace }: ReceiptLineProps) {
  const view = useOwnerReceipt(source.event, source.first, source.ownerPlain);
  const { event } = source;
  // The hold that reports what the kernel decided, with its card right under the row: the card says why.
  const cardBelow = source.first && event.type === 'held' && cards.includes(event.decision_id);
  return (
    <MarginReceipt
      source={view.source}
      plain={view.plain}
      ledgerSeq={view.ledgerSeq}
      reason={view.reason}
      cardBelow={cardBelow}
      onOpenTrace={onOpenTrace}
      drawCheck={done && view.source.kind === 'decision' && view.source.state === 'executed'}
      shownBefore={shownBefore}
    />
  );
}

interface RowViewProps {
  row: OwnerRow;
  paymentBlock: (block: RenderedBlock) => RenderedBlock;
  /** The row arrived while the chat was open: Claude's reply is revealed, as the visitor sees it. */
  live: boolean;
  /** The held requests whose cards are drawn right after this row. */
  cards: readonly string[];
  /** The receipts shown so far, by ledger seq. */
  shown: ReadonlySet<number>;
  agentName: string;
  ownerName: string;
  timezone: string;
  onOpenTrace: (ledgerSeq: number) => void;
}

function RowView({ row, paymentBlock, live, cards, shown, agentName, ownerName, timezone, onOpenTrace }: RowViewProps) {
  const { item } = row;
  const done = item.kind === 'message' && item.ev.blocks.some((block) => block.kind === 'card' && DONE_CARDS.has(block.template ?? ''));
  const margin = row.receipts.map((source, index) => (
    <ReceiptLine
      key={`${source.event.ledger_seq}-${index}`}
      source={source}
      done={done}
      cards={cards}
      shownBefore={shown.has(source.event.ledger_seq)}
      onOpenTrace={onOpenTrace}
    />
  ));
  let message: ReactNode;
  switch (item.kind) {
    case 'visitor':
      message = <VisitorMessage text={item.text} translation={item.translation ?? undefined} />;
      break;
    case 'agent':
      message = <AgentMessage agentName={agentName} signed title="Signed request" meta={`Request ${item.request}`} text={item.text} />;
      break;
    case 'whisper':
      message = <Whisper caption={`Your whisper, ${formatClock(item.at, timezone)}. Only Claude sees this, and uses it in its next reply.`} text={item.text} />;
      break;
    case 'message':
      message =
        item.ev.author === 'owner' ? (
          <PersonMessage name="You" initials={initialsOf(ownerName)} blocks={item.ev.blocks} language={item.ev.language} />
        ) : (
          <ClaudeMessage blocks={item.ev.blocks.map(paymentBlock)} language={item.ev.language} ownerName={ownerName} reveal={live} />
        );
      break;
  }
  return (
    <TranscriptRow margin={margin} live={live}>
      {message}
    </TranscriptRow>
  );
}

/** The Desk's signed record, read only while a trace is open. */
function useRecord(deskId: string, open: boolean) {
  const ledger = useQuery({ ...ledgerQuery(deskId), enabled: open });
  const health = useQuery({ queryKey: ['health'], queryFn: () => request('health'), enabled: open });
  return { ledger, devKey: health.data?.kernel?.dev_signing_key ?? false };
}

export function OwnerTranscript({
  items,
  focusTarget,
  agentName,
  ownerName,
  timezone,
  deskId,
  heldIds,
  renderHeld,
  recorded = false,
  readSinceOpened,
}: OwnerTranscriptProps) {
  const groups = useMemo(() => rowsOf(items), [items]);
  const messages = useMemo(() => groups.rows.flatMap(({ item }) => item.kind === 'message' ? [item.ev] : []), [groups]);
  const [paymentLinks] = useState(paymentLinkMemory);
  const paymentBlock = usePaymentLinks(messages, paymentLinks, focusTarget);
  const { arrived, liveAfter } = useArrivals(items, groups.rows, recorded, readSinceOpened);
  const shown = useShownReceipts(groups);
  const heldCards = useHeldCards();
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const traceBox = useRef<HTMLDivElement>(null);
  const focusTrace = useRef(false);
  const { ledger, devKey } = useRecord(deskId, openSeq !== null);
  // Kept until a read works, so the line and its buttons stay while "Try again" reads.
  const failure = useReadFailure(ledger);

  const openTrace = (ledgerSeq: number) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenSeq(ledgerSeq);
    focusTrace.current = true;
    // An entry written since the record was last read: read it again.
    if (ledger.data !== undefined && !ledger.data.entries.some((e) => e.seq === ledgerSeq)) void ledger.refetch();
  };

  // The trace takes focus once it is drawn, so a keyboard or screen reader user lands in it: the
  // line that says the record is being read or couldn't be first, then the trace once the record
  // is in. Focus already in that line (on "Try again", say) stays where it is.
  useLayoutEffect(() => {
    if (!focusTrace.current) return;
    const box = traceBox.current;
    const full = box?.querySelector<HTMLElement>('.cd-full-trace');
    if (full) {
      focusTrace.current = false;
      full.focus();
      return;
    }
    const missing = box?.querySelector<HTMLElement>('.cd-conversation__trace-missing');
    if (missing && !missing.contains(document.activeElement)) missing.focus();
  });
  const closeTrace = () => {
    focusTrace.current = false;
    setOpenSeq(null);
    opener.current?.focus();
  };

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeTrace();
  };

  const page = ledger.data;
  const entry = openSeq === null ? null : (page?.entries.find((e) => e.seq === openSeq) ?? null);
  let traceBody: ReactNode;
  if (entry !== null && page !== undefined) {
    traceBody = <FullTrace entry={entry} chain={{ chain_ok: page.chain_ok, first_bad_seq: page.first_bad_seq }} devKey={devKey} onClose={closeTrace} />;
  } else if (failure !== null) {
    // The owner's line for the failed read, as other owner screens say it, with a way to read
    // the record again and a way to close it.
    traceBody = (
      <div className="cd-conversation__trace-missing" tabIndex={-1} onKeyDown={closeOnEscape}>
        <Notice
          tone="error"
          action={
            <span className="cd-conversation__trace-actions">
              <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
                Try again
              </Button>
              <Button variant="ghost" onClick={closeTrace}>
                Close
              </Button>
            </span>
          }
        >
          {failure.line}
        </Notice>
      </div>
    );
  } else {
    traceBody = (
      <p className="cd-conversation__trace-missing cd-conversation__trace-reading cd-type-meta" role="status" tabIndex={-1} onKeyDown={closeOnEscape}>
        Reading the record
      </p>
    );
  }
  const trace = (
    <div ref={traceBox} className="cd-conversation__trace">
      {traceBody}
    </div>
  );

  // Each held request after the row its hold is under; one whose hold isn't in the conversation yet goes last.
  const leading = groups.leading;
  const [leadingCards = [], ...rowCards] = cardsAfter([leading, ...groups.rows.map((row) => row.receipts)], heldIds);
  const placed = new Set([leadingCards, ...rowCards].flat());
  // Each held request's card comes in after the reply that held it (HeldAfter). One whose hold
  // came in while the owner watched, before that reply has come, waits for it: a hold under a row
  // that isn't Claude's reply (her question), under a reply older than the hold (a turn Claude
  // started itself, whose own reply hasn't come), or not yet in the conversation at all.
  const isReply = (row: OwnerRow) => row.item.kind === 'message' && row.item.ev.author !== 'owner';
  const holdCameLive = (receipts: readonly OwnerReceiptSource[], id: string, under?: OwnerRow) =>
    liveAfter !== null &&
    receipts.some(
      ({ event, n }) => event.type === 'held' && event.decision_id === id && n > liveAfter && (under === undefined || !isReply(under) || n > under.item.n),
    );
  const held = (ids: readonly string[], waitsForReply: (id: string) => boolean): ReactNode[] =>
    ids.map((id) => (
      <HeldAfter
        key={`held-${id}`}
        seen={heldCards.seen(id)}
        waitsForReply={waitsForReply(id)}
        since={heldCards.since(id)}
        onSeen={() => heldCards.markSeen(id)}
        render={(slot) => renderHeld(id, slot)}
      />
    ));
  const hasSeq = (receipts: readonly OwnerReceiptSource[]) => openSeq !== null && receipts.some((r) => r.event.ledger_seq === openSeq);

  const rows = groups.rows.map((row, index) => {
    const cards = rowCards[index] ?? [];
    return (
      <Fragment key={`${row.item.kind}-${row.item.n}`}>
        <RowView
          row={row}
          paymentBlock={paymentBlock}
          live={arrived(row)}
          cards={cards}
          shown={shown}
          agentName={agentName}
          ownerName={ownerName}
          timezone={timezone}
          onOpenTrace={openTrace}
        />
        {hasSeq(row.receipts) ? trace : null}
        {held(cards, (id) => holdCameLive(row.receipts, id, row))}
      </Fragment>
    );
  });
  const rest = held(
    heldIds.filter((id) => !placed.has(id)),
    () => liveAfter !== null,
  );

  return (
    <>
      {leading.length > 0 ? (
        <>
          <TranscriptRow
            margin={leading.map((source, index) => (
              <ReceiptLine
                key={`${source.event.ledger_seq}-${index}`}
                source={source}
                done={false}
                cards={leadingCards}
                shownBefore={shown.has(source.event.ledger_seq)}
                onOpenTrace={openTrace}
              />
            ))}
          >
            {null}
          </TranscriptRow>
          {hasSeq(leading) ? trace : null}
          {held(leadingCards, (id) => holdCameLive(leading, id))}
        </>
      ) : null}
      {rows}
      {rest}
    </>
  );
}
