/**
 * AppShell switches between the sidebar column and the compact top bar as the window crosses
 * 768 px. The page inside must survive the switch: resizing a window or turning a phone keeps an
 * unsent draft and every other bit of page state.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

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
