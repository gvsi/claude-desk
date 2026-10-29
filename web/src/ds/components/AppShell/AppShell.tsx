import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { Icon } from '../../icons/index.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { Mark } from '../Mark/Mark.tsx';

import './AppShell.css';

export interface AppShellProps {
  /** The `Sidebar`: a column at the left, or a sheet behind "Menu" on a narrow screen. */
  sidebar: ReactNode;
  /** The current business's name, for the top bar on a narrow screen: "Rivera Plumbing". */
  business: string;
  /** A full-width line above everything, such as the `ReviewerBar`. */
  banner?: ReactNode;
  /** `auto` (the default) shows the column from 768 px up; `compact` always shows the top bar. */
  layout?: 'auto' | 'compact';
  /** The page. */
  children: ReactNode;
}

/** Below this width the sidebar becomes a sheet behind "Menu". */
const NARROW = '(max-width: 767.98px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

/**
 * The owner app's frame: an optional banner across the top, the sidebar in its column on the
 * panel, and the page beside it, padded and no wider than `size-content`. On a narrow screen, or
 * with `layout="compact"`, a top bar with the mark, the business and "Menu" replaces the column;
 * Menu opens the sidebar as a modal sheet, and Escape, "Close menu" or going to a page closes it
 * and returns focus to Menu.
 */
export function AppShell({ sidebar, business, banner, layout = 'auto', children }: AppShellProps) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const compact = layout === 'compact' || narrow;

  return (
    <div className={`cd-app-shell${compact ? ' cd-app-shell--compact' : ''}`}>
      {banner}
      {compact ? (
        <CompactFrame sidebar={sidebar} business={business}>
          {children}
        </CompactFrame>
      ) : (
        <div className="cd-app-shell__body">
          <aside className="cd-app-shell__column" aria-label="Claude Desk">
            {sidebar}
          </aside>
          <Main>{children}</Main>
        </div>
      )}
    </div>
  );
}

function Main({ children }: { children: ReactNode }) {
  return (
    <main className="cd-app-shell__main">
      <div className="cd-app-shell__content">{children}</div>
    </main>
  );
}

function CompactFrame({ sidebar, business, children }: { sidebar: ReactNode; business: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const sheetId = useId();

  // The sheet is a native modal dialog: the page behind it is inert, and focus moves into it.
  useLayoutEffect(() => {
    const dialog = sheet.current;
    if (dialog && open && !dialog.open) dialog.showModal();
  }, [open]);

  // Every way of closing ends here: Escape, Close menu, a page link, the backdrop, or the
  // dialog's own close. Focus goes back to Menu.
  const close = useCallback(() => {
    sheet.current?.close();
    setOpen(false);
    menu.current?.focus();
  }, []);

  // Escape is handled here rather than left to the dialog's cancel, so it closes the same way
  // from any keyboard event, and a control inside that uses Escape itself can stop it first.
  const onSheetKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };

  const onSheetClick = (event: MouseEvent<HTMLDialogElement>) => {
    const target = event.target as Element;
    // The backdrop's clicks land on the dialog itself; a link inside goes to another page.
    if (target === event.currentTarget || target.closest('a[href]') !== null) close();
  };

  return (
    <>
      <div className="cd-app-shell__topbar">
        <Mark />
        <span className="cd-app-shell__business cd-type-control" data-copy="user">
          {business}
        </span>
        <button
          ref={menu}
          type="button"
          className="cd-app-shell__menu cd-type-control"
          aria-expanded={open}
          aria-controls={open ? sheetId : undefined}
          onClick={() => setOpen(true)}
        >
          <Icon name="menu" size={18} />
          Menu
        </button>
      </div>
      {open ? (
        <dialog
          id={sheetId}
          ref={sheet}
          className="cd-app-shell__sheet"
          aria-label="Menu"
          onClose={close}
          onKeyDown={onSheetKeyDown}
          onClick={onSheetClick}
        >
          <div className="cd-app-shell__sheet-head">
            <IconButton label="Close menu" icon="close" onClick={close} />
          </div>
          {sidebar}
        </dialog>
      ) : null}
      <Main>{children}</Main>
    </>
  );
}
