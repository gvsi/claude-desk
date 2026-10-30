import { MarginLine } from './MarginLine.tsx';
import { receiptLine, receiptTone, type ReceiptSource } from './receiptTone.ts';

export interface MarginReceiptProps {
  /** What the receipt reports on: a reply's check or an action's decision (`receiptFromEvent`). */
  source: ReceiptSource;
  /** The event's `visitor_plain`, the kernel's line, unchanged (`receiptFromEvent`). */
  plain: string;
  /** The ledger entry the event was signed with. */
  ledgerSeq: number;
  /**
   * Owner screens only: the decision's `reason_plain`, for the receipt that reports what the kernel
   * decided. On a `decision` in `OWNER_REASON_STATES` (`held`, `refused`, `executed`, `allowed`) the
   * line reads "{words}. {reason}", its state's `OWNER_STATE_WORDS` first. Any other state keeps
   * `plain`, since the reason was written at decide time; so do a `reply` and an empty reason.
   */
  reason?: string;
  /**
   * Owner screens only: the request's `ApprovalCard` is drawn right under this receipt's row, so a
   * `held` decision reads "Held for you" alone; the card's headline gives the reason. Ignored on a
   * `reply` and on any other state.
   */
  cardBelow?: boolean;
  /** Owner screens only: makes the receipt a button that opens the full trace of `ledgerSeq`. */
  onOpenTrace?: (ledgerSeq: number) => void;
  /** An executed booking or a paid link: the sage check that draws once, shown only when handled. */
  drawCheck?: boolean;
}

/**
 * A checkpoint result attached under the message it explains: a status dot from `receiptTone`
 * and the kernel's line, or on owner screens the state's words and the decision's reason
 * (`receiptLine`). It never rewrites either line or adds a time.
 */
export function MarginReceipt({ source, plain, ledgerSeq, reason, cardBelow, onOpenTrace, drawCheck = false }: MarginReceiptProps) {
  const tone = receiptTone(source);
  const { lead, text } = receiptLine({ source, plain, reason, cardBelow });
  return (
    <MarginLine
      kind="receipt"
      tone={tone}
      lead={lead}
      text={text}
      check={drawCheck && tone === 'handled'}
      onOpen={onOpenTrace === undefined ? undefined : () => onOpenTrace(ledgerSeq)}
    />
  );
}
