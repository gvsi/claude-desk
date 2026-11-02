/**
 * The Ask Claude panel beside the Rules page, as the signed board draws it (N-Conn-12-Chat), across
 * its breakpoints. Under 1024 px, where the page beside it would be under 360 px wide, it is a modal
 * sheet: whatever the app draws behind it, the sidebar's column or the top bar that replaces it,
 * stays out of reach until the sheet goes or the window widens again. From 640 px it keeps the
 * panel's 400 px, docked at the right over the scrim; under 640 px it is the whole window. The
 * sheet's keyboard walk holds at an upright tablet and at the narrowest phone, 320 px.
 */
import { composeStories } from '@storybook/react-vite';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import * as boards from '../../boards/ConnectorsHub.stories.tsx';
import { chen } from '../../fixtures/index.ts';
import { AppShell } from '../AppShell/AppShell.tsx';
import { AskClaudePanel } from './AskClaudePanel.tsx';
import * as panelStories from './AskClaudePanel.stories.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const { AskClaude } = composeStories(boards);
const { Phone } = composeStories(panelStories);

const DESKTOP = { width: 1512, height: 982 };
const PHONE = { width: 390, height: 844 };
const NARROWEST = { width: 320, height: 700 };
/** An upright tablet, the narrowest window that shows the sidebar's column. */
const TABLET = { width: 768, height: 1024 };
/** The narrowest window with room for the page beside the panel: 264 px of sidebar, 360 px of page, 400 px of panel. */
const BESIDE = 1024;
/** The narrowest the page beside the panel may be. */
const PAGE_MIN = 360;
/** The panel's own width, `size-side-panel`. */
const PANEL = 400;
/** The `scrim` token. */
const SCRIM = 'rgba(0, 0, 0, 0.5)';

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await page.viewport(1280, 820);
});

function panel(): HTMLElement {
  const found = container.querySelector<HTMLElement>('.cd-ask-claude');
  if (!found) throw new Error('No Ask Claude panel');
  return found;
}

/** The page's controls behind the sheet: the top bar's Menu, a connector's link and the page's composer. */
function behind(): HTMLElement[] {
  const controls = [
    container.querySelector<HTMLElement>('.cd-app-shell__menu'),
    container.querySelector<HTMLElement>('.cd-connector-section__header'),
    container.querySelector<HTMLElement>('.board-ask textarea'),
  ];
  if (controls.some((el) => el === null)) throw new Error('A control behind the sheet is missing');
  return controls as HTMLElement[];
}

/** How many lines an element's text takes: the distinct tops of its line boxes. */
function lineCount(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
  return new Set(rects.map((rect) => Math.round(rect.top))).size;
}

/** Nothing scrolls sideways: not the document, and not the page inside the shell. */
function expectNoSidewaysScroll(width: number): void {
  expect(document.documentElement.scrollWidth, `${width} px: the document doesn't scroll sideways`).toBeLessThanOrEqual(width);
  const main = container.querySelector<HTMLElement>('main');
  if (!main) throw new Error('No main');
  expect(main.scrollWidth, `${width} px: the page doesn't scroll sideways`).toBeLessThanOrEqual(main.clientWidth);
}

/**
 * From 640 px to 1023 px: the sheet is the panel's own 400 px, flush with the window's right edge at
 * its full height, and the scrim covers the rest of the window. The scrim is the panel's own
 * backdrop, so any point left of the panel lands on the panel; the page behind is inert.
 */
function expectDockedOverTheScrim(width: number, height: number): void {
  const box = panel().getBoundingClientRect();
  expect([box.left, box.top, box.width, box.height], `${width} px: 400 px, flush right, full height`).toEqual([width - PANEL, 0, PANEL, height]);
  const scrim = getComputedStyle(panel(), '::before');
  expect(scrim.backgroundColor, `${width} px: the scrim`).toBe(SCRIM);
  expect([scrim.position, scrim.top, scrim.left, scrim.bottom, scrim.right], `${width} px: the scrim covers the rest of the window`).toEqual([
    'fixed',
    '0px',
    '0px',
    '0px',
    `${PANEL}px`,
  ]);
  for (const [x, y] of [
    [1, 1],
    [width - PANEL - 1, height / 2],
    [1, height - 1],
  ] as const) {
    expect(document.elementFromPoint(x, y), `${width} px: the scrim at ${x}, ${y}`).toBe(panel());
  }
}

/** No scrim: beside the page, and as the phone's whole-window sheet. */
function expectNoScrim(width: number): void {
  expect(getComputedStyle(panel(), '::before').content, `${width} px: no scrim`).toBe('none');
}

/** The sheet is modal: nothing behind it takes focus, by Tab or from a script, and Tab stays in it. */
async function expectModal(controls: HTMLElement[] = behind()): Promise<void> {
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  expect(panel().getAttribute('aria-modal')).toBe('true');
  expect(panel().contains(document.activeElement), 'focus is in the sheet').toBe(true);
  for (const control of controls) {
    control.focus();
    expect(document.activeElement, `${control.className} can't take focus`).not.toBe(control);
  }
  panel().querySelector<HTMLElement>('textarea')?.focus();
  for (let i = 0; i < 6; i += 1) {
    await userEvent.keyboard('{Tab}');
    expect(panel().contains(document.activeElement), `Tab ${i + 1} stays in the sheet`).toBe(true);
  }
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(panel().contains(document.activeElement), 'Shift+Tab stays in the sheet').toBe(true);
}

it('ask_claude_sheet_keeps_the_page_inert_across_the_breakpoint', async () => {
  await page.viewport(DESKTOP.width, DESKTOP.height);
  act(() => root.render(<AskClaude />));
  // Beside the page on a laptop: a complementary panel, and the page is live.
  expect(panel().getAttribute('role')).toBe('complementary');
  expect(container.querySelector('[inert]')).toBeNull();

  // Down to a phone: the top bar replaces the sidebar behind the sheet, and stays out of reach. Under
  // 640 px the sheet is the whole window, with no scrim.
  await page.viewport(PHONE.width, PHONE.height);
  await vi.waitFor(() => expect(container.querySelector('.cd-app-shell__menu')).not.toBeNull());
  await expectModal();
  const phone = panel().getBoundingClientRect();
  expect([phone.left, phone.top, phone.width, phone.height], 'the whole window').toEqual([0, 0, PHONE.width, PHONE.height]);
  expectNoScrim(PHONE.width);

  // And to the narrowest phone.
  await page.viewport(NARROWEST.width, NARROWEST.height);
  await expectModal();
  expectNoScrim(NARROWEST.width);
});

it('leaving_the_phone_lifts_the_inert_page', async () => {
  await page.viewport(PHONE.width, PHONE.height);
  act(() => root.render(<AskClaude />));
  await expectModal();

  // Up to a laptop with the panel still open: it is a panel beside the page again, and the page is live.
  await page.viewport(DESKTOP.width, DESKTOP.height);
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('complementary'));
  expect(panel().hasAttribute('aria-modal')).toBe(false);
  expect(container.querySelector('[inert]')).toBeNull();
  const today = container.querySelector<HTMLElement>('.cd-sidebar a');
  const connector = container.querySelector<HTMLElement>('.cd-connector-section__header');
  for (const control of [today, connector]) {
    control?.focus();
    expect(document.activeElement, `${control?.textContent ?? ''} takes focus again`).toBe(control);
  }
});

it('ask_claude_is_a_sheet_while_the_page_beside_it_would_be_under_360_px', async () => {
  // At an upright tablet the sidebar's column (264 px) and the panel (400 px) would leave the page
  // 104 px; just under 1024 px, 359 px. Both get the sheet, docked at the right over the scrim. At
  // 1024 px the page has its 360 px.
  await page.viewport(TABLET.width, TABLET.height);
  act(() => root.render(<AskClaude />));
  const widths = [
    { width: TABLET.width, role: 'dialog' },
    { width: BESIDE - 1, role: 'dialog' },
    { width: BESIDE, role: 'complementary' },
  ] as const;
  for (const { width, role } of widths) {
    await page.viewport(width, TABLET.height);
    await vi.waitFor(() => expect(panel().getAttribute('role'), `${width} px`).toBe(role));
    // The sidebar's column shows at every one of these widths.
    expect(container.querySelector('.cd-app-shell__column'), `${width} px: the sidebar's column`).not.toBeNull();
    const main = container.querySelector<HTMLElement>('main');
    if (!main) throw new Error('No main');
    if (role === 'dialog') {
      // A modal sheet, 400 px at the right over the scrim, focus inside, and the shell behind it inert.
      expect(panel().getAttribute('aria-modal'), `${width} px`).toBe('true');
      expectDockedOverTheScrim(width, TABLET.height);
      expect(panel().contains(document.activeElement), `${width} px: focus is in the sheet`).toBe(true);
      expect(main.closest('[inert]'), `${width} px: the page is inert`).not.toBeNull();
      expect(container.querySelector('.cd-app-shell__column')?.closest('[inert]'), `${width} px: the sidebar is inert`).not.toBeNull();
    } else {
      // Beside the page, which keeps its 360 px, and nothing is inert.
      expect(panel().hasAttribute('aria-modal'), `${width} px`).toBe(false);
      expect(panel().getBoundingClientRect().width, `${width} px: the panel`).toBe(PANEL);
      expect(main.getBoundingClientRect().width, `${width} px: the page beside it`).toBeGreaterThanOrEqual(PAGE_MIN);
      expectNoScrim(width);
      expect(container.querySelector('[inert]'), `${width} px: nothing is inert`).toBeNull();
    }
    expectNoSidewaysScroll(width);
    const title = container.querySelector('h1');
    if (!title) throw new Error('No title');
    expect(title.textContent).toBe('Rules');
    expect(lineCount(title), `${width} px: the title on one line`).toBe(1);
  }
});

it('crossing_1024_px_keeps_the_draft', async () => {
  // The same element at every width, so the composer's draft survives the breakpoint both ways.
  await page.viewport(BESIDE, TABLET.height);
  act(() => root.render(<AskClaude />));
  expect(panel().getAttribute('role')).toBe('complementary');
  const box = panel().querySelector<HTMLTextAreaElement>('textarea');
  if (!box) throw new Error('No composer');
  await act(async () => {
    await userEvent.type(box, 'Turn off Payments');
  });
  expect(box.value).toBe('Turn off Payments');
  await page.viewport(BESIDE - 1, TABLET.height);
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  expect(panel().querySelector('textarea'), 'the same composer').toBe(box);
  expect(box.value).toBe('Turn off Payments');
  await page.viewport(BESIDE, TABLET.height);
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('complementary'));
  expect(panel().querySelector('textarea'), 'the same composer').toBe(box);
  expect(box.value).toBe('Turn off Payments');

  // And across the sheet's own breakpoint: docked over the scrim at 768, the whole window at 639,
  // docked again at 640. The same composer keeps the draft and the focus all the way.
  for (const { width, docked } of [
    { width: TABLET.width, docked: true },
    { width: 639, docked: false },
    { width: 640, docked: true },
  ]) {
    await page.viewport(width, TABLET.height);
    await vi.waitFor(() => expect(window.innerWidth).toBe(width));
    await vi.waitFor(() => expect(panel().getAttribute('role'), `${width} px`).toBe('dialog'));
    expect(panel().querySelector('textarea'), `${width} px: the same composer`).toBe(box);
    expect(box.value, `${width} px: the draft`).toBe('Turn off Payments');
    expect(document.activeElement, `${width} px: focus stays on the composer`).toBe(box);
    if (docked) {
      expectDockedOverTheScrim(width, TABLET.height);
    } else {
      const whole = panel().getBoundingClientRect();
      expect([whole.left, whole.top, whole.width, whole.height], `${width} px: the whole window`).toEqual([0, 0, width, TABLET.height]);
      expectNoScrim(width);
    }
    expectNoSidewaysScroll(width);
  }
});

it('docked_over_the_scrim_with_the_top_bar', async () => {
  // At 700 px the top bar replaces the sidebar's column, and the sheet is still the panel's 400 px
  // at the window's right edge, over the scrim, with everything behind it out of reach.
  await page.viewport(700, TABLET.height);
  act(() => root.render(<AskClaude />));
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  expect(container.querySelector('.cd-app-shell__menu'), 'the top bar').not.toBeNull();
  expect(container.querySelector('.cd-app-shell__column'), 'no sidebar column').toBeNull();
  expectDockedOverTheScrim(700, TABLET.height);
  expectNoSidewaysScroll(700);
  await expectModal();
});

/** Open the sheet from the page, walk it from the keyboard, close it with Escape: focus returns to the opener. */
async function walkTheSheet(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  act(() => root.render(<Phone />));
  const opener = page.getByRole('button', { name: 'Ask Claude to change a rule' });
  await userEvent.click(opener);
  // Focus moves into the sheet, to its composer, and the walk stays inside it.
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  expect(document.activeElement).toBe(panel().querySelector('textarea'));
  for (let i = 0; i < 6; i += 1) {
    await userEvent.keyboard('{Tab}');
    expect(panel().contains(document.activeElement), `Tab ${i + 1} stays in the sheet`).toBe(true);
  }
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(panel().contains(document.activeElement)).toBe(true);
  // The controls behind: Menu or the sidebar's link, whichever the shell draws, and the page's link.
  const behindControls = container.querySelectorAll<HTMLElement>('.cd-app-shell__menu, .cd-app-shell__column a, a[href="#quotes"]');
  expect(behindControls.length, 'the navigation and the page each have a control behind the sheet').toBe(2);
  for (const control of behindControls) {
    control.focus();
    expect(document.activeElement).not.toBe(control);
  }
  // Escape closes it, focus returns to what opened it, and nothing is left inert.
  await userEvent.keyboard('{Escape}');
  await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude')).toBeNull());
  expect(document.activeElement).toBe(opener.element());
  expect(container.querySelector('[inert]')).toBeNull();
}

it('ask_claude_sheet_keyboard_walk_at_a_tablet', async () => {
  await walkTheSheet(TABLET.width, TABLET.height);
});

it('ask_claude_sheet_keyboard_walk_at_320', async () => {
  await walkTheSheet(NARROWEST.width, NARROWEST.height);
});

it('a_click_on_text_in_the_sheet_keeps_focus_in_it', async () => {
  // Text that can't take focus (the heading, the conversation) hands a press to the sheet itself, so
  // focus never falls to the page: Shift+Tab wraps to the sheet's last control, and Escape closes it
  // and returns focus to what opened it. On a tablet's docked sheet and on a phone's.
  for (const { width, height } of [TABLET, PHONE]) {
    await page.viewport(width, height);
    act(() => root.render(<Phone />));
    const opener = page.getByRole('button', { name: 'Ask Claude to change a rule' });
    await userEvent.click(opener);
    await vi.waitFor(() => expect(panel().getAttribute('role'), `${width} px`).toBe('dialog'));
    const heading = panel().querySelector<HTMLElement>('h2');
    if (!heading) throw new Error('No heading');

    await userEvent.click(heading);
    expect(panel().contains(document.activeElement), `${width} px: focus stays in the sheet`).toBe(true);
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    const controls = [...panel().querySelectorAll<HTMLElement>('button:not([disabled]), textarea')];
    expect(document.activeElement, `${width} px: Shift+Tab wraps to the last control`).toBe(controls[controls.length - 1]);

    await userEvent.click(heading);
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude'), `${width} px: Escape closes it`).toBeNull());
    expect(document.activeElement, `${width} px: focus returns to the opener`).toBe(opener.element());
    expect(container.querySelector('[inert]')).toBeNull();
    act(() => root.render(<div />));
  }
});

it('a_click_on_the_composers_empty_row_in_the_sheet_focuses_its_text', async () => {
  // The sheet takes focus itself (tabIndex -1), yet the composer's empty row still hands a click to
  // its text box, with the caret at the end.
  await page.viewport(PHONE.width, PHONE.height);
  act(() => root.render(<Phone />));
  await userEvent.click(page.getByRole('button', { name: 'Ask Claude to change a rule' }));
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  const box = panel().querySelector<HTMLTextAreaElement>('.cd-ask-claude__composer textarea');
  const tools = panel().querySelector<HTMLElement>('.cd-ask-claude__composer .cd-composer__tools');
  if (!box || !tools) throw new Error('No composer in the sheet');
  await userEvent.click(box);
  await userEvent.keyboard('Weekends too');
  await userEvent.click(panel().querySelector<HTMLElement>('h2')!);
  expect(document.activeElement).not.toBe(box);
  await userEvent.click(tools);
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe('Weekends too'.length);
});

it('a_click_on_the_scrim_keeps_the_sheet_and_its_focus', async () => {
  // Closing on a scrim click would throw away a half-written question, so the click changes
  // nothing: the sheet stays open, focus stays on the composer, and Escape still closes it.
  await page.viewport(TABLET.width, TABLET.height);
  act(() => root.render(<Phone />));
  const opener = page.getByRole('button', { name: 'Ask Claude to change a rule' });
  await userEvent.click(opener);
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  const composer = panel().querySelector('textarea');
  if (!composer) throw new Error('No composer');
  expect(document.activeElement).toBe(composer);
  await act(async () => {
    await userEvent.type(composer, 'Can verified clients book');
  });

  // A point left of the panel is the scrim, the sheet's own backdrop. The click lands there as a
  // person's would, wherever the point is.
  const [x, y] = [10, TABLET.height / 2];
  expect(document.elementFromPoint(x, y), 'the point is the scrim').toBe(panel());
  await userEvent.click(document.documentElement, { position: { x, y }, force: true });
  expect(panel().getAttribute('role'), 'the sheet stays open').toBe('dialog');
  expect(document.activeElement, 'focus stays on the composer').toBe(composer);
  expect(composer.value, 'the half-written question is kept').toBe('Can verified clients book');

  await userEvent.keyboard('{Escape}');
  await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude')).toBeNull());
  expect(document.activeElement).toBe(opener.element());
  expect(container.querySelector('[inert]')).toBeNull();
});

it('standalone_sheet_keeps_focus_inside', async () => {
  // Without AppShell nothing makes the page inert, so the sheet itself keeps focus: a script's
  // focus on a control behind it, and the Tab after it, both stay in the sheet.
  await page.viewport(PHONE.width, PHONE.height);
  act(() =>
    root.render(
      <div>
        <button type="button">Behind the sheet</button>
        <a href="#behind">Another control behind</a>
        <AskClaudePanel onClose={() => {}} onSend={() => {}}>
          <p>Conversation</p>
        </AskClaudePanel>
      </div>,
    ),
  );
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  expect(panel().contains(document.activeElement)).toBe(true);
  const behindButton = container.querySelector<HTMLElement>('button');
  behindButton?.focus();
  expect(panel().contains(document.activeElement), 'a script cannot move focus behind the sheet').toBe(true);
  for (let i = 0; i < 4; i += 1) {
    await userEvent.keyboard('{Tab}');
    expect(panel().contains(document.activeElement), `Tab ${i + 1} stays in the sheet`).toBe(true);
  }
  container.querySelector<HTMLElement>('a')?.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(panel().contains(document.activeElement)).toBe(true);
});

/**
 * A shell that always shows the top bar (`layout="compact"`), so Menu shows while the window is wide
 * enough for the panel beside the page.
 */
function CompactScreen() {
  return (
    <AppShell
      layout="compact"
      business={chen.business.name}
      sidebar={
        <nav aria-label="Main">
          <a href="#rules">Rules</a>
        </nav>
      }
      panel={
        <AskClaudePanel onClose={() => {}} onSend={() => {}}>
          <p>Conversation</p>
        </AskClaudePanel>
      }
    >
      <h1>Rules</h1>
      <p>
        <a href="#quotes">Quotes</a>
      </p>
    </AppShell>
  );
}

it('open_menu_closes_when_the_panel_becomes_a_sheet', async () => {
  // A compact shell with the panel beside the page: the navigation sheet is open. Narrowing under
  // 1024 px makes the panel a modal sheet, so the navigation sheet closes and focus moves into the panel.
  await page.viewport(BESIDE + 76, 900);
  act(() => root.render(<CompactScreen />));
  expect(panel().getAttribute('role')).toBe('complementary');
  await userEvent.click(page.getByRole('button', { name: 'Menu' }));
  await vi.waitFor(() => expect(container.querySelector('dialog.cd-app-shell__sheet[open]')).not.toBeNull());

  await page.viewport(BESIDE - 24, 900);
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  await vi.waitFor(() => expect(container.querySelector('dialog.cd-app-shell__sheet[open]')).toBeNull());
  expect(panel().contains(document.activeElement), 'focus moved into the panel').toBe(true);
  const menu = container.querySelector<HTMLElement>('.cd-app-shell__menu');
  const quotes = container.querySelector<HTMLElement>('a[href="#quotes"]');
  if (!menu || !quotes) throw new Error('A control behind the sheet is missing');
  await expectModal([menu, quotes]);
});

/**
 * The Rules page as Safari has it: a click doesn't focus the button it presses, so when the panel
 * opens, focus is on the page's body, not on the opener. `opened` records where it was.
 */
function SafariScreen({ shell, opened }: { shell: boolean; opened: { focus: Element | null } }) {
  const [open, setOpen] = useState(false);
  const panel = open ? (
    <AskClaudePanel onClose={() => setOpen(false)} onSend={() => {}}>
      <p>Conversation</p>
    </AskClaudePanel>
  ) : null;
  const opener = (
    <button
      type="button"
      // What Safari does: the press moves no focus to the button.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        opened.focus = document.activeElement;
        setOpen(true);
      }}
    >
      Ask Claude to change a rule
    </button>
  );
  if (!shell) {
    return (
      <div>
        <h1>Rules</h1>
        {opener}
        {panel}
      </div>
    );
  }
  return (
    <AppShell
      business={chen.business.name}
      sidebar={
        <nav aria-label="Main">
          <a href="#rules">Rules</a>
        </nav>
      }
      panel={panel}
    >
      <h1>Rules</h1>
      {opener}
    </AppShell>
  );
}

it('focus_returns_to_an_opener_the_click_did_not_focus', async () => {
  // Opened by a click that left focus on the page's body, as Safari's does, the sheet still returns
  // focus to the button that opened it, whether Escape or Close shuts it, in the shell on a phone
  // and a tablet, and on its own.
  const cases = [
    { size: PHONE, shell: true, close: 'Escape' },
    { size: TABLET, shell: true, close: 'Close' },
    { size: PHONE, shell: false, close: 'Escape' },
  ] as const;
  for (const { size, shell, close } of cases) {
    const label = `${size.width} px, ${shell ? 'in the shell' : 'on its own'}, ${close}`;
    await page.viewport(size.width, size.height);
    const opened: { focus: Element | null } = { focus: null };
    act(() => root.render(<SafariScreen shell={shell} opened={opened} />));
    (document.activeElement as HTMLElement | null)?.blur();
    const opener = page.getByRole('button', { name: 'Ask Claude to change a rule' });
    await userEvent.click(opener);
    expect(opened.focus, `${label}: the click left focus on the body`).toBe(document.body);
    await vi.waitFor(() => expect(panel().getAttribute('role'), label).toBe('dialog'));
    expect(panel().contains(document.activeElement), `${label}: focus moved into the sheet`).toBe(true);

    if (close === 'Escape') await userEvent.keyboard('{Escape}');
    else await userEvent.click(page.getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude'), `${label}: closed`).toBeNull());
    expect(document.activeElement, `${label}: focus returns to the opener`).toBe(opener.element());
    expect(container.querySelector('[inert]'), label).toBeNull();
    act(() => root.render(<div />));
  }
});
