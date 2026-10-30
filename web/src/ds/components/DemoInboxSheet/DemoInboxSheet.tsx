import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import { CountPill } from '../CountPill/CountPill.tsx';
import { DemoInboxPanel, shownItems, type DemoInboxPanelProps } from '../DemoInboxPanel/DemoInboxPanel.tsx';
import { INBOX_COPY } from '../DemoInboxPanel/inboxCopy.ts';
import { useModalDialog } from '../Dialog/useModalDialog.ts';

import './DemoInboxSheet.css';

export type DemoInboxSheetProps = Omit<DemoInboxPanelProps, 'action'>;

/**
 * The Demo inbox as a sheet, where there is no room for it beside the page: a "Demo inbox" button
 * with a count of the entries waiting, which opens the panel in a modal sheet, from the bottom for
 * a visitor (the public page below 1280 px) and from the right for the owner (Today). A visitor's
 * sheet opens itself on the first entry they may see. Focus moves in, stays in, Escape or Close
 * closes it, and focus goes back to whatever had it; the page behind is inert.
 */
export function DemoInboxSheet({ viewer, items, language, onRetry }: DemoInboxSheetProps) {
  const copy = INBOX_COPY[language] ?? INBOX_COPY.en;
  // Closed, or open and how: from the button, or by itself on the first entry.
  const [open, setOpen] = useState<false | 'button' | 'itself'>(false);
  const count = shownItems(viewer, items).length;

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
      <Button variant="secondary" onClick={() => setOpen('button')}>
        <span className="cd-demo-inbox-sheet__button">
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

function Sheet({ openedBy, viewer, items, language, onRetry, onClose }: SheetProps) {
  const copy = INBOX_COPY[language] ?? INBOX_COPY.en;
  const modal = useModalDialog(onClose, (dialog) =>
    dialog.querySelector<HTMLElement>(openedBy === 'itself' ? '.cd-demo-inbox__title' : '.cd-demo-inbox-sheet__close button'),
  );
  // Following a link inside, such as an alert's "Open the request", closes the sheet, so it isn't
  // left over the page the link opens.
  const onLinkClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target instanceof Element && event.target.closest('a[href]')) onClose();
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
