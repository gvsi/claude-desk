import type { LedgerEvent, LedgerPage } from '../../../api/contracts.ts';
import { handoffEntryOf, type HandoffEntry } from '../../../api/handoffEntry.ts';
import type { StatusTone } from '../StatusDot/StatusDot.tsx';

/** What each kind of ledger entry records, in plain words. A kind missing here is a compile error. */
const KIND_LINES = {
  session: 'A chat started.',
  auth: 'A check of who sent a request.',
  verify: 'A step in confirming who someone is.',
  decide: 'A decision on an action Claude asked to take.',
  review: "The auto reviewer's second look at an action.",
  breaker: 'A turned-down request counted against the chat.',
  approval: 'A request held for you, or your answer to it.',
  execute: 'An action being carried out, or its result.',
  payment: 'A step in a test payment.',
  document_link: 'A private document link, given out or opened.',
  reply: 'A reply checked before it could be shown.',
  policy: 'A change to your rules, or a check of them.',
  tool_pin: "A connected tool's definition, confirmed or changed.",
  takeover: 'The chat was taken over, paused or handed back to Claude.',
  whisper: 'A whisper to Claude.',
  rate_limit: 'A limit on how fast requests can come in was reached.',
  agent_auth: "A check of a visiting agent's signature.",
  head_checkpoint: 'A signed checkpoint of the record so far.',
  desk_data: "A change to your Desk's details.",
  web_search: 'Web search.',
  business_tools: "A change to your Desk's jobs.",
} as const satisfies Record<LedgerEvent['kind'], string>;

/**
 * Handoff entries share the owner's history rule and read the owner's history row names, each as a
 * sentence: one line per handoff state.
 */
const HANDOFF_LINES = {
  opened: 'Chat handed to you.',
  done: 'Chat marked done.',
  replaced: 'Chat moved to a call-back.',
  took_over: 'Handoff closed when you took over.',
  wrote: 'Handoff closed when you wrote in the chat.',
} as const satisfies Record<HandoffEntry, string>;

/** Who wrote the entry: the checkpoint, or the chat service, whose report is recorded as it arrived, unchecked. */
const ORIGIN_LINES = {
  kernel: 'Recorded by the checkpoint.',
  api: 'Reported by the chat service, not checked by the checkpoint.',
} as const satisfies Record<LedgerEvent['origin'], string>;

/**
 * The trace's plain line: what the entry records (handoffs have their own line), then who recorded
 * it. A kind this build doesn't know reads as "An entry in the record."; an origin it doesn't
 * know reads as reported, never as checked.
 */
export function traceLine(event: Pick<LedgerEvent, 'kind' | 'origin' | 'summary'>): string {
  const handoff = handoffEntryOf(event);
  const what = handoff !== null
    ? HANDOFF_LINES[handoff]
    : Object.hasOwn(KIND_LINES, event.kind) ? KIND_LINES[event.kind] : 'An entry in the record.';
  const who = event.origin === 'kernel' ? ORIGIN_LINES.kernel : ORIGIN_LINES.api;
  return `${what} ${who}`;
}

/**
 * The chain line under a trace. Verified only when the kernel's check passed (`chain_ok` exactly
 * `true`); a broken chain without a well-formed entry number still reads as broken, and no check
 * yet claims nothing.
 */
export function traceChainLine(chain: Pick<LedgerPage, 'chain_ok' | 'first_bad_seq'> | null, seq: number): { tone: StatusTone; line: string } {
  if (chain == null) return { tone: 'info', line: 'Not verified yet' };
  if (chain.chain_ok === true) return { tone: 'handled', line: `Chain verified through entry ${seq}` };
  if (!Number.isInteger(chain.first_bad_seq)) return { tone: 'refused', line: 'Chain broken' };
  return { tone: 'refused', line: `Chain broken at entry ${chain.first_bad_seq}` };
}
