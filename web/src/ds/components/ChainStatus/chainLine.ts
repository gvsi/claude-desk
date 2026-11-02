import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/**
 * The ledger header's line and its dot. Only a passed check (`chainOk` exactly `true`) reads as
 * handled; a failed one always says so, naming the entry only when its number is well formed.
 *
 * The words claim no more than the kernel's check shows. A pass means every entry still hashes and
 * verifies as signed, in an unbroken run, ending at the head the kernel last wrote, so no entry has
 * been changed. A failure at entry N is only the first entry whose check failed: that entry may have
 * changed, but so does an untouched record checked against another key (it fails at entry 1), and a
 * removed entry fails at the unchanged one after it. So a failed check says where it failed, never
 * that the record changed.
 */
export function chainLine(chainOk: boolean | null, firstBadSeq: number | null): { tone: StatusTone; line: string } {
  if (chainOk === null) return { tone: 'info', line: 'Not checked yet' };
  if (chainOk === true) return { tone: 'handled', line: 'No entry has been changed since it was written' };
  if (!Number.isInteger(firstBadSeq)) return { tone: 'refused', line: 'The record check failed' };
  return { tone: 'refused', line: `The record check failed at entry ${firstBadSeq}` };
}

/** How many entries the record holds, in words beside the header's line: "1 entry", "88 entries". */
export function entriesLabel(n: number): string {
  return n === 1 ? '1 entry' : `${n} entries`;
}
