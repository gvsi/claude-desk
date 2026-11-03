import { useId, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';

import { Icon, type IconName } from '../../icons/index.tsx';
import { CountPill } from '../CountPill/CountPill.tsx';
import { AppShellOnly } from '../AppShell/AppShell.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import { Mark, Wordmark } from '../Mark/Mark.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';
import { Switch } from '../Switch/Switch.tsx';
import { ACTING_SWITCH_COPY } from '../Switch/copy.ts';

import './Sidebar.css';

/** The owner app's pages, in the sidebar's fixed order. */
export type NavKey =
  | 'today'
  | 'conversations'
  | 'people'
  | 'knowledge'
  | 'rules'
  | 'connectors'
  | 'safety'
  | 'notifications'
  | 'profile'
  | 'share'
  | 'settings';

/** The rows an app may leave out, with no page for them: the sidebar draws no row for one without an href. */
type OptionalRow = 'connectors' | 'notifications';

/**
 * Where each row goes. Every page needs its href but Connectors and Notifications: an app without
 * one of those pages leaves its href out, and the sidebar draws no row for it.
 */
export type SidebarHrefs = Record<Exclude<NavKey, OptionalRow>, string> & Partial<Record<OptionalRow, string>>;

/** What a nav row's link receives: a router's link component takes the same props as `<a>`. */
export interface SidebarLinkProps {
  href: string;
  className: string;
  'aria-label'?: string;
  'aria-current'?: 'page';
  children: ReactNode;
}

/** One link in the "About this prototype" group: a document behind the prototype. */
export interface SidebarAboutLink {
  id: string;
  /** The document's name: "Product proposal". */
  label: string;
  href: string;
  /** The document open now: its row is the current page, and the main nav marks none. */
  current?: boolean;
  /** Opens an external page in a new tab, named explicitly for assistive technology. */
  external?: boolean;
  icon?: IconName;
}

/** The group of links above the Answering block: its caption title, then one row per link. */
export interface SidebarAbout {
  /** "About this prototype". It also names the group's navigation. */
  title: string;
  links: SidebarAboutLink[];
}

/** A count beside a nav row: the number shown, and the words read instead of it. */
export interface NavCount {
  n: number;
  label: string;
}

export interface SidebarProps {
  /** The current business's name: "Turner Plumbing". */
  business: string;
  /** Opens the business switcher (`SwitcherMenu`). */
  onSwitchBusiness: () => void;
  /** The current business's Desks. The Desk picker shows only with two or more. */
  desks: { id: string; name: string }[];
  currentDeskId: string;
  onSwitchDesk: (deskId: string) => void;
  /** The page the owner is on; its row is marked `aria-current="page"`. */
  current: NavKey;
  /** Where each row goes. Without `connectors` or `notifications`, that row isn't drawn and the rows close up. */
  hrefs: SidebarHrefs;
  /** The lockup's destination, independent of the nav rows; `hrefs.today` by default. */
  brandHref?: string;
  /** The destination in the lockup's accessible name, after its visible name and badge. */
  brandDestination?: 'today' | 'home';
  /** The business's word for the people it serves, the row under Notifications: "Customers", "Clients". */
  peopleLabel: string;
  /**
   * Counts on Conversations, Safety and Notifications only; `attention` adds a held dot beside
   * Safety's.
   */
  counts?: { conversations?: NavCount; safety?: NavCount & { attention?: boolean }; notifications?: NavCount };
  /** Whether Claude is answering on this Desk. */
  answering: boolean;
  onAnsweringChange: (answering: boolean) => void;
  /**
   * The switch's line while on. "Within your rules" by default; off always says "Taking messages only".
   */
  answeringDescription?: string;
  /** The owner's name and one line of status: "Available for chats". */
  owner: { name: string; status: string };
  /** The router's link component for the nav rows; a plain `<a>` by default. */
  linkComponent?: ComponentType<SidebarLinkProps>;
  /** The "About this prototype" group, just above the Answering block. Left out, nothing shows. */
  about?: SidebarAbout;
  /** The owner app's concept line under About, in the wide shell only. */
  conceptFooter?: boolean;
}

/**
 * Each page's row label, the words a page can name itself by (a tab's title: "Today · Claude Desk").
 * People's row is the consumer's `peopleLabel`.
 */
export const NAV_LABELS = {
  today: 'Today',
  conversations: 'Conversations',
  knowledge: 'Knowledge',
  rules: 'Rules',
  connectors: 'Connectors',
  safety: 'Safety',
  notifications: 'Notifications',
  profile: 'Profile',
  share: 'Share',
  settings: 'Settings',
} as const satisfies Record<Exclude<NavKey, 'people'>, string>;

const NAV_ROWS = [
  { key: 'today', icon: 'today', label: NAV_LABELS.today },
  { key: 'conversations', icon: 'conversations', label: NAV_LABELS.conversations },
  { key: 'rules', icon: 'rules', label: NAV_LABELS.rules },
  { key: 'connectors', icon: 'connectors', label: NAV_LABELS.connectors },
  { key: 'safety', icon: 'safety', label: NAV_LABELS.safety },
  { key: 'notifications', icon: 'bell', label: NAV_LABELS.notifications },
  { key: 'people', icon: 'people', label: null },
  { key: 'profile', icon: 'store', label: NAV_LABELS.profile },
  { key: 'share', icon: 'share', label: NAV_LABELS.share },
  { key: 'knowledge', icon: 'knowledge', label: NAV_LABELS.knowledge },
  { key: 'settings', icon: 'settings', label: NAV_LABELS.settings },
] as const satisfies readonly { key: NavKey; icon: IconName; label: string | null }[];

function PlainLink({ children, ...props }: SidebarLinkProps) {
  return <a {...props}>{children}</a>;
}

/** The first letter of the first and last words, as written: "Mike Turner" is "MT". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return [first, last].map((word) => (word === undefined ? '' : (Array.from(word)[0] ?? ''))).join('');
}

/**
 * The owner app's sidebar: the Claude Desk mark, the business and Desk switchers, the pages in a
 * fixed order (Connectors and Notifications only when they have an href), an optional "About this prototype" group, and
 * at the bottom the Answering switch and the owner. It fills the column the `AppShell` gives it.
 */
export function Sidebar({
  business,
  onSwitchBusiness,
  desks,
  currentDeskId,
  onSwitchDesk,
  current,
  hrefs,
  brandHref = hrefs.today,
  brandDestination = 'today',
  peopleLabel,
  counts,
  answering,
  onAnsweringChange,
  answeringDescription = ACTING_SWITCH_COPY.on,
  owner,
  linkComponent: Link = PlainLink,
  about,
  conceptFooter = false,
}: SidebarProps) {
  const preview = true;
  const aboutId = useId();
  // One page is current: while a document from the about group is open, the main nav marks none.
  const mainCurrent = about?.links.some((link) => link.current === true) ? null : current;
  return (
    <div className="cd-sidebar">
      {/* The lockup (owner, 2026-10-30): the 36 px bell, the name and the Preview badge, on one line. */}
      <Link href={brandHref} className="cd-sidebar__brand" aria-label={`Claude Desk${preview ? ' Preview' : ''}, ${brandDestination === 'home' ? 'home' : 'go to Today'}`}>
        <Mark size={36} />
        <Wordmark preview={preview} />
      </Link>
      <button
        type="button"
        className="cd-sidebar__business cd-type-control"
        aria-haspopup="menu"
        aria-label={`Switch business, current: ${business}`}
        onClick={onSwitchBusiness}
      >
        {/* A name too long for the row is cut with an ellipsis; its title holds it in full. */}
        <span className="cd-sidebar__ellipsis" data-copy="user" title={business}>
          {business}
        </span>
        <Icon name="chevrons" size={16} className="cd-sidebar__quiet-icon" />
      </button>
      {desks.length >= 2 ? (
        <DeskPicker business={business} desks={desks} currentDeskId={currentDeskId} onSwitchDesk={onSwitchDesk} />
      ) : null}
      <div className="cd-sidebar__middle">
        <nav className="cd-sidebar__nav" aria-label="Main">
          {NAV_ROWS.map((row) => {
            const href = hrefs[row.key];
            // Only Connectors' and Notifications' hrefs may be left out, and then their row isn't
            // drawn. Every other page keeps its row even if its href goes missing past the types, as
            // it always has.
            if ((row.key === 'connectors' || row.key === 'notifications') && href === undefined) return null;
            const count =
              row.key === 'conversations' || row.key === 'safety' || row.key === 'notifications' ? counts?.[row.key] : undefined;
            const attention = row.key === 'safety' && counts?.safety?.attention === true;
            return (
              <Link
                key={row.key}
                href={href as string}
                className="cd-sidebar__row cd-type-control"
                {...(row.key === mainCurrent ? { 'aria-current': 'page' as const } : {})}
              >
                <Icon name={row.icon} />
                <span className="cd-sidebar__label">{row.label ?? peopleLabel}</span>
                {attention ? <StatusDot tone="held" /> : null}
                {count ? <CountPill count={count.n} label={count.label} /> : null}
              </Link>
            );
          })}
        </nav>
        {about ? (
          <nav className="cd-sidebar__about" aria-labelledby={aboutId}>
            <p id={aboutId} className="cd-sidebar__about-title cd-type-caption">
              {about.title}
            </p>
            {about.links.map((link) => link.external ? (
              <a key={link.id} href={link.href} target="_blank" rel="noreferrer" aria-label={`${link.label} (opens in a new tab)`} className="cd-sidebar__row cd-type-control">
                <Icon name={link.icon ?? 'document'} />
                <span className="cd-sidebar__label">{link.label}</span>
              </a>
            ) : (
              <Link
                key={link.id}
                href={link.href}
                className="cd-sidebar__row cd-type-control"
                {...(link.current === true ? { 'aria-current': 'page' as const } : {})}
              >
                <Icon name={link.icon ?? 'document'} />
                <span className="cd-sidebar__label">{link.label}</span>
              </Link>
            ))}
          </nav>
        ) : null}
        {conceptFooter ? (
          <AppShellOnly layout="wide">
            <div className="cd-sidebar__concept-footer" data-owner-footer>
              <ConceptFooter />
            </div>
          </AppShellOnly>
        ) : null}
      </div>
      <div className="cd-sidebar__footer">
        <Switch label={ACTING_SWITCH_COPY.label} description={answering ? answeringDescription : ACTING_SWITCH_COPY.off} checked={answering} onChange={onAnsweringChange} />
        <div className="cd-sidebar__owner">
          <span className="cd-sidebar__avatar cd-type-count" aria-hidden="true">
            {initialsOf(owner.name)}
          </span>
          <span className="cd-sidebar__owner-text">
            <span className="cd-sidebar__ellipsis cd-type-control" data-copy="user">
              {owner.name}
            </span>
            <span className="cd-sidebar__owner-status cd-type-caption">{owner.status}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

interface DeskPickerProps {
  business: string;
  desks: { id: string; name: string }[];
  currentDeskId: string;
  onSwitchDesk: (deskId: string) => void;
}

/**
 * The current Desk, and the business's Desks listed under it when opened. Escape closes the list
 * and returns focus to the picker, as does picking a Desk.
 */
function DeskPicker({ business, desks, currentDeskId, onSwitchDesk }: DeskPickerProps) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const currentDesk = desks.find((desk) => desk.id === currentDeskId);

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return;
    // Handled here, so a sheet the sidebar sits in stays open.
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div className="cd-sidebar__desks" onKeyDown={onKeyDown}>
      <button
        ref={toggle}
        type="button"
        className="cd-sidebar__desk-toggle cd-type-meta"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={currentDesk ? `Switch Desk, current: ${currentDesk.name}` : 'Switch Desk'}
        onClick={() => setOpen(!open)}
      >
        <span className="cd-sidebar__ellipsis" data-copy="user">
          {currentDesk?.name}
        </span>
        <Icon name="chevrons" size={14} className="cd-sidebar__quiet-icon" />
      </button>
      {open ? (
        <ul id={listId} role="list" className="cd-sidebar__desk-list" aria-label={`Desks in ${business}`}>
          {desks.map((desk) => {
            const isCurrent = desk.id === currentDeskId;
            return (
              <li key={desk.id}>
                <button
                  type="button"
                  className="cd-sidebar__desk cd-type-meta"
                  aria-current={isCurrent || undefined}
                  onClick={() => {
                    if (!isCurrent) onSwitchDesk(desk.id);
                    close();
                  }}
                >
                  <span className="cd-sidebar__ellipsis" data-copy="user">
                    {desk.name}
                  </span>
                  {isCurrent ? <Icon name="check" size={14} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
