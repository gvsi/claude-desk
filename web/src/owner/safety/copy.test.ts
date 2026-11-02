/**
 * Safety's words for the record: every kind of entry, where it came from, what an attempt was
 * about and why a request was turned down, each table covering exactly the values the contracts
 * name; and the one entry an attempt is shown with.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LedgerEntry, LedgerEvent, LedgerPage } from '../../api/contracts.ts';
import type { HandoffEntry } from '../../api/handoffEntry.ts';
import type { Attempt, RefusalCause, TriageCategory } from '../../api/views.ts';
// The trace's line comes from its own module: the design system's index doesn't export it, and
// tests are outside the screens' index-only import rule.
import { traceLine } from '../../ds/components/FullTrace/traceLine.ts';
import {
  CATEGORY_COPY,
  CATEGORY_LABELS,
  CAUSE_COPY,
  HANDOFF_ENTRY_COPY,
  LEDGER_KIND_COPY,
  ORIGIN_COPY,
  SAFETY_SUBTITLE,
  anythingStoppedIn,
  anythingTurnedDownIn,
  categoryLabel,
  causeLabel,
  entryCopy,
  entryFor,
  originCopy,
  rowLabel,
  turnedDownHeadline,
} from './copy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', '..', '..', '..', 'backend', 'desk', 'contracts.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  $defs: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
};

/** The string enum of a model's field in the shared contracts. */
function schemaEnum(model: string, field: string): string[] {
  const values = schema.$defs[model]?.properties?.[field]?.enum;
  if (!values) throw new Error(`contracts.schema.json has no enum at ${model}.${field}`);
  return values;
}

type SchemaNode = { $ref?: string; anyOf?: SchemaNode[]; enum?: string[]; properties?: Record<string, SchemaNode> };
const OPENAPI_PATH = path.join(here, '..', '..', '..', '..', 'backend', 'desk', 'api', 'openapi.json');
const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as { components: { schemas: Record<string, SchemaNode> } };

/** The causes a refused Safety entry can carry, as the API's own document lists them. */
function causeEnum(): string[] {
  const resolve = (node: SchemaNode | undefined): SchemaNode | undefined =>
    node?.$ref === undefined ? node : resolve(openapi.components.schemas[node.$ref.split('/').at(-1) ?? '']);
  const cause = resolve(openapi.components.schemas.Attempt?.properties?.cause);
  const values = (cause?.anyOf ?? (cause ? [cause] : [])).flatMap((option) => resolve(option)?.enum ?? []);
  if (values.length === 0) throw new Error('openapi.json has no enum at Attempt.cause');
  return values;
}

const PROMPTS_PATH = path.join(here, '..', '..', '..', '..', 'backend', 'desk', 'api', 'prompts.py');

/**
 * The words a triage summary gives as the reason a request was turned down, by cause, as prompts.py
 * holds them in `TURNED_DOWN_BECAUSE`: one `"cause": "words",` line each, every line read.
 */
function turnedDownBecause(): Record<string, string> {
  const block = /^TURNED_DOWN_BECAUSE\b[^=\n]*=\s*\{\n([\s\S]*?)^\}/m.exec(readFileSync(PROMPTS_PATH, 'utf8'))?.[1];
  if (block === undefined) throw new Error('prompts.py has no TURNED_DOWN_BECAUSE');
  const lines = block.split('\n').filter((line) => line.trim() !== '');
  return Object.fromEntries(lines.map((line) => {
    const entry = /^\s*"(\w+)": "([^"\\]*)",$/.exec(line);
    if (!entry) throw new Error(`a TURNED_DOWN_BECAUSE line this test can't read: ${line}`);
    return [entry[1], entry[2]];
  }));
}

/** Why a request was turned down, each cause in the owner's signed words. */
const SIGNED_CAUSES = {
  owner_rule: 'Your rule says no',
  not_verified: 'Not verified yet',
  not_their_record: 'Only for the person it belongs to',
  recipient: 'Only to you or a contact on record',
  no_such_slot: "That time isn't open",
  unknown_item: 'Not on the price list',
  over_quote_ceiling: 'Over the $10,000 quote ceiling',
  quote_unpayable: "That quote can't be paid now",
  no_such_charge: "Couldn't find that payment",
  not_refundable: "That payment can't be refunded",
  no_such_document: 'No such document',
  no_amount: 'Not a valid amount',
  tool_not_available: 'Not a tool this chat can use',
  incomplete_request: "The request wasn't in a form I can use",
  paused: 'The chat was paused',
  no_rules: 'No rules turned on yet',
  rules_unchecked: "Your rules couldn't be checked, so I said no",
  agent_pay_out: "Agents can't send money out",
  agent_limit: "Outside the agent's spending limit",
  other_copy: 'Not a record on this Desk',
  no_rule: 'No rule covers this yet',
} as const;

/** The descriptive subjects in the owner's signed order. */
const TRIAGE_CATEGORIES = ['prices', 'records', 'codes', 'instructions', 'limits', 'wording', 'other'] as const satisfies readonly TriageCategory[];

const sorted = (values: readonly string[]) => [...values].sort();

function entry(seq: number, kind: LedgerEvent['kind'], ref: string): LedgerEntry {
  return {
    copy_id: 'copy-1',
    desk_id: 'desk-1',
    seq,
    prev_hash: '0'.repeat(64),
    created_at: `2026-10-30T16:5${seq}:00.000000Z`,
    event: { kind, origin: 'kernel', session_id: 'ses-1', ref_id: ref, summary: {} },
    hash: 'a'.repeat(64),
    signature: 'b'.repeat(128),
    key_id: 'key-1',
  };
}

function attempt(ledgerSeq: number): Attempt {
  return {
    ref_id: 'dec-refund',
    kind: 'refused',
    reason_plain: 'Refunds go only to the customer who paid.',
    card_ids: [],
    origin: 'kernel',
    created_at: '2026-10-30T16:52:00.000000Z',
    triage: null,
    ledger_seq: ledgerSeq,
    cause: null,
    from_the_visitor: null,
  };
}

function page(entries: LedgerEntry[]): LedgerPage {
  return { entries, head: 'a'.repeat(64), chain_ok: true, first_bad_seq: null, public_key_hex: 'c'.repeat(64), key_id: 'key-1' };
}

describe('Safety copy', () => {
  it('each_subject_has_its_own_label_in_the_signed_order', () => {
    const labels = ['Prices and discounts', "Someone's records", 'Verification codes', 'Instructions in a message', 'Above a limit', "The AI's wording", 'Other'];
    expect(Object.keys(CATEGORY_COPY)).toEqual(TRIAGE_CATEGORIES);
    expect(CATEGORY_LABELS).toEqual(labels);
    for (const [index, category] of TRIAGE_CATEGORIES.entries()) {
      const triage = { summary: 'The person asked a question. The Desk checked its reply.', category };
      expect(categoryLabel({ triage })).toBe(labels[index]);
    }
    expect(categoryLabel({ triage: null })).toBe('Not sorted yet');
    expect(categoryLabel({ triage: { summary: 'A new subject.', category: 'future' } as unknown as Attempt['triage'] })).toBe('Other');
  });

  it('copy_tables_are_exhaustive', () => {
    expect(sorted(Object.keys(LEDGER_KIND_COPY))).toEqual(sorted(schemaEnum('LedgerEvent', 'kind')));
    expect(sorted(Object.keys(ORIGIN_COPY))).toEqual(sorted(schemaEnum('LedgerEvent', 'origin')));
    expect(sorted(Object.keys(CATEGORY_COPY))).toEqual(sorted(TRIAGE_CATEGORIES));
    // Every word is written: none is left empty.
    for (const table of [LEDGER_KIND_COPY, ORIGIN_COPY, CATEGORY_COPY]) {
      for (const [key, words] of Object.entries(table)) expect(words.trim(), key).not.toBe('');
    }
  });

  it('origin_and_subtitle_name_no_part', () => {
    // Where an entry came from says who recorded it, never which part wrote it. A kernel entry isn't
    // called checked, since some are events ("Chat started"), and claims nothing about when, since
    // the sample week's replayed entries are written when a copy is made.
    expect(ORIGIN_COPY).toEqual({
      kernel: 'Recorded by your Desk',
      api: 'Reported by the chat, not verified by your Desk',
    });
    expect(originCopy('kernel')).toBe(ORIGIN_COPY.kernel);
    // Anything but the kernel reads as reported, never as recorded by the Desk. The kernel checks a
    // report's form, not whether it is true, so the line says it wasn't verified.
    for (const origin of ['api', 'other', '']) expect(originCopy(origin), origin).toBe(ORIGIN_COPY.api);
    expect(SAFETY_SUBTITLE).toBe('Requests your Desk turned down, replies it stopped before they were shown, and the signed record of every entry.');
    for (const words of [...Object.values(ORIGIN_COPY), SAFETY_SUBTITLE]) expect(words, words).not.toMatch(/checkpoint|chat service|as it happened/);
  });

  it('handoff_entries_say_which_they_are', () => {
    // The kernel's two `desk_data` entries about a conversation handed to the owner: the handoff
    // card opening one (`kind: "card"`) and the owner marking one done (no `kind`).
    const deskData = (summary: Record<string, unknown>) => ({ kind: 'desk_data' as const, summary });
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'], kind: 'card' }))).toBe('Chat handed to you');
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'] }))).toBe('Chat marked done');
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'], replaced_by: 'handoff-2' }))).toBe('Chat moved to a call-back');
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'], closed_by: 'takeover' }))).toBe('Handoff closed when you took over');
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'], closed_by: 'owner_message' }))).toBe('Handoff closed when you wrote in the chat');
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'], closed_by: 'booking' }))).toBe('Handoff closed when they booked a time');
    // Every other `desk_data` entry is unchanged, a handoffs entry of a kind this build doesn't know among them.
    for (const summary of [{ part: 'tools', refs: ['native.quote'] }, { part: 'desk', created: true }, { part: 'hours', refs: [] }, {}]) {
      expect(entryCopy(deskData(summary)), JSON.stringify(summary)).toBe('Desk details changed');
    }
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'], kind: 'callback' }))).toBe('Desk details changed');
    expect(entryCopy(deskData({ part: 'handoffs', refs: ['handoff-1'], kind: null }))).toBe('Desk details changed');
    expect(entryCopy({ kind: 'business_tools', summary: { tools: [] } })).toBe("Your Desk's jobs changed");
    // Another kind of entry keeps its own name, whatever its summary says.
    expect(entryCopy({ kind: 'reply', summary: { part: 'handoffs', refs: ['handoff-1'], kind: 'card' } })).toBe('Reply checked');
    expect(entryCopy({ kind: 'execute', summary: { part: 'handoffs', refs: ['handoff-1'] } })).toBe('Action ran');
  });

  it('full_trace_reads_the_history_row_name_of_each_handoff_entry', () => {
    // The design system's full trace and the owner's history rows name a handoff entry in the same
    // signed words: the trace's line opens with the row's name as a sentence.
    const details = {
      opened: { kind: 'card' },
      done: {},
      replaced: { replaced_by: 'handoff-2' },
      took_over: { closed_by: 'takeover' },
      wrote: { closed_by: 'owner_message' },
      booked: { closed_by: 'booking' },
    } as const satisfies Record<HandoffEntry, Record<string, unknown>>;
    for (const [handoff, more] of Object.entries(details) as [HandoffEntry, Record<string, unknown>][]) {
      const event = { kind: 'desk_data', summary: { part: 'handoffs', refs: ['handoff-1'], ...more } } as const;
      const sentence = `${HANDOFF_ENTRY_COPY[handoff]}.`;
      for (const origin of ['kernel', 'api'] as const) {
        expect(traceLine({ ...event, origin }).slice(0, sentence.length), `${handoff} ${origin}`).toBe(sentence);
      }
    }
  });

  it('entry_for_matches_ledger_seq', () => {
    // One action's decide, approval and execute entries: the attempt is shown with the one its
    // ledger_seq names, never another entry about the same action.
    const decide = entry(1, 'decide', 'dec-refund');
    const approval = entry(2, 'approval', 'dec-refund');
    const execute = entry(3, 'execute', 'dec-refund');
    const record = page([decide, approval, execute]);
    expect(entryFor(attempt(1), record)).toBe(decide);
    expect(entryFor(attempt(2), record)).toBe(approval);
    expect(entryFor(attempt(3), record)).toBe(execute);
    // A page without that entry, or no page yet: nothing to show.
    expect(entryFor(attempt(4), record)).toBeNull();
    expect(entryFor(attempt(1), undefined)).toBeNull();
  });

  it('anything_stopped_in_the_week_takes_either_kind', () => {
    // The last 7 days as Today reads them: Saturday, October 24, to Friday, October 30, in Los Angeles.
    const week = { timezone: 'America/Los_Angeles', start: '2026-10-24', end: '2026-10-30' };
    const one = (kind: Attempt['kind'], createdAt: string) => [{ kind, created_at: createdAt }];
    expect(anythingStoppedIn([], week)).toBe(false);
    // A refused request or a draft of Claude's the reply check stopped, from 00:00 on the first day
    // to the end of the last, on the business's clock.
    expect(anythingStoppedIn(one('refused', '2026-10-24T07:00:00.000000Z'), week)).toBe(true);
    expect(anythingStoppedIn(one('reply_blocked', '2026-10-31T06:59:00.000000Z'), week)).toBe(true);
    // Before the week began there, though already the 24th in UTC: not this week.
    expect(anythingStoppedIn(one('reply_blocked', '2026-10-24T06:59:00.000000Z'), week)).toBe(false);
    // After the week Today last read ended, just past midnight or with the clocks apart: newer than
    // that read, so it counts, and the week isn't said to have stopped nothing.
    expect(anythingStoppedIn(one('refused', '2026-10-31T07:00:00.000000Z'), week)).toBe(true);
    // A hold is the owner's to answer, not stopped.
    expect(anythingStoppedIn(one('held', '2026-10-29T17:00:00.000000Z'), week)).toBe(false);
    // A kind this build doesn't know yet may be a stop, so it counts.
    expect(anythingStoppedIn(one('rate_limited' as Attempt['kind'], '2026-10-29T17:00:00.000000Z'), week)).toBe(true);
    // A time that can't be read may be this week's, so the week isn't said to have nothing.
    expect(anythingStoppedIn(one('reply_blocked', 'not a time'), week)).toBe(true);
  });

  it('anything_turned_down_in_the_week_takes_refusals_only', () => {
    // The same week and the same clock as `anythingStoppedIn`, but a draft of Claude's the reply
    // check stopped is no request anyone made, so it was never turned down.
    const week = { timezone: 'America/Los_Angeles', start: '2026-10-24', end: '2026-10-30' };
    const one = (kind: Attempt['kind'], createdAt: string) => [{ kind, created_at: createdAt }];
    expect(anythingTurnedDownIn([], week)).toBe(false);
    expect(anythingTurnedDownIn(one('refused', '2026-10-24T07:00:00.000000Z'), week)).toBe(true);
    expect(anythingTurnedDownIn(one('reply_blocked', '2026-10-29T17:00:00.000000Z'), week)).toBe(false);
    expect(anythingTurnedDownIn(one('held', '2026-10-29T17:00:00.000000Z'), week)).toBe(false);
    // Before the week began on the business's clock: not this week.
    expect(anythingTurnedDownIn(one('refused', '2026-10-24T06:59:00.000000Z'), week)).toBe(false);
    // Newer than the week Today last read, a kind this build doesn't know yet, or a time that can't
    // be read: each may be a request turned down this week, so the week isn't said to have none.
    expect(anythingTurnedDownIn(one('refused', '2026-10-31T07:00:00.000000Z'), week)).toBe(true);
    expect(anythingTurnedDownIn(one('rate_limited' as Attempt['kind'], '2026-10-29T17:00:00.000000Z'), week)).toBe(true);
    expect(anythingTurnedDownIn(one('refused', 'not a time'), week)).toBe(true);
  });

  it('cause_copy_has_every_cause_in_the_signed_words', () => {
    expect(sorted(Object.keys(CAUSE_COPY))).toEqual(sorted(causeEnum()));
    expect(CAUSE_COPY).toEqual(SIGNED_CAUSES);
  });

  it('a_triage_summary_gives_the_cause_labels_words', () => {
    // The AI-written summary under a turned-down entry names why in the label's words: the API
    // sends Haiku its cause's words from prompts.py, so they're the label's, word for word.
    expect(turnedDownBecause()).toEqual(CAUSE_COPY);
  });

  it('cause_label_is_only_for_a_refused_entry_with_a_cause', () => {
    for (const [cause, words] of Object.entries(SIGNED_CAUSES)) {
      expect(causeLabel({ kind: 'refused', cause: cause as RefusalCause }), cause).toBe(words);
    }
    // No cause, or none sent: no label, and the entry's detail says why on its own.
    expect(causeLabel({ kind: 'refused', cause: null })).toBeNull();
    expect(causeLabel({ kind: 'refused' } as Pick<Attempt, 'kind' | 'cause'>)).toBeNull();
    // A cause this build has no words for yet: no label, never a guess.
    expect(causeLabel({ kind: 'refused', cause: 'a_newer_cause' as RefusalCause })).toBeNull();
    // A stopped draft or a held request is never labelled, whatever it carries.
    expect(causeLabel({ kind: 'reply_blocked', cause: null })).toBeNull();
    expect(causeLabel({ kind: 'reply_blocked', cause: 'owner_rule' })).toBeNull();
    expect(causeLabel({ kind: 'held', cause: 'owner_rule' })).toBeNull();
  });

  it('row_label_says_why_a_request_was_turned_down_or_that_a_reply_was_stopped', () => {
    const triage = { category: 'wording', summary: 'The visitor asked for a discount.' } as Attempt['triage'];
    // A refused request: its cause, exactly as `causeLabel` words it, or none.
    expect(rowLabel({ kind: 'refused', cause: 'owner_rule', triage })).toBe('Your rule says no');
    expect(rowLabel({ kind: 'refused', cause: null, triage: null })).toBeNull();
    // A stopped reply Claude has summarised says it's one; an unsummarised one reads the API's reason
    // as its title, which already says so.
    expect(rowLabel({ kind: 'reply_blocked', cause: null, triage })).toBe('A reply was stopped before it was shown');
    expect(rowLabel({ kind: 'reply_blocked', cause: null, triage: null })).toBeNull();
    // A held request, or a kind this build doesn't know yet: no label.
    expect(rowLabel({ kind: 'held', cause: 'owner_rule', triage })).toBeNull();
    expect(rowLabel({ kind: 'a_newer_kind' as Attempt['kind'], cause: null, triage })).toBeNull();
  });

  it('headline_says_how_many_requests_were_turned_down', () => {
    expect(turnedDownHeadline(3)).toBe('I turned down 3 requests this week.');
    expect(turnedDownHeadline(1)).toBe('I turned down 1 request this week.');
    expect(turnedDownHeadline(0)).toBe("I didn't turn down any requests this week.");
  });
});
