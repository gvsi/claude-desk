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
import { cdp, userEvent } from 'vitest/browser';

import type { RuleCard } from '../../api/contracts.ts';
import { apiPath } from '../../api/routes.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { worker } from '../../mocks/browser.ts';
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

describe('on a phone', () => {
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
