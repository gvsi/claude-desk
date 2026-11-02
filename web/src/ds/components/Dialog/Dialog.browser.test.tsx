/**
 * Under React's StrictMode the dialog's effect runs, is cleaned up and runs again on mount, which
 * closes and reopens the native dialog. That close is not the browser closing it: the dialog must
 * stay open without calling onCancel, and a real close by the browser afterwards must still reach
 * the screen.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { Dialog } from './Dialog.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

it('strict_mode_remount_is_not_a_browser_close', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onCancel = vi.fn();
  act(() =>
    root.render(
      <StrictMode>
        <Dialog title="Delete Turner Plumbing's Emergencies?" body="Its public link stops working." confirmLabel="Delete Desk" cancelLabel="Keep it" onConfirm={() => {}} onCancel={onCancel} />
      </StrictMode>,
    ),
  );
  await act(nextTask);
  const dialog = container.querySelector('dialog');
  expect(dialog?.open).toBe(true);
  expect(onCancel).not.toHaveBeenCalled();

  dialog?.close();
  await act(nextTask);
  expect(onCancel).toHaveBeenCalledTimes(1);

  act(() => root.unmount());
  await nextTask();
  expect(onCancel).toHaveBeenCalledTimes(1);
  container.remove();
});
