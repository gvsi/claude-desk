/**
 * A confirmed rule change lands where it applies, in a real browser against the mock API: in Ask
 * Claude the review gives way to a receipt under Claude's message, with the version from the
 * confirm's answer; on Rules each row the change changed lights up, holds and lets go, and keeps
 * "Updated" until the owner leaves Rules. A preset and a new payment limit land the same way. On a
 * phone the sheet shows the receipt, and closing it brings Rules to the row. Under reduced motion
 * it is all at its end state at once.
 */
import { onlineManager } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';
import { cdp, page, userEvent, type Locator } from 'vitest/browser';

import type { RuleCard } from '../../api/contracts.ts';
import { apiPath, ROUTES } from '../../api/routes.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { worker } from '../../mocks/browser.ts';
import { chenBusinessTools, seedBusinessTools } from '../../mocks/businessTools.ts';
import { businessOut, rulesView } from '../../mocks/readModels.ts';
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

/** The rows on Rules a change can land on, by name, in the page's order: the Desk's own jobs, then each connector's tools. */
function landingRows(root: HTMLElement): { name: string; row: HTMLElement }[] {
  return [...root.querySelectorAll<HTMLElement>('.cd-business-jobs .cd-tool-rules, .cd-connector-section__tool')].map((row) => ({
    name: row.querySelector('.cd-tool-rules__tool-name, .cd-connector-section__tool-name')?.textContent ?? '',
    row,
  }));
}

/** The row on Rules named `name`: a connector's tool, or one of the Desk's own jobs. */
function toolRow(root: HTMLElement, name: string): HTMLElement {
  const row = landingRows(root).find((each) => each.name === name)?.row;
  if (!row) throw new Error(`no ${name} row on Rules`);
  return row;
}

/** The fill a row is lit with now: its glow's, or none when it has no glow. */
function fillOf(row: HTMLElement): string {
  const glow = row.querySelector('.cd-landed-glow');
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
  // Beside the page, or a dialog over it where it is a sheet: under 1024 px.
  const sheet = opts.viewport === 'phone' || (typeof opts.viewport === 'object' && opts.viewport.width < 1024);
  const panel = rendered.screen.getByRole(sheet ? 'dialog' : 'complementary', { name: 'Ask Claude' });
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

  it('focus_goes_to_the_panels_composer_when_the_receipt_lands', async () => {
    const { log, panel } = await askForTheWeekdayChange();
    const confirm = log.getByRole('button', { name: 'Confirm change' });
    confirm.element().focus();
    const version = desk().lastVersion;
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();
    // The button it pressed has gone with the review: focus doesn't drop to the page.
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' })).toHaveFocus();
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
    expect(root.querySelectorAll('.cd-landed-glow')).toHaveLength(0);
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
    // A Desk with no jobs above its connectors, so the Quote row sits in Rules' first screen.
    desk().tools = desk().tools.filter((row) => row.source !== 'business');
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
    expect(screen.container.querySelectorAll('.cd-landed-glow')).toHaveLength(0);
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

/** The main Desk's rules, as the app reads them. */
const RULES_PATH = apiPath('rules', { desk_id: RIVERA.deskId });

/** Holds every read of the main Desk's rules until `release()` lets them through to the mock. */
function holdRules(): { held: () => number; release: () => void } {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  worker.use(
    http.get(RULES_PATH, async () => {
      waiting += 1;
      await released;
      return undefined;
    }),
  );
  return { held: () => waiting, release };
}

/**
 * Whether `root` draws an element matching `selector` (a selector starting with ".") or text holding
 * `words`, anywhere but in its loading shapes, which are laid out with the page's own classes and
 * words.
 */
function showsOutsideShapes(root: HTMLElement, selectorOrWords: string): boolean {
  const outside = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('.cd-skeleton-screen__layer') == null;
  if (selectorOrWords.startsWith('.')) return [...root.querySelectorAll(selectorOrWords)].some(outside);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent?.includes(selectorOrWords) && outside(node)) return true;
  }
  return false;
}

/** Text that starts with `words`, whatever follows them. */
const startingWith = (words: string) => new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/** The names of the rows on Rules (jobs and tools) that say they were updated, in the page's order. */
function updatedRows(root: HTMLElement): string[] {
  return landingRows(root)
    .filter(({ row }) => saysUpdated(row))
    .map(({ name }) => name);
}

describe('a preset or a new payment limit', () => {
  it('a_preset_lands_on_every_row_it_changed', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    const root = screen.container;
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Ask me first' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    const version = desk().lastVersion;
    // Whether the review's old done line shows at any moment on the way back.
    let flashed = false;
    const watch = new MutationObserver(() => {
      if (root.textContent?.includes('Your rules are updated.')) flashed = true;
    });
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    onTestFinished(() => watch.disconnect());
    await screen.getByRole('button', { name: 'Confirm change' }).click();

    // Confirmed, it goes back to Rules, where the change applies, with no done line on the way.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    expect(desk().policy.version).toBe(version);
    await expect.element(screen.getByText(`Version ${version} of your rules, checked against the always-on rules`, { exact: true })).toBeVisible();
    // Every row whose rules it changed lands, and those it left alone (the starter's own) don't.
    const changed = ['Emergency callback', 'Quote', 'Book a visit', 'Share a document', 'Payment link', 'Charge within a signed limit', 'See charges', 'Refund'];
    await expect.poll(() => updatedRows(root).sort()).toEqual([...changed].sort());
    for (const name of changed) await expect.poll(() => fillOf(toolRow(root, name)), { message: name }).toBe(SELECTED);
    for (const name of ['Find open times', 'Save a lead', 'Request a callback']) expect(fillOf(toolRow(root, name)), name).toBe('none');
    expect(flashed).toBe(false);
    await expect.poll(() => fillOf(toolRow(root, 'Quote')), { timeout: 5_000 }).toBe(CLEAR);
    expect(updatedRows(root).sort()).toEqual([...changed].sort());
  });

  it('a_preset_lands_only_on_the_rows_its_review_listed', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const root = screen.container;
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Recommended rules' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Recommended rules' })).toBeVisible();
    // The tools its review lists by name, each once: its quote and document rules replace Turner's
    // with ones that differ only in their ids, so it lists neither.
    const listed = [...new Set([...root.querySelectorAll('.cd-change-review__title')].map((title) => title.firstChild?.textContent ?? ''))].sort();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).not.toContain('Quote');
    expect(listed).not.toContain('Share a document');
    await screen.getByRole('button', { name: 'Confirm change' }).click();

    // Back on Rules, exactly those rows say "Updated" and light up; Quote and Share a document don't.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    await expect.poll(() => updatedRows(root).sort()).toEqual(listed);
    for (const name of listed) await expect.poll(() => fillOf(toolRow(root, name)), { message: name }).toBe(SELECTED);
    for (const name of ['Quote', 'Share a document']) {
      expect(saysUpdated(toolRow(root, name)), name).toBe(false);
      expect(fillOf(toolRow(root, name)), name).toBe('none');
    }
  });

  it('back_on_rules_the_reading_state_shows_until_the_rules_read_has_the_new_version', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const root = screen.container;
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Ask me first' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    const version = desk().lastVersion;
    // Every read of the rules after the confirm is held, as on a slow network.
    const reads = holdRules();
    // Whether Rules draws any of the old version's rows, or its line, while the read is held.
    let oldShown = false;
    const watch = new MutationObserver(() => {
      if (showsOutsideShapes(root, '.cd-connector-section__tool') || showsOutsideShapes(root, 'Version 7 of your rules')) oldShown = true;
    });
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    onTestFinished(() => watch.disconnect());
    await screen.getByRole('button', { name: 'Confirm change' }).click();

    // Back on Rules, the read held: its reading state, never the old rules.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    await expect.poll(reads.held).toBeGreaterThan(0);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeVisible();
    await pause(300);
    watch.disconnect();
    expect(oldShown).toBe(false);
    expect(updatedRows(root)).toEqual([]);

    // The read lands: the new version's line, and the rows it changed say so.
    reads.release();
    await expect.element(screen.getByText(`Version ${version} of your rules, checked against the always-on rules`, { exact: true })).toBeVisible();
    await expect.poll(() => updatedRows(root)).toContain('Quote');
    await expect.poll(() => fillOf(toolRow(root, 'Quote'))).toBe(SELECTED);
    expect(showsOutsideShapes(root, 'Version 7 of your rules')).toBe(false);
  });

  /** Rules, then the "Ask me first" preset's review, ready to confirm. Returns the version it makes. */
  async function reviewAskMeFirst() {
    const rendered = await renderRoute(`${DESK}/rules`);
    await rendered.screen.getByRole('button', { name: 'Start from a preset' }).click();
    await rendered.screen.getByRole('menuitem', { name: 'Ask me first' }).click();
    await expect.element(rendered.screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    return { ...rendered, root: rendered.screen.container, version: desk().lastVersion };
  }

  /** Turner's version 7 line, drawn on the page rather than in its loading shapes. */
  const showsVersion7 = (root: HTMLElement) => showsOutsideShapes(root, 'Version 7 of your rules');

  it('rules_that_keep_coming_back_older_end_the_reading_state_after_a_few_seconds', async () => {
    const { screen, root, version } = await reviewAskMeFirst();
    // Every read after the confirm answers with the rules as they were, as a read that lags behind it might.
    const older = rulesView(desk());
    let lagging = true;
    let olderReads = 0;
    worker.use(
      http.get(RULES_PATH, () => {
        if (!lagging) return undefined;
        olderReads += 1;
        return HttpResponse.json(older);
      }),
    );
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    const back = performance.now();

    // The reading state, while the older rules keep coming, for a few seconds.
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeVisible();
    await pause(2_000);
    expect(olderReads).toBeGreaterThan(1);
    expect(showsVersion7(root)).toBe(false);
    // Then Rules draws the rules it has, with nothing marked as updated: they aren't the new ones yet.
    await expect.poll(() => showsVersion7(root), { timeout: 5_000 }).toBe(true);
    expect(performance.now() - back).toBeGreaterThan(3_000);
    expect(updatedRows(root)).toEqual([]);

    // A later read with the confirmed version still lands the change.
    lagging = false;
    await expect.element(screen.getByText(`Version ${version} of your rules, checked against the always-on rules`, { exact: true })).toBeVisible();
    await expect.poll(() => updatedRows(root)).toContain('Quote');
    expect(showsVersion7(root)).toBe(false);
  });

  it('a_read_waiting_for_the_network_ends_the_reading_state_at_once', async () => {
    const { screen, root, version } = await reviewAskMeFirst();
    // Offline as the change is confirmed: the read of the new rules waits for the network.
    onTestFinished(() => onlineManager.setOnline(true));
    onlineManager.setOnline(false);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    const back = performance.now();

    // Rules draws the rules it has well before the wait's deadline, with the network error it
    // already shows for a read that can't go out, and nothing marked as updated yet.
    await expect.poll(() => showsVersion7(root)).toBe(true);
    expect(performance.now() - back).toBeLessThan(3_000);
    await expect.element(screen.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
    expect(updatedRows(root)).toEqual([]);

    // Back online, the read goes out, and the change lands.
    onlineManager.setOnline(true);
    await expect.element(screen.getByText(`Version ${version} of your rules, checked against the always-on rules`, { exact: true })).toBeVisible();
    await expect.poll(() => updatedRows(root)).toContain('Quote');
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

  it.each(['Turner Plumbing', 'Acme Accounting'])('a_change_from_far_down_rules_lands_in_view_and_back_keeps_the_place_for_%s', async (business) => {
    // Acme has none of the sample's suggestions, so Rules waits for its first reads before drawing.
    // A short window, so Payments can be wholly out of view above Stripe. The Desk keeps its job, so
    // Back lands its place on a page whose jobs section is drawn above it (#620).
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

describe('focus once a review Rules opened returns', () => {
  /** The words of the payment limit's field. */
  const LIMIT_FIELD = 'Most a payment can be without asking you, in dollars';

  /**
   * Rules with Payments at the top of what shows, then its limit's review from Payments' "Change",
   * by keyboard: 600, then Enter. Returns the place Rules was at.
   */
  async function reviewPaymentsLimit() {
    const rendered = await renderRoute(`${DESK}/rules`, { viewport: { width: 1440, height: 600 } });
    const { screen } = rendered;
    const payments = screen.getByRole('region', { name: 'Payments' });
    await expect.element(payments.getByRole('button', { name: 'Change' })).toBeVisible();
    // The shell's main area, once the Desk has opened, which scrolls on its own.
    const main = screen.getByRole('main').element();
    payments.element().scrollIntoView({ block: 'start' });
    await expect.poll(() => main.scrollTop).toBeGreaterThan(0);
    const place = main.scrollTop;
    payments.getByRole('button', { name: 'Change' }).element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(payments.getByRole('textbox', { name: LIMIT_FIELD })).toHaveFocus();
    await userEvent.keyboard('600{Enter}');
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    return { ...rendered, main, place };
  }

  /** Presses `name` on the review by keyboard, as the owner tabs to it. */
  async function press(screen: Awaited<ReturnType<typeof renderRoute>>['screen'], name: string) {
    screen.getByRole('button', { name }).element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
  }

  it('keep_my_rules_puts_focus_back_on_the_change_that_opened_it', async () => {
    const { screen, main, place } = await reviewPaymentsLimit();
    await press(screen, 'Keep my rules');

    // Back on Rules at its place, focus on Payments' "Change", not the page: the next Tab goes on from there.
    const change = screen.getByRole('region', { name: 'Payments' }).getByRole('button', { name: 'Change' });
    await expect.element(change).toHaveFocus();
    expect(main.scrollTop).toBe(place);
    await pause(300);
    expect(document.activeElement).toBe(change.element());
    expect(main.scrollTop).toBe(place);
  });

  it('confirm_change_puts_focus_back_on_the_change_that_opened_it', async () => {
    const { screen, main, place } = await reviewPaymentsLimit();
    await press(screen, 'Confirm change');

    // The new limit lands on its line, in view where Rules was, and focus is on Payments' "Change".
    const payments = screen.getByRole('region', { name: 'Payments' });
    await expect.poll(() => payments.element().querySelector('.cd-money-limit .cd-pill')?.textContent).toBe('Updated');
    await expect.element(payments.getByRole('button', { name: 'Change' })).toHaveFocus();
    await pause(300);
    expect(main.scrollTop).toBe(place);
    expect(document.activeElement).toBe(payments.getByRole('button', { name: 'Change' }).element());
  });

  it('keep_my_rules_on_a_preset_puts_focus_back_on_start_from_a_preset', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Recommended rules' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Recommended rules' })).toBeVisible();
    await press(screen, 'Keep my rules');
    await expect.element(screen.getByRole('button', { name: 'Start from a preset' })).toHaveFocus();
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
    const glow = quote.querySelector('.cd-landed-glow');
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
    expect(root.querySelectorAll('.cd-landed-glow')).toHaveLength(0);
  });

  it('a_window_widened_past_the_sheet_lands_the_change_beside_the_panel', async () => {
    // Confirmed in the sheet on a tablet-wide window, the row waits for the sheet.
    answerWithNoRefunds();
    const { screen, log } = await askForTheWeekdayChange({ viewport: { width: 900, height: 900 } }, STOP_REFUNDS);
    const root = screen.container;
    const version = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();
    await expect.poll(() => desk().policy.version).toBe(version);
    await pause(300);
    expect(updatedRows(root)).toEqual([]);

    // Widened past the sheet's breakpoint, Ask Claude sits beside the page, and the row lands at once.
    await page.viewport(1440, 900);
    await expect.element(screen.getByRole('complementary', { name: 'Ask Claude' })).toBeVisible();
    await expect.poll(() => updatedRows(root)).toEqual(['Refund']);
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

describe("the business's own jobs", () => {
  /** New clients answer three questions before they book, on their own: one of Chen & Co.'s jobs. */
  const INTAKE: RuleCard = {
    card_id: 'intake-auto',
    applies_to: 'desk.new-client-intake',
    mode: 'auto',
    who: 'anyone',
    person_id: null,
    agent_key_id: null,
    max_amount_cents: null,
    max_discount_bp: 0,
    hours: null,
    review: false,
    is_default: false,
    reason: 'New clients answer three questions before they book.',
  };
  const INTAKE_ASKS: RuleCard = { ...INTAKE, mode: 'ask', reason: 'New clients answer three questions, then wait for your answer.' };
  const INTAKE_ASKS_ANSWER = "Here's that change: new client intake waits for your answer.";

  /** The main Desk as Chen & Co. CPA, with its two jobs on and the intake rule its only rule. */
  function seedJobs(): void {
    desk().summary.business_name = 'Chen & Co. CPA';
    seedBusinessTools(desk(), chenBusinessTools.map((row) => ({ ...row, status: 'enabled', review_reason: null })));
    desk().policy = { ...desk().policy, cards: [INTAKE] };
  }

  /** The card of the job named `name` on Rules. */
  function jobCard(root: HTMLElement, name: string): HTMLElement {
    const card = [...root.querySelectorAll<HTMLElement>('[aria-label="Your Desk’s jobs"] section')].find((el) => el.getAttribute('aria-label') === name);
    if (!card) throw new Error(`no ${name} job on Rules`);
    return card;
  }

  it('a_change_to_a_job_lands_on_its_card', async () => {
    seedJobs();
    answerWith(INTAKE_ASKS, INTAKE_ASKS_ANSWER);
    const { screen, log } = await askForTheWeekdayChange({}, 'Make new client intake ask me first');
    await expect.element(log.getByText(INTAKE_ASKS_ANSWER, { exact: true })).toBeVisible();
    const root = screen.container;
    // Rules scrolled to its end, the jobs at its top out of view.
    const main = screen.getByRole('main').element();
    main.scrollTop = main.scrollHeight;
    await expect.poll(() => inView(jobCard(root, 'New client intake'), main)).toBe(false);
    const version = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();

    // The intake card comes into view, lit, with "Updated" by its title and its new words.
    const intake = () => jobCard(root, 'New client intake');
    await expect.poll(() => intake().querySelector('.cd-tool-rules__tool .cd-pill')?.textContent).toBe('Updated');
    await expect.poll(() => fillOf(intake())).toBe(SELECTED);
    await expect.poll(() => inView(intake(), main)).toBe(true);
    await expect.poll(() => intake().querySelector('.cd-rule-row__reason')?.textContent).toBe(INTAKE_ASKS.reason);
    // The other job carries neither.
    const booking = jobCard(root, 'Book a free intro call');
    expect(booking.querySelector('.cd-pill')).toBeNull();
    expect(fillOf(booking)).toBe('none');
  });
});

describe('under StrictMode, as the app renders', () => {
  // Renders and effects run twice on mount, as in development: a change still lands once, and the
  // review's hand-off to Rules survives the rehearsed unmount.
  it('a_change_confirmed_in_ask_claude_lands', async () => {
    const { screen, log } = await askForTheWeekdayChange({ strict: true });
    const root = screen.container;
    const version = desk().lastVersion;
    await log.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(log.getByText(receiptWords(version), { exact: true })).toBeVisible();
    await expect.poll(() => updatedRows(root)).toEqual(['Quote']);
    await expect.poll(() => fillOf(toolRow(root, 'Quote'))).toBe(SELECTED);
    expect(root.querySelectorAll('.cd-margin-receipt')).toHaveLength(1);
  });

  it('a_preset_confirmed_on_its_review_lands_back_on_rules', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`, { strict: true });
    const root = screen.container;
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Ask me first' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    const changed = ['Emergency callback', 'Quote', 'Book a visit', 'Share a document', 'Payment link', 'Charge within a signed limit', 'See charges', 'Refund'];
    await expect.poll(() => updatedRows(root).sort()).toEqual([...changed].sort());
    expect(root.textContent).not.toContain('Your rules are updated.');
  });
});

