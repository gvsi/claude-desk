import type { Health, LedgerPage } from '../../../api/contracts.ts';
import { StatusDot } from '../StatusDot/StatusDot.tsx';
import { chainLine, entriesLabel } from './chainLine.ts';

import './ChainStatus.css';

export interface ChainStatusProps {
  /** `LedgerPage.chain_ok`, or `null` before the ledger has been read. */
  chainOk: LedgerPage['chain_ok'] | null;
  /** `LedgerPage.first_bad_seq`: the first entry whose check failed. */
  firstBadSeq: LedgerPage['first_bad_seq'];
  /** How many entries the page holds (`entries.length`). */
  entries: number;
  /** `Health.dev_signing_key`: the Desk signs with the development key. */
  devKey: Health['dev_signing_key'];
}

/**
 * The Safety ledger's header: whether any signed entry has changed since it was written, how many
 * entries there are, in words, and whether they are signed with the development key.
 */
export function ChainStatus({ chainOk, firstBadSeq, entries, devKey }: ChainStatusProps) {
  const { tone, line } = chainLine(chainOk, firstBadSeq);
  return (
    <div className="cd-chain-status">
      <p className="cd-chain-status__line cd-type-body">
        <StatusDot tone={tone} />
        <span>{line}</span>
      </p>
      <p className="cd-chain-status__count cd-type-caption">{entriesLabel(entries)}</p>
      {devKey ? <p className="cd-chain-status__key cd-type-caption">Signed with a development key</p> : null}
    </div>
  );
}
