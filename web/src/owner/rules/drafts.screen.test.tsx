/**
 * A rule draft's review in a real browser against the mock API: each change before and after, the
 * check in plain words, the payment limit in its signed words, and one confirm that applies it,
 * only once the check passed.
 */
import { describe, expect, it } from 'vitest';

import type { ProofReport, RuleCard } from '../../api/contracts.ts';
import { RULES_UNAVAILABLE_COPY, request } from '../../api/http.ts';
import type { RulesDraft } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { PRESETS, RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import type { DeskRecord } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
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
async function openDraft(version: number, state?: unknown) {
  // A page that reads nothing, so every request recorded is the review's.
  const rendered = await renderRoute('/a-page-that-does-not-exist');
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

/** True when `first` comes before `second` in the page. */
function before(first: Element | null, second: Element | null): boolean {
  if (first === null || second === null) return false;
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** A failed part of a check, in the kernel's plain words. */
const failing = (name: string, counterexample: string | null) => ({ name, ok: false, counterexample_plain: counterexample, counterexample_raw: null });

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

    // A reload has no router state: one read of the draft, and the same rows under the plain title.
    const reloaded = await openDraft(stored.version);
    await expect.element(reloaded.screen.getByRole('heading', { level: 1, name: 'Review the change' })).toBeVisible();
    await expect.element(reloaded.screen.getByText(CANCELS_LINKS, { exact: true })).toBeVisible();
    expect(rowTexts(reloaded.screen)).toEqual(handedRows);
    expect(requests('ruleDraft')).toHaveLength(1);
    await expect.element(reloaded.screen.getByRole('button', { name: 'Confirm change' })).toBeEnabled();

    // A draft that isn't open anymore says so, and where to ask again.
    const gone = await openDraft(99);
    await expect.element(gone.screen.getByText("This draft isn't open anymore. Ask for the change again from Rules.", { exact: true })).toBeVisible();
    await expect.element(gone.screen.getByRole('link', { name: 'Go to Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    expect(gone.screen.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    await expectScreenBasics(gone.screen.container, { owner: true });
  });

  it('confirm_shows_the_cap_change_in_words_both_ways', async () => {
    const link = rivera.ruleCards['rv-link'];
    const withLink = (cents: number) => desk().policy.cards.map((card) => (card.card_id === link.card_id ? { ...card, max_amount_cents: cents } : card));

    // Raised from $500 to $5,000, the link rule with it: the new limit in words over the change, and nothing cancelled.
    const raise = mockStore.world.draftCards(desk(), withLink(100_000), { cap: 500_000 });
    const raised = await openDraft(raise.version);
    const limit = raised.screen.getByRole('region', { name: 'Payment limit' });
    await expect.element(limit.getByText('New limit: no payment over $5,000 without asking you.', { exact: true })).toBeVisible();
    await expect.element(limit.getByText('Was $500', { exact: true })).toBeVisible();
    expect(before(limit.element(), raised.screen.getByRole('button', { name: 'Confirm change' }).element())).toBe(true);
    expect(raised.screen.getByText(CANCELS_LINKS, { exact: true }).elements()).toHaveLength(0);
    await expectScreenBasics(raised.screen.container, { owner: true });

    // Lowered from $500 to $100, the $300 link rule down to $100: links may be cancelled, said above the buttons.
    const lower = mockStore.world.draftCards(desk(), withLink(10_000), { cap: 10_000 });
    const lowered = await openDraft(lower.version);
    const newLimit = lowered.screen.getByRole('region', { name: 'Payment limit' });
    await expect.element(newLimit.getByText('New limit: no payment over $100 without asking you.', { exact: true })).toBeVisible();
    await expect.element(newLimit.getByText('Was $500', { exact: true })).toBeVisible();
    const row = lowered.screen.getByRole('region', { name: 'Changes' }).getByRole('listitem');
    await expect.element(row.getByRole('group', { name: 'Before' }).getByText('Automatic up to $300; over $300, ask me first', { exact: true })).toBeVisible();
    await expect.element(row.getByRole('group', { name: 'After' }).getByText('Anyone · Up to $100 · Checked by the reviewer', { exact: true })).toBeVisible();
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

    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version: stored.version }]);
    expect(desk().policy.auto_money_cap_cents).toBe(40_000);
  });

  it('draft_review_matches_its_board', async () => {
    // "Ask me first" on Rivera's rules, as N-Conn-18-Preset-Review draws it.
    const stored = mockStore.world.draftCards(desk(), PRESETS.ask_first);
    const { screen } = await openDraft(stored.version, { draft: draftFromDiff(stored, desk().policy, 'ask_first'), title: 'Ask me first' } satisfies RuleDraftState);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await expect.element(breadcrumb.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    await expect.element(breadcrumb.getByText('Ask me first', { exact: true })).toHaveAttribute('aria-current', 'page');
    // Every rule of Rivera's own goes to the default ask, and the starter's cards it keeps make no row.
    await expect.element(screen.getByRole('region', { name: 'Changes' })).toBeVisible();
    const rows = rowTexts(screen);
    expect(rows).toHaveLength(Object.keys(rivera.ruleCards).length);
    for (const text of rows) expect(text).toMatch(/^Changed/);
    for (const text of rows) expect(text).toContain('Not covered by a rule you set, so I ask you.');
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
  });
});
