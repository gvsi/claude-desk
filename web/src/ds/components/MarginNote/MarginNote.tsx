import { MarginLine } from '../MarginReceipt/MarginLine.tsx';

export interface MarginNoteProps {
  /** The owner screen's words: "Name and phone saved to Customers as a new lead." */
  text: string;
  /** Makes the note a button that opens the full trace behind it. */
  onOpen?: () => void;
}

/**
 * An owner note attached under a message that isn't a checkpoint result (a lead saved, a whisper applied):
 * the hollow info dot beside the line, laid out like a `MarginReceipt`.
 */
export function MarginNote({ text, onOpen }: MarginNoteProps) {
  return <MarginLine kind="note" tone="info" text={text} onOpen={onOpen} />;
}
