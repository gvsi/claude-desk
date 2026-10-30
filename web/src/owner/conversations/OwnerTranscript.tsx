/**
 * A stored conversation as the owner reads it: each message in its own row with its receipts
 * attached under it, the owner's own words as "You", whispers with their caption, a visiting
 * agent's signed requests, and each held request's card after the row its hold is under. A receipt
 * opens the full trace of its ledger entry under its row; Escape or the close button returns focus
 * to the receipt.
 */
import { useQuery } from '@tanstack/react-query';
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { EvMessage, StatusEvent } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import type { TranscriptItem } from '../../api/views.ts';
import { AgentMessage, ClaudeMessage, FullTrace, MarginReceipt, PersonMessage, TranscriptRow, VisitorMessage, Whisper } from '../../ds/index.ts';
import { formatClock } from '../../lib/format.ts';
import { groupRows, type GroupedRow, type RowPart } from '../../lib/transcript.ts';
import { useOwnerReceipt } from './ownerReceipt.ts';

/** One receipt as the owner's transcript keeps it: its signed event, and whether it is the first for its decision. */
interface OwnerReceiptSource {
  event: StatusEvent | EvMessage;
  first: boolean;
}

type OwnerRowItem =
  | { kind: 'visitor'; n: number; text: string; translation: string | null }
  | { kind: 'agent'; n: number; text: string; request: number }
  | { kind: 'whisper'; n: number; text: string; at: string }
  | { kind: 'message'; n: number; ev: EvMessage };

type OwnerRow = GroupedRow<OwnerRowItem, OwnerReceiptSource>;

export interface OwnerTranscriptProps {
  items: readonly TranscriptItem[];
  /** Who an agent's requests come from, as the owner's screens name them. */
  agentName: string;
  /** The owner's display name: Claude's messages name them, and their own messages show their initials. */
  ownerName: string;
  /** The business's time zone, which a whisper's time is read in. */
  timezone: string;
  /** The Desk whose signed record a receipt's trace is read from. */
  deskId: string;
  /** Held requests to answer here, each drawn by `renderHeld` after the row its hold is under. */
  heldIds: readonly string[];
  renderHeld: (decisionId: string) => ReactNode;
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
function rowsOf(items: readonly TranscriptItem[]) {
  const sorted = [...items].sort((a, b) => a.n - b.n);
  const firsts = new Map<string, OwnerReceiptSource>();
  let requests = 0;
  const partOf = (item: TranscriptItem): RowPart<OwnerRowItem, OwnerReceiptSource> | null => {
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
        return { kind: 'reply', row: { kind: 'message', n: item.n, ev: event }, receipt: { event, first: false } };
      case 'status': {
        if (!isStatus(event)) return null;
        const earlier = firsts.get(event.decision_id);
        const receipt: OwnerReceiptSource = { event, first: earlier === undefined };
        if (earlier === undefined) firsts.set(event.decision_id, receipt);
        return { kind: 'receipt', receipt, beside: earlier };
      }
      default:
        return null;
    }
  };
  return groupRows(sorted, partOf);
}

/** The decisions held under `receipts`: the ones whose hold is among them. */
function holdsUnder(receipts: readonly OwnerReceiptSource[]): string[] {
  return receipts.flatMap(({ event }) => (event.type === 'held' ? [event.decision_id] : []));
}

interface ReceiptLineProps {
  source: OwnerReceiptSource;
  /** Its message reports something done, so an executed receipt draws the check. */
  done: boolean;
  onOpenTrace: (ledgerSeq: number) => void;
}

/** One receipt: the owner's line for it, a button that opens its trace. */
function ReceiptLine({ source, done, onOpenTrace }: ReceiptLineProps) {
  const view = useOwnerReceipt(source.event, source.first);
  return (
    <MarginReceipt
      source={view.source}
      plain={view.plain}
      ledgerSeq={view.ledgerSeq}
      onOpenTrace={onOpenTrace}
      drawCheck={done && view.source.kind === 'decision' && view.source.state === 'executed'}
    />
  );
}

interface RowViewProps {
  row: OwnerRow;
  agentName: string;
  ownerName: string;
  timezone: string;
  onOpenTrace: (ledgerSeq: number) => void;
}

function RowView({ row, agentName, ownerName, timezone, onOpenTrace }: RowViewProps) {
  const { item } = row;
  const done = item.kind === 'message' && item.ev.blocks.some((block) => block.kind === 'card' && DONE_CARDS.has(block.template ?? ''));
  const margin = row.receipts.map((source, index) => (
    <ReceiptLine key={`${source.event.ledger_seq}-${index}`} source={source} done={done} onOpenTrace={onOpenTrace} />
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
      message = <Whisper caption={`Your whisper, ${formatClock(item.at, timezone)}. Only Claude sees this.`} text={item.text} />;
      break;
    case 'message':
      message =
        item.ev.author === 'owner' ? (
          <PersonMessage name="You" initials={initialsOf(ownerName)} blocks={item.ev.blocks} language={item.ev.language} />
        ) : (
          <ClaudeMessage blocks={item.ev.blocks} language={item.ev.language} ownerName={ownerName} />
        );
      break;
  }
  return <TranscriptRow margin={margin}>{message}</TranscriptRow>;
}

/** The Desk's signed record, read only while a trace is open. */
function useRecord(deskId: string, open: boolean) {
  const ledger = useQuery({
    queryKey: ['ledger', deskId],
    queryFn: () => request('ledger', { params: { desk_id: deskId }, query: { verify: true } }),
    enabled: open,
  });
  const health = useQuery({ queryKey: ['health'], queryFn: () => request('health'), enabled: open });
  return { ledger, devKey: health.data?.kernel?.dev_signing_key ?? false };
}

export function OwnerTranscript({ items, agentName, ownerName, timezone, deskId, heldIds, renderHeld }: OwnerTranscriptProps) {
  const groups = useMemo(() => rowsOf(items), [items]);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const traceBox = useRef<HTMLDivElement>(null);
  const focusTrace = useRef(false);
  const { ledger, devKey } = useRecord(deskId, openSeq !== null);

  const openTrace = (ledgerSeq: number) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenSeq(ledgerSeq);
    focusTrace.current = true;
    // An entry written since the record was last read: read it again.
    if (ledger.data !== undefined && !ledger.data.entries.some((e) => e.seq === ledgerSeq)) void ledger.refetch();
  };

  // The trace takes focus once it is drawn, so a keyboard or screen reader user lands in it: the
  // line that says the record is being read first, then the trace once the record is in.
  useLayoutEffect(() => {
    if (!focusTrace.current) return;
    const box = traceBox.current;
    const full = box?.querySelector<HTMLElement>('.cd-full-trace');
    if (full) {
      focusTrace.current = false;
      full.focus();
      return;
    }
    box?.querySelector<HTMLElement>('.cd-conversation__trace-missing')?.focus();
  });
  const closeTrace = () => {
    focusTrace.current = false;
    setOpenSeq(null);
    opener.current?.focus();
  };

  const page = ledger.data;
  const entry = openSeq === null ? null : (page?.entries.find((e) => e.seq === openSeq) ?? null);
  const trace = (
    <div ref={traceBox} className="cd-conversation__trace">
      {entry !== null && page !== undefined ? (
        <FullTrace entry={entry} chain={{ chain_ok: page.chain_ok, first_bad_seq: page.first_bad_seq }} devKey={devKey} onClose={closeTrace} />
      ) : (
        <p
          className="cd-conversation__trace-missing cd-type-meta"
          role="status"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeTrace();
          }}
        >
          {ledger.isError ? "The record couldn't be read. Try again in a moment." : 'Reading the record'}
        </p>
      )}
    </div>
  );

  // Each held request after the row its hold is under; one whose hold isn't in the conversation yet goes last.
  const placed = new Set<string>();
  const heldAfter = (receipts: readonly OwnerReceiptSource[]): ReactNode[] =>
    holdsUnder(receipts)
      .filter((id) => heldIds.includes(id) && !placed.has(id))
      .map((id) => {
        placed.add(id);
        return <Fragment key={`held-${id}`}>{renderHeld(id)}</Fragment>;
      });
  const hasSeq = (receipts: readonly OwnerReceiptSource[]) => openSeq !== null && receipts.some((r) => r.event.ledger_seq === openSeq);

  const leading = groups.leading;
  const leadingHeld = heldAfter(leading);
  const rows = groups.rows.map((row) => (
    <Fragment key={`${row.item.kind}-${row.item.n}`}>
      <RowView row={row} agentName={agentName} ownerName={ownerName} timezone={timezone} onOpenTrace={openTrace} />
      {hasSeq(row.receipts) ? trace : null}
      {heldAfter(row.receipts)}
    </Fragment>
  ));
  const rest = heldIds.filter((id) => !placed.has(id)).map((id) => <Fragment key={`held-${id}`}>{renderHeld(id)}</Fragment>);

  return (
    <>
      {leading.length > 0 ? (
        <>
          <TranscriptRow
            margin={leading.map((source, index) => (
              <ReceiptLine key={`${source.event.ledger_seq}-${index}`} source={source} done={false} onOpenTrace={openTrace} />
            ))}
          >
            {null}
          </TranscriptRow>
          {hasSeq(leading) ? trace : null}
          {leadingHeld}
        </>
      ) : null}
      {rows}
      {rest}
    </>
  );
}
