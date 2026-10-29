import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './Dialog.css';

export interface DialogProps {
  /** The question, which names the dialog: "Delete Emergencies?", "Start over with a fresh copy?". */
  title: ReactNode;
  /** What happens, in plain words, which describes the dialog. */
  body: ReactNode;
  /** The button that does it: "Delete Desk", "Start over". */
  confirmLabel: string;
  /** The button that leaves things as they are: "Keep it", "Keep this copy". */
  cancelLabel: string;
  /** `danger` adds a refused dot beside the title, for something that can't be undone; the buttons stay neutral. */
  tone?: 'default' | 'danger';
  /** The confirmation is being sent: both buttons wait with `aria-busy`, and Escape does nothing. */
  pending?: boolean;
  onConfirm: () => void;
  /** Called by the cancel button and by Escape. */
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
export function Dialog({ title, body, confirmLabel, cancelLabel, tone = 'default', pending = false, onConfirm, onCancel }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
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
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('.cd-dialog__actions button')?.focus();
    return () => {
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

  // The browser's own close request (Escape it handled itself) never closes it behind the screen's back.
  const onNativeCancel = (event: SyntheticEvent<HTMLDialogElement>) => event.preventDefault();

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
    >
      <h2 id={titleId} className="cd-dialog__title cd-type-section">
        {tone === 'danger' ? <StatusDot tone="refused" /> : null}
        <span>{title}</span>
      </h2>
      <div id={bodyId} className="cd-dialog__body cd-type-body">
        {body}
      </div>
      <div className="cd-dialog__actions">
        <Button variant="secondary" busy={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="primary" busy={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
