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

/** The words Turner Plumbing's mock says, which the live API's Claude may put differently. */
const MOCK = {
  quoteReceipt: "Quoted from Mike Turner's price list",
  heldReceipt: 'Waiting for Mike Turner to approve',
  allowedLine: "You allowed this. It's done.",
  /**
   * Claude's reply once the discount is allowed: its words, the discounted quote's price (the 50%
   * `DISCOUNT_ASK` asks for, off the $180.00 list price), and the reply's check.
   */
  allowedReply: "Here's the price for clearing a drain, from Mike's price list.",
  allowedPrice: '$90.00',
  replyReceipt: "Reply checked against Mike Turner's rules",
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
  const liveNow = page.getByRole('region', { name: 'Live now', exact: true });
  // The chats under Live now on arrival, by the conversation each opens: a fresh copy may already
  // have one, so the chat this path starts is the one whose link wasn't there.
  let liveOnArrival = new Set<string>();
  await test.step("Today as Mike, with no chat open and the right column's public page and last 7 days", async () => {
    await expect(page.getByText(live ? /You're .+ today\./ : "You're Mike Turner today.")).toBeVisible();
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
    // Today's read is in: "Last 7 days" comes from it, and so does Live now.
    liveOnArrival = new Set(await liveChats(liveNow));
  });

  const { publicTab, turnEnds } = await test.step('"Chat as a customer" opens the public page in a new tab', async () => {
    const [tab] = await Promise.all([context.waitForEvent('page'), publicPageSection(page).getByRole('link', { name: 'Chat as a customer' }).click()]);
    // Counted from as soon as the tab opens, before it has loaded. A turn end missed would fail
    // the waits on the count, never pass them.
    const ended = await countTurnEnds(tab);
    await tab.waitForLoadState();
    expect(new URL(tab.url()).pathname).toBe(`/d/${encodeURIComponent(slug)}`);
    await expect(tab.getByRole('textbox', { name: /^Message / })).toBeEnabled({ timeout: wait.update });
    return { publicTab: tab, turnEnds: ended };
  });

  // The visitor's messages from the public tab, counted: each starts a turn that ends with a turn_end of its own.
  let sent = 0;
  const ask = async (text: string) => {
    await send(publicTab, text);
    sent += 1;
  };

  await test.step('a price question gets a checked quote card with its receipt', async () => {
    await ask(QUOTE_QUESTION);
    const quote = publicTab.getByRole('article', { name: 'Quote' });
    await expect(quote.first()).toBeVisible({ timeout: wait.reply });
    const receipts = rowOf(publicTab, quote.first()).locator('.cd-transcript-row__margin .cd-margin-receipt');
    await expect(receipts.first()).toBeVisible();
    if (!live) await expect(receipts.filter({ hasText: MOCK.quoteReceipt })).toHaveCount(1);
    await expect(publicTab.getByText('Claude is writing')).toHaveCount(0, { timeout: wait.reply });
  });

  const cancel = publicTab.getByRole('button', { name: 'Cancel this request' });
  // The public tab's rows. They only ever join at the end, so a row's place in the chat names it.
  const rows = publicTab.locator('.cd-transcript-row');
  const heldRow = await test.step('a discount ask is held, with a way to cancel it', async () => {
    await ask(DISCOUNT_ASK);
    await expect(cancel, NOT_HELD).toBeVisible({ timeout: wait.reply });
    // The held request's row, the one its cancel sits under: its place names it from here on,
    // after its cancel has gone.
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
    const newChats = async () => (await liveChats(liveNow)).filter((href) => !liveOnArrival.has(href));
    await expect.poll(newChats, { message: 'the chat shows under Live now', timeout: wait.update }).not.toHaveLength(0);
    if (!live) {
      const preview = liveNow.getByRole('link', { name: /Your preview/ });
      await expect(preview).toBeVisible();
      expect(await newChats(), 'the new chat is the preview').toContain(await preview.getAttribute('href'));
    }
  });

  await test.step('"Allow this time" shows its final line, and the public tab its resolved receipt and Claude\'s reply', async () => {
    // A visitor's turn can go on after its reply, so the discount turn may not be over, and a late
    // message of its own would take the place of the reply to the answer. Every turn sent so far
    // ends first.
    await expect.poll(turnEnds, { message: 'the discount turn ended', timeout: wait.reply }).toBeGreaterThanOrEqual(sent);
    // Claude answers the allowed request in a turn of its own, so its reply is the first row to
    // join after the answer, below the held row.
    const reply = rows.nth(await rows.count());
    await newCard.getByRole('button', { name: 'Allow this time' }).click();
    await expect(newCard.getByText(live ? /^You allowed this\./ : MOCK.allowedLine)).toBeVisible({ timeout: wait.update });
    await expect(newCard.getByRole('button', { name: /^(Allow|Deny)/ })).toHaveCount(0);
    await expectNoAxeViolations(page, 'Today');

    await publicTab.bringToFront();
    const last = heldRow.locator('.cd-margin-receipt').last();
    await expect(last.locator('.cd-status-dot--handled'), 'the held request resolved in the chat').toHaveCount(1, { timeout: wait.update });
    if (!live) await expect(last).toHaveText(MOCK.quoteReceipt);
    await expect(cancel).toHaveCount(0);
    // The reply to the allowed request, with its receipt.
    await expect(reply.locator('.cd-claude-message'), 'Claude replied to the allowed request').toBeVisible({ timeout: wait.reply });
    const replyReceipts = reply.locator('.cd-transcript-row__margin .cd-margin-receipt');
    await expect(replyReceipts.first()).toBeVisible();
    if (!live) {
      await expect(reply.locator('.cd-claude-message__prose')).toHaveText([MOCK.allowedReply]);
      await expect(reply.getByRole('article', { name: 'Quote' })).toContainText(MOCK.allowedPrice);
      await expect(replyReceipts).toHaveText([MOCK.replyReceipt]);
    }
    // Then the reply's turn ends, and the page no longer says "Claude is writing".
    await expect.poll(turnEnds, { message: "the reply's turn ended", timeout: wait.reply }).toBeGreaterThanOrEqual(sent + 1);
    await expect(publicTab.getByText('Claude is writing')).toHaveCount(0, { timeout: wait.update });
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

/** The links under Live now that show, by the conversation each opens; none while it isn't there. */
function liveChats(liveNow: Locator): Promise<string[]> {
  return liveNow.getByRole('link').evaluateAll((links) => links.filter((a) => a.checkVisibility()).map((a) => a.getAttribute('href') ?? ''));
}

/**
 * Counts the turns that have ended in `tab`'s chat, from the `turn_end` events on its event stream,
 * as Chromium's DevTools protocol sees them. The page itself shows no sign of a turn's end: a
 * message clears "Claude is writing", and a visitor's turn can go on after its reply. Only each
 * event's name is read, never its data.
 */
async function countTurnEnds(tab: Page): Promise<() => number> {
  const cdp = await tab.context().newCDPSession(tab);
  let ended = 0;
  cdp.on('Network.eventSourceMessageReceived', ({ eventName }) => {
    if (eventName === 'turn_end') ended += 1;
  });
  await cdp.send('Network.enable');
  return () => ended;
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
