/**
 * A stored conversation as the owner reads it: each message in its own row with its receipts
 * attached under it, the owner's own words as "You", whispers with their caption, a visiting
 * agent's signed requests, and each held request's card after the row its hold is under. The
 * receipt that reports what the kernel decided names its state and why (ownerReceipt.ts), and a
 * hold with its card right under it names only its state, since the card says why. A receipt opens
 * the full trace of its ledger entry under its row; Escape or the close button returns focus to the
 * receipt. A record that can't be read says so there, with "Try again" and "Close". A reply that
 * arrives while the owner has the chat open is revealed as on the public page: its words, then its
 * cards and receipts one by one.
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
} from '../../ds/index.ts';
import { formatClock } from '../../lib/format.ts';
import { groupRows, opensAReply, withoutRepeatedCards, type CardsRow, type GroupedRow, type RowPart } from '../../lib/transcript.ts';
import { paymentLinkMemory } from '../../public/paymentLinks.ts';
import { usePaymentLinks } from '../../public/usePaymentLinks.ts';
import { ledgerQuery } from '../safety/queries.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { useOwnerReceipt } from './ownerReceipt.ts';

/** One receipt as the owner's transcript keeps it: its signed event, and whether it is the first for its decision. */
interface OwnerReceiptSource {
  event: StatusEvent | EvMessage;
  first: boolean;
  ownerPlain?: string | null;
}

type OwnerRowItem =
  | { kind: 'visitor'; n: number; text: string; translation: string | null }
  | { kind: 'agent'; n: number; text: string; request: number }
  | { kind: 'whisper'; n: number; text: string; at: string }
  /** `turn` counts what started a turn before it, a take-over and hand-back included, which draw no row here. */
  | { kind: 'message'; n: number; ev: EvMessage; turn: number };

type OwnerRow = GroupedRow<OwnerRowItem, OwnerReceiptSource>;

/** How a row reads for `withoutRepeatedCards`: Claude's reply, or someone's words, which start a turn. */
function cardsRowOf({ item }: OwnerRow): CardsRow {
  return item.kind === 'message' && item.ev.author !== 'owner' ? { kind: 'reply', blocks: item.ev.blocks, turn: item.turn } : { kind: 'words' };
}

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
  /** Held requests to answer here, each drawn by `renderHeld` after the row its hold is under. */
  heldIds: readonly string[];
  renderHeld: (decisionId: string) => ReactNode;
  /** Recorded history replayed into this copy: no one adds to it, so nothing in it arrives live. */
  recorded?: boolean;
  /**
   * The conversation has been read since the chat was opened. Until then the page may show a read
   * it kept from before (coming back to the chat), and what the next read adds came while the owner
   * was away, so nothing arrives live.
   */
  readSinceOpened: boolean;
}

/** What starts a turn, with the owner's own messages: someone's words, and the owner joining or leaving. A stopped draft doesn't. */
const TURN_STARTS: ReadonlySet<OwnerTranscriptItem['kind']> = new Set(['visitor_text', 'agent_text', 'whisper', 'owner_joined', 'owner_left']);

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
  let turns = 0;
  const partOf = (item: OwnerTranscriptItem): RowPart<OwnerRowItem, OwnerReceiptSource> | null => {
    const { event } = item;
    if (TURN_STARTS.has(item.kind) || (item.kind === 'delivered' && event?.type === 'message' && event.author === 'owner')) turns += 1;
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
        return { kind: 'reply', row: { kind: 'message', n: item.n, ev: event, turn: turns }, receipt: { event, first: false } };
      case 'status': {
        if (!isStatus(event)) return null;
        const earlier = firsts.get(event.decision_id);
        const receipt: OwnerReceiptSource = { event, first: earlier === undefined, ownerPlain: item.owner_plain };
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
function useArrivals(rows: readonly OwnerRow[], recorded: boolean, readSinceOpened: boolean): (row: OwnerRow) => boolean {
  // The newest item this view has shown from a read taken since it opened, or null until then.
  const shownUpTo = useRef<number | null>(null);
  const newest = rows.reduce((max, row) => Math.max(max, row.item.n), 0);
  useEffect(() => {
    if (readSinceOpened) shownUpTo.current = Math.max(shownUpTo.current ?? 0, newest);
  }, [newest, readSinceOpened]);
  const before = shownUpTo.current;
  return (row) => !recorded && before !== null && row.item.kind === 'message' && row.item.ev.author !== 'owner' && row.item.n > before;
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
  /** Claude's reply's blocks to draw, without the cards its turn already drew; null for other rows. */
  blocks: readonly RenderedBlock[] | null;
  agentName: string;
  ownerName: string;
  timezone: string;
  onOpenTrace: (ledgerSeq: number) => void;
}

function RowView({ row, paymentBlock, live, cards, shown, blocks, agentName, ownerName, timezone, onOpenTrace }: RowViewProps) {
  const { item } = row;
  const done = item.kind === 'message' && item.ev.blocks.some((block) => block.kind === 'card' && DONE_CARDS.has(block.template ?? ''));
  // A reply with nothing its turn hasn't drawn already isn't drawn, nor its own check, the check
  // of nothing shown. Any other receipt under it stays.
  const hidden = item.kind === 'message' && item.ev.author !== 'owner' && blocks?.length === 0;
  const margin = row.receipts.filter((source) => !hidden || source.event.type !== 'message').map((source, index) => (
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
          <ClaudeMessage blocks={(blocks ?? item.ev.blocks).map(paymentBlock)} language={item.ev.language} ownerName={ownerName} reveal={live} />
        );
      break;
  }
  if (hidden && margin.length === 0) return null;
  return (
    <TranscriptRow margin={margin} live={live}>
      {hidden ? null : message}
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
  // Each reply's blocks without the cards its turn already drew.
  const replyBlocks = useMemo(() => withoutRepeatedCards(groups.rows.map(cardsRowOf)), [groups]);
  const messages = useMemo(() => groups.rows.flatMap(({ item }) => item.kind === 'message' ? [item.ev] : []), [groups]);
  const [paymentLinks] = useState(paymentLinkMemory);
  const paymentBlock = usePaymentLinks(messages, paymentLinks, focusTarget);
  const arrived = useArrivals(groups.rows, recorded, readSinceOpened);
  const shown = useShownReceipts(groups);
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
  const held = (ids: readonly string[]): ReactNode[] => ids.map((id) => <Fragment key={`held-${id}`}>{renderHeld(id)}</Fragment>);
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
          blocks={replyBlocks[index] ?? null}
          agentName={agentName}
          ownerName={ownerName}
          timezone={timezone}
          onOpenTrace={openTrace}
        />
        {hasSeq(row.receipts) ? trace : null}
        {held(cards)}
      </Fragment>
    );
  });
  const rest = held(heldIds.filter((id) => !placed.has(id)));

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
          {held(leadingCards)}
        </>
      ) : null}
      {rows}
      {rest}
    </>
  );
}
