import {
  createContext,
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
  /**
   * The page fills the main area edge to edge, with no padding and no content width, for a page
   * that lays out its own columns, such as Conversations' list beside the open conversation; the
   * page draws its own dividers. It changes only the main area, never the sidebar.
   */
  fill?: boolean;
  /**
   * The sidebar column's look: `panel` (the default) on the panel ground with a seam at its right,
   * as tall as the window; `ground` on the app ground with no seam, at its own height, as the
   * signed conversation boards draw it. The sidebar stays on every page, so the app passes the
   * same look on all of them.
   */
  sidebarLook?: 'panel' | 'ground';
  /**
   * A panel beside the page, such as `AskClaudePanel`: at the right of the main area, the main
   * area's height, the page narrowing to make room. A panel that becomes a modal sheet (on a phone)
   * says so through `AppShellPanelContext`, and the shell makes everything else inert meanwhile.
   */
  panel?: ReactNode;
  /** The page. */
  children: ReactNode;
}

/**
 * Given to the shell's `panel`: a panel calls it with `true` while it is a modal sheet over the
 * window, and the shell makes its banner, navigation and page inert, whatever it draws there as the
 * window changes, and closes the navigation sheet if it is open. `focusTo` is where focus goes once
 * the shell has done that: into the panel when it becomes a sheet; back to what opened it when it
 * was removed with focus in it, if focus was left nowhere.
 */
export type SetPanelModal = (modal: boolean, focusTo?: HTMLElement | null) => void;

export const AppShellPanelContext = createContext<SetPanelModal | null>(null);

/** React 18 has no `inert` prop: the attribute, present while `on`. */
function inertWhen(on: boolean): object {
  return on ? { inert: '' } : {};
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
export function AppShell({ sidebar, business, banner, layout = 'auto', fill = false, sidebarLook = 'panel', panel, children }: AppShellProps) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const compact = layout === 'compact' || narrow;

  // While the panel is a modal sheet, everything the shell draws besides it is inert: the inert
  // attribute is part of each render, so a part drawn anew (the top bar replacing the column as the
  // window narrows) is inert from the start.
  const [panelModal, setPanelModal] = useState(false);
  const pendingFocus = useRef<HTMLElement | null>(null);
  const setModal = useCallback<SetPanelModal>((modal, focusTo) => {
    pendingFocus.current = focusTo ?? null;
    setPanelModal(modal);
  }, []);
  const inert = panelModal && panel !== undefined && panel !== null;
  // Runs after the navigation has closed its sheet (a child's effects run first), so the panel's
  // control can take focus.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (!target?.isConnected) return;
    const active = document.activeElement;
    if (inert || active === null || active === document.body) target.focus();
  }, [inert]);

  // Only the navigation changes with the layout. The page stays in the same place in the tree, so
  // crossing the breakpoint (a resized window, a turned phone) keeps its drafts and other state.
  return (
    <div className={`cd-app-shell${compact ? ' cd-app-shell--compact' : ''}`}>
      {banner ? (
        <div className="cd-app-shell__banner" {...inertWhen(inert)}>
          {banner}
        </div>
      ) : null}
      {compact ? <CompactNav sidebar={sidebar} business={business} inert={inert} /> : null}
      <div className="cd-app-shell__body">
        {compact ? null : (
          <aside
            className={`cd-app-shell__column${sidebarLook === 'ground' ? ' cd-app-shell__column--ground' : ''}`}
            aria-label="Claude Desk"
            {...inertWhen(inert)}
          >
            {sidebar}
          </aside>
        )}
        <Main fill={fill} inert={inert}>
          {children}
        </Main>
        {panel ? <AppShellPanelContext.Provider value={setModal}>{panel}</AppShellPanelContext.Provider> : null}
      </div>
    </div>
  );
}

function Main({ fill, inert, children }: { fill: boolean; inert: boolean; children: ReactNode }) {
  return (
    <main className={`cd-app-shell__main${fill ? ' cd-app-shell__main--fill' : ''}`} {...inertWhen(inert)}>
      <div className="cd-app-shell__content">{children}</div>
    </main>
  );
}

/** The compact navigation: the top bar with the mark, the business and Menu, and the sheet Menu opens. */
function CompactNav({ sidebar, business, inert }: { sidebar: ReactNode; business: string; inert: boolean }) {
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const sheetId = useId();

  // The sheet is a native modal dialog: the page behind it is inert, and focus moves into it.
  useLayoutEffect(() => {
    const dialog = sheet.current;
    if (dialog && open && !dialog.open) dialog.showModal();
  }, [open]);

  // A panel that becomes a modal sheet (the window narrowed to a phone with the menu open) takes
  // over: the menu's sheet closes, and the shell moves focus into the panel, not back to Menu.
  useLayoutEffect(() => {
    if (!inert || !open) return;
    sheet.current?.close();
    setOpen(false);
  }, [inert, open]);

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
      <div className="cd-app-shell__topbar" {...inertWhen(inert)}>
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
          {/* The phone board draws the icon alone; the button keeps its name. */}
          <span className="cd-sr-only">Menu</span>
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
    </>
  );
}
