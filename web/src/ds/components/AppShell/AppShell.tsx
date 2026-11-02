import {
  Component,
  createContext,
  createRef,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';

import { Icon } from '../../icons/index.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { Mark } from '../Mark/Mark.tsx';
import type { SidebarLinkProps } from '../Sidebar/Sidebar.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';

import './AppShell.css';

const AppShellLayoutContext = createContext<'wide' | 'compact'>('wide');

export interface AppShellOnlyProps {
  layout: 'wide' | 'compact';
  children: ReactNode;
}

/** Uses the shell's own layout decision, including its forced compact layout. */
export function AppShellOnly({ layout, children }: AppShellOnlyProps) {
  return useContext(AppShellLayoutContext) === layout ? <>{children}</> : null;
}

export interface AppShellProps {
  /** The `Sidebar`: a column at the left, or a sheet behind "Menu" on a narrow screen. */
  sidebar: ReactNode;
  /** The current business's name, for the top bar on a narrow screen: "Turner Plumbing". */
  business: string;
  /** The current Desk's Today, for the compact bar's mark. */
  todayHref: string;
  /** The compact mark's destination, independent of the nav rows; `todayHref` by default. */
  brandHref?: string;
  /** The destination in the mark's accessible name, after "Claude Desk"; Today by default. */
  brandDestination?: 'today' | 'home';
  /** The router's link component, as passed to Sidebar; a plain anchor by default. */
  linkComponent?: ComponentType<SidebarLinkProps>;
  /** A full-width line above everything, such as the `ReviewerBar`. */
  banner?: ReactNode;
  /** `auto` (the default) shows the column from 768 px up; `compact` always shows the top bar. */
  layout?: 'auto' | 'compact';
  /**
   * The page fills the main area edge to edge, with no padding and no content width, for a page
   * that lays out its own columns, such as Conversations' list beside the open conversation; the
   * page draws its own dividers. It changes only the main area: the sidebar looks the same on
   * every page.
   */
  fill?: boolean;
  /** Draw the compact bar as shapes and leave landmarks to the loading page. */
  skeleton?: boolean;
  /**
   * A panel beside the page, such as `AskClaudePanel`: at the right of the main area, the main
   * area's height, the page narrowing to make room. A panel that becomes a modal sheet (on a phone
   * or a tablet) says so through `AppShellPanelContext`, and the shell makes everything else inert
   * meanwhile. A panel that opens beside the page slides in, and the page glides to its new place;
   * one that closes slides out while the page glides back (`PanelSlot`).
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

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function reducesMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches;
}

/**
 * The owner app's frame: an optional banner across the top, the sidebar in its column on the
 * panel, and the page beside it, padded and no wider than `size-content`. On a narrow screen, or
 * with `layout="compact"`, a top bar with the mark, the business and "Menu" replaces the column;
 * Menu opens the sidebar as a modal sheet, and Escape, "Close menu" or going to a page closes it
 * and returns focus to Menu.
 */
export function AppShell({ sidebar, business, todayHref, brandHref = todayHref, brandDestination = 'today', linkComponent = PlainLink, banner, layout = 'auto', fill = false, skeleton = false, panel, children }: AppShellProps) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const compact = layout === 'compact' || narrow;
  const reduced = useSyncExternalStore(subscribeReducedMotion, reducesMotion, () => true);
  const content = useRef<HTMLDivElement>(null);

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

  const Column = skeleton ? 'div' : 'aside';
  // Keep the address intact: owner pages may use its fragment for their own state.
  const mainId = useId();
  const main = useRef<HTMLElement>(null);
  const skipToContent = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    main.current?.focus();
  };

  // Only the navigation changes with the layout. The page stays in the same place in the tree, so
  // crossing the breakpoint (a resized window, a turned phone) keeps its drafts and other state.
  const shell = (
    <div className={`cd-app-shell${compact ? ' cd-app-shell--compact' : ''}`}>
      {skeleton ? null : (
        <a className="cd-app-shell__skip cd-type-control" href={`#${mainId}`} onClick={skipToContent} {...inertWhen(inert)}>
          Skip to content
        </a>
      )}
      {banner ? (
        <div className="cd-app-shell__banner" {...inertWhen(inert)}>
          {banner}
        </div>
      ) : null}
      {compact ? (
        skeleton ? (
          <div className="cd-app-shell__topbar" data-skeleton-anchor="top-bar">
            <Skeleton shape="block" width={20} height={20} anchor="top-mark" />
            <div className="cd-app-shell__business">
              <Skeleton shape="line" text="control" width="65%" />
            </div>
            <Skeleton shape="block" width="var(--size-control)" height="var(--size-control)" anchor="menu" />
          </div>
        ) : (
          <CompactNav sidebar={sidebar} business={business} brandHref={brandHref} brandDestination={brandDestination} linkComponent={linkComponent} inert={inert} />
        )
      ) : null}
      <div className="cd-app-shell__body">
        {compact ? null : (
          <Column className="cd-app-shell__column" aria-label={skeleton ? undefined : 'Claude Desk'} {...inertWhen(inert)}>
            {sidebar}
          </Column>
        )}
        <Main
          id={skeleton ? undefined : mainId}
          mainRef={skeleton ? undefined : main}
          tabIndex={skeleton ? undefined : -1}
          fill={fill}
          inert={inert}
          skeleton={skeleton}
          contentRef={content}
        >
          {children}
        </Main>
        {/* A panel beside the page slides in and out; a sheet, or any panel under reduced motion, comes and goes at once. */}
        <PanelSlot panel={panel} setModal={setModal} moves={!panelModal && !reduced} contentRef={content} />
      </div>
    </div>
  );
  return <AppShellLayoutContext.Provider value={compact ? 'compact' : 'wide'}>{shell}</AppShellLayoutContext.Provider>;
}

interface MainProps {
  id?: string;
  mainRef?: Ref<HTMLElement>;
  tabIndex?: -1;
  fill: boolean;
  inert: boolean;
  skeleton: boolean;
  contentRef: RefObject<HTMLDivElement>;
  children: ReactNode;
}

function Main({ id, mainRef, tabIndex, fill, inert, skeleton, contentRef, children }: MainProps) {
  const area = { className: `cd-app-shell__main${fill ? ' cd-app-shell__main--fill' : ''}`, ...inertWhen(inert) };
  const content = (
    <div ref={contentRef} className="cd-app-shell__content">
      {children}
    </div>
  );
  return skeleton ? (
    <div {...area}>{content}</div>
  ) : (
    <main ref={mainRef} id={id} tabIndex={tabIndex} {...area}>
      {content}
    </main>
  );
}

/** A motion token's value in milliseconds, from the root, whether the token is written in milliseconds or seconds. */
function tokenMillis(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const time = Number.parseFloat(value);
  if (!Number.isFinite(time)) return 0;
  return value.endsWith('ms') ? time : time * 1000;
}

function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface PanelSlotProps {
  /** The shell's `panel`: shown while given. */
  panel: ReactNode;
  setModal: SetPanelModal;
  /**
   * The panel sits beside the page and motion is allowed: it may slide, and the page glide. When
   * that stops (the panel became a sheet, or motion was reduced), any move under way ends at once.
   */
  moves: boolean;
  /** The page's content, which glides when the panel opens or closes beside it. */
  contentRef: RefObject<HTMLDivElement>;
}

interface PanelSlotState {
  /** The panel shown: the shell's own, or, while it leaves, the last one it gave. */
  node: ReactNode;
  /** The panel was taken away and is sliding out, out of reach, before it goes. */
  leaving: boolean;
  /** Counts openings, so a panel opened again while the last one leaves is a new one. */
  key: number;
}

type PanelPhase = 'none' | 'open' | 'leaving';

/** Where a block of the page is drawn: its box's top, bottom, width and height. */
interface BlockBox {
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** How the panel and the page are drawn just before a change, for the move after it to start from. */
interface PanelSnapshot {
  /** The page's left edge, mid-glide included; null without a page. */
  page: number | null;
  /** Each block of the page, down to `BLOCK_DEPTH` under its content, where it is drawn. */
  blocks: Map<Element, BlockBox>;
  /** A panel leaving as another opens: where it is drawn, so the new one comes in from there. */
  panel: { transform: string; opacity: string } | null;
}

/** How far under the page's content a block that its new width moved up or down is looked for. */
const BLOCK_DEPTH = 16;

/** At most this many blocks glide up or down at once; past it, the rest land in place, as the page does. */
const LIFT_CAP = 200;

/** The part of the window the page is seen through: its main area, as far as the window shows it. */
function seenOf(content: Element): { top: number; bottom: number } {
  const frame = (content.parentElement ?? content).getBoundingClientRect();
  return { top: Math.max(0, frame.top), bottom: Math.min(window.innerHeight, frame.bottom) };
}

/** Whether an element clips what is inside it to its own box, so nothing of it is drawn outside. */
function clipsContents(style: CSSStyleDeclaration): boolean {
  return style.overflowX !== 'visible' || style.overflowY !== 'visible' || /\b(?:paint|strict|content)\b/.test(style.contain);
}

/**
 * How much an element stretches what is inside it vertically, when it only scales and moves it.
 * Null when it turns or skews it, works in 3D or sets a perspective: a glide is never converted
 * through those, so such a block, and what is in it, land in place.
 */
function stretchOf(style: CSSStyleDeclaration): number | null {
  if (style.perspective !== 'none' || style.rotate !== 'none') return null;
  const depth = style.translate === 'none' ? undefined : style.translate.trim().split(/\s+/)[2];
  if (depth !== undefined && Number.parseFloat(depth) !== 0) return null;
  let stretch = 1;
  if (style.scale !== 'none') {
    const [sx = 1, sy = sx, sz = 1] = style.scale.trim().split(/\s+/).map(Number.parseFloat);
    if (sz !== 1) return null;
    stretch *= sy;
  }
  if (style.transform !== 'none') {
    const matrix = new DOMMatrix(style.transform);
    if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0) return null;
    stretch *= matrix.d;
  }
  return stretch;
}

/**
 * Where each element under `content`, down to `BLOCK_DEPTH`, is drawn now, moves under way
 * included. Whether one can be seen moving is decided once it has been measured again after the
 * change (`blockShifts`). Only a block further than a window's height from sight that also clips
 * what is in it to its box is not looked into: nothing of it can be brought into sight.
 */
function blocksOf(content: Element | null): Map<Element, BlockBox> {
  const blocks = new Map<Element, BlockBox>();
  if (!content) return blocks;
  const seen = seenOf(content);
  const reach = seen.bottom - seen.top;
  const visit = (parent: Element, depth: number) => {
    if (depth > BLOCK_DEPTH) return;
    for (const child of Array.from(parent.children)) {
      const box = child.getBoundingClientRect();
      blocks.set(child, { top: box.top, bottom: box.bottom, width: box.width, height: box.height });
      const far = box.bottom <= seen.top - reach || box.top >= seen.bottom + reach;
      if (!far || !clipsContents(getComputedStyle(child))) visit(child, depth + 1);
    }
  };
  visit(content, 1);
  return blocks;
}

/**
 * The blocks of the page that its new width moved up or down, and the `translate` that puts each
 * back where it was drawn: its own move on screen, less what the blocks around it carry it, divided
 * by how much the boxes around it scale it. Measured with nothing moving, before any move starts.
 * - A block whose width or height changed laid its children out anew, so they are looked at too,
 *   even when it kept its height (a fill page's column). So are those of a block that moved but
 *   doesn't glide, each on its own. One that glides and kept its size carries them with it.
 * - An element with no box of its own (`display: contents`) passes its children through.
 * - A block that is turned, skewed, in 3D or sets a perspective, or is inside one, lands in place.
 * - A block out of sight both before and after can't be seen moving and lands in place, decided
 *   once it has been measured both times. What is in it is still judged on its own, as it may be
 *   drawn outside its box, unless it clips what is inside it to its box.
 * - At most `LIFT_CAP` blocks; past it, the rest land in place.
 */
function blockShifts(content: Element, before: Map<Element, BlockBox>): { block: Element; y: number }[] {
  const seen = seenOf(content);
  const unseen = (top: number, bottom: number) => bottom <= seen.top || top >= seen.bottom;
  const shifts: { block: Element; y: number }[] = [];
  const walk = (parent: Element, carried: number, stretch: number, depth: number) => {
    if (depth > BLOCK_DEPTH) return;
    for (const child of Array.from(parent.children)) {
      if (shifts.length >= LIFT_CAP) return;
      const was = before.get(child);
      if (!was) continue;
      if (child.getClientRects().length === 0) {
        walk(child, carried, stretch, depth + 1);
        continue;
      }
      const style = getComputedStyle(child);
      const own = stretchOf(style);
      if (own === null) continue;
      const box = child.getBoundingClientRect();
      const out = unseen(was.top, was.bottom) && unseen(box.top, box.bottom);
      if (out && clipsContents(style)) continue;
      const shift = was.top - box.top - carried;
      let applied = 0;
      if (!out && Math.abs(shift) >= 0.5 && stretch !== 0) {
        shifts.push({ block: child, y: shift / stretch });
        applied = shift;
      }
      const resized = Math.abs(was.width - box.width) >= 0.5 || Math.abs(was.height - box.height) >= 0.5;
      if (resized || Math.abs(shift - applied) >= 0.5) walk(child, carried + applied, stretch * own, depth + 1);
    }
  };
  walk(content, 0, 1, 1);
  return shifts;
}

const phaseOf = (state: PanelSlotState): PanelPhase => (state.node ? (state.leaving ? 'leaving' : 'open') : 'none');

/**
 * The panel beside the page, and how it comes and goes. Opening, the panel slides `space-24` in
 * from the right and fades up, and the page, laid out at its new width at once, glides from where
 * it was to its new place on transform alone (a FLIP: first, last, invert, play), both on
 * motion-base with the emphasis ease. Closing reverses on motion-fast: the panel, out of reach and
 * out of the row, so the page takes its full width at once, slides out while the page glides back.
 * A panel that takes no room in the row (a sheet over the window) neither slides nor moves the page,
 * and under reduced motion every change is its end state at once.
 *
 * A class, because the page's place before the change has to be read before React changes the
 * page (`getSnapshotBeforeUpdate`), and the motion started after it, before the browser paints.
 */
class PanelSlot extends Component<PanelSlotProps, PanelSlotState> {
  state: PanelSlotState = { node: null, leaving: false, key: 0 };

  private slot = createRef<HTMLDivElement>();

  private glide: Animation | null = null;

  /** The page's blocks gliding up or down to their new places, beside the sideways glide. */
  private lifts: Animation[] = [];

  private fallback: number | undefined;

  static getDerivedStateFromProps(props: PanelSlotProps, state: PanelSlotState): Partial<PanelSlotState> | null {
    if (props.panel) {
      const reopened = !state.node || state.leaving;
      return { node: props.panel, leaving: false, key: reopened ? state.key + 1 : state.key };
    }
    if (state.node && !state.leaving) return props.moves ? { leaving: true } : { node: null };
    return null;
  }

  getSnapshotBeforeUpdate(_props: PanelSlotProps, prev: PanelSlotState): PanelSnapshot | null {
    if (phaseOf(prev) === phaseOf(this.state) && prev.key === this.state.key) return null;
    // A panel that has slid out was already out of the row: its going moves nothing.
    if (phaseOf(prev) === 'leaving' && phaseOf(this.state) === 'none') return null;
    // Where the page is drawn now, mid-glide included, so a glide taken over starts from there; and
    // a panel opened again as the last one leaves comes in from where that one is drawn.
    const leaving = phaseOf(prev) === 'leaving' ? this.slot.current : null;
    const drawn = leaving ? getComputedStyle(leaving) : null;
    const content = this.props.contentRef.current;
    return {
      page: content?.getBoundingClientRect().left ?? null,
      blocks: blocksOf(content),
      panel: drawn ? { transform: drawn.transform, opacity: drawn.opacity } : null,
    };
  }

  componentDidUpdate(props: PanelSlotProps, _prev: PanelSlotState, snapshot: PanelSnapshot | null): void {
    // A panel that became a sheet mid-move (a sheet is fixed, and a moving slot would carry it), or
    // motion reduced mid-move: the move's end state, at once.
    if (props.moves && !this.props.moves) {
      for (const animation of this.slot.current?.getAnimations() ?? []) animation.finish();
      this.glide?.finish();
      for (const lift of this.lifts) lift.finish();
    }
    if (snapshot === null) return;
    const phase = phaseOf(this.state);
    const content = this.props.contentRef.current;
    this.glide?.cancel();
    this.glide = null;
    for (const lift of this.lifts) lift.cancel();
    this.lifts = [];
    if (!content || snapshot.page === null || reducesMotion()) return;
    const first = snapshot.page;
    const opening = phase === 'open';
    const timing = { duration: tokenMillis(opening ? '--motion-base' : '--motion-fast'), easing: tokenValue('--motion-ease-emphasis') };
    // Where the new width moved blocks up or down (a subtitle taking a second line), measured
    // before anything moves. Each glides from where it was drawn on its `translate`, which moves it
    // outside its own transform, added to any translate it has.
    this.lifts = blockShifts(content, snapshot.blocks).map(({ block, y }) =>
      block.animate([{ translate: `0px ${y}px` }, { translate: '0px 0px' }], { ...timing, composite: 'add' }),
    );
    const shift = first - content.getBoundingClientRect().left;
    if (Math.abs(shift) >= 0.5) {
      const glide = content.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], timing);
      this.glide = glide;
      // Drawn past the main area's edge while it glides, the page never makes it scroll sideways.
      const main = content.parentElement;
      main?.setAttribute('data-gliding', '');
      const landed = () => {
        if (this.glide === glide || this.glide === null) main?.removeAttribute('data-gliding');
      };
      glide.finished.then(landed, landed);
    }
    const slot = this.slot.current;
    if (!slot) return;
    const away = { transform: `translateX(${tokenValue('--space-24')})`, opacity: 0 };
    const here = { transform: 'none', opacity: 1 };
    if (opening) {
      // Only a panel beside the page slides in: a sheet takes no room in the row.
      if (slot.offsetWidth > 0) slot.animate([snapshot.panel ?? away, here], timing);
      return;
    }
    if (phase === 'leaving') {
      const { key } = this.state;
      // Only where it goes: the exit starts from where the panel is drawn, its entrance included
      // if that hasn't ended, so closing mid-entrance never flashes it back to fully open.
      const leave = slot.animate([away], { ...timing, fill: 'forwards' });
      leave.finished.then(() => this.drop(key), () => {});
      // If the animation's end never comes (a hidden tab), the panel still goes.
      window.clearTimeout(this.fallback);
      this.fallback = window.setTimeout(() => this.drop(key), timing.duration + tokenMillis('--motion-instant'));
    }
  }

  componentWillUnmount(): void {
    window.clearTimeout(this.fallback);
  }

  /** The panel that was leaving goes, unless another has opened since, whose way out it leaves alone. */
  private drop(key: number): void {
    if (this.state.key !== key) return;
    window.clearTimeout(this.fallback);
    this.setState((state) => (state.leaving && state.key === key ? { node: null, leaving: false } : null));
  }

  render() {
    const { node, leaving, key } = this.state;
    if (!node) return null;
    return (
      <div key={key} ref={this.slot} className={`cd-app-shell__panel${leaving ? ' cd-app-shell__panel--leaving' : ''}`} {...inertWhen(leaving)}>
        <AppShellPanelContext.Provider value={this.props.setModal}>{node}</AppShellPanelContext.Provider>
      </div>
    );
  }
}

/** The compact navigation: the top bar with the mark, the business and Menu, and the sheet Menu opens. */
function CompactNav({ sidebar, business, brandHref, brandDestination, linkComponent: Link = PlainLink, inert }: Pick<AppShellProps, 'sidebar' | 'business' | 'linkComponent'> & { brandHref: string; brandDestination: 'today' | 'home'; inert: boolean }) {
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const sheetId = useId();

  // The sheet is a native modal dialog: the page behind it is inert, and focus moves into it.
  useLayoutEffect(() => {
    const dialog = sheet.current;
    if (dialog && open && !dialog.open) dialog.showModal();
  }, [open]);

  // A panel that becomes a modal sheet (the window narrowed with the menu open) takes over: the
  // menu's sheet closes, and the shell moves focus into the panel, not back to Menu.
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
        <Link href={brandHref} className="cd-app-shell__brand" aria-label={`Claude Desk, ${brandDestination === 'home' ? 'home' : 'go to Today'}`}>
          <Mark />
        </Link>
        {/* A name too long for the bar is cut with an ellipsis; its title holds it in full. */}
        <span className="cd-app-shell__business cd-type-control" data-copy="user" title={business}>
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

function PlainLink({ children, ...props }: SidebarLinkProps) {
  return <a {...props}>{children}</a>;
}
