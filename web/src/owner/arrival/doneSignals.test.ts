/**
 * The four things on Today's list, each done only on what the reads show the owner did in this
 * copy: never on replayed history, the seed's own stopped reply, an answer the kernel refused, a
 * request that expired or was cancelled, or the owner's own words.
 */
import { describe, expect, it } from 'vitest';

import type { DecisionState, EvMessage, LedgerEntry, LedgerEvent } from '../../api/contracts.ts';
import type { Attempt, BusinessOut, ConversationSummary, DeskSummary, OwnerTranscript, TranscriptItem } from '../../api/views.ts';
import {
  NOTHING_DONE,
  answeredInView,
  answeredOnRecord,
  chattedAsCustomer,
  doneCaption,
  firstDesk,
  madeAnotherDesk,
  previewSessions,
  remember,
  stoppedInPreview,
  type Reading,
  type Thing,
} from './doneSignals.ts';

/** A delivered message by `author`, as the owner's transcript holds one. */
function delivered(n: number, author: EvMessage['author']): TranscriptItem {
  const event: EvMessage = {
    type: 'message',
    message_id: `msg-${n}`,
    generation: 1,
    author,
    language: 'en',
    handoff: false,
    blocks: [],
    visitor_plain: '',
    ledger_seq: n,
    signature: 's'.repeat(128),
  };
  return { n, kind: 'delivered', created_at: '2026-10-30T16:00:00.000000Z', text: null, event };
}

function said(n: number, kind: 'visitor_text' | 'agent_text', text: string): TranscriptItem {
  return { n, kind, created_at: '2026-10-30T16:00:00.000000Z', text, event: null };
}

function transcript(items: TranscriptItem[], fields: Partial<OwnerTranscript> = {}): OwnerTranscript {
  return {
    state: { session_id: 'ses-preview', kind: 'visitor', verified: false, assurance: 'none', mode: 'ai', generation: 1 },
    items,
    ...fields,
  };
}

function conversation(sessionId: string, fields: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    session_id: sessionId,
    kind: 'visitor',
    display_name: null,
    verified: false,
    mode: 'ai',
    last_activity: '2026-10-30T16:00:00.000000Z',
    outcome_counts: {},
    owner_preview: false,
    ...fields,
  };
}

/** A signed entry of the record, with its event's fields as given. */
function entry(seq: number, event: Partial<LedgerEvent> & Pick<LedgerEvent, 'kind'>): LedgerEntry {
  return {
    copy_id: 'copy-1',
    desk_id: 'desk-1',
    seq,
    prev_hash: String(seq - 1).repeat(64).slice(0, 64),
    created_at: '2026-10-30T16:00:00.000000Z',
    event: { origin: 'kernel', session_id: null, ref_id: null, summary: {}, ...event },
    hash: String(seq).repeat(64).slice(0, 64),
    signature: 's'.repeat(128),
    key_id: 'key-1',
  };
}

/** A stopped attempt as Safety lists it, shown with entry `seq`. */
function attempt(seq: number, kind: Attempt['kind'] = 'reply_blocked'): Attempt {
  return {
    ref_id: String(seq),
    kind,
    reason_plain: 'I stopped a reply that named a price the cards don’t back.',
    card_ids: [],
    origin: 'kernel',
    created_at: '2026-10-30T16:00:00.000000Z',
    triage: null,
    ledger_seq: seq,
  };
}

/** A blocked reply's entry in `sessionId`. */
function blockedReply(seq: number, sessionId: string, summary: Record<string, unknown> = {}): LedgerEntry {
  return entry(seq, { kind: 'reply', session_id: sessionId, ref_id: `msg-${seq}`, summary: { author: 'claude', ok: false, violations: ['number_in_prose'], ...summary } });
}

describe("the owner's preview chats", () => {
  it('are the conversations marked as the preview, live in this copy', () => {
    const list = [
      conversation('ses-visitor'),
      conversation('ses-preview', { owner_preview: true }),
      conversation('ses-recorded', { owner_preview: true, replayed: true }),
      conversation('ses-agent', { kind: 'agent' }),
    ];
    expect(previewSessions(list)).toEqual(['ses-preview']);
  });
});

describe('chat as a customer', () => {
  it('a reply from Claude in the preview chat counts', () => {
    expect(chattedAsCustomer([transcript([said(1, 'visitor_text', 'Do you work weekends?'), delivered(2, 'claude')])])).toBe(true);
  });

  it('a card from the Desk counts as its reply', () => {
    expect(chattedAsCustomer([transcript([said(1, 'visitor_text', 'How much for a drain?'), delivered(2, 'desk')])])).toBe(true);
  });

  it("the owner's own message in a preview chat is not a reply", () => {
    expect(chattedAsCustomer([transcript([said(1, 'visitor_text', 'Hello?'), delivered(2, 'owner')])])).toBe(false);
  });

  it("a visiting agent's words are not a reply", () => {
    expect(chattedAsCustomer([transcript([said(1, 'agent_text', 'Book Tuesday at 2 pm.')])])).toBe(false);
  });

  it('a chat with nothing delivered, or not read yet, is not done', () => {
    expect(chattedAsCustomer([transcript([said(1, 'visitor_text', 'Hello?')]), undefined])).toBe(false);
    expect(chattedAsCustomer([])).toBe(false);
  });

  it('a replayed chat is history, not the owner chatting', () => {
    expect(chattedAsCustomer([transcript([said(1, 'visitor_text', 'Hello?'), delivered(2, 'claude')], { replayed: true })])).toBe(false);
  });
});

describe('try to break it', () => {
  const preview = new Set(['ses-preview']);

  it('an attempt stopped in a preview chat counts', () => {
    const ledger = { entries: [entry(1, { kind: 'session', session_id: 'ses-preview' }), blockedReply(2, 'ses-preview')] };
    expect(stoppedInPreview([attempt(2)], ledger, preview)).toBe(true);
  });

  it("the seed's own stopped reply, in a visitor's chat, doesn't count", () => {
    const ledger = { entries: [blockedReply(7, 'ses-visitor-web')] };
    expect(stoppedInPreview([attempt(7)], ledger, preview)).toBe(false);
  });

  it('a replayed entry is history, even in a preview chat', () => {
    const ledger = { entries: [blockedReply(3, 'ses-preview', { replayed: { at: '2026-10-29T18:00:00.000000Z' } })] };
    expect(stoppedInPreview([attempt(3)], ledger, preview)).toBe(false);
  });

  it("an attempt whose entry the record read doesn't hold yet isn't done", () => {
    const ledger = { entries: [blockedReply(2, 'ses-preview')] };
    expect(stoppedInPreview([attempt(9, 'refused')], ledger, preview)).toBe(false);
    expect(stoppedInPreview([], ledger, preview)).toBe(false);
  });

  it('with no preview chat, nothing counts', () => {
    const ledger = { entries: [blockedReply(2, 'ses-preview')] };
    expect(stoppedInPreview([attempt(2)], ledger, new Set())).toBe(false);
  });
});

/** An approval entry for `dec-1`, as `approvals.py` writes one. */
function approval(seq: number, summary: Record<string, unknown>): LedgerEntry {
  return entry(seq, { kind: 'approval', session_id: 'ses-visitor-web', ref_id: 'dec-1', summary });
}

describe('answer a held request, on the record', () => {
  it('an answer the kernel took counts: allowed', () => {
    const ledger = { entries: [approval(4, { decision_id: 'dec-1', action_id: 'act-1', answer: 'allow_once', state: 'approved' })] };
    expect(answeredOnRecord(ledger)).toBe(true);
  });

  it('denied, or allowed and refused at execution, counts too', () => {
    for (const [answer, state] of [
      ['deny_once', 'denied'],
      ['allow_once', 'refused_at_execution'],
    ]) {
      expect(answeredOnRecord({ entries: [approval(4, { decision_id: 'dec-1', action_id: 'act-1', answer, state })] }), state).toBe(true);
    }
  });

  it("a refusal note, the request still held, doesn't count", () => {
    const note = approval(4, { decision_id: 'dec-1', answer: 'allow_once', refused: 'not_offered' });
    expect(answeredOnRecord({ entries: [note] })).toBe(false);
    // Even with a state beside it.
    const odd = approval(5, { decision_id: 'dec-1', answer: 'allow_once', refused: 'answered', state: 'approved' });
    expect(answeredOnRecord({ entries: [odd] })).toBe(false);
  });

  it("an expired or cancelled request isn't an answer", () => {
    const cancelled = approval(4, { decision_id: 'dec-1', action_id: 'act-1', state: 'cancelled' });
    const expired = approval(5, { decision_id: 'dec-1', action_id: 'act-1', state: 'expired' });
    const lateAnswer = approval(6, { decision_id: 'dec-1', answer: 'allow_once', state: 'expired' });
    expect(answeredOnRecord({ entries: [cancelled, expired, lateAnswer] })).toBe(false);
  });

  it('a replayed answer is history', () => {
    const replayed = approval(4, { decision_id: 'dec-1', answer: 'deny_once', state: 'denied', replayed: { at: '2026-10-29T18:00:00.000000Z' } });
    expect(answeredOnRecord({ entries: [replayed] })).toBe(false);
  });

  it('only approval entries count', () => {
    const ran = entry(4, { kind: 'execute', ref_id: 'dec-1', summary: { answer: 'allow_once', state: 'approved' } });
    expect(answeredOnRecord({ entries: [ran] })).toBe(false);
    expect(answeredOnRecord({ entries: [] })).toBe(false);
  });
});

describe('answer a held request, in this view', () => {
  it('an answer that settled the request counts, whatever it then did', () => {
    const answered: DecisionState[] = ['approved', 'executed', 'failed', 'unknown', 'denied', 'refused_at_execution'];
    for (const state of answered) expect(answeredInView([{ state }]), state).toBe(true);
  });

  it("a late answer that found the request expired or cancelled isn't one", () => {
    expect(answeredInView([{ state: 'expired' }, { state: 'cancelled' }])).toBe(false);
    expect(answeredInView([{ state: 'held' }])).toBe(false);
    expect(answeredInView([])).toBe(false);
  });
});

function desk(deskId: string): DeskSummary {
  return { desk_id: deskId, slug: deskId, name: deskId, business_name: 'Rivera Plumbing', hours: [], answering: true };
}

function business(businessId: string, desks: DeskSummary[]): BusinessOut {
  return { business_id: businessId, name: businessId, owner_display_name: 'Maria Rivera', timezone: 'America/Los_Angeles', desks };
}

describe('the Desk the copy started with', () => {
  it('is the first Desk listed, as the API lists them in the order they were made', () => {
    const copy = [business('biz-rivera', [desk('desk-main'), desk('desk-em')]), business('biz-new', [desk('desk-new')])];
    expect(firstDesk(copy)).toBe('desk-main');
    expect(firstDesk([business('biz-empty', []), business('biz-new', [desk('desk-new')])])).toBe('desk-new');
    expect(firstDesk([])).toBeNull();
  });
});

describe('create your own Desk', () => {
  it('a Desk besides the one the copy started with counts', () => {
    expect(madeAnotherDesk([business('biz-rivera', [desk('desk-main')]), business('biz-new', [desk('desk-new')])], 'desk-main')).toBe(true);
    expect(madeAnotherDesk([business('biz-rivera', [desk('desk-main')])], 'desk-main')).toBe(false);
  });

  it('once the first Desk is deleted, the Desks still listed are the others', () => {
    expect(madeAnotherDesk([business('biz-new', [desk('desk-new')])], 'desk-main')).toBe(true);
  });
});

/** What the reads show for each thing now: nothing settled and nothing done, unless given. */
function reading(fields: Partial<Record<Thing, Partial<Reading>>> = {}): Record<Thing, Reading> {
  const one = (thing: Thing): Reading => ({ done: false, settled: false, ...fields[thing] });
  return { chat: one('chat'), break: one('break'), answer: one('answer'), create: one('create') };
}

describe('what this view remembers', () => {
  it('a thing done in the first settled read of its queries was done at load', () => {
    const memory = remember(NOTHING_DONE, reading({ create: { done: true, settled: true }, chat: { settled: true } }));
    expect(memory.done).toEqual({ create: { atLoad: true } });
  });

  it('a thing done after its first settled read was done in view', () => {
    const loaded = remember(NOTHING_DONE, reading({ answer: { settled: true } }));
    const answered = remember(loaded, reading({ answer: { done: true, settled: true } }));
    expect(answered.done).toEqual({ answer: { atLoad: false } });
  });

  it('a thing done by an answer given here, before its reads settled, was done in view', () => {
    const answered = remember(NOTHING_DONE, reading({ answer: { inView: true } }));
    expect(answered.done).toEqual({ answer: { atLoad: false } });
    // Its reads settling later changes nothing.
    expect(remember(answered, reading({ answer: { done: true, settled: true } })).done).toEqual({ answer: { atLoad: false } });
  });

  it('reads that show a thing done before they have all come in wait for the rest', () => {
    // One preview chat's transcript has a reply; another's is still being read.
    const partly = remember(NOTHING_DONE, reading({ chat: { done: true } }));
    expect(partly.done).toEqual({});
    // Once every read is in, it was done at load.
    expect(remember(partly, reading({ chat: { done: true, settled: true } })).done).toEqual({ chat: { atLoad: true } });
  });

  it('once its reads have settled, a thing the reads show done while a new read is out was done in view', () => {
    const loaded = remember(NOTHING_DONE, reading({ chat: { settled: true } }));
    // A second preview chat's transcript is being read, and the first one got its reply.
    expect(remember(loaded, reading({ chat: { done: true } })).done).toEqual({ chat: { atLoad: false } });
  });

  it('a thing seen done stays done, whatever the reads show next', () => {
    const done = remember(NOTHING_DONE, reading({ answer: { done: true, settled: true }, chat: { settled: true } }));
    const later = remember(done, reading({ answer: { settled: true }, chat: { settled: true } }));
    expect(later.done).toEqual({ answer: { atLoad: true } });
  });

  it('a reading that changes nothing keeps the same memory', () => {
    const memory = remember(NOTHING_DONE, reading({ create: { done: true, settled: true }, chat: { settled: true } }));
    expect(remember(memory, reading({ create: { done: true, settled: true }, chat: { settled: true } }))).toBe(memory);
    expect(remember(NOTHING_DONE, reading())).toBe(NOTHING_DONE);
  });
});

describe("the list's line", () => {
  it('says how long it takes until something is done, then counts of 4', () => {
    expect(doneCaption(0)).toBe('About 10 minutes. No real customer sees any of it.');
    expect(doneCaption(1)).toBe('1 of 4 done. No real customer sees any of it.');
    expect(doneCaption(3)).toBe('3 of 4 done. No real customer sees any of it.');
    expect(doneCaption(4)).toBe('All 4 done. No real customer sees any of it.');
  });
});
