/**
 * The demo path end to end, as a first visitor walks it: a fresh copy from the intro dialog, the
 * public page in a new tab, a checked quote, a held discount answered on Today, and Safety's
 * checked record, with axe on each page. The mock project runs it on the dev server's shared mock
 * (one copy for every tab of the browser); the live project runs it on a real kernel and API,
 * where Claude's words differ every run, so live mode checks structure rather than wording.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

/** The axe rule tags every page passes with no violations: WCAG 2.2 AA, as the screen tests use them. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

export const QUOTE_QUESTION = 'How much is drain clearing?';
export const DISCOUNT_ASK = 'Can I get 50% off if I pay cash?';

/** The words Rivera Plumbing's mock says, which the live API's Claude may put differently. */
const MOCK = {
  quoteReceipt: "Quoted from Maria Rivera's price list",
  heldReceipt: 'Waiting for Maria Rivera to approve',
  allowedLine: "You allowed this. It's done.",
};

/** The failure when the discount isn't held, in the chat or on Today: never retried, since a live turn is Claude's call. */
const NOT_HELD = "The model didn't hold the discount; check the conversation in the owner app";

/** How long each wait may take: the mock answers in under a second, a live turn waits on Claude. */
function waits(live: boolean) {
  return live ? { reply: 90_000, approval: 60_000, update: 30_000 } : { reply: 5_000, approval: 5_000, update: 5_000 };
}

export interface DemoCopy {
  /** The copy's first Desk, as Today's URL names it. */
  deskId: string;
  /** That Desk's public page slug, as its public link names it. Each copy's Desks have their own. */
  slug: string;
}

const TODAY_URL = /\/app\/[^/]+\/today$/;

/**
 * Makes a fresh copy from `/`: the intro dialog's passcode and "Start the demo", then the Desk from
 * Today's URL and the slug from the "Chat as a customer" link under "Your public page". Nothing is
 * read from a fixed value, since every copy has slugs of its own. A refused passcode fails at once.
 *
 * The passcode is never printed or written, even when this fails:
 * - The field is checked while it is still empty: it is there, editable and blank.
 * - The passcode goes in with `keyboard.insertText`, which, unlike `fill`, puts nothing in the
 *   action's call log, the log a failed action's error carries.
 * - No expect runs while the field holds the passcode, since a failing expect that finds nothing
 *   snapshots the whole page, field values included; and nothing acts on the field but emptying
 *   it, whose failure is dropped, since a call log shows the element it found with its `value`
 *   attribute, which React keeps equal to what was typed. The field is emptied before the next
 *   expect, whatever the outcome.
 */
export async function startCopy(page: Page, passcode: string): Promise<DemoCopy> {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'A Claude front desk for your business' });
  const field = dialog.getByLabel('Passcode');
  await field.waitFor();
  await expect(field).toBeEditable();
  await expect(field).toHaveValue('');
  await field.focus();
  await page.keyboard.insertText(passcode);
  // The field holds the passcode from here until it is emptied: no expect, and no action on it.
  await dialog.getByRole('button', { name: 'Start the demo' }).click();
  const refusal = dialog.getByRole('alert');
  const outcome = await Promise.race([
    page.waitForURL(TODAY_URL, { timeout: 0 }).then(
      () => 'today' as const,
      () => 'closed' as const,
    ),
    refusal.waitFor({ timeout: 0 }).then(
      () => 'refused' as const,
      () => 'closed' as const,
    ),
  ]);
  const line = outcome === 'refused' ? await refusal.textContent() : null;
  // Whatever happened, the field is emptied, if it is still there, before anything checks the page.
  if ((await field.count().catch(() => 0)) > 0) await field.clear({ timeout: 5_000 }).catch(() => undefined);
  if (outcome !== 'today') throw new Error(`The intro dialog didn't start a copy${line === null ? '' : `: ${line}`}`);
  await expect(dialog).toHaveCount(0);

  const deskId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  const section = publicPageSection(page);
  const href = await section.getByRole('link', { name: 'Chat as a customer' }).getAttribute('href');
  if (href === null) throw new Error('"Chat as a customer" has no link');
  const link = new URL(href, page.url());
  expect(link.searchParams.get('preview'), 'the link opens the owner preview of this Desk').toBe(deskId);
  const slug = decodeURIComponent(link.pathname.match(/^\/d\/([^/]+)$/)?.[1] ?? '');
  expect(slug, 'the public page link names a slug').not.toBe('');
  // The link shown to share names the same page.
  await expect(section.getByText(`/d/${encodeURIComponent(slug)}`)).toBeVisible();
  return { deskId, slug };
}

export interface DemoPathOptions {
  passcode: string;
  /** Against a real kernel and API: structure, not wording, and Claude's own pace. */
  live: boolean;
}

/** The demo path, from a fresh copy to Safety's checked record. */
export async function demoPath(page: Page, { passcode, live }: DemoPathOptions): Promise<void> {
  const wait = waits(live);
  const context = page.context();
  const { deskId, slug } = await test.step('a fresh copy from the intro dialog', () => startCopy(page, passcode));

  const heldCards = page.getByRole('article', { name: /^Held for you: / });
  let seeded = 0;
  await test.step("Today as Maria, with no chat open and the right column's public page and last 7 days", async () => {
    await expect(page.getByText(live ? /You're .+ today\./ : "You're Maria Rivera today.")).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Message / })).toHaveCount(0);
    const aside = page.locator('.cd-today-aside');
    await expect(aside.getByRole('heading', { name: 'Your public page' })).toBeVisible();
    await expect(aside.getByRole('heading', { name: 'Last 7 days' })).toBeVisible();
    const main = await page.locator('.cd-today__main').boundingBox();
    const right = await aside.boundingBox();
    expect(main !== null && right !== null && right.x >= main.x + main.width, 'the public page and last 7 days are in the right column').toBe(true);
    // The seeded hold waits for the owner.
    await expect(heldCards.first(), 'the seeded hold shows in Needs you').toBeVisible({ timeout: wait.update });
    seeded = await heldCards.count();
  });

  const publicTab = await test.step('"Chat as a customer" opens the public page in a new tab', async () => {
    const [tab] = await Promise.all([context.waitForEvent('page'), publicPageSection(page).getByRole('link', { name: 'Chat as a customer' }).click()]);
    await tab.waitForLoadState();
    expect(new URL(tab.url()).pathname).toBe(`/d/${encodeURIComponent(slug)}`);
    await expect(tab.getByRole('textbox', { name: /^Message / })).toBeEnabled({ timeout: wait.update });
    return tab;
  });

  await test.step('a price question gets a checked quote card with its receipt', async () => {
    await send(publicTab, QUOTE_QUESTION);
    const quote = publicTab.getByRole('article', { name: 'Quote' });
    await expect(quote.first()).toBeVisible({ timeout: wait.reply });
    const receipts = rowOf(publicTab, quote.first()).locator('.cd-transcript-row__margin .cd-margin-receipt');
    await expect(receipts.first()).toBeVisible();
    if (!live) await expect(receipts.filter({ hasText: MOCK.quoteReceipt })).toHaveCount(1);
    await expect(publicTab.getByText('Claude is writing')).toHaveCount(0, { timeout: wait.reply });
  });

  const cancel = publicTab.getByRole('button', { name: 'Cancel this request' });
  const heldRow = await test.step('a discount ask is held, with a way to cancel it', async () => {
    await send(publicTab, DISCOUNT_ASK);
    await expect(cancel, NOT_HELD).toBeVisible({ timeout: wait.reply });
    // The held request's row, the one its cancel sits under. Rows only ever join at the end, so
    // its place in the chat names it from here on, after its cancel has gone.
    const rows = publicTab.locator('.cd-transcript-row');
    const at = await rows.evaluateAll((els) =>
      els.findIndex((el) => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Cancel this request')),
    );
    expect(at, 'the cancel sits under the held request').toBeGreaterThanOrEqual(0);
    const row = rows.nth(at);
    const held = row.locator('.cd-margin-receipt').filter({ has: publicTab.locator('.cd-status-dot--held') });
    await expect(held.first(), NOT_HELD).toBeVisible();
    if (!live) await expect(held.filter({ hasText: MOCK.heldReceipt })).toHaveCount(1);
    return row;
  });

  const newCard = heldCards.filter({ hasText: DISCOUNT_ASK });
  await test.step('back on Today, the new approval card beside the seeded hold, and the chat under Live now', async () => {
    await page.bringToFront();
    await expect(heldCards, NOT_HELD).toHaveCount(seeded + 1, { timeout: wait.approval });
    await expect(newCard).toHaveCount(1);
    const liveNow = page.getByRole('region', { name: 'Live now', exact: true });
    await expect(liveNow.getByRole('link').first()).toBeVisible({ timeout: wait.update });
    if (!live) await expect(liveNow.getByRole('link', { name: /Your preview/ })).toBeVisible();
  });

  await test.step('"Allow this time" shows its final line, and the public tab its resolved receipt', async () => {
    await newCard.getByRole('button', { name: 'Allow this time' }).click();
    await expect(newCard.getByText(live ? /^You allowed this\./ : MOCK.allowedLine)).toBeVisible({ timeout: wait.update });
    await expect(newCard.getByRole('button', { name: /^(Allow|Deny)/ })).toHaveCount(0);
    await expectNoAxeViolations(page, 'Today');

    await publicTab.bringToFront();
    const last = heldRow.locator('.cd-margin-receipt').last();
    await expect(last.locator('.cd-status-dot--handled'), 'the held request resolved in the chat').toHaveCount(1, { timeout: wait.update });
    if (!live) await expect(last).toHaveText(MOCK.quoteReceipt);
    await expect(cancel).toHaveCount(0);
    await expect(publicTab.getByText('Claude is writing')).toHaveCount(0, { timeout: wait.reply });
    await expectNoAxeViolations(publicTab, 'the public page');
  });

  await test.step('Safety: every entry of the record checks out', async () => {
    await page.bringToFront();
    await page.getByRole('navigation').getByRole('link', { name: /^Safety/ }).click();
    await page.waitForURL(`**/app/${encodeURIComponent(deskId)}/safety`);
    await expect(page.getByText('Every entry checks out', { exact: true })).toBeVisible({ timeout: wait.update });
    await expectNoAxeViolations(page, 'Safety');
  });
}

/** The "Your public page" card in Today's right column. */
function publicPageSection(page: Page): Locator {
  return page.locator('.cd-today-aside section').filter({ has: page.getByRole('heading', { name: 'Your public page' }) });
}

/** Types `text` into the public page's composer and sends it. */
async function send(tab: Page, text: string): Promise<void> {
  await tab.getByRole('textbox', { name: /^Message / }).fill(text);
  await tab.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The transcript row that holds `el`, with the receipts attached under it. */
function rowOf(tab: Page, el: Locator): Locator {
  return tab.locator('.cd-transcript-row').filter({ has: el });
}

/** Runs axe over the whole page with `AXE_TAGS`; fails listing each violation and where it is. */
export async function expectNoAxeViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const found = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact ?? 'unknown'}): ${v.help} at ${n.target.join(' ')}`));
  expect(found, `axe on ${name}`).toEqual([]);
}
