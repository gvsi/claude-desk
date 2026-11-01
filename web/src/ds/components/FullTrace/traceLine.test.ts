import { describe, expect, it } from 'vitest';

import type { LedgerEvent, LedgerPage } from '../../../api/contracts.ts';
import { traceChainLine, traceLine } from './traceLine.ts';

const RECORDED = 'Recorded by the checkpoint.';
const REPORTED = 'Reported by the chat service, not checked by the checkpoint.';

describe('traceLine', () => {
  it('names_web_search_usage', () => {
    expect(traceLine({ kind: 'web_search', origin: 'kernel', summary: {} })).toBe(`Web search. ${RECORDED}`);
  });

  it('kernel_entries_are_recorded_by_the_checkpoint', () => {
    expect(traceLine({ kind: 'decide', origin: 'kernel', summary: {} })).toBe(`A decision on an action Claude asked to take. ${RECORDED}`);
  });

  it('chat_service_entries_read_as_reported', () => {
    expect(traceLine({ kind: 'decide', origin: 'api', summary: {} })).toBe(`A decision on an action Claude asked to take. ${REPORTED}`);
    expect(traceLine({ kind: 'whisper', origin: 'api', summary: {} })).toBe(`A whisper to Claude. ${REPORTED}`);
  });

  it('a_paused_chats_count_reads_as_turned_down_requests', () => {
    expect(traceLine({ kind: 'breaker', origin: 'kernel', summary: {} })).toBe(`A turned-down request counted against the chat. ${RECORDED}`);
  });

  it('unknown_origin_reads_as_reported_never_as_checked', () => {
    // Only an entry the kernel wrote says the checkpoint recorded it.
    for (const origin of ['bogus', 'Kernel', 'kernel ', '', undefined, null]) {
      const line = traceLine({ kind: 'decide', origin: origin as unknown as LedgerEvent['origin'], summary: {} });
      expect(line, JSON.stringify(origin)).toBe(`A decision on an action Claude asked to take. ${REPORTED}`);
      expect(line).not.toContain(RECORDED);
    }
  });

  it('unknown_kind_reads_as_an_entry', () => {
    for (const kind of ['bogus', '', '__proto__', 'toString', undefined]) {
      const event = { kind: kind as unknown as LedgerEvent['kind'], summary: {} };
      expect(traceLine({ ...event, origin: 'kernel' }), JSON.stringify(kind)).toBe(`An entry in the record. ${RECORDED}`);
      expect(traceLine({ ...event, origin: 'api' }), JSON.stringify(kind)).toBe(`An entry in the record. ${REPORTED}`);
    }
  });

  it.each([
    ['opened', { kind: 'card' }, 'Chat handed to you.'],
    ['done', {}, 'Chat marked done.'],
    ['replaced', { replaced_by: 'h-2' }, 'Chat moved to a call-back.'],
    ['took_over', { closed_by: 'takeover' }, 'Handoff closed when you took over.'],
    ['wrote', { closed_by: 'owner_message' }, 'Handoff closed when you wrote in the chat.'],
  ] as const)('names_the_%s_handoff_entry', (_state, details, what) => {
    const event = { kind: 'desk_data', summary: { part: 'handoffs', refs: ['h-1'], ...details } } as const;
    expect(traceLine({ ...event, origin: 'kernel' })).toBe(`${what} ${RECORDED}`);
    expect(traceLine({ ...event, origin: 'api' })).toBe(`${what} ${REPORTED}`);
  });

  it('non_handoff_desk_data_keeps_the_kind_line', () => {
    const event = { kind: 'desk_data', origin: 'kernel', summary: { part: 'calendar' } } as const;
    expect(traceLine(event)).toBe(`A change to your Desk's details. ${RECORDED}`);
    expect(traceLine({ kind: 'business_tools', origin: 'kernel', summary: {} })).toBe(`A change to your Desk's jobs. ${RECORDED}`);
  });

  it('unknown_handoff_closing_keeps_the_kind_line', () => {
    const event = { kind: 'desk_data', summary: { part: 'handoffs', refs: ['h-1'], closed_by: 'expired' } } as const;
    expect(traceLine({ ...event, origin: 'kernel' })).toBe(`A change to your Desk's details. ${RECORDED}`);
    expect(traceLine({ ...event, origin: 'api' })).toBe(`A change to your Desk's details. ${REPORTED}`);
  });
});

type Chain = Pick<LedgerPage, 'chain_ok' | 'first_bad_seq'>;

describe('traceChainLine', () => {
  it('reads_each_chain_state', () => {
    expect(traceChainLine(null, 3)).toEqual({ tone: 'info', line: 'Not verified yet' });
    expect(traceChainLine({ chain_ok: true, first_bad_seq: null }, 3)).toEqual({ tone: 'handled', line: 'Chain verified through entry 3' });
    expect(traceChainLine({ chain_ok: false, first_bad_seq: 2 }, 3)).toEqual({ tone: 'refused', line: 'Chain broken at entry 2' });
  });

  it('broken_without_an_entry_still_reads_broken', () => {
    expect(traceChainLine({ chain_ok: false, first_bad_seq: null }, 3)).toEqual({ tone: 'refused', line: 'Chain broken' });
    // A malformed entry number names no entry, rather than "entry undefined".
    for (const seq of [undefined, 'two', Number.NaN]) {
      const chain = { chain_ok: false, first_bad_seq: seq as unknown as number };
      expect(traceChainLine(chain, 3), String(seq)).toEqual({ tone: 'refused', line: 'Chain broken' });
    }
  });

  it('only_a_passed_check_reads_verified', () => {
    for (const ok of ['true', 1, undefined, null]) {
      const chain = { chain_ok: ok as unknown as boolean, first_bad_seq: null };
      expect(traceChainLine(chain, 3), JSON.stringify(ok)).toEqual({ tone: 'refused', line: 'Chain broken' });
    }
    // No chain at all claims nothing, and doesn't fail.
    expect(traceChainLine(undefined as unknown as Chain | null, 3)).toEqual({ tone: 'info', line: 'Not verified yet' });
  });
});
