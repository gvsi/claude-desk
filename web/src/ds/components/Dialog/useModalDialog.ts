import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';

/** What Tab can reach inside a dialog, before leaving out radios a checked one stands for. */
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog's controls in Tab order. A radio group is one stop, at its checked radio, as the
 * browser tabs through it; a group with nothing checked is reached at each of its radios.
 */
function tabbables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || el.checked || el.name === '') return true;
    const group = dialog.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`);
    return ![...group].some((radio) => radio.checked);
  });
}

/**
 * Keeps Tab and Shift+Tab inside `container`: from its last control Tab goes to its first, and
 * Shift+Tab from its first goes to its last; with nothing to reach, Tab stays put. Focus on the
 * container itself (a press on text inside it) counts as outside its controls, so Tab goes to the
 * first and Shift+Tab to the last. Call it from the container's `keydown` for a Tab.
 */
export function keepTabInside(event: KeyboardEvent<HTMLElement>, container: HTMLElement): void {
  const order = tabbables(container);
  const first = order[0];
  const last = order[order.length - 1];
  const active = container.ownerDocument.activeElement;
  const outside = active === container || !container.contains(active);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

/** The props a modal `<dialog>` takes from `useModalDialog`. */
export interface ModalDialogProps {
  ref: RefObject<HTMLDialogElement>;
  role: 'dialog';
  'aria-modal': 'true';
  onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => void;
  onCancel: (event: SyntheticEvent<HTMLDialogElement>) => void;
  onClose: (event: SyntheticEvent<HTMLDialogElement>) => void;
}

/**
 * A native modal dialog that the screen opens by rendering and closes by removing: it opens with
 * `showModal()` (the page behind is inert), moves focus to `firstFocus`, keeps Tab and Shift+Tab
 * inside, and calls `onDismiss` for Escape, the browser's own close request, and a close the screen
 * didn't make. When the screen removes it, focus returns to whatever opened it, unless focus has
 * moved on since.
 */
export function useModalDialog(onDismiss: () => void, firstFocus: (dialog: HTMLDialogElement) => HTMLElement | null): ModalDialogProps {
  const ref = useRef<HTMLDialogElement>(null);
  // Set while the screen removes the dialog, so the close that removal causes isn't reported back.
  const removing = useRef(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const focusFirst = useRef(firstFocus);
  focusFirst.current = firstFocus;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const doc = dialog.ownerDocument;
    const opener = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    removing.current = false;
    if (!dialog.open) dialog.showModal();
    focusFirst.current(dialog)?.focus();
    return () => {
      removing.current = true;
      const active = doc.activeElement;
      const focusInside = active === null || active === doc.body || dialog.contains(active);
      if (dialog.open) dialog.close();
      if (focusInside && opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      // Handled here rather than by the dialog's own cancel, so the screen decides when it closes.
      event.preventDefault();
      event.stopPropagation();
      dismiss.current();
      return;
    }
    if (event.key !== 'Tab') return;
    keepTabInside(event, event.currentTarget);
  };

  // The browser's own close request (not a key press) asks the screen, like Escape.
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    dismiss.current();
  };

  // A close the screen didn't make, such as a repeated back gesture: the screen hears about it. A
  // close event that finds the dialog open again is stale (StrictMode reopens it), not a close.
  const onClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (!removing.current && !event.currentTarget.open) dismiss.current();
  };

  return { ref, role: 'dialog', 'aria-modal': 'true', onKeyDown, onCancel, onClose };
}
