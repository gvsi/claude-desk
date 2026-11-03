/**
 * The code field under an input method and a real keyboard, in a real browser. CJK input methods
 * and some Android keyboards compose text before they commit it, and a composition can't be
 * cancelled the way a typed or pasted insertion can, so a whole code that a composition grows is put
 * back as it was, caret included. The stories cover typing and pasting; Chrome's DevTools protocol
 * drives the composition here, as an input method does. Enter is pressed here too: the stories'
 * simulated Enter sends the form without first offering the field the line break a browser does,
 * so it can't catch a field that refuses that line break, and with it the send.
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';

import { VerifyCodeForm } from './VerifyCodeForm.tsx';

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(() => {
  if (!mounted) return;
  const { root, container } = mounted;
  root.unmount();
  container.remove();
  mounted = null;
});

/** The form holding the whole code 482913, typed, with the caret at `caret`. */
async function wholeCode(caret: number, onSubmit: (code: string) => void = vi.fn()): Promise<HTMLInputElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  root.render(<VerifyCodeForm state="idle" language="en" onSubmit={onSubmit} onAskForOwner={vi.fn()} />);
  await expect.poll(() => container.querySelector('input')).not.toBeNull();
  const field = container.querySelector('input') as HTMLInputElement;
  await userEvent.type(field, '482913');
  await expect.poll(() => field.value).toBe('482913');
  field.focus();
  field.setSelectionRange(caret, caret);
  return field;
}

it('composed_digit_keeps_a_whole_code', async () => {
  // An input method composes "7" in the middle of a whole code, then commits it.
  const field = await wholeCode(3);
  await cdp().send('Input.imeSetComposition', { text: '7', selectionStart: 1, selectionEnd: 1 });
  await cdp().send('Input.insertText', { text: '7' });
  await expect.poll(() => [field.value, field.selectionStart, field.selectionEnd]).toEqual(['482913', 3, 3]);
});

it('enter_after_a_whole_code_sends_it', async () => {
  // Enter in the field, the caret after a whole code, sends it once, as Confirm does. The field
  // refuses what is put into a whole code, but Enter's line break is never put in a one-line
  // field, and refusing it would refuse the send with it.
  const onSubmit = vi.fn();
  const field = await wholeCode(6, onSubmit);
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => onSubmit.mock.calls).toEqual([['482913']]);
  expect([field.value, field.selectionStart, field.selectionEnd]).toEqual(['482913', 6, 6]);
});

it.each([
  ['en', 'Enter the 6-digit code'],
  ['es', 'Escribe el código de 6 dígitos'],
] as const)('the_field_asks_for_the_code_in_%s', async (language, placeholder) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  root.render(<VerifyCodeForm state="idle" language={language} onSubmit={vi.fn()} onAskForOwner={vi.fn()} hint="Your code arrives in the Demo inbox." />);
  await expect.poll(() => container.querySelector('input')).not.toBeNull();
  const field = container.querySelector('input') as HTMLInputElement;
  expect(field.placeholder).toBe(placeholder);
  // The line under the field describes it, so a screen reader hears where the code arrives.
  const hint = container.querySelector('.cd-verify-code__hint');
  expect(hint?.textContent).toBe('Your code arrives in the Demo inbox.');
  expect(field.getAttribute('aria-describedby')).toBe(hint?.id);
  expect(field.closest('.cd-verify-code__entry')?.contains(hint ?? null)).toBe(true);
});

it('without_a_hint_no_line_shows', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  root.render(<VerifyCodeForm state="idle" language="en" onSubmit={vi.fn()} onAskForOwner={vi.fn()} />);
  await expect.poll(() => container.querySelector('input')).not.toBeNull();
  expect(container.querySelector('.cd-verify-code__hint')).toBeNull();
  expect(container.querySelector('input')?.hasAttribute('aria-describedby')).toBe(false);
});
