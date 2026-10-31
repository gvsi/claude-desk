/**
 * AppShell switches between the sidebar column and the compact top bar as the window crosses
 * 768 px. The page inside must survive the switch: resizing a window or turning a phone keeps an
 * unsent draft and every other bit of page state.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { AskClaudePanel } from '../AskClaudePanel/AskClaudePanel.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { Sidebar, type SidebarHrefs } from '../Sidebar/Sidebar.tsx';
import { AppShell } from './AppShell.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const WIDE = { width: 1280, height: 820 };
const NARROW = { width: 600, height: 820 };

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await page.viewport(WIDE.width, WIDE.height);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await page.viewport(WIDE.width, WIDE.height);
});

function isCompact(): boolean {
  return container.querySelector('.cd-app-shell--compact') !== null;
}

it('fill_never_changes_the_sidebar', () => {
  // The sidebar looks the same on every page: the panel, its seam, the window's height. `fill`
  // sets only the main area, so moving between a padded page and a filled one leaves it as it is.
  const shell = (fill: boolean) => (
    <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Rivera Plumbing" fill={fill}>
      <p>Page</p>
    </AppShell>
  );
  const column = () => container.querySelector('.cd-app-shell__column') as HTMLElement;
  const main = () => container.querySelector('main') as HTMLElement;
  const look = () => {
    const style = getComputedStyle(column());
    return { ground: style.backgroundColor, seam: style.borderRightWidth, align: style.alignItems };
  };
  const PANEL = { ground: 'rgb(34, 34, 32)', seam: '1px', align: 'normal' };

  act(() => root.render(shell(false)));
  expect(look()).toEqual(PANEL);
  expect(getComputedStyle(main()).paddingLeft).toBe('40px');
  act(() => root.render(shell(true)));
  expect(getComputedStyle(main()).paddingLeft).toBe('0px');
  expect(look()).toEqual(PANEL);
});

it('page_state_survives_the_breakpoint', async () => {
  act(() =>
    root.render(
      <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Rivera Plumbing">
        <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude. Dana won't see it." onSend={() => {}} />
      </AppShell>,
    ),
  );
  expect(isCompact()).toBe(false);

  const box = page.getByRole('textbox', { name: 'Whisper to Claude' });
  await userEvent.type(box, 'Keep this draft');
  const textarea = box.element() as HTMLTextAreaElement;
  expect(textarea.value).toBe('Keep this draft');

  // Narrower than 768 px: the top bar replaces the column, and the draft is the same text box.
  await page.viewport(NARROW.width, NARROW.height);
  await vi.waitFor(() => expect(isCompact()).toBe(true));
  expect(page.getByRole('button', { name: 'Menu' }).element()).toBeTruthy();
  expect(box.element()).toBe(textarea);
  expect(textarea.isConnected).toBe(true);
  expect(textarea.value).toBe('Keep this draft');

  // And back: the column returns, and the draft is still there.
  await page.viewport(WIDE.width, WIDE.height);
  await vi.waitFor(() => expect(isCompact()).toBe(false));
  expect(box.element()).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft');
});

it('long_pages_scroll_inside_the_shell', async () => {
  // The shell is the window's height and its main area scrolls. A long page, with the
  // screen-reader-only labels receipts carry, must not stretch the document behind it: the page
  // itself never scrolls, on a laptop or a phone, padded or filled.
  const longPage = (
    <div>
      {Array.from({ length: 80 }, (_, index) => (
        <p key={index}>
          Message {index + 1}
          <span className="cd-sr-only">Reply checked before the visitor saw it.</span>
        </p>
      ))}
    </div>
  );
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.viewport(width, height);
    for (const fill of [false, true]) {
      act(() =>
        root.render(
          <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Rivera Plumbing" fill={fill}>
            {longPage}
          </AppShell>,
        ),
      );
      const main = container.querySelector('main') as HTMLElement;
      // The page is longer than the window, so the main area scrolls...
      await vi.waitFor(() => expect(main.scrollHeight).toBeGreaterThan(main.clientHeight));
      // ...and the document doesn't.
      expect([width, fill, document.documentElement.scrollHeight]).toEqual([width, fill, height]);
    }
  }
});

it('long_sidebars_and_panels_scroll_inside_the_shell', async () => {
  // The shell's other scroll regions hold their own long content the same way: a sidebar taller
  // than a short window, and the Ask Claude panel's conversation beside the page.
  const longList = (
    <div>
      {Array.from({ length: 80 }, (_, index) => (
        <p key={index}>
          Line {index + 1}
          <span className="cd-sr-only">Checked before it was shown.</span>
        </p>
      ))}
    </div>
  );
  const noop = () => {};
  await page.viewport(1440, 400);
  act(() =>
    root.render(
      <AppShell sidebar={longList} business="Rivera Plumbing">
        <p>Page</p>
      </AppShell>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('.cd-app-shell__column')!.scrollHeight).toBeGreaterThan(400));
  expect(['sidebar', document.documentElement.scrollHeight]).toEqual(['sidebar', 400]);

  await page.viewport(1440, 900);
  act(() =>
    root.render(
      <AppShell
        sidebar={<nav aria-label="Main">Today</nav>}
        business="Rivera Plumbing"
        panel={
          <AskClaudePanel onClose={noop} onSend={noop}>
            {longList}
          </AskClaudePanel>
        }
      >
        <p>Page</p>
      </AppShell>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude__log')!.scrollHeight).toBeGreaterThan(900));
  expect(['panel', document.documentElement.scrollHeight]).toEqual(['panel', 900]);
});

/** A business name too long for one line of the business row, at a phone's width and a laptop's. */
const LONG_NAME = 'Bayview Heating, Plumbing & Drain Services of Greater Oakland';
/** A name of the API's 80 characters: three lines of the phone menu's business row. */
const API_LONGEST_NAME = 'Bayview Heating, Plumbing & Drain Services of Greater Oakland, Alameda, Richmond';
/** Names that run past three lines of the phone menu's business row: words, and one unbroken run. */
const OVER_LONG_NAMES = [
  'Bayview Heating, Plumbing & Drain Services of Greater Oakland, Alameda, Berkeley, Richmond and Walnut Creek',
  'BayviewHeatingPlumbingDrainServicesOfGreaterOaklandAlamedaBerkeleyRichmondWalnutCreek',
];

const HREFS = Object.fromEntries(
  (['today', 'conversations', 'people', 'rules', 'safety', 'share', 'settings'] as const).map((key) => [key, `#${key}`]),
) as SidebarHrefs;

/** The owner app's frame for `business`, its sidebar the real one. */
function shellFor(business: string) {
  const noop = () => {};
  return (
    <AppShell
      business={business}
      sidebar={
        <Sidebar
          business={business}
          onSwitchBusiness={noop}
          desks={[{ id: 'desk-main', name: 'Main line' }]}
          currentDeskId="desk-main"
          onSwitchDesk={noop}
          current="today"
          hrefs={HREFS}
          peopleLabel="Customers"
          answering
          onAnsweringChange={noop}
          owner={{ name: 'Sam Ortiz', status: 'Available for chats' }}
        />
      }
    >
      <p>Page</p>
    </AppShell>
  );
}

/** How many lines `el`'s text takes, hidden ones included: its text's boxes, one row per distinct top. */
function linesOf(el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}

/** Opens the compact top bar's menu, the phone menu, inside act(), so its sheet is drawn before anything reads it. */
function openMenu(): void {
  const menu = [...container.querySelectorAll<HTMLButtonElement>('.cd-app-shell__menu')][0];
  if (!menu) throw new Error('no Menu button in the top bar');
  act(() => menu.click());
}

/** The business row a sidebar draws in `scope`, by its name for screen readers, and the name it shows. */
function businessRow(scope: Element, business: string): { row: HTMLElement; name: HTMLElement; caret: Element } {
  const row = [...scope.querySelectorAll<HTMLElement>('button')].find((button) => button.getAttribute('aria-label') === `Switch business, current: ${business}`);
  const name = row?.querySelector<HTMLElement>('[data-copy="user"]');
  const caret = row?.querySelector('svg');
  if (!row || !name || !caret) throw new Error(`no business row for ${business}`);
  return { row, name, caret };
}

it('phone_menu_business_row_wraps_to_three_lines', async () => {
  // On a phone the menu's business row wraps onto up to three lines, so a long name reads in full
  // on touch; the top bar above the page keeps its one line, cut with an ellipsis, its title
  // holding the whole name.
  await page.viewport(390, 844);
  for (const [business, lines] of [
    [LONG_NAME, 3],
    [API_LONGEST_NAME, 3],
    ['Rivera Plumbing', 1],
  ] as const) {
    act(() => root.render(shellFor(business)));
    await vi.waitFor(() => expect(isCompact()).toBe(true));
    const header = container.querySelector<HTMLElement>('.cd-app-shell__topbar [data-copy="user"]');
    if (!header) throw new Error('the top bar shows no business');
    expect([business, linesOf(header), header.title]).toEqual([business, 1, business]);
    if (business === LONG_NAME) expect(header.scrollWidth).toBeGreaterThan(header.clientWidth);

    openMenu();
    const { row, name, caret } = businessRow(page.getByRole('dialog', { name: 'Menu' }).element(), business);
    const lineHeight = parseFloat(getComputedStyle(name).lineHeight);
    // The whole name, nothing cut, and its title kept.
    expect([business, linesOf(name)]).toEqual([business, lines]);
    expect(name.clientHeight, business).toBe(lines * lineHeight);
    expect(name.scrollHeight, business).toBeLessThanOrEqual(name.clientHeight);
    expect(name.scrollWidth, business).toBeLessThanOrEqual(name.clientWidth);
    expect(name.title, business).toBe(business);
    // A touch target of at least 44 px, the caret on the middle of the first line.
    expect(row.getBoundingClientRect().height, business).toBeGreaterThanOrEqual(44);
    const caretBox = caret.getBoundingClientRect();
    const firstLineMiddle = name.getBoundingClientRect().top + lineHeight / 2;
    expect(Math.abs((caretBox.top + caretBox.bottom) / 2 - firstLineMiddle), business).toBeLessThanOrEqual(1);
    expect(document.documentElement.scrollWidth, business).toBeLessThanOrEqual(390);
  }
});

it('phone_menu_business_row_clamps_a_longer_name_at_three_lines', async () => {
  await page.viewport(390, 844);
  for (const business of OVER_LONG_NAMES) {
    act(() => root.render(shellFor(business)));
    await vi.waitFor(() => expect(isCompact()).toBe(true));
    openMenu();
    const { row, name } = businessRow(page.getByRole('dialog', { name: 'Menu' }).element(), business);
    const lineHeight = parseFloat(getComputedStyle(name).lineHeight);
    // Three lines show, the third ending with an ellipsis; the rest is cut, and the title holds it all.
    expect(linesOf(name), business).toBeGreaterThan(3);
    expect(name.clientHeight, business).toBe(3 * lineHeight);
    expect(name.scrollHeight, business).toBeGreaterThan(name.clientHeight);
    expect(name.scrollWidth, business).toBeLessThanOrEqual(name.clientWidth);
    expect(getComputedStyle(name).textOverflow, business).toBe('ellipsis');
    expect(name.title, business).toBe(business);
    expect(row.getBoundingClientRect().height, business).toBe(3 * lineHeight + 24);
    expect(document.documentElement.scrollWidth, business).toBeLessThanOrEqual(390);
  }
});

it('desktop_sidebar_business_row_keeps_one_line', async () => {
  // The column at a laptop's width is as it was: one 36 px line, the name cut with an ellipsis.
  await page.viewport(1440, 900);
  act(() => root.render(shellFor(LONG_NAME)));
  const column = container.querySelector<HTMLElement>('.cd-app-shell__column');
  if (!column) throw new Error('no sidebar column at 1440');
  const { row, name } = businessRow(column, LONG_NAME);
  expect(row.getBoundingClientRect().height).toBe(36);
  expect(linesOf(name)).toBe(1);
  expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
  expect(getComputedStyle(name).textOverflow).toBe('ellipsis');
  expect(name.title).toBe(LONG_NAME);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
});
