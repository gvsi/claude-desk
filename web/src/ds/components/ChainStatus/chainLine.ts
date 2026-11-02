import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/**
 * The ledger header's line and its dot. Only a passed check (`chainOk` exactly `true`) reads as
 * handled; a failed one always says so, naming the entry only when its number is well formed.
 *
 * The words claim no more than the kernel's check shows. A pass means every entry still hashes and
 * verifies as signed, in an unbroken run, ending at the head the kernel last wrote, so no entry has
 * been changed. A failure at entry N is the first place the record stops checking out: that entry
 * changed, or one before it or past the end was removed or added, so the line says where the record
 * changed, never that entry N itself did.
 */
export function chainLine(chainOk: boolean | null, firstBadSeq: number | null): { tone: StatusTone; line: string } {
  if (chainOk === null) return { tone: 'info', line: 'Not checked yet' };
  if (chainOk === true) return { tone: 'handled', line: 'No entry has been changed since it was written' };
  if (!Number.isInteger(firstBadSeq)) return { tone: 'refused', line: 'Something in this record has changed since it was written' };
  return { tone: 'refused', line: `Something in this record changed at entry ${firstBadSeq}` };
}

/** How many entries the record holds, in words beside the header's line: "1 entry", "88 entries". */
export function entriesLabel(n: number): string {
  return n === 1 ? '1 entry' : `${n} entries`;
}
