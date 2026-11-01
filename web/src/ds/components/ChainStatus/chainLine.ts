import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/**
 * The ledger header's line and its dot. Only a passed check (`chainOk` exactly `true`) reads as
 * handled; a broken chain always says so, naming the entry only when its number is well formed.
 */
export function chainLine(chainOk: boolean | null, firstBadSeq: number | null): { tone: StatusTone; line: string } {
  if (chainOk === null) return { tone: 'info', line: 'Not checked yet' };
  if (chainOk === true) return { tone: 'handled', line: 'Every entry matches the chain' };
  if (!Number.isInteger(firstBadSeq)) return { tone: 'refused', line: "An entry doesn't match the chain" };
  return { tone: 'refused', line: `Entry ${firstBadSeq} doesn't match the chain` };
}
