import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import { CountPill } from '../CountPill/CountPill.tsx';
import { DemoInboxPanel, shownItems, type DemoInboxPanelProps } from '../DemoInboxPanel/DemoInboxPanel.tsx';
import { INBOX_COPY } from '../DemoInboxPanel/inboxCopy.ts';
import { useModalDialog } from '../Dialog/useModalDialog.ts';

import './DemoInboxSheet.css';

export interface DemoInboxSheetProps extends Omit<DemoInboxPanelProps, 'action' | 'titleFocusable'> {
  /** Hears the sheet open (`true`) and close (`false`), whatever opened or closed it. */
  onOpenChange?: (open: boolean) => void;
  /**
   * A quiet button (`ghost`, its count 6 px after its words), as a control in the demo bar beside
   * Start over takes; a secondary button by default.
   */
  quiet?: boolean;
}

/**
 * The Demo inbox as a sheet, where there is no room for it beside the page: a "Demo inbox" button
 * with a count of the entries waiting, which opens the panel in a modal sheet, from the bottom for
 * a visitor (the public page below 1280 px) and from the right for the owner (Today). A visitor's
 * sheet opens itself on the first entry they may see. Focus moves in, stays in, Escape or Close
 * closes it, and focus goes back to whatever had it; the page behind is inert.
 */
export function DemoInboxSheet({ viewer, items, language, onRetry, notice, onOpenChange, quiet = false }: DemoInboxSheetProps) {
  const copy = INBOX_COPY[language] ?? INBOX_COPY.en;
  // Closed, or open and how: from the button, or by itself on the first entry.
  const [open, setOpen] = useState<false | 'button' | 'itself'>(false);
  const count = shownItems(viewer, items).length;

  // The screen hears each time the sheet opens or closes, and nothing while it stays as it is.
  const isOpen = open !== false;
  const told = useRef(false);
  const tell = useRef(onOpenChange);
  tell.current = onOpenChange;
  useEffect(() => {
    if (told.current === isOpen) return;
    told.current = isOpen;
    tell.current?.(isOpen);
  }, [isOpen]);
  // Taken off the screen while open, it has closed too. It always draws closed first, so a remount
  // under StrictMode tells nothing.
  useEffect(
    () => () => {
      if (!told.current) return;
      told.current = false;
      tell.current?.(false);
    },
    [],
  );

  // A visitor's sheet opens itself once, when the first entry they may see arrives.
  const seen = useRef(count);
  const opened = useRef(false);
  useEffect(() => {
    if (viewer === 'visitor' && !opened.current && seen.current === 0 && count > 0) {
      opened.current = true;
      setOpen((now) => now || 'itself');
    }
    seen.current = count;
  }, [viewer, count]);

  return (
    <>
      <Button variant={quiet ? 'ghost' : 'secondary'} onClick={() => setOpen('button')}>
        <span className={quiet ? 'cd-demo-inbox-sheet__button cd-demo-inbox-sheet__button--quiet' : 'cd-demo-inbox-sheet__button'}>
          <span>{copy.title}</span>
          {count > 0 ? <CountPill count={count} label={copy.entries(count)} /> : null}
        </span>
      </Button>
      {open ? (
        <Sheet
          openedBy={open}
          viewer={viewer}
          items={items}
          language={language}
          onRetry={onRetry}
          notice={notice}
          onClose={() => {
            // Closing a sheet that showed something uses up its one opening by itself; closing an
            // empty one, opened to look before anything arrived, doesn't.
            if (seen.current > 0) opened.current = true;
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

interface SheetProps extends DemoInboxSheetProps {
  /** How it opened: from the button focuses Close; by itself focuses the heading, away from the visitor's next key. */
  openedBy: 'button' | 'itself';
  onClose: () => void;
}

function Sheet({ openedBy, viewer, items, language, onRetry, notice, onClose }: SheetProps) {
  const copy = INBOX_COPY[language] ?? INBOX_COPY.en;
  const modal = useModalDialog(onClose, (dialog) =>
    dialog.querySelector<HTMLElement>(openedBy === 'itself' ? '.cd-demo-inbox__title' : '.cd-demo-inbox-sheet__close button'),
  );
  // Following a link inside, such as an alert's "Open the request", closes the sheet, so it isn't
  // left over the page the link opens. A click that opens a new tab or window leaves this page, and
  // the sheet, as they are.
  // Something inside that had focus can go while the sheet stays open, such as a notice's Try again
  // once a read works. Focus then falls to the page behind, which is inert, so it moves back to the
  // sheet's heading.
  const dialogRef = modal.ref;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog?.open && dialog.ownerDocument.activeElement === dialog.ownerDocument.body) {
      dialog.querySelector<HTMLElement>('.cd-demo-inbox__title')?.focus();
    }
  });
  const onLinkClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link && link.getAttribute('target') === null) onClose();
  };
  return (
    <dialog
      {...modal}
      onClick={onLinkClick}
      aria-label={copy.title}
      lang={language}
      className={`cd-demo-inbox-sheet cd-demo-inbox-sheet--${viewer === 'owner' ? 'side' : 'bottom'}`}
    >
      <DemoInboxPanel
        viewer={viewer}
        items={items}
        language={language}
        onRetry={onRetry}
        notice={notice}
        titleFocusable
        action={
          <span className="cd-demo-inbox-sheet__close">
            <Button variant="ghost" onClick={onClose}>
              {copy.close}
            </Button>
          </span>
        }
      />
    </dialog>
  );
}
