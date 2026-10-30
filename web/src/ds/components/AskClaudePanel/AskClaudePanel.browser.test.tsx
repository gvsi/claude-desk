/**
 * The Ask Claude panel beside the Rules page, as the signed board draws it (N-Conn-12-Chat), across
 * the phone breakpoint. Under 640 px it is a modal sheet: whatever the app draws behind it, the
 * top bar that replaces the sidebar included, stays out of reach until the sheet goes or the window
 * widens again. And the sheet's keyboard walk holds at the narrowest phone, 320 px.
 */
import { composeStories } from '@storybook/react-vite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import * as boards from '../../boards/ConnectorsHub.stories.tsx';
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

/** The page's controls behind the sheet: the top bar's Menu, "Add a connector" and the page's composer. */
function behind(): HTMLElement[] {
  const controls = [
    container.querySelector<HTMLElement>('.cd-app-shell__menu'),
    container.querySelector<HTMLElement>('.cd-page-header button'),
    container.querySelector<HTMLElement>('.board-ask textarea'),
  ];
  if (controls.some((el) => el === null)) throw new Error('A control behind the sheet is missing');
  return controls as HTMLElement[];
}

/** The sheet is modal: nothing behind it takes focus, by Tab or from a script, and Tab stays in it. */
async function expectModal(): Promise<void> {
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  expect(panel().getAttribute('aria-modal')).toBe('true');
  expect(panel().contains(document.activeElement), 'focus is in the sheet').toBe(true);
  for (const control of behind()) {
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

  // Down to a phone: the top bar replaces the sidebar behind the sheet, and stays out of reach.
  await page.viewport(PHONE.width, PHONE.height);
  await vi.waitFor(() => expect(container.querySelector('.cd-app-shell__menu')).not.toBeNull());
  await expectModal();

  // And to the narrowest phone.
  await page.viewport(NARROWEST.width, NARROWEST.height);
  await expectModal();
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
  const add = container.querySelector<HTMLElement>('.cd-page-header button');
  for (const control of [today, add]) {
    control?.focus();
    expect(document.activeElement, `${control?.textContent ?? ''} takes focus again`).toBe(control);
  }
});

it('ask_claude_sheet_keyboard_walk_at_320', async () => {
  await page.viewport(NARROWEST.width, NARROWEST.height);
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
  for (const control of container.querySelectorAll<HTMLElement>('.cd-app-shell__menu, a[href="#quotes"]')) {
    control.focus();
    expect(document.activeElement).not.toBe(control);
  }
  // Escape closes it, focus returns to what opened it, and nothing is left inert.
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

it('open_menu_closes_when_the_panel_becomes_a_sheet', async () => {
  // A compact screen with the panel beside the page: the navigation sheet is open. Narrowing to a
  // phone makes the panel a modal sheet, so the navigation sheet closes and focus moves into the panel.
  await page.viewport(700, 900);
  act(() => root.render(<AskClaude />));
  expect(panel().getAttribute('role')).toBe('complementary');
  await userEvent.click(page.getByRole('button', { name: 'Menu' }));
  await vi.waitFor(() => expect(container.querySelector('dialog.cd-app-shell__sheet[open]')).not.toBeNull());

  await page.viewport(PHONE.width, PHONE.height);
  await vi.waitFor(() => expect(panel().getAttribute('role')).toBe('dialog'));
  await vi.waitFor(() => expect(container.querySelector('dialog.cd-app-shell__sheet[open]')).toBeNull());
  expect(panel().contains(document.activeElement), 'focus moved into the panel').toBe(true);
  for (const link of container.querySelectorAll<HTMLElement>('.cd-sidebar a, .cd-app-shell__menu')) {
    link.focus();
    expect(document.activeElement, `${link.textContent ?? ''} can't take focus`).not.toBe(link);
  }
  await expectModal();
});
