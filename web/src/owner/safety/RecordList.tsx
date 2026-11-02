import { useRef, useState } from 'react';

import type { LedgerEntry, LedgerPage } from '../../api/contracts.ts';
import { EmptyState, FullTrace } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { REPLAYED_LABEL, entryCopy, entryTime, originCopy, replayedOf } from './copy.ts';
import { focusTrace } from './focusTrace.ts';

export interface RecordListProps {
  page: LedgerPage;
  /** `Health.dev_signing_key`, for the trace. */
  devKey: boolean;
  /** The business's time zone, which every time is read in. */
  timezone: string;
}

interface RecordRowProps {
  entry: LedgerEntry;
  timezone: string;
  /** Its trace is open. */
  open: boolean;
  onOpen: (row: HTMLButtonElement) => void;
}

/** One entry's row: its number, what it records, who wrote it and when it happened, as one button that opens its trace. */
function RecordRow({ entry, timezone, open, onOpen }: RecordRowProps) {
  const replayed = replayedOf(entry) !== null;
  const kind = entryCopy(entry.event);
  const who = originCopy(entry.event.origin);
  const when = formatWhen(entryTime(entry), timezone, new Date());
  // Read as one line, the words shown in order: "Entry 48, Action checked, Recorded by your Desk, Today, 9:52 am".
  const name = [`Entry ${entry.seq}`, kind, ...(replayed ? [REPLAYED_LABEL] : []), who, when].join(', ');
  return (
    <button type="button" className="cd-record__row" aria-label={name} aria-expanded={open} onClick={(event) => onOpen(event.currentTarget)}>
      <span className="cd-record__seq cd-type-meta">{entry.seq}</span>
      <span className="cd-record__what">
        <span className="cd-record__kind cd-type-control">{kind}</span>
        {replayed ? <span className="cd-record__replayed cd-type-caption">{REPLAYED_LABEL}</span> : null}
      </span>
      <span className="cd-record__who cd-type-caption">{who}</span>
      <span className="cd-record__when cd-type-meta">{when}</span>
    </button>
  );
}

/**
 * Safety's "Every entry": the signed record, newest first, each row saying what the entry records,
 * where it came from and when it happened. A row opens the entry's full trace beside the list (under
 * it on a narrow window), with the chain's check and the signing key; closing the trace returns to
 * the row.
 */
export function RecordList({ page, devKey, timezone }: RecordListProps) {
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const trace = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const entries = [...page.entries].sort((a, b) => b.seq - a.seq);
  const open = openSeq === null ? null : (entries.find((e) => e.seq === openSeq) ?? null);

  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing in the record yet"
        body="Every chat, check and answer on this Desk is written here as it happens. Start a chat from your public page to see the first entries."
      />
    );
  }

  const openEntry = (seq: number, el: HTMLButtonElement) => {
    opener.current = el;
    setOpenSeq(seq);
    // The trace takes focus once it is drawn, so a keyboard or screen reader user lands in it.
    requestAnimationFrame(() => focusTrace(trace.current));
  };
  const close = () => {
    setOpenSeq(null);
    opener.current?.focus();
  };

  return (
    <div className="cd-safety__split">
      <div className="cd-record">
        <div className="cd-record__head cd-type-caption" aria-hidden="true">
          <span>Entry</span>
          <span>What</span>
          <span>From</span>
          <span className="cd-record__head-when">Time</span>
        </div>
        <ul className="cd-record__list" aria-label="Every entry, newest first">
          {entries.map((entry) => (
            <li key={entry.seq}>
              <RecordRow entry={entry} timezone={timezone} open={entry.seq === openSeq} onOpen={(el) => openEntry(entry.seq, el)} />
            </li>
          ))}
        </ul>
      </div>
      <div className="cd-safety__beside" ref={trace}>
        {open ? (
          <FullTrace entry={open} chain={{ chain_ok: page.chain_ok, first_bad_seq: page.first_bad_seq }} devKey={devKey} onClose={close} />
        ) : (
          <p className="cd-safety__hint cd-type-meta">Choose an entry to see its full trace.</p>
        )}
      </div>
    </div>
  );
}
