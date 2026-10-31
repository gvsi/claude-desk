/**
 * The code field under an input method, in a real browser. CJK input methods and some Android
 * keyboards compose text before they commit it, and a composition can't be cancelled the way a
 * typed or pasted insertion can, so a whole code that a composition grows is put back as it was,
 * caret included. The stories cover typing and pasting; Chrome's DevTools protocol drives the
 * composition here, as an input method does.
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
async function wholeCode(caret: number): Promise<HTMLInputElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  root.render(<VerifyCodeForm state="idle" language="en" onSubmit={vi.fn()} onAskForOwner={vi.fn()} />);
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
