/**
 * Safety in a real browser against the mock API: this week's stopped attempts with what stopped
 * each one, an attempt's detail in tiers, and every entry of the signed record with its chain,
 * each saying where it came from and when it happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { LedgerEntry, LedgerEvent, LedgerPage } from '../../api/contracts.ts';
import type { Attempt, Today, TriageCategory } from '../../api/views.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { isoTime } from '../../mocks/world.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoWindowScroll, expectScreenBasics } from '../../test/screen.ts';
import { attemptTime } from './copy.ts';

const DESK = `/app/${RIVERA.deskId}`;
const SAFETY = `${DESK}/safety`;
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** Waits until `key` has been read `n` more times. */
async function readsMore(key: string, n: number): Promise<void> {
  const from = requests(key).length;
  await expect.poll(() => requests(key).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(from + n);
}

/** An element's box on screen. */
function box(el: Element | null | undefined): DOMRect {
  if (!el) throw new Error('no element to measure');
  return el.getBoundingClientRect();
}

/** Today as the mock reads it now, changed by `patch`, answering every read of it from here on. */
async function injectToday(patch: (today: Today) => Today): Promise<void> {
  const answer = await mockStore.dispatch('today', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads Today');
  mockStore.inject({ route: 'today', status: 200, times: 10_000, body: patch(answer.body as Today) });
}

/** This week's stopped count, as Today's "Last 7 days" reads it. */
function stoppedThisWeek(stopped: number): Promise<void> {
  return injectToday((t) => ({ ...t, this_week: { ...t.this_week, stopped } }));
}

/** The record as the mock reads it now. */
async function mockLedger(): Promise<LedgerPage> {
  const answer = await mockStore.dispatch('ledger', { params: { desk_id: RIVERA.deskId }, query: { verify: 'true' } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads the record');
  return answer.body as LedgerPage;
}

/** Answers every read of the record with `page` from here on. */
function injectLedger(page: LedgerPage): void {
  mockStore.inject({ route: 'ledger', status: 200, times: 10_000, body: page });
}

/** The attempts as the mock lists them now. */
async function mockAttempts(): Promise<Attempt[]> {
  const answer = await mockStore.dispatch('safety', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads the attempts');
  return answer.body as Attempt[];
}

/** Answers every read of the attempts with `attempts` from here on. */
function injectAttempts(attempts: Attempt[]): void {
  mockStore.inject({ route: 'safety', status: 200, times: 10_000, body: attempts });
}

/**
 * Lists the seeded hold, the 15% quote waiting for Maria, among the mock's attempts as one held,
 * from here on. Neither the mock nor the API lists a hold as stopped; the attempt's `kind` allows
 * one, and the page says so plainly.
 */
async function listSeededHold(): Promise<void> {
  const record = [...mockStore.world.decisions.values()].find((d) => d.decision.state === 'held');
  if (!record) throw new Error('the seed holds the 15% quote');
  const { decision } = record;
  const attempt: Attempt = {
    ref_id: decision.decision_id,
    kind: 'held',
    reason_plain: decision.reason_plain,
    card_ids: [...decision.card_ids],
    origin: 'kernel',
    created_at: isoTime(record.createdAt),
    triage: null,
    ledger_seq: decision.ledger_seq,
  };
  injectAttempts([...(await mockAttempts()), attempt].sort((a, b) => b.created_at.localeCompare(a.created_at)));
}

/** Whether the checkpoint signs with the development key, from here on. */
function injectDevKey(devKey: boolean): void {
  const kernel = {
    version: 'mock',
    proof_mode: 'symcc',
    dev_signing_key: devKey,
    public_key_hex: 'c'.repeat(64),
    key_id: 'key-rivera',
    unproved_seeds: [],
  };
  mockStore.inject({ route: 'health', status: 200, times: 10_000, body: { ok: true, kernel } });
}

const hex = (seed: string, length: number) => seed.repeat(length).slice(0, length);

/** A signed entry of the record, with its event's fields as given. */
function entry(seq: number, at: string, event: Partial<LedgerEvent> & Pick<LedgerEvent, 'kind'>): LedgerEntry {
  return {
    copy_id: RIVERA.copyId,
    desk_id: RIVERA.deskId,
    seq,
    prev_hash: hex(String(seq - 1), 64),
    created_at: at,
    event: { origin: 'kernel', session_id: null, ref_id: null, summary: {}, ...event },
    hash: hex(String(seq), 64),
    signature: hex(`s${seq}`, 128),
    key_id: 'key-rivera',
  };
}

/** A record page holding `entries`, its chain checked as `chain`. */
function ledgerPage(entries: LedgerEntry[], chain: Pick<LedgerPage, 'chain_ok' | 'first_bad_seq'> = { chain_ok: true, first_bad_seq: null }): LedgerPage {
  return { entries, head: entries.at(-1)?.hash ?? '0'.repeat(64), ...chain, public_key_hex: 'c'.repeat(64), key_id: 'key-rivera' };
}

/** Three entries a visitor's chat might leave: the chat starting, an action checked and a reply checked. */
function threeEntries(): LedgerEntry[] {
  return [
    entry(1, '2026-10-20T16:50:00.000000Z', { kind: 'session', session_id: 'ses-1', summary: { kind: 'visitor' } }),
    entry(2, '2026-10-20T16:51:00.000000Z', {
      kind: 'decide',
      session_id: 'ses-1',
      ref_id: 'dec-refund',
      summary: { tool: 'payments.create_refund', outcome: 'refuse', state: 'refused', card_ids: [] },
    }),
    entry(3, '2026-10-20T16:52:00.000000Z', { kind: 'reply', session_id: 'ses-1', summary: { author: 'claude', ok: true, language: 'en', violations: [] } }),
  ];
}

function region(screen: RenderResult, name: string) {
  return screen.getByRole('region', { name, exact: true });
}

const REPLAYED = 'Recorded history, replayed into your copy';

const REFUND_REASON = 'Someone in the public chat said they were Maria and asked me to refund a charge to their own card. Refunds go only to the customer who paid, so I didn’t.';

/** An attempt as the API lists it: by default the refused refund, entry 2 of `threeEntries`. */
function attempt(fields: Partial<Attempt> = {}): Attempt {
  return {
    ref_id: 'dec-refund',
    kind: 'refused',
    reason_plain: REFUND_REASON,
    card_ids: [],
    origin: 'kernel',
    created_at: '2026-10-20T16:51:00.000000Z',
    triage: null,
    ledger_seq: 2,
    ...fields,
  };
}

/** The open attempt beside the list. */
function detail(screen: RenderResult) {
  return region(screen, 'Attempt details');
}

/** The view switch's option `name`. */
function viewOption(screen: RenderResult, name: 'Attempts' | 'Every entry') {
  return screen.getByRole('radiogroup', { name: 'What to show' }).getByRole('radio', { name, exact: true });
}

/** The record's row for entry `seq`. */
function recordRow(screen: RenderResult, seq: number) {
  return screen.getByRole('list', { name: 'Every entry, newest first' }).getByRole('button', { name: new RegExp(`^Entry ${seq},`) });
}

/**
 * 10:30 am on Friday, October 30, in Los Angeles: the clock every test here runs on, the page's and
 * the mock's alike, so what reads "Today" and what reads a date don't depend on the hour the suite
 * runs. Run on the real clock just after midnight, the seeded hold (twelve minutes before its copy
 * opened) was yesterday's.
 */
const NOW = new Date('2026-10-30T17:30:00Z');

beforeEach(() => {
  localStorage.clear();
  // Only `Date` is faked, and it runs on from NOW, so the page's polls and waits keep real time.
  // The setup seeded a copy on the real clock before this; seed it again on this one.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW, shouldAdvanceTime: true });
  mockStore.reset('rivera');
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('Safety', () => {
  it('chain_ok_header', async () => {
    await stoppedThisWeek(2);
    const entries = (await mockLedger()).entries.length;
    const { screen } = await renderRoute(SAFETY);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Safety' })).toBeVisible();
    await expect.element(screen.getByText('2 attempts to talk me around were stopped this week.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Every entry checks out', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('img', { name: `${entries} entries`, exact: true })).toBeVisible();

    // One attempt reads in the singular.
    mockStore.reset('rivera');
    await stoppedThisWeek(1);
    const one = await renderRoute(SAFETY);
    await expect.element(one.screen.getByText('1 attempt to talk me around was stopped this week.', { exact: true })).toBeVisible();
  });

  it('headline_counts_the_listed_attempts', async () => {
    // A visitor asks for 50% off, the Desk holds it for Maria, and she allows it. A hold is hers to
    // answer, not an attempt that was stopped: the count and the list both leave it out.
    const ask = 'Can I get 50% off if I pay cash?';
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: ask } });
    const asked = () => [...mockStore.world.decisions.values()].find((d) => d.fromTheVisitor === ask)?.decision;
    await expect.poll(() => asked()?.state, { timeout: 5_000 }).toBe('held');
    await mockStore.dispatch('answer', { params: { decision_id: asked()?.decision_id ?? '' }, body: { answer: 'allow_once' } });
    await expect.poll(() => asked()?.state, { timeout: 5_000 }).toBe('executed');

    const { screen } = await renderRoute(SAFETY);
    const headline = screen.getByText(/^\d+ attempts? to talk me around (?:was|were) stopped this week\.$/);
    await expect.element(headline).toBeVisible();
    const rows = screen.getByRole('list', { name: 'Attempts, newest first' }).getByRole('listitem');
    await expect.element(rows.first()).toBeVisible();
    expect(rows.elements()).toHaveLength(Number.parseInt(headline.element().textContent ?? '', 10));

    // Newest first, by the time each row shows.
    const ledger = await mockLedger();
    const times = (await mockAttempts()).map((a) => Date.parse(attemptTime(a, ledger)));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('broken_chain_is_plain', async () => {
    injectLedger(ledgerPage(threeEntries(), { chain_ok: false, first_bad_seq: 2 }));
    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(screen.getByText("Entry 2 doesn't match the chain", { exact: true })).toBeVisible();
    expect(screen.getByText('Every entry checks out').elements()).toHaveLength(0);

    // An entry's full trace says the chain is broken, and where, never that it was verified.
    await recordRow(screen, 3).click();
    const trace = region(screen, 'Full trace of entry 3');
    await expect.element(trace.getByText('Chain broken at entry 2', { exact: true })).toBeVisible();
    expect(trace.getByText(/Chain verified/).elements()).toHaveLength(0);
  });

  it('dev_key_is_labelled', async () => {
    injectLedger(ledgerPage(threeEntries()));
    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await recordRow(screen, 2).click();
    const trace = region(screen, 'Full trace of entry 2');
    await expect.element(trace.getByText('Signed with a development key', { exact: true })).toBeVisible();
    await expect.element(trace.getByText('Chain verified through entry 2', { exact: true })).toBeVisible();

    // A Desk signing with its own key says nothing about one.
    mockStore.reset('rivera');
    injectLedger(ledgerPage(threeEntries()));
    injectDevKey(false);
    const own = await renderRoute(`${SAFETY}?view=entries`);
    await recordRow(own.screen, 2).click();
    await expect.element(region(own.screen, 'Full trace of entry 2')).toBeVisible();
    expect(own.screen.getByText('Signed with a development key').elements()).toHaveLength(0);
  });

  it('attempt_detail_tiers', async () => {
    injectLedger(ledgerPage(threeEntries()));
    injectAttempts([attempt()]);
    const { screen } = await renderRoute(`${SAFETY}/dec-refund`);
    const open = detail(screen);

    // First the reason, in plain words: nothing in mono, no meter and no trace yet.
    await expect.element(open.getByText(REFUND_REASON, { exact: true })).toBeVisible();
    await expect.element(open.getByText('Stopped', { exact: true })).toBeVisible();
    expect(document.querySelectorAll('.cd-type-trace')).toHaveLength(0);
    expect(open.getByText('Action checkpoint').elements()).toHaveLength(0);
    const row = screen.getByRole('link', { name: /Stopped by: Action checkpoint$/ });
    await expect.element(row).toHaveAttribute('aria-current', 'true');

    // "See how it was stopped" shows the checkpoints it passed and the one that stopped it.
    const how = open.getByRole('button', { name: 'See how it was stopped' });
    await expect.element(how).toHaveAttribute('aria-expanded', 'false');
    await how.click();
    await expect.element(how).toHaveAttribute('aria-expanded', 'true');
    await expect.element(open.getByText('Stopped by: Action checkpoint', { exact: true })).toBeVisible();
    expect(document.querySelectorAll('.cd-type-trace')).toHaveLength(0);

    // "Full trace" opens the signed entry the attempt is kept in, in mono.
    const full = open.getByRole('button', { name: 'Full trace' });
    await full.click();
    await expect.element(full).toHaveAttribute('aria-expanded', 'true');
    const trace = region(screen, 'Full trace of entry 2');
    await expect.element(trace).toBeVisible();
    const values = [...document.querySelectorAll('.cd-type-trace')].map((el) => el.textContent);
    expect(values).toContain('2');
    expect(values.join('\n')).toContain('payments.create_refund');
    // Closing the trace puts the owner back on its button.
    await trace.getByRole('button', { name: 'Close the full trace' }).click();
    expect(document.querySelectorAll('.cd-type-trace')).toHaveLength(0);
    await expect.element(full).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(full.element());
  });

  it('claims_cover_only_the_stopped_item', async () => {
    // A booking ran in this chat, then one of Claude's replies was blocked.
    const entries = [
      entry(1, '2026-10-20T16:40:00.000000Z', { kind: 'session', session_id: 'ses-dana', summary: { kind: 'visitor' } }),
      entry(2, '2026-10-20T16:41:00.000000Z', {
        kind: 'decide',
        session_id: 'ses-dana',
        ref_id: 'dec-book',
        summary: { tool: 'native.book', outcome: 'allow', state: 'allowed', card_ids: ['rv-book'] },
      }),
      entry(3, '2026-10-20T16:41:01.000000Z', { kind: 'execute', session_id: 'ses-dana', ref_id: 'dec-book', summary: { state: 'executed' } }),
      entry(4, '2026-10-20T16:42:00.000000Z', {
        kind: 'reply',
        session_id: 'ses-dana',
        ref_id: 'msg-blocked',
        summary: { author: 'claude', ok: false, language: 'en', violations: ['number_in_prose'] },
      }),
    ];
    injectLedger(ledgerPage(entries));
    const blocked = attempt({
      ref_id: '4',
      kind: 'reply_blocked',
      reason_plain: "Claude's reply put a price in its own words instead of a checked card, so it wasn't shown.",
      created_at: entries[3]?.created_at ?? '',
      ledger_seq: 4,
    });
    injectAttempts([blocked]);
    const { screen } = await renderRoute(`${SAFETY}/4`);
    const open = detail(screen);
    await expect.element(open.getByText('This reply was never shown.', { exact: true })).toBeVisible();
    // The stop says nothing about the booking before it, which kept its own receipt.
    expect(open.element().textContent).not.toMatch(/didn.t run|nothing/i);
    await expect.element(screen.getByRole('link', { name: /Stopped by: Reply checkpoint$/ })).toHaveAttribute('aria-current', 'true');
  });

  it('triage_is_labelled_ai_written', async () => {
    injectLedger(ledgerPage(threeEntries()));
    const summary = 'Claimed to be the owner to move a customer’s refund to another card.';
    injectAttempts([
      attempt({ triage: { summary, category: 'impersonation' } }),
      attempt({ ref_id: 'dec-other', reason_plain: 'Someone asked for another customer’s invoice.', ledger_seq: 3 }),
    ]);
    const { screen } = await renderRoute(`${SAFETY}/dec-refund`);
    const open = detail(screen);
    // In the list, Claude's summary names the attempt; beside it, it is labelled as written by Claude.
    await expect.element(screen.getByRole('link', { name: new RegExp(`^Oct 20, 9:51 am ${summary}`) })).toBeVisible();
    await expect.element(open.getByText('Summary written by Claude', { exact: true })).toBeVisible();
    await expect.element(open.getByText(summary, { exact: true })).toBeVisible();
    await expect.element(open.getByText('Posing as you', { exact: true })).toBeVisible();
    await expect.element(open.getByText(REFUND_REASON, { exact: true })).toBeVisible();

    // An attempt Claude hasn't summed up yet keeps the checkpoint's reason, with no summary.
    await screen.getByRole('link', { name: /Someone asked for another customer’s invoice\./ }).click();
    await expect.element(open.getByText('Someone asked for another customer’s invoice.', { exact: true })).toBeVisible();
    await expect.element(open.getByText('Not sorted yet', { exact: true })).toBeVisible();
    expect(open.getByText('Summary written by Claude').elements()).toHaveLength(0);
  });

  it('every_entry_shows_its_origin', async () => {
    const CHECKED = 'Recorded by the checkpoint';
    const REPORTED = 'Reported by the chat service, not checked by the checkpoint';
    const reported = entry(4, '2026-10-20T16:53:00.000000Z', { kind: 'rate_limit', origin: 'api', session_id: 'ses-2', summary: { limit: 'turns' } });
    injectLedger(ledgerPage([...threeEntries(), reported]));
    injectAttempts([
      attempt({ ref_id: 'att-reported', origin: 'api', reason_plain: 'Someone sent messages faster than a person can type.', ledger_seq: 4 }),
      attempt(),
    ]);
    const { screen } = await renderRoute(`${SAFETY}/att-reported`);
    const noOldWords = () => expect(document.body.textContent).not.toMatch(/From chat|From the chat service/);

    // Each attempt's row, and the attempt open beside the list, in the same words.
    const reportedRow = screen.getByRole('link', { name: /Someone sent messages faster/ });
    const checkedRow = screen.getByRole('link', { name: new RegExp(REFUND_REASON.slice(0, 30)) });
    await expect.element(reportedRow.getByText(REPORTED, { exact: true })).toBeVisible();
    await expect.element(checkedRow.getByText(CHECKED, { exact: true })).toBeVisible();
    await expect.element(detail(screen).getByText(REPORTED, { exact: true })).toBeVisible();
    noOldWords();
    await checkedRow.click();
    await expect.element(detail(screen).getByText(CHECKED, { exact: true })).toBeVisible();
    expect(detail(screen).getByText(REPORTED).elements()).toHaveLength(0);
    noOldWords();

    // Every row of the record.
    await viewOption(screen, 'Every entry').click();
    await expect.element(recordRow(screen, 4).getByText(REPORTED, { exact: true })).toBeVisible();
    for (const seq of [1, 2, 3]) await expect.element(recordRow(screen, seq).getByText(CHECKED, { exact: true })).toBeVisible();
    noOldWords();
  });

  it('filters_start_with_all', async () => {
    injectLedger(ledgerPage(threeEntries()));
    const sorted = (summary: string, category: TriageCategory, n: number) =>
      attempt({ ref_id: `att-${n}`, triage: { summary, category }, created_at: `2026-10-20T16:4${n}:00.000000Z`, ledger_seq: 100 + n });
    injectAttempts([
      sorted('Posed as Maria to get a refund', 'impersonation', 5),
      sorted('Pushed for half off', 'discount_push', 4),
      sorted('Agent went over its signed limit', 'over_limit', 3),
      sorted('Asked for Bob’s warranty', 'private_data', 2),
      attempt({ ref_id: 'att-1', reason_plain: 'Someone asked for a callback at midnight.', created_at: '2026-10-20T16:41:00.000000Z', ledger_seq: 101 }),
    ]);
    const { screen } = await renderRoute(SAFETY);
    const filters = screen.getByRole('group', { name: 'Show attempts' });
    const list = screen.getByRole('list', { name: 'Attempts, newest first' });
    const shown = () => list.getByRole('link').elements().map((a) => a.querySelector('.cd-attempt-row__title')?.textContent);
    const ALL = ['Posed as Maria to get a refund', 'Pushed for half off', 'Agent went over its signed limit', 'Asked for Bob’s warranty', 'Someone asked for a callback at midnight.'];

    // "All" first and pressed, every attempt listed; then the categories in order, one "Money", and "Not sorted yet" last.
    await expect.element(list.getByRole('link').first()).toBeVisible();
    const chips = filters.getByRole('button');
    expect(chips.elements().map((b) => b.textContent)).toEqual([
      'All',
      'Posing as you',
      'Money',
      'Private data',
      'Codes',
      'Hidden instructions',
      'Other',
      'Not sorted yet',
    ]);
    await expect.element(filters.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(chips.elements().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(shown()).toEqual(ALL);

    // A category shows only its attempts, and "Money" both kinds of money attempt.
    await filters.getByRole('button', { name: 'Posing as you', exact: true }).click();
    await expect.element(filters.getByRole('button', { name: 'Posing as you', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.element(filters.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(shown()).toEqual(['Posed as Maria to get a refund']);
    await filters.getByRole('button', { name: 'Money', exact: true }).click();
    await expect.poll(shown).toEqual(['Pushed for half off', 'Agent went over its signed limit']);
    await filters.getByRole('button', { name: 'Not sorted yet', exact: true }).click();
    await expect.poll(shown).toEqual(['Someone asked for a callback at midnight.']);
    // A category with none says so, and how to see the rest.
    await filters.getByRole('button', { name: 'Codes', exact: true }).click();
    await expect.element(screen.getByText('No attempts of this kind. Choose All to see every attempt.', { exact: true })).toBeVisible();
    expect(list.elements()).toHaveLength(0);

    // "All" brings them back.
    await filters.getByRole('button', { name: 'All', exact: true }).click();
    await expect.poll(shown).toEqual(ALL);
  });

  it('replayed_entries_are_labelled', async () => {
    // Entry 2 was written into this copy on Oct 20 at 9:51 am, replaying a refusal that happened
    // in the recorded history on Oct 18 at 9:52 am; the marker is inside the signed summary.
    const [live, decide, reply] = threeEntries();
    if (!live || !decide || !reply) throw new Error('three entries');
    const replayedAt = '2026-10-18T16:52:00.000000Z';
    const replayed: LedgerEntry = {
      ...decide,
      event: { ...decide.event, summary: { ...decide.event.summary, replayed: { at: replayedAt, recording: 'night-2026-10' } } },
    };
    injectLedger(ledgerPage([live, replayed, reply]));
    injectAttempts([attempt({ created_at: decide.created_at })]);

    // "?view=entries" opens every entry.
    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(viewOption(screen, 'Every entry')).toHaveAttribute('aria-checked', 'true');
    const row = recordRow(screen, 2);
    await expect.element(row.getByText(REPLAYED, { exact: true })).toBeVisible();
    await expect.element(row.getByText('Oct 18, 9:52 am', { exact: true })).toBeVisible();
    expect(row.getByText('Oct 20, 9:51 am').elements()).toHaveLength(0);
    // A live entry says nothing about replay.
    await expect.element(recordRow(screen, 1).getByText('Oct 20, 9:50 am', { exact: true })).toBeVisible();
    expect(recordRow(screen, 1).getByText(REPLAYED).elements()).toHaveLength(0);
    expect(recordRow(screen, 3).getByText(REPLAYED).elements()).toHaveLength(0);

    // The trace shows the signed entry as it is: when it was recorded into this copy, and the marker.
    await row.click();
    const trace = region(screen, 'Full trace of entry 2');
    const values = () => [...trace.element().querySelectorAll('.cd-type-trace')].map((el) => el.textContent ?? '');
    await expect.element(trace.getByText('Recorded at', { exact: true })).toBeVisible();
    expect(values()).toContain(decide.created_at);
    expect(values().join('\n')).toContain(replayedAt);

    // The attempt kept in that entry says the same, at the same time.
    await viewOption(screen, 'Attempts').click();
    const open = detail(screen);
    await expect.element(open.getByText(REPLAYED, { exact: true })).toBeVisible();
    await expect.element(open.getByText('Oct 18, 9:52 am', { exact: true })).toBeVisible();
    expect(open.getByText('Oct 20, 9:51 am').elements()).toHaveLength(0);
  });

  it('attempt_times_show_the_day_and_time', async () => {
    // 9:52 am today on the business's clock (38 minutes before NOW), and four days before.
    const todayAt = isoTime(NOW.getTime() - 38 * 60_000);
    const olderAt = '2026-10-26T16:52:00.000000Z';
    injectLedger(
      ledgerPage([
        entry(1, olderAt, { kind: 'decide', session_id: 'ses-old', ref_id: 'dec-old', summary: { tool: 'native.send_code', outcome: 'refuse', state: 'refused', card_ids: [] } }),
        entry(2, todayAt, { kind: 'decide', session_id: 'ses-1', ref_id: 'dec-refund', summary: { tool: 'payments.create_refund', outcome: 'refuse', state: 'refused', card_ids: [] } }),
      ]),
    );
    injectAttempts([
      attempt({ created_at: todayAt }),
      attempt({ ref_id: 'dec-old', reason_plain: 'Someone asked me to send Dana’s code somewhere else.', created_at: olderAt, ledger_seq: 1 }),
    ]);
    const { screen } = await renderRoute(`${SAFETY}/dec-refund`);
    const todays = screen.getByRole('link', { name: new RegExp(`^Today, 9:52 am ${REFUND_REASON.slice(0, 20)}`) });
    const older = screen.getByRole('link', { name: /^Oct 26, 9:52 am Someone asked me to send Dana/ });

    // In the list, and in the attempt open beside it.
    await expect.element(todays).toBeVisible();
    await expect.element(older).toBeVisible();
    await expect.element(detail(screen).getByText('Today, 9:52 am', { exact: true })).toBeVisible();
    await older.click();
    await expect.element(detail(screen).getByText('Oct 26, 9:52 am', { exact: true })).toBeVisible();

    // In the record.
    await viewOption(screen, 'Every entry').click();
    await expect.element(recordRow(screen, 2).getByText('Today, 9:52 am', { exact: true })).toBeVisible();
    await expect.element(recordRow(screen, 1).getByText('Oct 26, 9:52 am', { exact: true })).toBeVisible();

    // Never a bare time or a bare date.
    await viewOption(screen, 'Attempts').click();
    await expect.element(detail(screen)).toBeVisible();
    const times = [...document.querySelectorAll('.cd-attempt-row__time, .cd-attempt__when')].map((el) => el.textContent ?? '');
    expect(times.length).toBeGreaterThanOrEqual(3);
    for (const time of times) expect(time).toMatch(/^(?:Today|[A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2} [ap]m$/);
  });

  it('safety_has_no_jargon', async () => {
    // The seeded copy as the mock has it: a blocked reply and the record so far, with the held 15%
    // quote listed as a held attempt.
    await listSeededHold();
    const { screen } = await renderRoute(SAFETY);
    await expect.element(detail(screen).getByText('This reply was never shown.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Every entry checks out', { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    // A held request is held, not stopped, and claims nothing about what happens next.
    await screen.getByRole('link', { name: /^Today, \d{1,2}:\d{2} [ap]m A visitor not on record/ }).click();
    await expect.element(detail(screen).getByText('Held for you', { exact: true })).toBeVisible();
    expect(detail(screen).element().textContent).not.toMatch(/didn.t run|never shown/);
    await expect.element(screen.getByRole('link', { name: '1 held for you', exact: true })).toHaveAttribute('href', `${DESK}/today`);
    await expectScreenBasics(screen.container, { owner: true });
    await detail(screen).getByRole('button', { name: 'See how it was stopped' }).click();
    await expectScreenBasics(screen.container, { owner: true });
    await viewOption(screen, 'Every entry').click();
    await expect.element(screen.getByRole('list', { name: 'Every entry, newest first' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // Attempts Claude has sorted, with a summary and a category.
    mockStore.reset('rivera');
    await stoppedThisWeek(2);
    injectLedger(ledgerPage(threeEntries()));
    injectAttempts([
      attempt({ triage: { summary: 'Claimed to be the owner to move a refund to another card.', category: 'impersonation' } }),
      attempt({ ref_id: '3', kind: 'reply_blocked', reason_plain: "Claude's reply put a price in its own words, so it wasn't shown.", ledger_seq: 3 }),
    ]);
    const sorted = await renderRoute(SAFETY);
    await expect.element(detail(sorted.screen).getByText('Summary written by Claude', { exact: true })).toBeVisible();
    await expectScreenBasics(sorted.screen.container, { owner: true });

    // A fresh copy with nothing stopped and nothing in the record yet.
    const quiet = await renderRoute(SAFETY, { seed: 'rivera_quiet' });
    await expect.element(quiet.screen.getByText('Nothing stopped this week', { exact: true })).toBeVisible();
    await expect.element(quiet.screen.getByRole('link', { name: 'Open your public page' })).toHaveAttribute('target', '_blank');
    await expectScreenBasics(quiet.screen.container, { owner: true });
    await viewOption(quiet.screen, 'Every entry').click();
    await expect.element(quiet.screen.getByText('Nothing in the record yet', { exact: true })).toBeVisible();
    await expectScreenBasics(quiet.screen.container, { owner: true });
  });

  it('ledger_read_failure_says_so', async () => {
    // The record was read and checked; then a later read fails. The check says so, first, beside
    // what it last found, and stays until a read works, so an old check never reads as current.
    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    const checked = screen.getByText('Every entry checks out', { exact: true });
    const record = screen.getByRole('list', { name: 'Every entry, newest first' });
    await expect.element(checked).toBeVisible();
    await expect.element(record).toBeVisible();
    mockStore.inject({ route: 'ledger', status: 503, times: 10_000 });
    const alert = screen.getByRole('alert');
    const line = alert.getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    expect(line.element().closest('.cd-safety__chain')).toBe(checked.element().closest('.cd-safety__chain'));
    expect(line.element().compareDocumentPosition(checked.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect.element(checked).toBeVisible();
    await expect.element(record).toBeVisible();
    const retry = alert.getByRole('button', { name: 'Try again' });
    await expect.element(retry).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // It stays while the polls read again, and while "Try again" reads, busy until that read settles.
    await readsMore('ledger', 2);
    expect(line.elements()).toHaveLength(1);
    await retry.click();
    await expect.element(retry).toHaveAttribute('aria-busy', 'true');
    await expect.element(retry, { timeout: 5_000 }).not.toHaveAttribute('aria-busy');
    expect(line.elements()).toHaveLength(1);

    // Once a read works, the line is gone and the check is current again.
    mockStore.reset('rivera');
    await expect.element(line, { timeout: 5_000 }).not.toBeInTheDocument();
    await expect.element(checked).toBeVisible();

    // With nothing read yet, the line stays through the polls rather than going back to
    // "Checking the record" each time a read starts.
    mockStore.inject({ route: 'ledger', status: 503, times: 10_000 });
    const fresh = await renderRoute(SAFETY);
    const first = fresh.screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(first, { timeout: 5_000 }).toBeVisible();
    await readsMore('ledger', 2);
    expect(first.elements()).toHaveLength(1);
    expect(fresh.screen.getByText('Checking the record').elements()).toHaveLength(0);
  });

  it('attempts_read_failure_says_so', async () => {
    // The attempts were read; then a later read fails. The line says so over the attempts already
    // read, which stay with the one open beside them, until a read works.
    const { screen } = await renderRoute(SAFETY);
    const list = screen.getByRole('list', { name: 'Attempts, newest first' });
    await expect.element(list).toBeVisible();
    await expect.element(detail(screen)).toBeVisible();
    mockStore.inject({ route: 'safety', status: 503, times: 10_000 });
    const alert = screen.getByRole('alert');
    const line = alert.getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    expect(line.element().compareDocumentPosition(list.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect.element(list).toBeVisible();
    await expect.element(detail(screen)).toBeVisible();
    const retry = alert.getByRole('button', { name: 'Try again' });
    await expect.element(retry).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    await readsMore('safety', 2);
    expect(line.elements()).toHaveLength(1);
    await retry.click();
    await expect.element(retry).toHaveAttribute('aria-busy', 'true');
    await expect.element(retry, { timeout: 5_000 }).not.toHaveAttribute('aria-busy');
    expect(line.elements()).toHaveLength(1);

    mockStore.reset('rivera');
    await expect.element(line, { timeout: 5_000 }).not.toBeInTheDocument();
    await expect.element(list).toBeVisible();

    // With nothing read yet, the line stays through the polls rather than going back to
    // "Reading the attempts".
    mockStore.inject({ route: 'safety', status: 503, times: 10_000 });
    const fresh = await renderRoute(SAFETY);
    const first = fresh.screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(first, { timeout: 5_000 }).toBeVisible();
    await readsMore('safety', 2);
    expect(first.elements()).toHaveLength(1);
    expect(fresh.screen.getByText('Reading the attempts').elements()).toHaveLength(0);
  });

  it('headline_read_failure_says_so', async () => {
    // This week's count was read; then a later read fails. The line says so over the count, which
    // stays, until a read works.
    const { screen } = await renderRoute(SAFETY);
    const headline = screen.getByText(/stopped this week\.$/);
    await expect.element(headline).toBeVisible();
    mockStore.inject({ route: 'today', status: 503, times: 10_000 });
    const line = screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    expect(line.element().compareDocumentPosition(headline.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect.element(headline).toBeVisible();
    await readsMore('today', 2);
    expect(line.elements()).toHaveLength(1);
    mockStore.reset('rivera');
    await expect.element(line, { timeout: 5_000 }).not.toBeInTheDocument();
    await expect.element(headline).toBeVisible();
  });

  it('picking_an_attempt_moves_to_it', async () => {
    // The seeded copy: the blocked reply, newest, open on arrival, and the held 15% quote listed
    // as a held attempt.
    await listSeededHold();
    const { screen } = await renderRoute(SAFETY);
    const open = detail(screen);
    await expect.element(open.getByText('This reply was never shown.', { exact: true })).toBeVisible();
    // The attempt open on arrival, or after a filter, leaves the focus where it is.
    expect(document.activeElement).toBe(document.body);
    const filters = screen.getByRole('group', { name: 'Show attempts' });
    await filters.getByRole('button', { name: 'Codes', exact: true }).click();
    const all = filters.getByRole('button', { name: 'All', exact: true });
    await all.click();
    await expect.element(open.getByText('This reply was never shown.', { exact: true })).toBeVisible();
    expect(document.activeElement).toBe(all.element());

    // A picked row moves the focus to the attempt it opens, so a keyboard or screen reader user
    // lands on it.
    const held = /^Today, \d{1,2}:\d{2} [ap]m A visitor not on record/;
    await screen.getByRole('link', { name: held }).click();
    await expect.element(open.getByText('Held for you', { exact: true })).toBeVisible();
    await expect.poll(() => document.activeElement?.contains(open.element()) ?? false).toBe(true);

    // On a phone the attempt opens under the list, mostly past the window's edge: picking a row
    // also scrolls it into view, all of it, or from its top when it is taller than the window. A
    // short phone window, so the list's rows reach past its edge too.
    const phone = await renderRoute(SAFETY, { viewport: 'phone' });
    await page.viewport(390, 600);
    await expect.poll(() => window.innerHeight).toBe(600);
    const under = detail(phone.screen);
    await expect.element(under.getByText('This reply was never shown.', { exact: true })).toBeInTheDocument();
    const main = document.querySelector('.cd-app-shell__main');
    if (!main) throw new Error('the page area');
    expect(box(under.element()).bottom).toBeGreaterThan(box(main).bottom);
    // Only the page area scrolls, never the window, so the shell's bars stay in place.
    expectNoWindowScroll();
    await phone.screen.getByRole('link', { name: held }).click();
    await expect.element(under.getByText('Held for you', { exact: true })).toBeInTheDocument();
    await expect.poll(() => document.activeElement?.contains(under.element()) ?? false).toBe(true);
    const margin = Number.parseFloat(getComputedStyle(under.element().parentElement ?? under.element()).scrollMarginTop);
    await expect
      .poll(() => {
        const opened = box(under.element());
        const area = box(main);
        return main.scrollTop > 0 && opened.top >= area.top && (opened.bottom <= area.bottom || opened.top <= area.top + margin + 1);
      })
      .toBe(true);
    expectNoWindowScroll();
    expect(window.scrollY).toBe(0);
  });

  it('chain_key_sits_at_the_end', async () => {
    // The check's line and count at the start of the bar, the signing key at its end, just before
    // the switch between the views.
    injectDevKey(true);
    const { screen } = await renderRoute(SAFETY);
    const key = screen.getByText('Signed with a development key', { exact: true });
    await expect.element(key).toBeVisible();
    const bar = key.element().closest('.cd-safety__bar');
    const view = bar?.lastElementChild;
    if (!bar || !view) throw new Error('the bar with the view switch at its end');
    const gap = Number.parseFloat(getComputedStyle(bar).columnGap);
    expect(box(view).left - box(key.element()).right).toBeCloseTo(gap, 0);
  });

  it('record_columns_line_up', async () => {
    // Times wider than the head's "Time": late in the evening, on a day that isn't today.
    injectLedger(
      ledgerPage([
        entry(1, '2026-10-27T06:30:00.000000Z', { kind: 'session', session_id: 'ses-1', summary: { kind: 'visitor' } }),
        entry(2, '2026-10-27T06:31:00.000000Z', {
          kind: 'decide',
          session_id: 'ses-1',
          ref_id: 'dec-refund',
          summary: { tool: 'payments.create_refund', outcome: 'refuse', state: 'refused', card_ids: [] },
        }),
      ]),
    );
    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(recordRow(screen, 1).getByText('Oct 26, 11:30 pm', { exact: true })).toBeVisible();
    const [, what, who, when] = [...document.querySelectorAll('.cd-record__head > span')].map((el) => box(el));
    if (!what || !who || !when) throw new Error('the four column heads');
    // Each column's words start under its head, and the times end under "Time".
    for (const seq of [1, 2]) {
      const row = recordRow(screen, seq).element();
      expect(box(row.querySelector('.cd-record__what')).left).toBeCloseTo(what.left, 0);
      expect(box(row.querySelector('.cd-record__who')).left).toBeCloseTo(who.left, 0);
      expect(box(row.querySelector('.cd-record__when')).right).toBeCloseTo(when.right, 0);
    }
  });
});
