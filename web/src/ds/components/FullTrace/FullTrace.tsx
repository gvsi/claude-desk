import { useId, type KeyboardEvent } from 'react';

import type { Health, LedgerEntry, LedgerPage } from '../../../api/contracts.ts';
import { IconButton } from '../IconButton/IconButton.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';
import { traceChainLine, traceLine } from './traceLine.ts';

import './FullTrace.css';

export interface FullTraceProps {
  /** The signed ledger entry, shown as the kernel returned it. */
  entry: LedgerEntry;
  /** The page's chain check, or `null` before there is one. */
  chain: Pick<LedgerPage, 'chain_ok' | 'first_bad_seq'> | null;
  /** `Health.dev_signing_key`: the Desk signs with the development key. */
  devKey: Health['dev_signing_key'];
  /** Called by the close button and by Escape inside the trace. */
  onClose: () => void;
  /**
   * `-1` (the default): the screen that opens the trace can move focus to it. `0` for a trace that
   * scrolls inside itself, so a keyboard can reach and scroll it, as Safety's every-entry view does
   * beside its list.
   */
  tabIndex?: 0 | -1;
}

/** Values longer than this are shortened in the middle; the whole value is in the `title`. */
const SHORTEN_OVER = 17;
const KEEP = 8;

function shorten(value: string): string {
  return value.length > SHORTEN_OVER ? `${value.slice(0, KEEP)}…${value.slice(-KEEP)}` : value;
}

/**
 * One ledger entry in full, for the owner: a plain line saying what it records, then the signed
 * record in mono (the only mono in Claude Desk) and the chain's state. Nothing is computed:
 * values are shown as given, long ones shortened in the middle.
 */
export function FullTrace({ entry, chain, devKey, onClose, tabIndex = -1 }: FullTraceProps) {
  const titleId = useId();
  const status = traceChainLine(chain, entry.seq);
  const fields: readonly [label: string, value: string, full?: string][] = [
    ['Entry', String(entry.seq)],
    ['Recorded at', entry.created_at],
    ['Previous hash', shorten(entry.prev_hash), entry.prev_hash],
    ['Hash', shorten(entry.hash), entry.hash],
    ['Signature', shorten(entry.signature), entry.signature],
    ['Signing key', shorten(entry.key_id), entry.key_id],
  ];

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };

  return (
    // The screen that opens the trace can move focus to it, and Tab reaches one that scrolls itself.
    <section className="cd-full-trace" aria-labelledby={titleId} tabIndex={tabIndex} onKeyDown={handleKeyDown}>
      <div className="cd-full-trace__top">
        <p id={titleId} className="cd-full-trace__title cd-type-control">
          Full trace of entry {entry.seq}
        </p>
        <IconButton label="Close the full trace" icon="close" onClick={onClose} />
      </div>
      <p className="cd-full-trace__plain cd-type-body">{traceLine(entry.event)}</p>
      <dl className="cd-full-trace__fields">
        {fields.map(([label, value, full]) => (
          <div key={label} className="cd-full-trace__field">
            <dt className="cd-full-trace__label cd-type-caption">{label}</dt>
            <dd className="cd-full-trace__value cd-type-trace" title={full} translate="no">
              {value}
            </dd>
          </div>
        ))}
        <div className="cd-full-trace__field cd-full-trace__field--block">
          <dt className="cd-full-trace__label cd-type-caption">What was recorded</dt>
          <dd className="cd-full-trace__value">
            <pre className="cd-full-trace__summary cd-type-trace" translate="no">
              {JSON.stringify(entry.event.summary, null, 2)}
            </pre>
          </dd>
        </div>
      </dl>
      <p className="cd-full-trace__chain cd-type-caption">
        <StatusDot tone={status.tone} />
        <span>{status.line}</span>
      </p>
      {devKey ? <p className="cd-full-trace__key cd-type-caption">Signed with a development key</p> : null}
    </section>
  );
}
