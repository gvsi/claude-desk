/**
 * Where focus goes once the visitor's code works, in a real browser against the mock API. The code
 * form goes and the verified line takes its place, before the released document, which comes in a
 * later message: focus that was in the form moves to that line, so a screen reader keeps its place
 * and the next Tab reaches the document. A line draws no focus edge and raises no phone keyboard.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';

import { coarsePointer } from '../ds/test/touch.ts';
import { DEMO_CODE } from '../mocks/script.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';

/** The chat's line once a demo code works, with the design system's simulated label. */
const VERIFIED = 'Verified with a code. Simulated verification';

/** Dana asks for her invoice, and the chat asks her for the code that confirms it's her. */
async function codeAsked(viewport: Viewport) {
  const view = await renderRoute(`/d/${RIVERA.slug}`, { viewport, strict: true });
  const { screen } = view;
  const box = screen.getByRole('textbox', { name: 'Message Turner Plumbing' });
  await expect.element(box).toBeEnabled();
  await box.fill('Can you send my invoice?');
  await userEvent.keyboard('{Enter}');
  const field = screen.getByRole('textbox', { name: '6-digit code' });
  await expect.element(field).toBeVisible();
  await expect.poll(() => mockStore.visitorSession(RIVERA.slug)?.events.at(-1)?.ev.type).toBe('turn_end');
  await expect.poll(() => document.querySelector('.cd-claude-message--revealing, .cd-claude-message--following')).toBeNull();
  return { screen, box, field, confirm: screen.getByRole('button', { name: 'Confirm' }) };
}

/** The verified line's own element, the one that takes focus. */
function verifiedLine(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.cd-verified-line');
}

it('sends a wrong code only once while Enter is held through the failure', async () => {
  const { field } = await codeAsked('desktop');
  await field.fill('000000');
  const submitted = vi.fn();
  (field.element() as HTMLInputElement).form?.addEventListener('submit', submitted);
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' };
  try {
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
    await expect.element(field).toHaveAttribute('aria-invalid', 'true');
    await expect.element(field).toHaveFocus();
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, autoRepeat: true });
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(mockStore.requests.filter((r) => r.key === 'verifyCheck')).toHaveLength(1);
  } finally {
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
  }
});

it('moves focus from the code field to Start a new chat when the session ends', async () => {
  const { screen, field } = await codeAsked('desktop');
  mockStore.inject({ route: 'verifyCheck', status: 401 });
  await field.fill(DEMO_CODE);
  await userEvent.keyboard('{Enter}');
  await expect.element(field).not.toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Start a new chat' })).toHaveFocus();
});

describe.each(['desktop', 'phone'] as const)('focus once the code works at %s size', (viewport) => {
  it.each(['in the field', 'on Confirm'] as const)('moves keyboard focus to the verified line after Enter %s', async (where) => {
    const { screen, box, field, confirm } = await codeAsked(viewport);
    // At phone size the Demo inbox opens itself over the page with the code; Escape closes it.
    if (viewport === 'phone') {
      await expect.element(screen.getByRole('dialog', { name: 'Demo inbox' })).toBeVisible();
      await userEvent.keyboard('{Escape}');
      await expect.element(screen.getByRole('dialog', { name: 'Demo inbox' })).not.toBeInTheDocument();
    }
    // From the composer, back to the code field by keyboard.
    (box.element() as HTMLElement).focus();
    for (let step = 0; step < 8 && document.activeElement !== field.element(); step += 1) await userEvent.tab({ shift: true });
    await expect.element(field).toHaveFocus();
    await userEvent.keyboard(DEMO_CODE);
    if (where === 'on Confirm') {
      await userEvent.tab();
      await expect.element(confirm).toHaveFocus();
    }
    await userEvent.keyboard('{Enter}');

    // The form goes, and the line in its place has focus: never the page.
    await expect.element(screen.getByText(VERIFIED)).toBeVisible();
    await expect.element(field).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(verifiedLine());
    expect(document.activeElement?.textContent).toBe(VERIFIED);

    // The invoice comes in below the line, and focus stays on the line; the next Tab is its Download.
    const invoice = screen.getByRole('article', { name: 'Document, only for you' });
    await expect.element(invoice).toBeVisible();
    const line = verifiedLine();
    if (!line) throw new Error('the verified line is on the page');
    expect(line.compareDocumentPosition(invoice.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(line);
    await userEvent.tab();
    await expect.poll(() => document.activeElement?.textContent?.trim()).toBe('Download');
    expect(invoice.element().contains(document.activeElement)).toBe(true);
  });
});

it('moves focus to the verified line with no focus edge after a touch', async () => {
  await coarsePointer();
  const { screen, box, field, confirm } = await codeAsked('phone');
  await expect.element(screen.getByRole('dialog', { name: 'Demo inbox' })).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await field.click();
  await field.fill(DEMO_CODE);
  await confirm.click();

  await expect.element(screen.getByText(VERIFIED)).toBeVisible();
  await expect.poll(() => document.activeElement).toBe(verifiedLine());
  // A line, not a field: no phone keyboard comes up, and nothing draws a focus edge around it.
  const line = document.activeElement as HTMLElement;
  expect(line.matches('input, textarea, [contenteditable="true"]')).toBe(false);
  expect(getComputedStyle(line)).toMatchObject({ boxShadow: 'none', outlineStyle: 'none' });
  await expect.element(box).not.toHaveFocus();
});

it('leaves focus where it is when the visitor has moved on before the code works', async () => {
  // She sends the code, then goes on writing in the composer while it is checked: her place there
  // is kept, and the line in the form's place takes nothing.
  const { screen, box, field, confirm } = await codeAsked('desktop');
  const chat = mockStore.visitorSession(RIVERA.slug);
  if (!chat) throw new Error('this browser has a chat');
  // The verify route checks the code at once and holds its answer until the test lets it land.
  let release = () => {};
  const until = new Promise<void>((resolve) => (release = resolve));
  onTestFinished(() => release());
  mockStore.inject({ route: 'verifyCheck', status: 200, afterCommit: true, until, body: { state: { ...chat.state, verified: true, assurance: 'demo_code' } } });
  await field.fill(DEMO_CODE);
  await confirm.click();
  await vi.waitFor(() => expect(mockStore.requests.filter((r) => r.key === 'verifyCheck')).toHaveLength(1));
  await box.click();
  await userEvent.keyboard('Also, ');
  release();
  await expect.element(screen.getByText(VERIFIED)).toBeVisible();
  await expect.element(box).toHaveFocus();
  await expect.element(box).toHaveValue('Also, ');
});
