import { MarginLine } from './MarginLine.tsx';
import { receiptTone, type ReceiptSource } from './receiptTone.ts';

export interface MarginReceiptProps {
  /** What the receipt reports on: a reply's check or an action's decision (`receiptFromEvent`). */
  source: ReceiptSource;
  /**
   * The line, shown exactly as given. Visitor surfaces pass the event's `visitor_plain` unchanged;
   * owner screens may pass the decision's `reason_plain`.
   */
  plain: string;
  /** The ledger entry the event was signed with. */
  ledgerSeq: number;
  /** Owner screens only: makes the receipt a button that opens the full trace of `ledgerSeq`. */
  onOpenTrace?: (ledgerSeq: number) => void;
  /** An executed booking or a paid link: the sage check that draws once, shown only when handled. */
  drawCheck?: boolean;
}

/**
 * A checkpoint result in the margin beside the message it explains: a status dot from
 * `receiptTone` and the kernel's line. It never rewrites the line or adds a time.
 */
export function MarginReceipt({ source, plain, ledgerSeq, onOpenTrace, drawCheck = false }: MarginReceiptProps) {
  const tone = receiptTone(source);
  return (
    <MarginLine
      kind="receipt"
      tone={tone}
      text={plain}
      check={drawCheck && tone === 'handled'}
      onOpen={onOpenTrace === undefined ? undefined : () => onOpenTrace(ledgerSeq)}
    />
  );
}
