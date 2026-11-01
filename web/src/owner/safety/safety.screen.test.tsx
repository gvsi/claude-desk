/**
 * Safety in a real browser against the mock API: this week's stopped attempts with what stopped
 * each one, an attempt's detail in tiers, and every entry of the signed record with its chain,
 * each saying where it came from and when it happened.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { LedgerEntry, LedgerEvent, LedgerPage } from '../../api/contracts.ts';
import type { Attempt, Today, TriageCategory } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { isoTime } from '../../mocks/world.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectNoWindowScroll, expectScreenBasics } from '../../test/screen.ts';
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
    cause: null,
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

const HALF_OFF_REASON = 'Asked for 50% off the drain clearing. Your rule says never to discount it, so I didn’t.';

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
    cause: null,
    ...fields,
  };
}

/** A blocked reply's line as the API writes it, when no violation says more. */
const STOPPED_REPLY = 'A reply was stopped before it was shown.';

/** Safety's empty state, its headline for a count of one or more, and its headline for none. */
const NOTHING = "When a request is turned down or a reply is stopped, you'll see here what was asked and why. Try it yourself from your public page.";
const HEADLINE = /^I turned down \d+ requests? this week\.$/;
const NONE_TURNED_DOWN = "I didn't turn down any requests this week.";

/**
 * One of Claude's drafts the reply check stopped at `at`: entry `seq` of the record, and its
 * attempt as the API lists it.
 */
function stoppedDraft(seq: number, at: string): { entry: LedgerEntry; attempt: Attempt } {
  return {
    entry: entry(seq, at, { kind: 'reply', session_id: `ses-${seq}`, summary: { author: 'claude', ok: false, language: 'en', violations: [] } }),
    attempt: attempt({ ref_id: String(seq), kind: 'reply_blocked', reason_plain: STOPPED_REPLY, created_at: at, ledger_seq: seq }),
  };
}

/**
 * The built-in agent tries to charge $185 in one go, over its signed limit, and the kernel refuses
 * it: a request this week's count takes in, unlike a draft of Claude's the reply check stopped.
 */
async function refuseTheAgentsCharge(): Promise<void> {
  const refused = () => [...mockStore.world.decisions.values()].filter((d) => d.decision.state === 'refused').length;
  const before = refused();
  await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
  const body = { task: 'push_the_limit', idempotency_key: `refuse-${before}` };
  const sent = await mockStore.dispatch('sendAgent', { params: { slug: RIVERA.slug }, body });
  if ('network' in sent || sent.status !== 202) throw new Error('the mock sends the built-in agent');
  await expect.poll(refused, { timeout: 5_000 }).toBe(before + 1);
}

/** A read the test lets land when it chooses. */
function held(): { until: Promise<void>; release: () => void } {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  return { until, release };
}

/** The open attempt beside the list. */
function detail(screen: RenderResult) {
  return region(screen, 'Details');
}

/** The view switch's option `name`. */
function viewOption(screen: RenderResult, name: 'Stopped' | 'Every entry') {
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
  it.each(['with entries', 'empty', 'chip with nothing', 'loading', 'missing entry'] as const)(
    'uses the signed page words: %s',
    async (state) => {
      const pending = held();
      if (state === 'empty') {
        injectAttempts([]);
        await stoppedThisWeek(0);
      } else if (state === 'loading') {
        mockStore.inject({ route: 'safety', status: 200, body: [], until: pending.until });
      } else {
        // Claude's summaries are outside the page's copy contract, in the row and detail alike.
        injectAttempts([attempt({ created_at: isoTime(NOW.getTime()), triage: { summary: 'An attempt described by Claude.', category: 'other' } })]);
        await stoppedThisWeek(1);
      }
      try {
        const { screen } = await renderRoute(state === 'missing entry' ? `${SAFETY}/missing` : SAFETY);
        if (state === 'empty') {
          await expect.element(screen.getByText(NONE_TURNED_DOWN, { exact: true })).toBeVisible();
        } else if (state === 'loading') {
          await expect.element(screen.getByRole('status').filter({ hasText: /^Reading/ })).toHaveClass('cd-sr-only');
        } else {
          await expect.element(screen.getByRole('list')).toBeVisible();
          if (state === 'chip with nothing') await screen.getByRole('button', { name: 'Verification codes', exact: true }).click();
        }

        const safety = document.querySelector<HTMLElement>('.cd-safety');
        if (!safety) throw new Error('the Safety page');
        const ownCopy = safety.cloneNode(true) as HTMLElement;
        ownCopy.querySelectorAll('.cd-attempt__summary, .cd-attempt-row__title, [hidden], [aria-hidden="true"]').forEach((el) => el.remove());
        expect(ownCopy.textContent, 'page text excluding Claude summaries').not.toMatch(/attempt/i);
        const names = [...ownCopy.querySelectorAll('*')].flatMap((el) =>
          ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'alt'].map((name) => el.getAttribute(name) ?? ''),
        );
        expect(names.join(' '), 'accessible names and descriptions').not.toMatch(/attempt/i);
        if (state !== 'loading') await expect.element(viewOption(screen, 'Stopped')).toHaveAttribute('aria-checked', 'true');
        if (state === 'empty') {
          await expect.element(screen.getByText(NOTHING, { exact: true })).toBeVisible();
          expect(screen.getByText('Nothing stopped this week', { exact: true }).elements()).toHaveLength(0);
          await expect.element(screen.getByRole('link', { name: 'Open your public page' })).toBeVisible();
        } else if (state === 'loading') {
          expect(screen.getByText('Reading the attempts', { exact: true }).elements()).toHaveLength(0);
          await expect.element(screen.getByText('Reading what was stopped', { exact: true })).toHaveClass('cd-sr-only');
        } else {
          await expect.element(screen.getByRole('group', { name: 'Show by kind' })).toBeVisible();
          if (state === 'chip with nothing') {
            await expect.element(screen.getByText('Nothing of this kind. Choose All to see the rest.', { exact: true })).toBeVisible();
          } else {
            await expect.element(screen.getByRole('list', { name: 'Stopped, newest first' })).toBeVisible();
            if (state === 'missing entry') {
              await expect.element(screen.getByText("This one isn't in the list", { exact: true })).toBeVisible();
            } else {
              await expect.element(detail(screen)).toBeVisible();
            }
          }
        }
      } finally {
        pending.release();
      }
    },
  );

  it('chain_ok_header', async () => {
    await stoppedThisWeek(2);
    const entries = (await mockLedger()).entries.length;
    const { screen } = await renderRoute(SAFETY);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Safety' })).toBeVisible();
    await expect.element(screen.getByText('I turned down 2 requests this week.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Every entry matches the chain', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('img', { name: `${entries} entries`, exact: true })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/talk me around|attempts? (?:was|were) stopped/);

    // One request reads in the singular.
    mockStore.reset('rivera');
    await stoppedThisWeek(1);
    const one = await renderRoute(SAFETY);
    await expect.element(one.screen.getByText('I turned down 1 request this week.', { exact: true })).toBeVisible();
  });

  it('empty_state_only_when_nothing_was_stopped_this_week', async () => {
    // A fresh copy, with nothing stopped ever. The empty state waits for the attempts, so it never
    // says nothing was stopped before the list has said so too.
    mockStore.reset('rivera_quiet');
    const list = held();
    mockStore.inject({ route: 'safety', status: 200, body: [], until: list.until });
    const quiet = await renderRoute(SAFETY);
    await readsMore('today', 2);
    expect(quiet.screen.getByText(NOTHING).elements()).toHaveLength(0);
    expect(quiet.screen.getByText(NONE_TURNED_DOWN).elements()).toHaveLength(0);
    list.release();
    await expect.element(quiet.screen.getByText(NOTHING, { exact: true })).toBeVisible();
    // The week turned nothing down, said in Claude's voice above the empty state.
    const none = quiet.screen.getByText(NONE_TURNED_DOWN, { exact: true });
    await expect.element(none).toBeVisible();
    expect(none.element().compareDocumentPosition(quiet.screen.getByText(NOTHING).element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quiet.screen.getByText(HEADLINE).elements()).toHaveLength(0);
    expect(quiet.screen.getByRole('list', { name: 'Stopped, newest first' }).elements()).toHaveLength(0);

    // A draft of Claude's the reply check stopped at 8:00 pm on Friday the 23rd in Los Angeles,
    // already the 24th in UTC: before the seven days began, so this week has still stopped nothing,
    // and the list still shows it.
    mockStore.reset('rivera');
    const older = stoppedDraft(1, '2026-10-24T03:00:00.000000Z');
    injectLedger(ledgerPage([older.entry]));
    injectAttempts([older.attempt]);
    await stoppedThisWeek(0);
    const { screen } = await renderRoute(SAFETY);
    await expect.element(screen.getByText(NOTHING, { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: /^Oct 23, 8:00 pm A reply was stopped before it was shown\./ })).toBeVisible();
  });

  it('stopped_drafts_alone_turn_nothing_down', async () => {
    // Only Claude's own drafts were stopped this week, at 12:30 am on its first day and at 9:52 am
    // today, and no request was refused: the headline says no request was turned down, and nothing
    // says nothing was stopped. The list shows both drafts.
    const first = stoppedDraft(1, '2026-10-24T07:30:00.000000Z');
    const second = stoppedDraft(2, isoTime(NOW.getTime() - 38 * 60_000));
    injectLedger(ledgerPage([first.entry, second.entry]));
    injectAttempts([second.attempt, first.attempt]);
    await stoppedThisWeek(0);
    const { screen } = await renderRoute(SAFETY);
    const rows = screen.getByRole('list', { name: 'Stopped, newest first' }).getByRole('link');
    await expect.element(rows.first()).toBeVisible();
    expect(rows.elements().map((row) => row.querySelector('.cd-attempt-row__title')?.textContent)).toEqual([STOPPED_REPLY, STOPPED_REPLY]);
    await expect.element(detail(screen).getByText('This reply was never shown.', { exact: true })).toBeVisible();

    // Today's count has been read again with the list on screen: still none turned down, no count
    // and no empty state.
    await readsMore('today', 2);
    await expect.element(screen.getByText(NONE_TURNED_DOWN, { exact: true })).toBeVisible();
    expect(screen.getByText(HEADLINE).elements()).toHaveLength(0);
    expect(screen.getByText(NOTHING).elements()).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Open your public page' }).elements()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/talk me around/);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('refused_requests_keep_the_headline', async () => {
    // A request the kernel refused this week, beside a draft of Claude's the reply check stopped:
    // the headline counts the refused request as Today does, and the list keeps both.
    const refusedAt = '2026-10-29T16:51:00.000000Z';
    const draft = stoppedDraft(3, '2026-10-29T17:10:00.000000Z');
    const refusal = entry(2, refusedAt, {
      kind: 'decide',
      session_id: 'ses-1',
      ref_id: 'dec-refund',
      summary: { tool: 'payments.create_refund', outcome: 'refuse', state: 'refused', card_ids: [] },
    });
    injectLedger(ledgerPage([refusal, draft.entry]));
    injectAttempts([draft.attempt, attempt({ created_at: refusedAt })]);
    await stoppedThisWeek(1);
    const { screen } = await renderRoute(SAFETY);
    await expect.element(screen.getByText('I turned down 1 request this week.', { exact: true })).toBeVisible();
    const rows = screen.getByRole('list', { name: 'Stopped, newest first' }).getByRole('link');
    await expect.element(rows.first()).toBeVisible();
    expect(rows.elements().map((row) => row.querySelector('.cd-attempt-row__title')?.textContent)).toEqual([STOPPED_REPLY, REFUND_REASON]);
    expect(screen.getByText(NOTHING).elements()).toHaveLength(0);
    expect(screen.getByText(NONE_TURNED_DOWN).elements()).toHaveLength(0);
  });

  it('headline_counts_the_listed_refusals', async () => {
    // A visitor asks for 50% off, the Desk holds it for Maria, and she allows it. A hold is hers to
    // answer, not an attempt that was stopped: the count and the list both leave it out. Then the
    // built-in agent tries to charge over its signed limit, which is refused. The count is the
    // refused requests, the rows stopped at the action checkpoint; the seeded draft of Claude's the
    // reply check stopped is listed, and not counted.
    const ask = 'Can I get 50% off if I pay cash?';
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: ask } });
    const asked = () => [...mockStore.world.decisions.values()].find((d) => d.decision.action?.discount_bp === 5000)?.decision;
    await expect.poll(() => asked()?.state, { timeout: 5_000 }).toBe('held');
    await mockStore.dispatch('answer', { params: { decision_id: asked()?.decision_id ?? '' }, body: { answer: 'allow_once' } });
    await expect.poll(() => asked()?.state, { timeout: 5_000 }).toBe('executed');
    await refuseTheAgentsCharge();

    const { screen } = await renderRoute(SAFETY);
    const headline = screen.getByText(HEADLINE);
    await expect.element(headline).toBeVisible();
    const list = screen.getByRole('list', { name: 'Stopped, newest first' });
    await expect.element(list.getByRole('link').first()).toBeVisible();
    const refused = list.getByRole('link', { name: /Stopped by: Action checkpoint$/ }).elements();
    expect(refused).toHaveLength(Number.parseInt(/\d+/.exec(headline.element().textContent ?? '')?.[0] ?? '', 10));
    expect(list.getByRole('link', { name: /Stopped by: Reply checkpoint$/ }).elements()).toHaveLength(1);
    expect(list.getByRole('link').elements()).toHaveLength(refused.length + 1);

    // Newest first, by the time each row shows.
    const ledger = await mockLedger();
    const times = (await mockAttempts()).map((a) => Date.parse(attemptTime(a, ledger)));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('broken_chain_is_plain', async () => {
    injectLedger(ledgerPage(threeEntries(), { chain_ok: false, first_bad_seq: 2 }));
    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(screen.getByText("Entry 2 doesn't match the chain", { exact: true })).toBeVisible();
    expect(screen.getByText('Every entry matches the chain').elements()).toHaveLength(0);

    // An entry's full trace says the chain is broken, and where, never that it was verified.
    await recordRow(screen, 3).click();
    const trace = region(screen, 'Full trace of entry 3');
    await expect.element(trace.getByText('Chain broken at entry 2', { exact: true })).toBeVisible();
    expect(trace.getByText(/Chain verified/).elements()).toHaveLength(0);
  });

  it('a_long_trace_scrolls_in_its_column_and_the_page_stays_put', async () => {
    // A trace taller than the window, in a window short enough for it (owner comment, 2026-11-01:
    // "long trace column makes the whole page jump"). Opening it leaves the page where it was, and
    // the trace scrolls inside its own column beside the list.
    const checks = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`check_${i}`, { status: 'ok', blocked: false, latency_ms: i }]));
    const entries = threeEntries();
    entries[2] = entry(3, '2026-10-20T16:52:00.000000Z', { kind: 'reply', session_id: 'ses-1', summary: { author: 'claude', ok: true, language: 'en', violations: [], soft_checks: checks } });
    injectLedger(ledgerPage(entries));
    const { screen } = await renderRoute(`${SAFETY}?view=entries`, { viewport: { width: 1440, height: 700 } });
    await expect.element(recordRow(screen, 3)).toBeVisible();
    const main = recordRow(screen, 3).element().closest<HTMLElement>('.cd-app-shell__main');
    if (!main) throw new Error('the owner app scrolls its main area');
    const before = main.scrollTop;

    await recordRow(screen, 3).click();
    const trace = region(screen, 'Full trace of entry 3');
    await expect.element(trace).toBeVisible();
    await expect.poll(() => document.activeElement).toBe(trace.element());
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(main.scrollTop).toBe(before);
    const beside = trace.element().closest<HTMLElement>('.cd-safety__beside');
    if (!beside) throw new Error('the trace sits in the column beside the list');
    expect(beside.scrollHeight).toBeGreaterThan(beside.clientHeight);
    // Exactly the main area's height inside its 24 px top and 20 px bottom padding, so all of it
    // shows once the page is scrolled to it, 20 px clear of the main area's bottom.
    expect(Math.abs(beside.getBoundingClientRect().height - (main.clientHeight - 44))).toBeLessThanOrEqual(1);
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

  it.each(['desktop', 'phone'] as const)('refused_entries_say_why_%s', async (viewport) => {
    // This week: a request the owner's rule refused, one the API couldn't place (no cause), and a
    // draft of Claude's the reply check stopped. Only the first says why, over its own detail.
    const ownerRule = attempt({ ref_id: 'dec-half-off', reason_plain: HALF_OFF_REASON, created_at: '2026-10-29T16:51:00.000000Z', ledger_seq: 2, cause: 'owner_rule' });
    const unplaced = attempt({ ref_id: 'dec-refund', created_at: '2026-10-29T16:40:00.000000Z', ledger_seq: 1, cause: null });
    const draft = stoppedDraft(3, '2026-10-29T17:10:00.000000Z');
    const decided = (seq: number, a: Attempt) =>
      entry(seq, a.created_at, { kind: 'decide', session_id: 'ses-1', ref_id: a.ref_id, summary: { tool: 'native.quote', outcome: 'refuse', state: 'refused', card_ids: [] } });
    injectLedger(ledgerPage([decided(1, unplaced), decided(2, ownerRule), draft.entry]));
    injectAttempts([draft.attempt, ownerRule, unplaced]);
    await stoppedThisWeek(2);
    const { screen } = await renderRoute(SAFETY, { viewport });
    await expect.element(screen.getByText('I turned down 2 requests this week.', { exact: true })).toBeVisible();
    const list = screen.getByRole('list', { name: 'Stopped, newest first' });
    const rows = list.getByRole('link');
    await expect.element(rows.first()).toBeVisible();
    const labels = rows.elements().map((row) => row.querySelector('.cd-status-label')?.textContent ?? null);
    const titles = rows.elements().map((row) => row.querySelector('.cd-attempt-row__title')?.textContent);
    expect(labels).toEqual([null, 'Your rule says no', null]);
    expect(titles).toEqual([STOPPED_REPLY, HALF_OFF_REASON, REFUND_REASON]);
    // The label is the first thing the row says after its time, and a refused dot stands beside it.
    await expect.element(list.getByRole('link', { name: /^Oct 29, 9:51 am Your rule says no Asked for 50% off/ })).toBeVisible();
    expect(rows.elements()[1]?.querySelector('.cd-status-label .cd-status-dot--refused')).not.toBeNull();
    // Opened, the entry's detail is as it was: no label there, its reason in full.
    await list.getByRole('link', { name: /Your rule says no/ }).click();
    await expect.element(detail(screen).getByText(HALF_OFF_REASON, { exact: true })).toBeVisible();
    expect(detail(screen).getByText('Your rule says no').elements()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/talk me around/);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_for_you_dot_stands_apart_from_its_words', async () => {
    // The seeded 15% quote waits for Maria: the header's button says so, its gold dot a status
    // label's gap before the words, never touching them.
    const { screen } = await renderRoute(SAFETY);
    const held = screen.getByRole('link', { name: '1 held for you', exact: true });
    await expect.element(held).toBeVisible();
    const dot = held.element().querySelector('.cd-status-dot--held');
    if (!dot) throw new Error('the button has its held dot');
    const walker = document.createTreeWalker(held.element(), NodeFilter.SHOW_TEXT);
    let words: Text | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.textContent?.trim()) {
        words = node as Text;
        break;
      }
    }
    if (words === null) throw new Error('the button has its words');
    const range = document.createRange();
    range.selectNodeContents(words);
    expect(Math.round(range.getBoundingClientRect().left - dot.getBoundingClientRect().right)).toBe(8);
    // The button keeps its one line's height: size-control, 32 px.
    expect(held.element().getBoundingClientRect().height).toBe(32);
  });

  it('mock_refusal_says_why', async () => {
    // The built-in agent's charge over its signed limit, refused by the baseline's signed-limit
    // policy, as the mock decides it: its row says why. The seeded stopped draft says nothing more.
    await refuseTheAgentsCharge();
    const { screen } = await renderRoute(SAFETY);
    const list = screen.getByRole('list', { name: 'Stopped, newest first' });
    const refused = list.getByRole('link', { name: /Stopped by: Action checkpoint$/ });
    await expect.element(refused).toBeVisible();
    await expect.element(refused.getByText("Outside the agent's spending limit", { exact: true })).toBeVisible();
    const draft = list.getByRole('link', { name: /Stopped by: Reply checkpoint$/ });
    await expect.element(draft).toBeVisible();
    expect(draft.element().querySelector('.cd-status-label')).toBeNull();
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
    const summary = 'Someone asked to move a customer’s refund to another card. The Desk refused.';
    injectAttempts([
      attempt({ triage: { summary, category: 'prices' } }),
      attempt({ ref_id: 'dec-other', reason_plain: 'Someone asked for another customer’s invoice.', ledger_seq: 3 }),
    ]);
    const { screen } = await renderRoute(`${SAFETY}/dec-refund`);
    const open = detail(screen);
    // In the list, Claude's summary names the attempt; beside it, it is labelled as written by Claude.
    await expect.element(screen.getByRole('link', { name: new RegExp(`^Oct 20, 9:51 am ${summary}`) })).toBeVisible();
    await expect.element(open.getByText('Summary written by Claude', { exact: true })).toBeVisible();
    await expect.element(open.getByText(summary, { exact: true })).toBeVisible();
    await expect.element(open.getByText('Prices and discounts', { exact: true })).toBeVisible();
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

  it('takeover_and_handback_have_distinct_record_labels', async () => {
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    const session = mockStore.visitorSession(RIVERA.slug);
    if (!session) throw new Error('the visitor has a chat');
    const params = { session_id: session.state.session_id };
    await mockStore.dispatch('takeover', { params, body: { generation: session.state.generation } });
    await mockStore.dispatch('handback', { params, body: { generation: session.state.generation } });
    const entries = (await mockLedger()).entries.filter((e) => e.event.kind === 'takeover');
    expect(entries).toHaveLength(2);
    const [taken, returned] = entries;
    if (!taken || !returned) throw new Error('both mode changes are recorded');

    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(recordRow(screen, taken.seq).getByText('Take over', { exact: true })).toBeVisible();
    await expect.element(recordRow(screen, returned.seq).getByText('Hand back to Claude', { exact: true })).toBeVisible();
    expect(taken.event.summary).toEqual({ from: 'ai', to: 'owner', generation: 2 });
    expect(returned.event.summary).toEqual({ from: 'owner', to: 'ai', generation: 3 });
    await expectScreenBasics(screen.container, { owner: true });
    await recordRow(screen, returned.seq).click();
    const trace = region(screen, `Full trace of entry ${returned.seq}`);
    await expect.element(trace.getByText('What was recorded', { exact: true })).toBeVisible();
    expect(trace.element().textContent).toContain('"from": "owner"');
    expect(trace.element().textContent).toContain('"to": "ai"');
  });

  it('handoff_entries_say_which_they_are', async () => {
    // A visitor asks for Maria, the handoff card hands her the chat, and she marks it done: the
    // record names the two entries the checkpoint wrote for what they are. Any other change to the
    // Desk's details reads as before.
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can I talk to Maria?' } });
    await expect.poll(() => mockStore.world.handoffs.size, { timeout: 5_000 }).toBe(1);
    const [handoffId = ''] = mockStore.world.handoffs.keys();
    await mockStore.dispatch('handoffDone', { params: { handoff_id: handoffId } });
    const { entries } = await mockLedger();
    const handoffs = entries.filter((e) => e.event.kind === 'desk_data' && e.event.summary.part === 'handoffs');
    expect(handoffs.map((e) => e.event.summary)).toEqual([
      { part: 'handoffs', refs: [handoffId], kind: 'card' },
      { part: 'handoffs', refs: [handoffId] },
    ]);
    const [opened, done] = handoffs.map((e) => e.seq);
    const hours = entries.length + 1;
    injectLedger(ledgerPage([...entries, entry(hours, isoTime(Date.now()), { kind: 'desk_data', summary: { part: 'hours', refs: [] } })]));

    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(recordRow(screen, opened ?? 0).getByText('Chat handed to you', { exact: true })).toBeVisible();
    await expect.element(recordRow(screen, done ?? 0).getByText('Chat marked done', { exact: true })).toBeVisible();
    await expect.element(recordRow(screen, hours).getByText('Desk details changed', { exact: true })).toBeVisible();
    expect(screen.getByText('Desk details changed').elements()).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });
    // The entry's full trace reads the row's name as its sentence.
    await recordRow(screen, opened ?? 0).click();
    const trace = region(screen, `Full trace of entry ${opened}`);
    await expect.element(trace.getByText('Chat handed to you. Recorded by the checkpoint.', { exact: true })).toBeVisible();
  });

  it('handoff_closed_by_a_call_back_says_so', async () => {
    // The handoff card hands Maria the chat, then the visitor asks for a call back, which closes
    // the card's handoff and opens its own: the record calls that closing what it was, never the
    // owner's Mark done.
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can I talk to Maria?' } });
    await expect.poll(() => mockStore.world.handoffs.size, { timeout: 5_000 }).toBe(1);
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can you call me back?' } });
    await expect.poll(() => mockStore.world.handoffs.size, { timeout: 5_000 }).toBe(2);
    const { entries } = await mockLedger();
    const closed = entries.find((e) => e.event.kind === 'desk_data' && e.event.summary.part === 'handoffs' && Object.hasOwn(e.event.summary, 'replaced_by'));
    if (!closed) throw new Error('the call-back closed the card handoff');
    injectLedger(ledgerPage(entries));

    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(recordRow(screen, closed.seq).getByText('Chat moved to a call-back', { exact: true })).toBeVisible();
    expect(screen.getByText('Chat marked done', { exact: true }).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('handoff_closed_by_the_owner_handling_the_chat_says_how', async () => {
    // The kernel closes the handoff card's handoff when Maria takes the chat over or writes in it:
    // the record names each closing, never her Mark done.
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can I talk to Maria?' } });
    await expect.poll(() => mockStore.world.handoffs.size, { timeout: 5_000 }).toBe(1);
    const session = mockStore.visitorSession(RIVERA.slug);
    if (!session) throw new Error('the visitor has a chat');
    const params = { session_id: session.state.session_id };
    await mockStore.dispatch('takeover', { params, body: { generation: session.state.generation } });
    // In the chat she has taken over, the handoff card again, then her own words.
    mockStore.world.reply(session, [rivera.blocks.handoff.en], 'en');
    expect(mockStore.world.handoffs.size).toBe(2);
    await mockStore.dispatch('ownerMessage', { params, body: { text: 'I can help with that.', kind: 'say' } });
    const { entries } = await mockLedger();
    const closings = entries.filter((e) => e.event.kind === 'desk_data' && e.event.summary.part === 'handoffs' && Object.hasOwn(e.event.summary, 'closed_by'));
    expect(closings.map((e) => e.event.summary.closed_by)).toEqual(['takeover', 'owner_message']);
    const [tookOver, wrote] = closings;
    if (!tookOver || !wrote) throw new Error('both closings are recorded');
    injectLedger(ledgerPage(entries));

    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(recordRow(screen, tookOver.seq).getByText('Handoff closed when you took over', { exact: true })).toBeVisible();
    await expect.element(recordRow(screen, wrote.seq).getByText('Handoff closed when you wrote in the chat', { exact: true })).toBeVisible();
    expect(screen.getByText('Chat marked done', { exact: true }).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });
    // The closing's full trace reads the row's name as its sentence.
    await recordRow(screen, tookOver.seq).click();
    const trace = region(screen, `Full trace of entry ${tookOver.seq}`);
    await expect.element(trace.getByText('Handoff closed when you took over. Recorded by the checkpoint.', { exact: true })).toBeVisible();
  });

  it('handoff_closed_by_a_booking_says_so', async () => {
    // The handoff card hands Maria the chat, then the visitor books a time in it, which closes the
    // card's handoff: the record calls that closing what it was, never her Mark done, and its full
    // trace reads the row's name as its sentence.
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can I talk to Maria?' } });
    await expect.poll(() => mockStore.world.handoffs.size, { timeout: 5_000 }).toBe(1);
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can someone come Tuesday?' } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'The first one, please.' } });
    await expect.poll(() => [...mockStore.world.handoffs.values()].map((h) => h.handoff.status), { timeout: 5_000 }).toEqual(['done']);
    const { entries } = await mockLedger();
    const closed = entries.find((e) => e.event.kind === 'desk_data' && e.event.summary.part === 'handoffs' && e.event.summary.closed_by === 'booking');
    if (!closed) throw new Error('the booking closed the card handoff');
    injectLedger(ledgerPage(entries));

    const { screen } = await renderRoute(`${SAFETY}?view=entries`);
    await expect.element(recordRow(screen, closed.seq).getByText('Handoff closed when they booked a time', { exact: true })).toBeVisible();
    expect(screen.getByText('Chat marked done', { exact: true }).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });
    await recordRow(screen, closed.seq).click();
    const trace = region(screen, `Full trace of entry ${closed.seq}`);
    await expect.element(trace.getByText('Handoff closed when they booked a time. Recorded by the checkpoint.', { exact: true })).toBeVisible();
  });

  it('filters_start_with_all', async () => {
    injectLedger(ledgerPage(threeEntries()));
    const sorted = (summary: string, category: TriageCategory, n: number) =>
      attempt({ ref_id: `att-${n}`, triage: { summary, category }, created_at: `2026-10-20T16:4${n}:00.000000Z`, ledger_seq: 100 + n });
    injectAttempts([
      sorted('Asked to move a refund to another card. The Desk refused.', 'prices', 5),
      sorted('Asked for half off. The Desk refused.', 'prices', 4),
      sorted('An agent requested more than its signed limit. The Desk refused.', 'limits', 3),
      sorted('Asked for Bob’s warranty. The Desk refused.', 'records', 2),
      attempt({ ref_id: 'att-1', reason_plain: 'Someone asked for a callback at midnight.', created_at: '2026-10-20T16:41:00.000000Z', ledger_seq: 101 }),
    ]);
    const { screen } = await renderRoute(SAFETY);
    const filters = screen.getByRole('group', { name: 'Show by kind' });
    const list = screen.getByRole('list', { name: 'Stopped, newest first' });
    const shown = () => list.getByRole('link').elements().map((a) => a.querySelector('.cd-attempt-row__title')?.textContent);
    const ALL = ['Asked to move a refund to another card. The Desk refused.', 'Asked for half off. The Desk refused.', 'An agent requested more than its signed limit. The Desk refused.', 'Asked for Bob’s warranty. The Desk refused.', 'Someone asked for a callback at midnight.'];

    // "All" first and pressed, every attempt listed; then the seven subjects in order, and "Not sorted yet" last.
    await expect.element(list.getByRole('link').first()).toBeVisible();
    const chips = filters.getByRole('button');
    expect(chips.elements().map((b) => b.textContent)).toEqual([
      'All',
      'Prices and discounts',
      "Someone's records",
      'Verification codes',
      'Instructions in a message',
      'Above a limit',
      "The AI's wording",
      'Other',
      'Not sorted yet',
    ]);
    await expect.element(filters.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(chips.elements().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(shown()).toEqual(ALL);

    // A subject shows only its entries; refunds and discounts both concern prices.
    await filters.getByRole('button', { name: 'Above a limit', exact: true }).click();
    await expect.element(filters.getByRole('button', { name: 'Above a limit', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.element(filters.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(shown()).toEqual(['An agent requested more than its signed limit. The Desk refused.']);
    await filters.getByRole('button', { name: 'Prices and discounts', exact: true }).click();
    await expect.poll(shown).toEqual(['Asked to move a refund to another card. The Desk refused.', 'Asked for half off. The Desk refused.']);
    await filters.getByRole('button', { name: 'Not sorted yet', exact: true }).click();
    await expect.poll(shown).toEqual(['Someone asked for a callback at midnight.']);
    // A category with none says so, and how to see the rest.
    await filters.getByRole('button', { name: 'Verification codes', exact: true }).click();
    await expect.element(screen.getByText('Nothing of this kind. Choose All to see the rest.', { exact: true })).toBeVisible();
    expect(list.elements()).toHaveLength(0);

    // "All" brings them back.
    await filters.getByRole('button', { name: 'All', exact: true }).click();
    await expect.poll(shown).toEqual(ALL);
  });

  it('every_subject_has_its_own_chip_and_filters_to_its_entries', async () => {
    const subjects: readonly [TriageCategory, string, string][] = [
      ['prices', 'Prices and discounts', 'Someone asked for half off. The Desk refused.'],
      ['records', "Someone's records", 'Someone asked for another customer’s invoice. The Desk refused.'],
      ['codes', 'Verification codes', 'Someone asked to send a code to a different address. The Desk refused.'],
      ['instructions', 'Instructions in a message', 'A message asked the Desk to ignore its rules. The Desk refused.'],
      ['limits', 'Above a limit', 'An agent requested more than its signed limit. The Desk refused.'],
      ['wording', "The AI's wording", 'Claude’s draft stated a price in prose. The Desk stopped the reply.'],
      ['other', 'Other', 'Someone asked for a different service. The Desk refused.'],
    ];
    injectLedger(ledgerPage(threeEntries()));
    injectAttempts(subjects.flatMap(([category, , summary], index) => [1, 2].map((n) => attempt({
      ref_id: `subject-${category}-${n}`,
      kind: category === 'wording' ? 'reply_blocked' : 'refused',
      triage: { category, summary: `${summary} Entry ${n}.` },
      ledger_seq: 100 + index * 2 + n,
    }))));
    const { screen } = await renderRoute(SAFETY);
    const filters = screen.getByRole('group', { name: 'Show by kind' });
    const list = screen.getByRole('list', { name: 'Stopped, newest first' });
    await expect.element(list.getByRole('link').first()).toBeVisible();
    expect(filters.getByRole('button').elements().map((chip) => chip.textContent)).toEqual([
      'All', ...subjects.map(([, label]) => label), 'Not sorted yet',
    ]);
    expect(list.getByRole('link').elements()).toHaveLength(14);
    for (const [, label, summary] of subjects) {
      const chip = filters.getByRole('button', { name: label, exact: true });
      await chip.click();
      await expect.element(chip).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => list.getByRole('link').elements().map((row) => row.querySelector('.cd-attempt-row__title')?.textContent)).toEqual([
        `${summary} Entry 1.`, `${summary} Entry 2.`,
      ]);
      await expect.element(detail(screen).getByText(label, { exact: true })).toBeVisible();
    }
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
    await viewOption(screen, 'Stopped').click();
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
    await viewOption(screen, 'Stopped').click();
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
    await expect.element(screen.getByText('Every entry matches the chain', { exact: true })).toBeVisible();
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
      attempt({ triage: { summary: 'Someone asked to move a refund to another card. The Desk refused.', category: 'prices' } }),
      attempt({ ref_id: '3', kind: 'reply_blocked', reason_plain: "Claude's reply put a price in its own words, so it wasn't shown.", ledger_seq: 3 }),
    ]);
    const sorted = await renderRoute(SAFETY);
    await expect.element(detail(sorted.screen).getByText('Summary written by Claude', { exact: true })).toBeVisible();
    await expectScreenBasics(sorted.screen.container, { owner: true });

    // A fresh copy with nothing stopped and nothing in the record yet.
    const quiet = await renderRoute(SAFETY, { seed: 'rivera_quiet' });
    await expect.element(quiet.screen.getByText(NOTHING, { exact: true })).toBeVisible();
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
    const checked = screen.getByText('Every entry matches the chain', { exact: true });
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

  it.each([
    ['attempts', SAFETY],
    ['entries', `${SAFETY}?view=entries`],
  ])('empty_state_waits_out_a_failed_attempts_read_%s', async (view, path) => {
    // A fresh copy with nothing stopped: the attempts were read, empty, and the empty state shows.
    mockStore.reset('rivera_quiet');
    const { screen } = await renderRoute(path);
    const nothing = screen.getByText(NOTHING, { exact: true });
    await expect.element(nothing).toBeVisible();

    // Then a draft of Claude's is stopped (Rivera's copy keeps one, and no request refused, so the
    // week still counts none) and every read of the attempts fails. The empty list read before
    // mustn't pass for current: the failure says so beside the headline, in either view, and the
    // empty state doesn't show while the reads fail.
    mockStore.reset('rivera');
    mockStore.inject({ route: 'safety', status: 503, times: 10_000 });
    const line = screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    await expect.element(nothing).not.toBeInTheDocument();
    expect(line.element().compareDocumentPosition(screen.getByText('Every entry matches the chain').element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await readsMore('safety', 2);
    await readsMore('today', 1);
    expect(nothing.elements()).toHaveLength(0);
    expect(screen.getByText(NONE_TURNED_DOWN).elements()).toHaveLength(0);
    expect(line.elements()).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });

    // Once a read works, the line is gone, and the stopped draft shows no empty state either: no
    // request was turned down, and the headline says so.
    mockStore.reset('rivera');
    await expect.element(line, { timeout: 5_000 }).not.toBeInTheDocument();
    await readsMore('safety', 1);
    await readsMore('today', 1);
    expect(nothing.elements()).toHaveLength(0);
    expect(screen.getByText(HEADLINE).elements()).toHaveLength(0);
    await expect.element(screen.getByText(NONE_TURNED_DOWN, { exact: true })).toBeVisible();
    if (view === 'attempts') {
      const rows = screen.getByRole('list', { name: 'Stopped, newest first' }).getByRole('link', { name: /Stopped by: Reply checkpoint$/ });
      await expect.element(rows.first()).toBeVisible();
    }
  });

  it('attempts_read_failure_says_so', async () => {
    // The attempts were read; then a later read fails. The line says so over the attempts already
    // read, which stay with the one open beside them, until a read works.
    const { screen } = await renderRoute(SAFETY);
    const list = screen.getByRole('list', { name: 'Stopped, newest first' });
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
    // "Reading what was stopped".
    mockStore.inject({ route: 'safety', status: 503, times: 10_000 });
    const fresh = await renderRoute(SAFETY);
    const first = fresh.screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(first, { timeout: 5_000 }).toBeVisible();
    await readsMore('safety', 2);
    expect(first.elements()).toHaveLength(1);
    expect(fresh.screen.getByText('Reading what was stopped').elements()).toHaveLength(0);
  });

  it('headline_read_failure_says_so', async () => {
    // This week's count was read; then a later read fails. The line says so over the count, which
    // stays, until a read works.
    await refuseTheAgentsCharge();
    const { screen } = await renderRoute(SAFETY);
    const headline = screen.getByText(HEADLINE);
    await expect.element(headline).toBeVisible();
    mockStore.inject({ route: 'today', status: 503, times: 10_000 });
    const line = screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    expect(line.element().compareDocumentPosition(headline.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect.element(headline).toBeVisible();
    await readsMore('today', 2);
    expect(line.elements()).toHaveLength(1);
    // A fresh copy answers again; once the agent's charge is refused in it too, the count is back.
    mockStore.reset('rivera');
    await expect.element(line, { timeout: 5_000 }).not.toBeInTheDocument();
    await refuseTheAgentsCharge();
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
    const filters = screen.getByRole('group', { name: 'Show by kind' });
    await filters.getByRole('button', { name: 'Verification codes', exact: true }).click();
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
