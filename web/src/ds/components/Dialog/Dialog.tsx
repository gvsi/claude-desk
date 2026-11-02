import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './Dialog.css';

export interface DialogProps {
  /** The question, which names the dialog: "Delete “Emergencies” for Turner Plumbing?", "Start over with a fresh copy?". */
  title: ReactNode;
  /** What happens, in plain words, which describes the dialog. */
  body: ReactNode;
  /** The button that does it: "Delete Desk", "Start over". */
  confirmLabel: string;
  /** The confirm button look: primary by default, or danger for a delete that cannot be undone. */
  confirmVariant?: 'primary' | 'danger';
  /** The button that leaves things as they are: "Keep it", "Keep this copy". */
  cancelLabel: string;
  /** `danger` adds only a refused dot beside the title; no signed screen uses it. Use the danger value of `confirmVariant` for the delete look. */
  tone?: 'default' | 'danger';
  /** The confirmation is being sent: both buttons wait with `aria-busy`, and Escape does nothing. */
  pending?: boolean;
  onConfirm: () => void;
  /** Called by the cancel button, by Escape, and when the browser closes the dialog itself. */
  onCancel: () => void;
}

/** What Tab can reach inside the dialog, in order. */
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal question that asks before something happens: its title, what will happen, and two
 * buttons. The screen renders it to open it and removes it to close it. Focus moves to the cancel
 * button, the least destructive answer, and stays inside until it closes; Escape cancels; focus
 * then returns to whatever opened it.
 */
export function Dialog({ title, body, confirmLabel, cancelLabel, confirmVariant = 'primary', tone = 'default', pending = false, onConfirm, onCancel }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Set while the screen removes the dialog, so the close that removal causes isn't reported back.
  const removing = useRef(false);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;

  // A native modal dialog: the page behind it is inert. Focus goes to the cancel button, and when
  // the dialog goes, back to the element that had it before, unless focus has moved on since.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const doc = dialog.ownerDocument;
    const opener = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    removing.current = false;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('.cd-dialog__actions button')?.focus();
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
      if (!pending) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    const tabbable = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)];
    const first = tabbable[0];
    const last = tabbable[tabbable.length - 1];
    const active = dialog.ownerDocument.activeElement;
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    // Tab past the last button comes back to the first, and Shift+Tab before the first to the last.
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  // The browser's own close request (not a key press: Escape is handled above) asks the screen,
  // like Escape, rather than closing the dialog behind its back.
  const onNativeCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    if (!pending) onCancel();
  };

  // A close the screen didn't make: the browser may close a modal itself after a repeated close
  // request (a second back gesture on Android). The dialog is gone, so the screen hears about it.
  // A close event that finds the dialog open again is stale (StrictMode reopens it), not a close.
  const onNativeClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (!removing.current && !event.currentTarget.open) onCancel();
  };

  return (
    <dialog
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      aria-busy={pending || undefined}
      className="cd-dialog"
      onKeyDown={onKeyDown}
      onCancel={onNativeCancel}
      onClose={onNativeClose}
    >
      <h2 id={titleId} className="cd-dialog__title cd-type-section">
        {tone === 'danger' ? <StatusDot tone="refused" /> : null}
        <span>{title}</span>
      </h2>
      <div id={bodyId} className="cd-dialog__body cd-type-body">
        {body}
      </div>
      {/* While the confirmation is sent, only its button spins; cancel waits, unpressable. */}
      <div className="cd-dialog__actions">
        <Button variant="secondary" size="main" waiting={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} size="main" busy={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
