import { MarginLine } from './MarginLine.tsx';

export interface RulesReceiptProps {
  /** The version now in force, from the API's answer to the confirm, never the draft's guess. */
  version: number;
}

/**
 * The checkpoint result under Claude's message once the owner confirmed a rules change: "Confirmed.
 * Version 8 of your rules, checked against the always-on rules.", with the handled dot. Drawn as
 * the confirm is answered, outside a conversation's rows, it lands on its own as a live receipt
 * does: rising as it fades in, its dot growing from half size.
 */
export function RulesReceipt({ version }: RulesReceiptProps) {
  return <MarginLine kind="receipt" tone="handled" lead="Confirmed." text={`Version ${version} of your rules, checked against the always-on rules.`} lands />;
}
