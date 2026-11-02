import { useEffect, type RefObject } from 'react';

/** A dialog open over the page: a native one that is open, or any other element that says it is one. */
const OPEN_DIALOG = 'dialog[open], :not(dialog)[role="dialog"], :not(dialog)[role="alertdialog"]';

/** Whether the page lets a text box take focus on its own now: nothing else has it, no dialog is open, and the screen isn't touch-first. */
function focusIsFree(): boolean {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return false;
  if (document.querySelector(OPEN_DIALOG) !== null) return false;
  // On a touch-first screen focus would bring the on-screen keyboard up over the page.
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
}

/**
 * Gives a text box focus when it first appears, so the person can type at once: once, when it is
 * there and can take it (not disabled), and never again on a later render or after focus has moved
 * on. Never by taking focus from elsewhere: not when something else has it, not while a dialog is
 * open, and not on a touch-first screen, where the keyboard would jump up over the page. Without
 * scrolling: the page stays where it opened.
 *
 * `ref` is the box itself, or, with `find`, an element around it in which the box (the first
 * match of `find`) may appear later, such as a chat's composer once the chat can be written in.
 */
export function useFocusOnArrival(ref: RefObject<HTMLElement | null>, find?: string): void {
  useEffect(() => {
    const root = ref.current;
    if (root === null) return undefined;
    const box = (): HTMLElement | null => (find === undefined ? root : root.querySelector<HTMLElement>(find));
    /** Takes focus if the box is there and can take it; whether it was there. */
    const arrive = (): boolean => {
      const el = box();
      if (el === null || el.matches(':disabled')) return false;
      if (focusIsFree()) el.focus({ preventScroll: true });
      return true;
    };
    if (arrive() || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      if (arrive()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => observer.disconnect();
  }, [ref, find]);
}
