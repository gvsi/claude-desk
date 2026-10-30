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
