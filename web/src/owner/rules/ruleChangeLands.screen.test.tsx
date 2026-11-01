/**
 * A confirmed rule change lands where it applies, in a real browser against the mock API: in Ask
 * Claude the review gives way to a receipt under Claude's message, with the version from the
 * confirm's answer; on Rules each row the change changed lights up, holds and lets go, and keeps
 * "Updated" until the owner leaves Rules. A preset and a new payment limit land the same way. On a
 * phone the sheet shows the receipt, and closing it brings Rules to the row. Under reduced motion
 * it is all at its end state at once.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';
import { cdp, userEvent, type Locator } from 'vitest/browser';

import type { RuleCard } from '../../api/contracts.ts';
import { apiPath, ROUTES } from '../../api/routes.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { worker } from '../../mocks/browser.ts';
import { businessOut } from '../../mocks/readModels.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import type { DeskRecord } from '../../mocks/world.ts';
import { renderRoute, type RenderRouteOptions } from '../../test/renderRoute.tsx';

const DESK = `/app/${RIVERA.deskId}`;
const ASK = 'Stop quoting on weekends';
const CONFIRM_PATH = apiPath('confirmRules', { desk_id: RIVERA.deskId });
const CHAT_PATH = apiPath('ruleChat', { desk_id: RIVERA.deskId });

/** No refunds at all: a change to a row far down Rules, in Payments. */
const STOP_REFUNDS = 'Stop refunds';
const STOP_REFUNDS_ANSWER = "Here's that change: refunds never go through.";

/** No documents shared: a change to a row halfway down Rules, in Documents. */
const STOP_DOCUMENTS = 'Stop sharing documents';
const STOP_DOCUMENTS_ANSWER = "Here's that change: documents are never shared.";

/** Claude answers the next request on Rules with `card` drafted in the mock, and `answer`. */
function answerWith(card: RuleCard, answer: string): void {
  worker.use(
    http.post(
      CHAT_PATH,
      () => {
        const draft = mockStore.world.draft(desk(), [card]);
        return HttpResponse.json({ answer, draft });
      },
      { once: true },
    ),
  );
}

/** Claude answers the next request on Rules with refunds that never go through. */
const answerWithNoRefunds = () => answerWith({ ...rivera.ruleCards['rv-refund'], mode: 'never', reason: 'Refunds never go through.' }, STOP_REFUNDS_ANSWER);

/** Claude answers the next request on Rules with documents that are never shared. */
const answerWithNoDocuments = () => answerWith({ ...rivera.ruleCards['rv-docs'], mode: 'never', reason: 'Documents are never shared.' }, STOP_DOCUMENTS_ANSWER);

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** The mock's main Desk. */
function desk(): DeskRecord {
  const found = mockStore.world.desk(RIVERA.deskId);
  if (!found) throw new Error('the mock has the main Desk');
  return found;
}

/** Renames both the business read and its Desk summary, as the API keeps them together. */
function renameBusiness(name: string): void {
  desk().summary.business_name = name;
  worker.use(http.get(ROUTES.desks.path, () => HttpResponse.json([{ ...businessOut(mockStore.world), name }])));
}

/** The receipt's words for `version`. */
const receiptWords = (version: number) => `Confirmed. Version ${version} of your rules, checked against the always-on rules.`;

/** The selected fill, as the browser computes `--bg-selected`, and no fill at all. */
const SELECTED = 'rgb(60, 57, 47)';
const CLEAR = 'rgba(0, 0, 0, 0)';

/** The tool row on Rules named `name`. */
function toolRow(root: HTMLElement, name: string): HTMLElement {
  const row = [...root.querySelectorAll<HTMLElement>('.cd-connector-section__tool')].find(
    (li) => li.querySelector('.cd-connector-section__tool-name')?.textContent === name,
  );
  if (!row) throw new Error(`no ${name} row on Rules`);
  return row;
}

/** The fill a row is lit with now: its glow's, or none when it has no glow. */
function fillOf(row: HTMLElement): string {
  const glow = row.querySelector('.cd-connector-section__glow');
  return glow === null ? 'none' : getComputedStyle(glow).backgroundColor;
}

/** The row's words, at the right: its rules and its outcome. */
function wordsOf(row: HTMLElement): string {
  return row.querySelector('.cd-connector-section__tool-summary')?.textContent ?? '';
}

/** Whether `row` says it was updated. */
const saysUpdated = (row: HTMLElement) => row.querySelector('.cd-pill')?.textContent === 'Updated';

/** Whether `el` is wholly inside the visible part of `scroller`. */
function inView(el: Element, scroller: Element): boolean {
  const box = el.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  return box.height > 0 && box.top >= port.top && box.bottom <= port.bottom;
}

/** How far `el`'s middle is from the middle of what `scroller` shows, in px. */
function offMiddle(el: Element, scroller: Element): number {
  const box = el.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  return Math.abs((box.top + box.bottom) / 2 - (port.top + port.bottom) / 2);
}

/** Sets prefers-reduced-motion for the page, back to no preference after the test. */
async function reduceMotion(): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  onTestFinished(async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  });
  await expect.poll(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
}

/** The animations running on `root` or anything in it. */
const animationsIn = (root: Element) => root.getAnimations({ subtree: true });

/** Waits `ms` of real time. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rules, with Ask Claude open on `words` (by default "Stop quoting on weekends") and its review ready to confirm. */
async function askForTheWeekdayChange(opts: RenderRouteOptions = {}, words = ASK) {
  const rendered = await renderRoute(`${DESK}/rules`, opts);
  const composer = rendered.screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
  await composer.fill(words);
  await userEvent.keyboard('{Enter}');
  // Beside the page, or a dialog over it where it is a sheet.
  const panel = rendered.screen.getByRole(opts.viewport === 'phone' ? 'dialog' : 'complementary', { name: 'Ask Claude' });
  const log = panel.getByRole('log');
  await expect.element(log.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
  return { ...rendered, panel, log };
}

describe('a confirmed rule change in Ask Claude', () => {
  it('the_receipt_takes_the_reviews_place_with_the_answers_version', async () => {
    const { log } = await askForTheWeekdayChange();
    // The API's answer names the version now in force: the receipt says that one, whatever the draft's.
    const answered = { ...desk().policy, version: 42, parent_version: 7, status: 'active' };
    const sent: unknown[] = [];
    worker.use(
      http.post(
        CONFIRM_PATH,
        async ({ request }) => {
          sent.push(await request.json());
          return HttpResponse.json(answered);
        },
        { once: true },
      ),
    );
    await log.getByRole('button', { name: 'Confirm change' }).click();

    const receipt = log.getByText(receiptWords(42), { exact: true });
    await expect.element(receipt).toBeVisible();
    // Under Claude's message, in the conversation: once landed, 8 px under it, as the board draws it.
    const message = log.getByText(/^Here's that change: quotes stay automatic on weekdays/).element();
    expect(message.compareDocumentPosition(receipt.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const line = receipt.element().closest('.cd-margin-receipt') as HTMLElement;
    await Promise.all(line.getAnimations({ subtree: true }).map((landing) => landing.finished));
    const answer = message.closest('.cd-claude-message') as HTMLElement;
    expect(Math.round(line.getBoundingClientRect().top - answer.getBoundingClientRect().bottom)).toBe(8);
    // The review has gone, and no link sends the owner to the page that is already open.
    await expect.element(log.getByRole('region', { name: 'Changes' })).not.toBeInTheDocument();
    expect(log.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(log.getByRole('button', { name: 'Keep my rules' }).elements()).toHaveLength(0);
    expect(log.getByRole('link', { name: 'See your rules' }).elements()).toHaveLength(0);
    expect(log.element().textContent).not.toContain('Your rules are updated.');
    expect(sent).toEqual([{ version: desk().lastVersion }]);
  });

  it('an_answer_without_a_version_settles_by_the_rules_read', async () => {
    const { log } = await askForTheWeekdayChange();
    const version = desk().lastVersion;
    // The confirm applies, but its answer names no version of its own (here, a word for one).
    worker.use(
      http.post(
        CONFIRM_PATH,
        () => {
          const applied = mockStore.world.confirmDraft(desk(), version);
          if (typeof applied === 'string') throw new Error(`the draft didn't apply: ${applied}`);
          return HttpResponse.json({ ...applied, version: '42' });
        },
        { once: true },
      ),
    );
    const reads = requests('rules').length;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    // The rules, read again, say which version is in force: the receipt says that one, never "42".
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();
    expect(requests('rules').length).toBeGreaterThan(reads);
    expect(log.element().textContent).not.toContain('Version 42');
  });

  it('a_lost_answer_takes_its_version_from_the_rules_read', async () => {
    const { log } = await askForTheWeekdayChange();
    const version = desk().lastVersion;
    // The confirm applies and its answer is lost on the way back.
    mockStore.inject({ route: 'confirmRules', status: 'network', afterCommit: true });
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();
    expect(desk().policy.version).toBe(version);
  });

  it('the_changed_row_lights_up_holds_lets_go_and_keeps_updated', async () => {
    const { screen, log } = await askForTheWeekdayChange();
    const root = screen.container;
    expect(wordsOf(toolRow(root, 'Quote'))).toBe('Anyone · No discounts');
    const version = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();

    // The Quote row, which the change changed, says so, lit in the selected fill, with its new words.
    await expect.poll(() => saysUpdated(toolRow(root, 'Quote'))).toBe(true);
    await expect.poll(() => fillOf(toolRow(root, 'Quote'))).toBe(SELECTED);
    await expect.poll(() => wordsOf(toolRow(root, 'Quote'))).toBe('Anyone · No discounts · Weekdays, all day');
    // Then it lets go, and keeps "Updated".
    await expect.poll(() => fillOf(toolRow(root, 'Quote')), { timeout: 5_000 }).toBe(CLEAR);
    expect(saysUpdated(toolRow(root, 'Quote'))).toBe(true);
    // A row the change didn't change carries neither.
    for (const name of ['Book a visit', 'Find open times', 'Payment link']) {
      expect(saysUpdated(toolRow(root, name)), name).toBe(false);
      expect(fillOf(toolRow(root, name)), name).toBe('none');
    }
    // The version line says the new one.
    await expect.element(screen.getByText(`Version ${version} of your rules, checked against the always-on rules`, { exact: true })).toBeVisible();
  });

  it('leaving_rules_and_coming_back_clears_updated', async () => {
    const { screen, router, log } = await askForTheWeekdayChange();
    const root = screen.container;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.poll(() => saysUpdated(toolRow(root, 'Quote'))).toBe(true);

    // To All rules and back: Rules opens afresh, and nothing on it says it was updated.
    await screen.getByRole('link', { name: 'See all rules' }).first().click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    await router.navigate(-1);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    await expect.poll(() => wordsOf(toolRow(root, 'Quote'))).toBe('Anyone · No discounts · Weekdays, all day');
    expect([...root.querySelectorAll<HTMLElement>('.cd-connector-section__tool')].filter(saysUpdated)).toEqual([]);
    expect(root.querySelectorAll('.cd-connector-section__glow')).toHaveLength(0);
  });

  it('a_row_out_of_view_scrolls_to_the_middle', async () => {
    // A change to the Share a document row, halfway down Rules, below what shows at its top.
    answerWithNoDocuments();
    const { screen, log } = await askForTheWeekdayChange({}, STOP_DOCUMENTS);
    await expect.element(log.getByText(STOP_DOCUMENTS_ANSWER, { exact: true })).toBeVisible();
    const root = screen.container;
    const main = screen.getByRole('main').element();
    expect(inView(toolRow(root, 'Share a document'), main)).toBe(false);
    await log.getByRole('button', { name: 'Confirm change' }).click();

    // It comes to the middle of what shows, where it lights up.
    await expect.poll(() => saysUpdated(toolRow(root, 'Share a document'))).toBe(true);
    await expect.poll(() => offMiddle(toolRow(root, 'Share a document'), main)).toBeLessThan(2);
    expect(fillOf(toolRow(root, 'Share a document'))).not.toBe('none');
    expect(updatedRows(root)).toEqual(['Share a document']);
  });

  it('a_row_above_what_shows_scrolls_as_near_the_middle_as_rules_goes', async () => {
    const { screen, log } = await askForTheWeekdayChange();
    const root = screen.container;
    // Rules scrolled to its end, the Quote row far above what shows.
    const main = screen.getByRole('main').element();
    main.scrollTop = main.scrollHeight;
    await expect.poll(() => inView(toolRow(root, 'Quote'), main)).toBe(false);
    await log.getByRole('button', { name: 'Confirm change' }).click();

    // The Quote row is in Rules' first screen, so Rules goes back to its top, the row in view.
    await expect.poll(() => saysUpdated(toolRow(root, 'Quote'))).toBe(true);
    await expect.poll(() => inView(toolRow(root, 'Quote'), main)).toBe(true);
    await expect.poll(() => main.scrollTop).toBe(0);
  });

  it('a_row_in_view_stays_where_it_is', async () => {
    const { screen, log } = await askForTheWeekdayChange();
    const root = screen.container;
    const main = screen.getByRole('main').element();
    expect(inView(toolRow(root, 'Quote'), main)).toBe(true);
    const top = main.scrollTop;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.poll(() => fillOf(toolRow(root, 'Quote'))).toBe(SELECTED);
    expect(main.scrollTop).toBe(top);
  });

  it('a_failed_confirm_lands_nothing_and_keeps_its_error', async () => {
    const { screen, log } = await askForTheWeekdayChange();
    mockStore.inject({ route: 'confirmRules', status: 409, body: { error: 'rules_changed_since_draft' } });
    await log.getByRole('button', { name: 'Confirm change' }).click();

    // The review stays, with the line it has always given, and nothing says the change applied.
    await expect.element(log.getByRole('alert')).toHaveTextContent('Your rules changed since this was drafted. Ask for the change again.');
    await expect.element(log.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
    expect(log.element().textContent).not.toContain('Confirmed.');
    expect(log.element().querySelector('.cd-margin-receipt')).toBeNull();
    // No row on Rules lights up or says it was updated, and the version stays.
    const rows = [...screen.container.querySelectorAll<HTMLElement>('.cd-connector-section__tool')];
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter(saysUpdated)).toEqual([]);
    expect(screen.container.querySelectorAll('.cd-connector-section__glow')).toHaveLength(0);
    await expect.element(screen.getByText('Version 7 of your rules, checked against the always-on rules', { exact: true })).toBeVisible();
    expect(desk().policy.version).toBe(7);
  });
});

/**
 * Holds the next confirm before it reaches the mock: `arrived()` once the app sent it, and
 * `release()` lets it through to the mock, which applies it and answers.
 */
function holdNextConfirm(): { arrived: () => boolean; release: () => void } {
  let arrived = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
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

/** The main Desk's Needs you, as the app reads it. */
const NEEDS_YOU_PATH = ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId);

/** Holds every read of the main Desk's Needs you until `release()` lets them through to the mock. */
function holdNeedsYou(): { held: () => number; release: () => void } {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  worker.use(
    http.get(NEEDS_YOU_PATH, async () => {
      waiting += 1;
      await released;
      return undefined;
    }),
  );
  return { held: () => waiting, release };
}

/** Text that starts with `words`, whatever follows them. */
const startingWith = (words: string) => new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/** The names of the tool rows on Rules that say they were updated, in the page's order. */
function updatedRows(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.cd-connector-section__tool')]
    .filter(saysUpdated)
    .map((row) => row.querySelector('.cd-connector-section__tool-name')?.textContent ?? '');
}

describe('a preset or a new payment limit', () => {
  it('a_preset_lands_on_every_row_it_changed', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    const root = screen.container;
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Ask me first' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    const version = desk().lastVersion;
    await screen.getByRole('button', { name: 'Confirm change' }).click();

    // Confirmed, it goes back to Rules, where the change applies.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    expect(desk().policy.version).toBe(version);
    await expect.element(screen.getByText(`Version ${version} of your rules, checked against the always-on rules`, { exact: true })).toBeVisible();
    // Every row whose rules it changed lands, and those it left alone (the starter's own) don't.
    const changed = ['Quote', 'Book a visit', 'Share a document', 'Payment link', 'Charge within a signed limit', 'See charges', 'Refund'];
    await expect.poll(() => updatedRows(root).sort()).toEqual([...changed].sort());
    for (const name of changed) expect(fillOf(toolRow(root, name)), name).toBe(SELECTED);
    for (const name of ['Find open times', 'Save a lead', 'Request a callback']) expect(fillOf(toolRow(root, name)), name).toBe('none');
    expect(screen.container.textContent).not.toContain('Your rules are updated.');
    await expect.poll(() => fillOf(toolRow(root, 'Quote')), { timeout: 5_000 }).toBe(CLEAR);
    expect(updatedRows(root).sort()).toEqual([...changed].sort());
  });

  it('an_answer_that_comes_after_the_review_has_gone_moves_nothing', async () => {
    // All rules, then Rules, then a preset's review, whose confirm is held.
    const { screen, router } = await renderRoute(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    await router.navigate(`${DESK}/rules`);
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Ask me first' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    const version = desk().lastVersion;
    const held = holdNextConfirm();
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.poll(held.arrived).toBe(true);

    // Back to Rules before the answer; then it comes. Rules reads the new rules, and stays where it is.
    await router.navigate(-1);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    held.release();
    await expect.poll(() => desk().policy.version).toBe(version);
    await expect.element(screen.getByText(`Version ${version} of your rules, checked against the always-on rules`, { exact: true })).toBeVisible();
    await pause(300);
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
  });

  it.each(['Rivera Plumbing', 'Acme Accounting'])('a_change_from_far_down_rules_lands_in_view_and_back_keeps_the_place_for_%s', async (business) => {
    // Acme has none of the sample's suggestions, so Rules waits for its first reads before drawing.
    // A short window, so Payments can be wholly out of view above Stripe.
    renameBusiness(business);
    const { screen, router } = await renderRoute(`${DESK}/rules`, { viewport: { width: 1440, height: 600 } });
    const root = screen.container;
    const stripe = screen.getByRole('region', { name: 'Stripe' });
    await expect.element(stripe.getByRole('button', { name: 'Change' })).toBeVisible();
    // The shell's main area, once the Desk has opened, which scrolls on its own.
    const main = screen.getByRole('main').element();
    // Stripe at the top of what shows, Payments above it out of view.
    stripe.element().scrollIntoView({ block: 'start' });
    await expect.poll(() => main.scrollTop).toBeGreaterThan(0);
    const paymentsLimit = () => screen.getByRole('region', { name: 'Payments' }).element().querySelector('.cd-money-limit') as HTMLElement;
    expect(inView(paymentsLimit(), main)).toBe(false);

    // A lower limit from Stripe's line, confirmed on its review.
    await stripe.getByRole('button', { name: 'Change' }).click();
    await stripe.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('100');
    await stripe.getByRole('button', { name: 'Review change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    // Back on Acme's Rules, its first Needs you read is held, so the new rules arrive while Rules
    // still shows its loading line; the sample's Rules doesn't wait for it.
    const needsYou = business === 'Acme Accounting' ? holdNeedsYou() : null;
    const version = desk().lastVersion;
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    if (needsYou !== null) {
      await expect.poll(needsYou.held).toBeGreaterThan(0);
      await expect.poll(() => desk().policy.version).toBe(version);
      await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeVisible();
      await pause(300);
      needsYou.release();
    }

    // The first row it changed, Payments' limit, comes into view and says so; the rule it lowered
    // lights up.
    await expect.poll(() => paymentsLimit()?.querySelector('.cd-pill')?.textContent).toBe('Updated');
    await expect.poll(() => inView(paymentsLimit(), main)).toBe(true);
    await expect.poll(() => updatedRows(root)).toEqual(['Payment link']);
    expect(fillOf(toolRow(root, 'Payment link'))).not.toBe('none');
    // Once it has come to rest, that is the owner's place: All rules, then Back, returns to it, on a
    // new visit with nothing updated.
    let place = -1;
    await expect.poll(async () => {
      const before = main.scrollTop;
      await pause(150);
      place = main.scrollTop;
      return place === before;
    }).toBe(true);
    // (Navigated to directly: clicking a link would first scroll it into view, moving the place.)
    await router.navigate(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    await router.navigate(-1);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    await expect.poll(() => main.scrollTop).toBe(place);
    expect(updatedRows(root)).toEqual([]);
  });

  it('a_new_limit_lands_on_its_line_and_the_rule_it_lowered', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    const root = screen.container;
    const payments = screen.getByRole('region', { name: 'Payments' });
    await payments.getByRole('button', { name: 'Change' }).click();
    await payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('100');
    await payments.getByRole('button', { name: 'Review change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    await screen.getByRole('button', { name: 'Confirm change' }).click();

    // Back on Rules: the limit's line in both groups has the new amount and says it was updated.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    const limit100 = 'No payment over $100 goes through without asking you, whatever the rules below say.';
    for (const name of ['Payments', 'Stripe']) {
      const line = screen.getByRole('region', { name }).getByText(startingWith(limit100));
      await expect.element(line).toBeVisible();
      await expect.poll(() => line.element().querySelector('.cd-pill')?.textContent, { message: name }).toBe('Updated');
    }
    // Payment link's own $300, brought down to the new limit, lands too; nothing else does.
    await expect.poll(() => updatedRows(root)).toEqual(['Payment link']);
    await expect.poll(() => fillOf(toolRow(root, 'Payment link'))).toBe(SELECTED);
    expect(desk().policy.auto_money_cap_cents).toBe(10_000);
  });
});

describe('under reduced motion', () => {
  it('a_confirmed_change_is_at_its_end_state_at_once', async () => {
    await reduceMotion();
    const { screen, log } = await askForTheWeekdayChange();
    const root = screen.container;
    const main = screen.getByRole('main').element();
    main.scrollTop = main.scrollHeight;
    const version = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();

    // The receipt, there at once with its dot whole, and the review gone without a fade.
    const receipt = log.getByText(receiptWords(version), { exact: true });
    await expect.element(receipt).toBeVisible();
    expect(log.element().querySelector('.cd-rule-draft--leaving')).toBeNull();
    expect(log.getByRole('region', { name: 'Changes' }).elements()).toHaveLength(0);
    // The row: "Updated" and its new words at once, with no fill to hold and nothing cross-fading.
    await expect.poll(() => saysUpdated(toolRow(root, 'Quote'))).toBe(true);
    const quote = toolRow(root, 'Quote');
    expect(wordsOf(quote)).toBe('Anyone · No discounts · Weekdays, all day');
    expect(quote.querySelector('.cd-cross-fade')).toBeNull();
    const glow = quote.querySelector('.cd-connector-section__glow');
    expect(glow === null || getComputedStyle(glow).display === 'none').toBe(true);
    // Brought into view with no scroll animation: where it is now, it stays.
    await expect.poll(() => inView(toolRow(root, 'Quote'), main)).toBe(true);
    const settledAt = main.scrollTop;
    await pause(400);
    expect(main.scrollTop).toBe(settledAt);
    // Nothing moves, in the conversation or on Rules.
    expect(animationsIn(log.element())).toEqual([]);
    expect(animationsIn(root.querySelector('.cd-rules') as Element)).toEqual([]);
  });
});

/** Asks in Ask Claude's own composer, with Claude answering `answer` with `card` drafted, and waits for its review. */
async function askAgain(panel: Locator, log: Locator, words: string, card: RuleCard, answer: string): Promise<void> {
  answerWith(card, answer);
  await panel.getByRole('textbox', { name: 'Ask Claude' }).fill(words);
  await userEvent.keyboard('{Enter}');
  await expect.element(log.getByText(answer, { exact: true })).toBeVisible();
  await expect.element(log.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
}

/** Refunds that never go through, as `answerWithNoRefunds` drafts them. */
const NO_REFUNDS: RuleCard = { ...rivera.ruleCards['rv-refund'], mode: 'never', reason: 'Refunds never go through.' };

/** Documents that are never shared, as `answerWithNoDocuments` drafts them. */
const NO_DOCUMENTS: RuleCard = { ...rivera.ruleCards['rv-docs'], mode: 'never', reason: 'Documents are never shared.' };

describe('on a phone', () => {
  it('two_changes_confirmed_in_one_sheet_both_land_once_it_closes', async () => {
    answerWithNoRefunds();
    const { screen, log, panel } = await askForTheWeekdayChange({ viewport: 'phone' }, STOP_REFUNDS);
    const root = screen.container;
    const first = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(first), { exact: true })).toBeVisible();
    // A second change in the same sheet, confirmed before it closes.
    await askAgain(panel, log, STOP_DOCUMENTS, NO_DOCUMENTS, STOP_DOCUMENTS_ANSWER);
    const second = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(second), { exact: true })).toBeVisible();
    expect(updatedRows(root)).toEqual([]);

    // Closed, both rows land.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => updatedRows(root)).toEqual(['Share a document', 'Refund']);
  });

  it('a_change_left_behind_with_back_never_lands_on_a_later_visit', async () => {
    // From All rules to Rules, so Back has somewhere to go.
    const rendered = await renderRoute(`${DESK}/rules/all`, { viewport: 'phone' });
    await expect.element(rendered.screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    await rendered.router.navigate(`${DESK}/rules`);
    answerWithNoRefunds();
    const composer = rendered.screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await composer.fill(STOP_REFUNDS);
    await userEvent.keyboard('{Enter}');
    const log = rendered.screen.getByRole('dialog', { name: 'Ask Claude' }).getByRole('log');
    await expect.element(log.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
    const version = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();

    // Back with the sheet still open, then Forward to Rules: a new visit, where nothing says it was updated.
    await rendered.router.navigate(-1);
    await expect.element(rendered.screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    await rendered.router.navigate(1);
    await expect.element(rendered.screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    const root = rendered.screen.container;
    await expect.poll(() => wordsOf(toolRow(root, 'Refund'))).not.toBe('');
    await pause(500);
    expect(updatedRows(root)).toEqual([]);
    expect(root.querySelectorAll('.cd-connector-section__glow')).toHaveLength(0);
  });

  it('the_sheet_shows_the_receipt_and_closing_it_brings_rules_to_the_row', async () => {
    // A change to the Refund row, far down Rules on a phone, under the composer that opened the sheet.
    answerWithNoRefunds();
    const { screen, log, panel } = await askForTheWeekdayChange({ viewport: 'phone' }, STOP_REFUNDS);
    await expect.element(log.getByText(STOP_REFUNDS_ANSWER, { exact: true })).toBeVisible();
    const root = screen.container;
    const main = screen.getByRole('main').element();
    const shows = () => {
      const box = toolRow(root, 'Refund').getBoundingClientRect();
      const port = main.scrollHeight > main.clientHeight ? main.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      return box.height > 0 && box.top >= Math.max(0, port.top) && box.bottom <= Math.min(window.innerHeight, port.bottom);
    };
    expect(shows()).toBe(false);
    const version = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();

    // The sheet shows the same receipt; the row waits for the sheet to close.
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();
    await expect.poll(() => desk().policy.version).toBe(version);
    await pause(300);
    expect(saysUpdated(toolRow(root, 'Refund'))).toBe(false);

    // Closed, focus goes back to the composer at the top, and Rules comes to the row, which lands there.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect.element(panel).not.toBeInTheDocument();
    await expect.poll(() => saysUpdated(toolRow(root, 'Refund'))).toBe(true);
    await expect.poll(shows).toBe(true);
    expect(fillOf(toolRow(root, 'Refund'))).not.toBe('none');
    expect(updatedRows(root)).toEqual(['Refund']);
    expect(main.scrollTop).toBeGreaterThan(0);
  });
});
