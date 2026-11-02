import { useCallback, useLayoutEffect, useRef } from 'react';

/** A focused retry that leaves hands its place to the recovered section's heading. */
export function useReadRecoveryFocus(heading: () => HTMLElement | null) {
  const button = useRef<HTMLButtonElement | null>(null);
  const leftWithFocus = useRef<HTMLButtonElement | null>(null);
  // As in the public chat, read focus before React removes the control.
  const buttonRef = useCallback((element: HTMLButtonElement | null) => {
    if (element === null && button.current !== null && button.current === document.activeElement) {
      leftWithFocus.current = button.current;
    }
    button.current = element;
  }, []);

  useLayoutEffect(() => {
    const left = leftWithFocus.current;
    leftWithFocus.current = null;
    if (left === null || left.isConnected || document.activeElement !== document.body) return;
    const target = heading();
    if (target === null) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  });

  return buttonRef;
}
