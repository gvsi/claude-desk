/**
 * A rule draft's review in a real browser against the mock API: each change before and after, the
 * check in plain words, the payment limit in its signed words, and one confirm that applies it,
 * only once the check passed.
 */
import { http } from 'msw';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ProofReport, RuleCard } from '../../api/contracts.ts';
import { PROVING_GIVE_UP_MS, RULES_UNAVAILABLE_COPY, request } from '../../api/http.ts';
import { apiPath } from '../../api/routes.ts';
import type { RulesDraft } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { worker } from '../../mocks/browser.ts';
import { PRESETS, RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import type { DeskRecord } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute, type RenderRouteOptions } from '../../test/renderRoute.tsx';
import { expectScreenBasics } from '../../test/screen.ts';
import type { AnswerDraftState } from '../approvals/useAnswer.ts';
import { draftFromDiff, draftFromVersion } from './drafts.ts';
import { RuleDraftReview, type RuleDraftState } from './RuleDraftReview.tsx';

const DESK = `/app/${RIVERA.deskId}`;
const DANA = rivera.people.dana;

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** The mock's main Desk. */
function desk(): DeskRecord {
  const found = mockStore.world.desk(RIVERA.deskId);
  if (!found) throw new Error('the mock has the main Desk');
  return found;
}

/** The review of draft `version`, opened from another page with `state`, as a screen hands it over, or with none, as a reload opens it. */
async function openDraft(version: number, state?: unknown, opts?: RenderRouteOptions) {
  // A page that reads nothing, so every request recorded is the review's.
  const rendered = await renderRoute('/a-page-that-does-not-exist', opts);
  await rendered.router.navigate(`${DESK}/rules/drafts/${version}`, state === undefined ? undefined : { state });
  return rendered;
}

/** Dana's "Deny, always" on her refund: a rule just for her that never lets one through. */
const DANA_NEVER_REFUND: RuleCard = {
  ...rivera.ruleCards['rv-refund'],
  card_id: 'card-dana-refund',
  mode: 'never',
  who: 'person',
  person_id: DANA.personId,
  reason: 'Refunds to Dana Whitfield never go through.',
};

/** A draft of Saturday bookings asking first, with `proof` as its check, stored in the mock for a reload to read. */
function draftWithCheck(proof: ProofReport | null): RulesDraft {
  const draft = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
  const record = desk().drafts.get(draft.version);
  if (!record) throw new Error('the mock keeps its drafts');
  record.draft = { ...record.draft, proof: proof as ProofReport };
  return record.draft;
}

const CANCELS_LINKS = "Open payment links I made on my own that the new rules don't allow will be cancelled.";

/** The review's rows as the owner reads them, in order. */
function rowTexts(screen: { container: HTMLElement }): string[] {
  return [...screen.container.querySelectorAll('[aria-label="Changes"] li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

/** The check panel's lines, in order. */
function checkLines(screen: { container: HTMLElement }): string[] {
  const panel = screen.container.querySelector('[aria-label="Checked before you confirm"]');
  if (panel === null) throw new Error('no check panel');
  return [...panel.querySelectorAll('li')].map((li) => li.textContent?.trim() ?? '');
}

/**
 * The payment limit's review trail, "Rules / Change your payment limit", as "Rules / Ask me first"
 * reads: the owner's choice (2026-10-30), where N-Conn-20 draws "Rules" alone.
 */
async function expectLimitTrail(screen: Awaited<ReturnType<typeof openDraft>>['screen']) {
  const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
  await expect.element(trail.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', `${DESK}/rules`);
  await expect.element(trail.getByText('Change your payment limit', { exact: true })).toHaveAttribute('aria-current', 'page');
  expect(trail.element().textContent).toBe('Rules/Change your payment limit');
}

/**
 * A draft that has applied, as the review says once it is confirmed: the change is in place, with a
 * link to the rules, and nothing to confirm or keep, nor anything that says it waits for the owner.
 */
async function expectConfirmed(screen: Awaited<ReturnType<typeof openDraft>>['screen']) {
  await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('link', { name: 'See your rules' })).toHaveAttribute('href', `${DESK}/rules`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Review the change' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Keep my rules' }).elements()).toHaveLength(0);
  const text = screen.container.textContent ?? '';
  expect(text).not.toContain('No rules change.');
  expect(text).not.toContain('Nothing changes until you confirm.');
  expect(text).not.toContain("isn't open anymore");
}

/** A version that isn't open, which says so and where to ask again, with nothing to confirm or keep and no claim that it applied. */
async function expectNotOpen(screen: Awaited<ReturnType<typeof openDraft>>['screen']) {
  await expect.element(screen.getByText("This draft isn't open anymore. Ask for the change again from Rules.", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('link', { name: 'Go to Rules' })).toHaveAttribute('href', `${DESK}/rules`);
  expect(screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Keep my rules' }).elements()).toHaveLength(0);
  expect(screen.container.textContent).not.toContain('Your rules are updated.');
}

/** True when `first` comes before `second` in the page. */
function before(first: Element | null, second: Element | null): boolean {
  if (first === null || second === null) return false;
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** A failed part of a check, in the kernel's plain words. */
const failing = (name: string, counterexample: string | null) => ({ name, ok: false, counterexample_plain: counterexample, counterexample_raw: null });

const CONFIRM_PATH = apiPath('confirmRules', { desk_id: RIVERA.deskId });

/** The API's 202 for a confirm of `version` it is still checking: send the same request again. */
const stillChecking = (version: number) => ({ retry: { path: CONFIRM_PATH, body: { version } } });

/**
 * A clock the request layer times its minute of waiting by, moved only by the test (and a little
 * by each `expect.poll` it runs); the page's timers and the mock keep real time.
 */
function freezeClock(): { pass: (ms: number) => void } {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return { pass: (ms) => vi.advanceTimersByTime(ms) };
}

/**
 * Holds the next confirm before it reaches the mock: `arrived()` once the app sent it, and
 * `release()` lets it through to the mock, which answers it (a planted fault included).
 */
function holdNextConfirm(): { arrived: () => boolean; release: () => void } {
  let arrived = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Never left waiting past its test.
  onTestFinished(() => release());
  worker.use(
    http.post(
      CONFIRM_PATH,
      async () => {
        arrived = true;
        await released;
        return undefined;
      },
      { once: true },
    ),
  );
  return { arrived: () => arrived, release };
}

/**
 * Clicks `label` and lets the confirm reach the mock only once a minute has passed on `clock`: the
 * API's 202 then comes back after the app's minute of waiting is up, so the app gives up on it.
 */
async function confirmAfterTheMinute(screen: Awaited<ReturnType<typeof openDraft>>['screen'], clock: { pass: (ms: number) => void }) {
  const held = holdNextConfirm();
  await screen.getByRole('button', { name: 'Confirm change' }).click();
  await expect.poll(held.arrived).toBe(true);
  clock.pass(PROVING_GIVE_UP_MS);
  held.release();
}

describe('rule draft review', () => {
  it('checked_draft_confirms', async () => {
    // Today hands over an "always" answer's card diff and its draft.
    const draft: RulesDraft = mockStore.world.draft(desk(), [DANA_NEVER_REFUND]);
    const state: AnswerDraftState = { cardDiff: [DANA_NEVER_REFUND], draft };
    const { screen } = await openDraft(draft.version, state);

    await expect.element(screen.getByRole('heading', { level: 1, name: 'Review the change' })).toBeVisible();
    await expect.element(screen.getByText("Here's exactly what changes on your Desk. Nothing changes until you confirm.", { exact: true })).toBeVisible();
    const changes = screen.getByRole('region', { name: 'Changes' });
    await expect.element(changes.getByText('Refund', { exact: true })).toBeVisible();
    const after = changes.getByRole('group', { name: 'After' });
    await expect.element(after.getByText(DANA_NEVER_REFUND.reason, { exact: true })).toBeVisible();
    await expect.element(after.getByText('Dana Whitfield · Verified', { exact: true })).toBeVisible();
    await expect.element(after.getByText('Never', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Checked against the always-on rules and your other rules.', { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expect(desk().policy.version).toBe(7);

    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version: draft.version }]);
    expect(desk().policy.version).toBe(draft.version);
    await expect.element(screen.getByRole('link', { name: 'See your rules' })).toHaveAttribute('href', `${DESK}/rules`);
    expect(screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    // Once it applied, nothing still says it waits for the owner.
    expect(screen.getByText("Here's exactly what changes on your Desk. Nothing changes until you confirm.", { exact: true }).elements()).toHaveLength(0);
  });

  it('confirmed_draft_reopens_confirmed', async () => {
    // Today hands over an "always" answer's draft, and the owner confirms it.
    const draft = mockStore.world.draft(desk(), [DANA_NEVER_REFUND]);
    const state: AnswerDraftState = { cardDiff: [DANA_NEVER_REFUND], draft };
    const { screen, router } = await openDraft(draft.version, state);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();

    // Back, then Forward: the change is in place, so it says so, with nothing to confirm or keep.
    await router.navigate(-1);
    await expect.element(screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    await router.navigate(1);
    await expectConfirmed(screen);
    expect(requests('confirmRules')).toHaveLength(1);

    // Opened again with no router state, as a new tab opens it: the same.
    const reopened = await openDraft(draft.version);
    await expectConfirmed(reopened.screen);
    await expectScreenBasics(reopened.screen.container, { owner: true });
  });

  it('replaced_draft_reopens_not_open', async () => {
    // The owner confirms a draft, then a later one that replaces it.
    const first = mockStore.world.draft(desk(), [DANA_NEVER_REFUND]);
    const { screen, router } = await openDraft(first.version, { cardDiff: [DANA_NEVER_REFUND], draft: first } satisfies AnswerDraftState);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    const quoteAsks = { ...rivera.ruleCards['rv-quote'], mode: 'ask' as const };
    const later = mockStore.world.draft(desk(), [quoteAsks]);
    await router.navigate(`${DESK}/rules/drafts/${later.version}`, { state: { cardDiff: [quoteAsks], draft: later } satisfies AnswerDraftState });
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(desk().policy.version).toBe(later.version);

    // Back to the first: older than the rules in force and no longer a draft. A 404 can't say it
    // applied, so it says only that it isn't open, with nothing to confirm or keep.
    await router.navigate(-1);
    await expect.poll(() => requests('ruleDraft').map((r) => r.path)).toEqual([apiPath('ruleDraft', { desk_id: RIVERA.deskId, version: String(first.version) })]);
    await expectNotOpen(screen);
    // Forward to the later one, in force.
    await router.navigate(1);
    await expectConfirmed(screen);
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version: first.version }, { version: later.version }]);

    // Opened again with no router state, as a new tab opens it: the same.
    const reopened = await openDraft(first.version);
    await expectNotOpen(reopened.screen);
  });

  it('version_that_never_applied_is_not_open', async () => {
    // Version 0, which never existed, and version 5, older than the rules in force and no draft:
    // the API answers both 404, which never says a change applied.
    for (const version of [0, 5]) {
      const { screen } = await openDraft(version);
      await expectNotOpen(screen);
    }
  });

  it('older_draft_read_failure_offers_no_confirm', async () => {
    // Two drafts from the rules in force; the owner confirms the second, then goes Back to the
    // first, now older than the rules in force.
    const quoteAsks = { ...rivera.ruleCards['rv-quote'], mode: 'ask' as const };
    const bookAsks = { ...rivera.ruleCards['rv-book-sat'], mode: 'ask' as const };
    const first = mockStore.world.draft(desk(), [quoteAsks]);
    const second = mockStore.world.draft(desk(), [bookAsks]);
    const { screen, router } = await openDraft(first.version, { cardDiff: [quoteAsks], draft: first } satisfies AnswerDraftState, { retryScale: 0 });
    await expect.element(screen.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
    await router.navigate(`${DESK}/rules/drafts/${second.version}`, { state: { cardDiff: [bookAsks], draft: second } satisfies AnswerDraftState });
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();

    // Its read fails, and its retry: the read's failure and a way to try again, never its confirm.
    mockStore.inject({ route: 'ruleDraft', status: 'network', times: 2 });
    await router.navigate(-1);
    await expect.element(screen.getByText("We couldn't reach Claude Desk. Check your connection, then try again.", { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Keep my rules' }).elements()).toHaveLength(0);
    expect(screen.container.textContent).not.toContain('Your rules are updated.');

    // Tried again, it reads as still open, drafted from rules that changed since: its review, whose
    // confirm the API refuses as it does any draft from rules that changed.
    await screen.getByRole('button', { name: 'Try again' }).click();
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Your rules changed since this was drafted. Ask for the change again.');
    expect(desk().policy.version).toBe(second.version);
  });

  it('diff_shows_the_enforced_limit', async () => {
    // Quotes allow up to 10% off; the draft raises it to 50% under the same reason.
    const quote = { ...rivera.ruleCards['rv-quote'], max_discount_bp: 1000 };
    desk().policy.cards = desk().policy.cards.map((card) => (card.card_id === quote.card_id ? quote : card));
    const draft = mockStore.world.draft(desk(), [{ ...quote, max_discount_bp: 5000 }]);
    const { screen } = await openDraft(draft.version);

    const row = screen.getByRole('region', { name: 'Changes' }).getByRole('listitem');
    const before = row.getByRole('group', { name: 'Before' });
    const after = row.getByRole('group', { name: 'After' });
    // The row's title names the tool. The rule stays on it, so neither side repeats it (N-Conn-18):
    // a side names its target only when the change moves it.
    await expect.element(row.getByText('Quote', { exact: true })).toBeVisible();
    expect(before.getByText('Quote', { exact: true }).elements()).toHaveLength(0);
    expect(after.getByText('Quote', { exact: true }).elements()).toHaveLength(0);
    await expect.element(before.getByText('Anyone · Discounts up to 10%', { exact: true })).toBeVisible();
    await expect.element(after.getByText('Anyone · Discounts up to 50%', { exact: true })).toBeVisible();
    // The line that changed is tagged in words on the After side, and only that line.
    const changedLine = after.getByText('Anyone · Discounts up to 50%', { exact: true }).element().closest('p');
    expect(changedLine?.textContent).toContain('Changed');
    expect(after.getByText('Changed', { exact: true }).elements()).toHaveLength(1);
    expect(before.getByText('Changed', { exact: true }).elements()).toHaveLength(0);
    await expect.element(after.getByText(quote.reason, { exact: true })).toBeVisible();
    expect(requests('ruleDraft')).toHaveLength(1);
  });

  it('failed_check_shows_counterexample_plain', async () => {
    const draft = draftWithCheck({ ok: false, method: 'symcc', cases: null, timed_out: false, checks: [failing('auto_within_cards', 'Dana could get a $500 refund without asking you')] });
    const { screen } = await openDraft(draft.version);

    const checks = screen.getByRole('region', { name: "This change can't be applied" });
    await expect.element(checks.getByText('Dana could get a $500 refund without asking you', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Confirm change' })).toBeDisabled();
    await screen.getByRole('button', { name: 'Confirm change' }).click({ force: true });
    expect(requests('confirmRules')).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('timed_out_report_is_unavailable_not_failed', async () => {
    for (const proof of [
      { ok: false, method: 'symcc', cases: null, timed_out: true, checks: [failing('auto_within_cards', 'Dana could get a refund')] },
      { ok: true, method: 'bounded', cases: 5000, timed_out: false, checks: [] },
    ] satisfies ProofReport[]) {
      const draft = draftWithCheck(proof);
      const { screen } = await openDraft(draft.version);
      const checks = screen.getByRole('region', { name: "Rules can't be checked right now" });
      await expect.element(checks.getByText(RULES_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
      await expect.element(screen.getByRole('button', { name: 'Confirm change' })).toBeDisabled();
      // Nothing was found wrong, so nothing says it failed, and nothing claims it was proven.
      const text = screen.container.textContent ?? '';
      expect(text).not.toContain("didn't pass");
      expect(text).not.toContain("This change can't be applied");
      expect(text).not.toContain('Dana could get a refund');
      expect(text.toLowerCase()).not.toContain('proven');
      await expectScreenBasics(screen.container, { owner: true });
    }
    expect(requests('confirmRules')).toHaveLength(0);
  });

  it('unproved_draft_cannot_confirm', async () => {
    // A screen hands over a draft it built, with no check.
    const stored = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
    const state: RuleDraftState = { draft: { ...draftFromDiff(stored, desk().policy), proof: null } };
    const { screen } = await openDraft(stored.version, state);

    await expect.element(screen.getByRole('region', { name: "Rules can't be checked right now" })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Confirm change' })).toBeDisabled();
    expect(requests('ruleDraft')).toHaveLength(0);
    expect(requests('confirmRules')).toHaveLength(0);
  });

  it('confirm_conflict_is_plain', async () => {
    // Two drafts from version 7; the other one is confirmed first, in another tab.
    const first = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
    const other = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-quote'], mode: 'ask' }]);
    const { screen } = await openDraft(first.version);
    await expect.element(screen.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
    mockStore.world.confirmDraft(desk(), other.version);

    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Your rules changed since this was drafted. Ask for the change again.');
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version: first.version }]);
    expect(desk().policy.version).toBe(other.version);
    expect(screen.getByText('Your rules are updated.', { exact: true }).elements()).toHaveLength(0);
    // Nothing applied, and the owner keeps their rules from here.
    await screen.getByRole('button', { name: 'Keep my rules' }).click();
    expect(requests('confirmRules')).toHaveLength(1);
  });

  it('drifted_tool_confirm_says_the_rules_changed', async () => {
    // Refund's definition changed, and the owner turned it on at the changed hash.
    const refund = 'payments.create_refund';
    const drift = (sha: string) => {
      desk().tools = desk().tools.map((row) => (row.tool === refund ? { ...row, status: 'needs_review', pending_definition_text: `Changed ${sha[0]}`, pending_sha256: sha } : row));
    };
    drift('e'.repeat(64));
    const turned = mockStore.world.confirmTools(desk(), [{ tool: refund, definition_sha256: 'e'.repeat(64) }], true);
    if (turned === 'not_found' || turned === 'conflict' || turned.draft == null) throw new Error('the tool confirm drafts a version');
    const row = (await request('rules', { params: { desk_id: RIVERA.deskId } })).tools.find((tool) => tool.tool === refund);
    if (row === undefined) throw new Error('the mock lists Refund');
    const element = <RuleDraftReview deskId={RIVERA.deskId} draft={draftFromVersion(desk().policy, turned.draft, [row])} />;
    const { screen } = await renderRoute('/review', { routes: [{ path: '/review', element }] });
    await expect.element(screen.getByRole('button', { name: 'Confirm and turn on' })).toBeEnabled();

    // It changes again before the owner confirms: the confirm is refused as the API answers it, and nothing turns on.
    drift('a'.repeat(64));
    await screen.getByRole('button', { name: 'Confirm and turn on' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Your rules changed since this was drafted. Ask for the change again.');
    expect(desk().policy.version).toBe(7);
    expect(desk().tools.find((tool) => tool.tool === refund)).toMatchObject({ status: 'needs_review', pending_sha256: 'a'.repeat(64) });
  });

  it('turn_on_review_leads_back_to_rules_until_connectors_are_built', async () => {
    // Refund's definition changed, and the owner turns it on at the changed hash.
    const refund = 'payments.create_refund';
    const sha = 'e'.repeat(64);
    desk().tools = desk().tools.map((row) => (row.tool === refund ? { ...row, status: 'needs_review', pending_definition_text: 'Changed', pending_sha256: sha } : row));
    const turned = mockStore.world.confirmTools(desk(), [{ tool: refund, definition_sha256: sha }], true);
    if (turned === 'not_found' || turned === 'conflict' || turned.draft == null) throw new Error('the tool confirm drafts a version');
    const row = (await request('rules', { params: { desk_id: RIVERA.deskId } })).tools.find((tool) => tool.tool === refund);
    if (row === undefined) throw new Error('the mock lists Refund');
    const element = <RuleDraftReview deskId={RIVERA.deskId} draft={draftFromVersion(desk().policy, turned.draft, [row])} />;

    // While the Connectors pages aren't built, its trail starts at Rules.
    const before = await renderRoute('/review', { routes: [{ path: '/review', element }] });
    const trail = before.screen.getByRole('navigation', { name: 'Breadcrumb' });
    await expect.element(trail.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    expect(trail.getByRole('link', { name: 'Connectors' }).elements()).toEqual([]);
    expect(before.screen.container.querySelectorAll('a[href*="/connectors"]')).toHaveLength(0);

    // Once they are, at Connectors.
    const built = await renderRoute('/review', { routes: [{ path: '/review', element }], connectorPages: true });
    const builtTrail = built.screen.getByRole('navigation', { name: 'Breadcrumb' });
    await expect.element(builtTrail.getByRole('link', { name: 'Connectors' })).toHaveAttribute('href', `${DESK}/connectors`);
    expect(builtTrail.getByRole('link', { name: 'Rules' }).elements()).toEqual([]);
  });

  it('reload_loads_the_draft', async () => {
    // "Ask me first", as the Rules page hands it over, titled with the preset's name.
    const stored = mockStore.world.draftCards(desk(), PRESETS.ask_first);
    const handed: RuleDraftState = { draft: draftFromDiff(stored, desk().policy, 'ask_first'), title: 'Ask me first' };
    const first = await openDraft(stored.version, handed);
    await expect.element(first.screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    await expect.element(first.screen.getByText(CANCELS_LINKS, { exact: true })).toBeVisible();
    const handedRows = rowTexts(first.screen);
    expect(handedRows.length).toBeGreaterThan(0);
    expect(requests('ruleDraft')).toHaveLength(0);
    expect(checkLines(first.screen)).toEqual(['Checked against the always-on rules and your other rules.', 'Open times, leads, callbacks and identity checks still run on their own.']);

    // A reload has no router state: one read of the draft, and the same rows under the plain title.
    const reloaded = await openDraft(stored.version);
    await expect.element(reloaded.screen.getByRole('heading', { level: 1, name: 'Review the change' })).toBeVisible();
    await expect.element(reloaded.screen.getByText(CANCELS_LINKS, { exact: true })).toBeVisible();
    expect(rowTexts(reloaded.screen)).toEqual(handedRows);
    // The draft doesn't say which preset made it, so a reload shows the check line alone.
    expect(checkLines(reloaded.screen)).toEqual(['Checked against the always-on rules and your other rules.']);
    expect(requests('ruleDraft')).toHaveLength(1);
    await expect.element(reloaded.screen.getByRole('button', { name: 'Confirm change' })).toBeEnabled();

    // A draft that isn't open anymore says so, and where to ask again.
    const gone = await openDraft(99);
    await expect.element(gone.screen.getByText("This draft isn't open anymore. Ask for the change again from Rules.", { exact: true })).toBeVisible();
    await expect.element(gone.screen.getByRole('link', { name: 'Go to Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    expect(gone.screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    await expectScreenBasics(gone.screen.container, { owner: true });
  });

  it('review_names_the_tab', async () => {
    // The tab names the review as its title does: a preset's name, the payment limit's own, or the plain one.
    document.title = 'Claude Desk';
    const preset = mockStore.world.draftCards(desk(), PRESETS.ask_first);
    const handed: RuleDraftState = { draft: draftFromDiff(preset, desk().policy, 'ask_first'), title: 'Ask me first' };
    const named = await openDraft(preset.version, handed);
    await expect.element(named.screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    expect(document.title).toBe('Ask me first · Claude Desk');

    const limit = mockStore.world.draftCards(desk(), desk().policy.cards, { cap: 500_000 });
    const raised = await openDraft(limit.version);
    await expect.element(raised.screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    expect(document.title).toBe('Change your payment limit · Claude Desk');

    // While a reload reads the draft, the page shows no title yet, and the tab names Rules, the page
    // the review is under; once the draft is read, the review's own.
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release());
    const read = await mockStore.dispatch('ruleDraft', { params: { desk_id: RIVERA.deskId, version: String(preset.version) } });
    mockStore.inject({ route: 'ruleDraft', status: 200, until, body: (read as { body: unknown }).body });
    const reloaded = await openDraft(preset.version);
    await expect.element(reloaded.screen.getByText('Reading the change', { exact: true })).toBeVisible();
    expect(document.title).toBe('Rules · Claude Desk');
    release();
    await expect.element(reloaded.screen.getByRole('heading', { level: 1, name: 'Review the change' })).toBeVisible();
    expect(document.title).toBe('Review the change · Claude Desk');

    // A draft that isn't open anymore keeps the plain title, and leaving hands the tab back.
    const gone = await openDraft(99);
    await expect.element(gone.screen.getByText("This draft isn't open anymore. Ask for the change again from Rules.", { exact: true })).toBeVisible();
    expect(document.title).toBe('Review the change · Claude Desk');
    await gone.router.navigate('/no/such/page');
    await expect.element(gone.screen.getByText("This page doesn't exist", { exact: true })).toBeVisible();
    expect(document.title).toBe('Claude Desk');
  });

  it('confirm_shows_the_cap_change_in_words_both_ways', async () => {
    const link = rivera.ruleCards['rv-link'];
    const withLink = (cents: number, reason = link.reason) =>
      desk().policy.cards.map((card) => (card.card_id === link.card_id ? { ...card, max_amount_cents: cents, reason } : card));

    // Raised from $500 to $5,000, the link rule with it: the new limit in words over the change, and nothing cancelled.
    const raise = mockStore.world.draftCards(desk(), withLink(100_000), { cap: 500_000 });
    const raised = await openDraft(raise.version);
    const limit = raised.screen.getByRole('region', { name: 'Payment limit' });
    await expect.element(limit.getByText('New limit: no payment over $5,000 without asking you.', { exact: true })).toBeVisible();
    await expect.element(limit.getByText('Was $500', { exact: true })).toBeVisible();
    expect(before(limit.element(), raised.screen.getByRole('button', { name: 'Confirm change' }).element())).toBe(true);
    expect(raised.screen.getByText(CANCELS_LINKS, { exact: true }).elements()).toHaveLength(0);
    await expectScreenBasics(raised.screen.container, { owner: true });

    // Lowered from $500 to $100, the $300 link rule down to $100 as the API lowers it, its reason the
    // sentence for the new limit in place of the one that quoted $300: links may be cancelled, said
    // above the buttons.
    const lower = mockStore.world.draftCards(desk(), withLink(10_000, 'Up to $100, your payment limit.'), { cap: 10_000 });
    const lowered = await openDraft(lower.version);
    const newLimit = lowered.screen.getByRole('region', { name: 'Payment limit' });
    await expect.element(newLimit.getByText('New limit: no payment over $100 without asking you.', { exact: true })).toBeVisible();
    await expect.element(newLimit.getByText('Was $500', { exact: true })).toBeVisible();
    const row = lowered.screen.getByRole('region', { name: 'Changes' }).getByRole('listitem');
    await expect.element(row.getByRole('group', { name: 'Before' }).getByText('Automatic up to $300; over $300, ask me first', { exact: true })).toBeVisible();
    await expect.element(row.getByRole('group', { name: 'Before' }).getByText(link.reason, { exact: true })).toBeVisible();
    await expect.element(row.getByRole('group', { name: 'After' }).getByText('Anyone · Up to $100 · Checked by the reviewer', { exact: true })).toBeVisible();
    // The new reason reads as a change, tagged as the other changed lines are.
    await expect.element(row.getByRole('group', { name: 'After' }).getByText('Up to $100, your payment limit. Changed', { exact: true })).toBeVisible();
    const cancels = lowered.screen.getByText(CANCELS_LINKS, { exact: true });
    await expect.element(cancels).toBeVisible();
    expect(before(cancels.element(), lowered.screen.getByRole('button', { name: 'Confirm change' }).element())).toBe(true);
    // Nothing says the new limit applies before the owner confirms it.
    expect(lowered.screen.container.textContent).not.toMatch(/already|now applies|is now/i);
    expect(desk().policy.auto_money_cap_cents).toBe(50_000);
  });

  it('limit_raise_alone_can_be_confirmed', async () => {
    const stored = mockStore.world.draftCards(desk(), desk().policy.cards, { cap: 500_000 });
    // As the Rules page hands it over, then as a reload reads it: the same review, with Confirm.
    const handed: RuleDraftState = { draft: draftFromDiff(stored, desk().policy), title: 'Change your payment limit' };
    for (const state of [handed, undefined]) {
      const { screen } = await openDraft(stored.version, state);
      await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
      await expect.element(screen.getByText('New limit: no payment over $5,000 without asking you.', { exact: true })).toBeVisible();
      await expect.element(screen.getByText('Was $500', { exact: true })).toBeVisible();
      await expect.element(screen.getByText('Your rules stay the same.', { exact: true })).toBeVisible();
      await expect.element(screen.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
      expect(screen.getByText(CANCELS_LINKS, { exact: true }).elements()).toHaveLength(0);
      // The check alone (N-Conn-20): no preset, so nothing about what runs on its own.
      expect(checkLines(screen)).toEqual(['Checked against the always-on rules and your other rules.']);
      await expectLimitTrail(screen);
    }
    expect(requests('ruleDraft')).toHaveLength(1);

    const { screen } = await openDraft(stored.version);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version: stored.version }]);
    expect(desk().policy.auto_money_cap_cents).toBe(500_000);
  });

  it('limit_lowering_alone_can_be_confirmed', async () => {
    // Every rule already fits under $400, so no rule changes; open links above it may be cancelled.
    const stored = mockStore.world.draftCards(desk(), desk().policy.cards, { cap: 40_000 });
    const { screen } = await openDraft(stored.version);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    await expect.element(screen.getByText('New limit: no payment over $400 without asking you.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Was $500', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Your rules stay the same.', { exact: true })).toBeVisible();
    expect(rowTexts(screen)).toEqual([]);
    await expect.element(screen.getByText(CANCELS_LINKS, { exact: true })).toBeVisible();
    await expectLimitTrail(screen);

    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version: stored.version }]);
    expect(desk().policy.auto_money_cap_cents).toBe(40_000);
  });

  it('draft_review_matches_its_board', async () => {
    // "Ask me first" on Rivera's rules with the board's shared rule for Alex Kim's assistant, as
    // N-Conn-18-Preset-Review draws it.
    desk().policy.cards = [...desk().policy.cards, rivera.sharedChargeCard];
    const stored = mockStore.world.draftCards(desk(), PRESETS.ask_first);
    const { screen } = await openDraft(stored.version, { draft: draftFromDiff(stored, desk().policy, 'ask_first'), title: 'Ask me first' } satisfies RuleDraftState);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await expect.element(breadcrumb.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    await expect.element(breadcrumb.getByText('Ask me first', { exact: true })).toHaveAttribute('aria-current', 'page');
    // Every rule of Rivera's own (its urgent job's among them) and the shared rule go to the default
    // ask, and the starter's cards it keeps make no row.
    const changes = screen.getByRole('region', { name: 'Changes' });
    await expect.element(changes).toBeVisible();
    const rows = rowTexts(screen);
    expect(rows).toHaveLength(Object.keys(rivera.ruleCards).length + 2);
    for (const text of rows) expect(text).toMatch(/^Changed/);
    for (const text of rows) expect(text).toContain('Not covered by a rule you set, so I ask you.');
    // The shared rule's row says so under its title, after its connector, and it's the only one.
    const sharedLine = changes.getByText('Payments · Shared rule', { exact: true });
    await expect.element(sharedLine).toBeVisible();
    expect(sharedLine.element().closest('li')?.textContent).toContain('Payment link and Charge within a signed limit');
    expect(changes.getByText('Shared rule', { exact: true }).elements()).toHaveLength(1);
    // The check, then what the preset keeps running on its own.
    expect(checkLines(screen)).toEqual(['Checked against the always-on rules and your other rules.', 'Open times, leads, callbacks and identity checks still run on their own.']);

    await expectOwnerBoard(screen.container, {
      current: 'Rules',
      tabStops: [screen.getByRole('button', { name: 'Confirm change' }).element() as HTMLElement, screen.getByRole('button', { name: 'Keep my rules' }).element() as HTMLElement],
    });
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('lost_confirm_reads_the_rules_first', async () => {
    // The confirm went through but its answer was lost: the rules as they stand say it applied.
    const applied = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 'network', afterCommit: true });
    const first = await openDraft(applied.version);
    await first.screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(first.screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(desk().policy.version).toBe(applied.version);

    // Lost before it reached the rules: nothing applied, it says so, and confirm works again.
    const lost = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-quote'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 'network' });
    const second = await openDraft(lost.version);
    await second.screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(second.screen.getByRole('alert')).toHaveTextContent("We couldn't reach Claude Desk. Check your connection, then try again.");
    expect(desk().policy.version).toBe(applied.version);
    await second.screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(second.screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(desk().policy.version).toBe(lost.version);
  });

  it('lost_custom_confirm_reads_the_rules_first', async () => {
    const clock = freezeClock();

    // A caller that applies the draft its own way (setup's confirm) loses the answer too: the rules
    // as they stand settle it, since applying it makes the draft's version the active one.
    const confirmed: number[] = [];
    const reviewOf = (stored: RulesDraft) => {
      const confirm = async () => {
        confirmed.push(stored.version);
        await request('confirmRules', { params: { desk_id: RIVERA.deskId }, body: { version: stored.version } });
      };
      const element = <RuleDraftReview deskId={RIVERA.deskId} draft={draftFromDiff(stored, desk().policy)} confirm={confirm} />;
      return renderRoute('/review', { routes: [{ path: '/review', element }] });
    };

    const applied = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 'network', afterCommit: true });
    const first = await reviewOf(applied);
    await first.screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(first.screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(first.screen.getByRole('alert').elements()).toHaveLength(0);
    expect(confirmed).toEqual([applied.version]);
    expect(desk().policy.version).toBe(applied.version);

    // Lost before it applied: the rules say nothing changed, so it says so, and nothing claims it did.
    const lost = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-quote'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 'network' });
    const second = await reviewOf(lost);
    await second.screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(second.screen.getByRole('alert')).toHaveTextContent("We couldn't reach Claude Desk. Check your connection, then try again.");
    expect(second.screen.getByText('Your rules are updated.', { exact: true }).elements()).toHaveLength(0);
    expect(confirmed).toEqual([applied.version, lost.version]);
    expect(desk().policy.version).toBe(applied.version);

    // Its confirm still being checked when the app stopped waiting a minute in: the rules are read
    // again, don't show it yet, and it may still apply, so the review says it couldn't confirm it.
    const checking = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-quote'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 202, body: stillChecking(checking.version) });
    const third = await reviewOf(checking);
    await expect.element(third.screen.getByRole('button', { name: 'Confirm change' })).toBeVisible();
    const reads = requests('rules').length;
    await confirmAfterTheMinute(third.screen, clock);
    await expect.element(third.screen.getByRole('alert')).toHaveTextContent("We couldn't confirm whether your change went through. Open Rules to see where it stands.");
    expect(requests('rules').length).toBeGreaterThan(reads);
    expect(third.screen.container.textContent).not.toContain("can't be applied");
    expect(third.screen.getByText('Your rules are updated.', { exact: true }).elements()).toHaveLength(0);
    expect(confirmed).toEqual([applied.version, lost.version, checking.version]);
    expect(desk().policy.version).toBe(applied.version);
  });

  it('given_up_confirm_reads_the_rules_first', async () => {
    const clock = freezeClock();

    // The API applied the confirm but still answered that it was checking when the app's minute was
    // up: the app stops waiting, and the rules as they stand say it applied.
    const applied = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 202, body: stillChecking(applied.version), afterCommit: true });
    const first = await openDraft(applied.version);
    await confirmAfterTheMinute(first.screen, clock);
    await expect.element(first.screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(first.screen.getByRole('alert').elements()).toHaveLength(0);
    expect(requests('confirmRules')).toHaveLength(1);
    expect(desk().policy.version).toBe(applied.version);

    // Still being checked when the app stopped waiting: the rules don't show it yet, but it may still
    // apply, so the review says it couldn't confirm it, and never that it wasn't applied.
    const checking = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-quote'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 202, body: stillChecking(checking.version) });
    const second = await openDraft(checking.version);
    await expect.element(second.screen.getByRole('button', { name: 'Confirm change' })).toBeVisible();
    const reads = requests('rules').length;
    await confirmAfterTheMinute(second.screen, clock);
    await expect.element(second.screen.getByRole('alert')).toHaveTextContent("We couldn't confirm whether your change went through. Open Rules to see where it stands.");
    // The rules were read again after it stopped waiting, not only when the review opened.
    expect(requests('rules').length).toBeGreaterThan(reads);
    const text = second.screen.container.textContent ?? '';
    expect(text).not.toContain("can't be applied");
    expect(text).not.toContain('Your current rules stay in place.');
    expect(second.screen.getByText('Your rules are updated.', { exact: true }).elements()).toHaveLength(0);
    // It gave up rather than send the confirm again.
    expect(requests('confirmRules')).toHaveLength(2);
    expect(desk().policy.version).toBe(applied.version);
  });

  it('unchecked_confirm_keeps_its_line', async () => {
    // The API answered that the rules couldn't be checked: a clear answer that nothing applied.
    const draft = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 409, body: { error: 'rules_cannot_be_checked' } });
    const { screen } = await openDraft(draft.version);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent(RULES_UNAVAILABLE_COPY);
    expect(screen.getByText('Your rules are updated.', { exact: true }).elements()).toHaveLength(0);
    expect(requests('confirmRules')).toHaveLength(1);
    expect(desk().policy.version).toBe(7);
  });

  it('unchecked_5xx_confirm_is_uncertain', async () => {
    // The same code on a 5xx is no clear answer: the change may still apply, so the review reads the
    // rules, which don't show it yet, and never says it can't be applied.
    const draft = mockStore.world.draft(desk(), [{ ...rivera.ruleCards['rv-book-sat'], mode: 'ask' }]);
    mockStore.inject({ route: 'confirmRules', status: 503, body: { error: 'rules_cannot_be_checked' } });
    const { screen } = await openDraft(draft.version);
    await expect.element(screen.getByRole('button', { name: 'Confirm change' })).toBeVisible();
    const reads = requests('rules').length;
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent("We couldn't confirm whether your change went through. Open Rules to see where it stands.");
    expect(requests('rules').length).toBeGreaterThan(reads);
    expect(screen.container.textContent).not.toContain("can't be applied");
    expect(requests('confirmRules')).toHaveLength(1);
    expect(desk().policy.version).toBe(7);
  });
});
