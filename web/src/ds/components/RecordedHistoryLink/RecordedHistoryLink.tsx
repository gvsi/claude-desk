import './RecordedHistoryLink.css';

export interface RecordedHistoryLinkProps {
  /** The ledger's explanation, "Recorded history, replayed into your copy". */
  href: string;
}

/**
 * "Includes recorded history": the quiet caption on a page whose rows include recorded history,
 * as a link to the ledger's explanation of what was replayed into this copy and how.
 */
export function RecordedHistoryLink({ href }: RecordedHistoryLinkProps) {
  return (
    <a className="cd-recorded-history-link cd-type-caption" href={href}>
      Includes recorded history
    </a>
  );
}
