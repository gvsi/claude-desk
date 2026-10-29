import { useId, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';

import { Icon, type IconName } from '../../icons/index.tsx';
import { CountPill } from '../CountPill/CountPill.tsx';
import { Mark, Wordmark } from '../Mark/Mark.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';
import { Switch } from '../Switch/Switch.tsx';

import './Sidebar.css';

/** The owner app's pages, in the sidebar's fixed order. */
export type NavKey = 'today' | 'conversations' | 'people' | 'rules' | 'safety' | 'share' | 'settings';

/** What a nav row's link receives: a router's link component takes the same props as `<a>`. */
export interface SidebarLinkProps {
  href: string;
  className: string;
  'aria-current'?: 'page';
  children: ReactNode;
}

/** A count beside a nav row: the number shown, and the words read instead of it. */
export interface NavCount {
  n: number;
  label: string;
}

export interface SidebarProps {
  /** The current business's name: "Rivera Plumbing". */
  business: string;
  /** Opens the business switcher (`SwitcherMenu`). */
  onSwitchBusiness: () => void;
  /** The current business's Desks. The Desk picker shows only with two or more. */
  desks: { id: string; name: string }[];
  currentDeskId: string;
  onSwitchDesk: (deskId: string) => void;
  /** The page the owner is on; its row is marked `aria-current="page"`. */
  current: NavKey;
  /** Where each row goes. */
  hrefs: Record<NavKey, string>;
  /** The business's word for the people it serves, the third row: "Customers", "Clients". */
  peopleLabel: string;
  /** Counts on Conversations and Safety only; `attention` adds a held dot beside Safety's. */
  counts?: { conversations?: NavCount; safety?: NavCount & { attention?: boolean } };
  /** Whether Claude is answering on this Desk. */
  answering: boolean;
  onAnsweringChange: (answering: boolean) => void;
  /** The owner's name and one line of status: "Available for chats". */
  owner: { name: string; status: string };
  /** The router's link component for the nav rows; a plain `<a>` by default. */
  linkComponent?: ComponentType<SidebarLinkProps>;
}

const NAV_ROWS = [
  { key: 'today', icon: 'today', label: 'Today' },
  { key: 'conversations', icon: 'conversations', label: 'Conversations' },
  { key: 'people', icon: 'people', label: null },
  { key: 'rules', icon: 'rules', label: 'Rules' },
  { key: 'safety', icon: 'safety', label: 'Safety' },
  { key: 'share', icon: 'share', label: 'Share' },
  { key: 'settings', icon: 'settings', label: 'Settings' },
] as const satisfies readonly { key: NavKey; icon: IconName; label: string | null }[];

function PlainLink({ children, ...props }: SidebarLinkProps) {
  return <a {...props}>{children}</a>;
}

/** The first letter of the first and last words, as written: "Maria Rivera" is "MR". */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return [first, last].map((word) => (word === undefined ? '' : (Array.from(word)[0] ?? ''))).join('');
}

/**
 * The owner app's sidebar: the Claude Desk mark, the business and Desk switchers, the seven pages
 * in a fixed order, and at the bottom the Answering switch and the owner. It fills the column the
 * `AppShell` gives it.
 */
export function Sidebar({
  business,
  onSwitchBusiness,
  desks,
  currentDeskId,
  onSwitchDesk,
  current,
  hrefs,
  peopleLabel,
  counts,
  answering,
  onAnsweringChange,
  owner,
  linkComponent: Link = PlainLink,
}: SidebarProps) {
  return (
    <div className="cd-sidebar">
      <div className="cd-sidebar__brand">
        <Mark />
        <Wordmark beta />
      </div>
      <button
        type="button"
        className="cd-sidebar__business cd-type-control"
        aria-haspopup="menu"
        aria-label={`Switch business, current: ${business}`}
        onClick={onSwitchBusiness}
      >
        <span className="cd-sidebar__ellipsis" data-copy="user">
          {business}
        </span>
        <Icon name="chevrons" size={16} className="cd-sidebar__quiet-icon" />
      </button>
      {desks.length >= 2 ? (
        <DeskPicker business={business} desks={desks} currentDeskId={currentDeskId} onSwitchDesk={onSwitchDesk} />
      ) : null}
      <nav className="cd-sidebar__nav" aria-label="Main">
        {NAV_ROWS.map((row) => {
          const count = row.key === 'conversations' ? counts?.conversations : row.key === 'safety' ? counts?.safety : undefined;
          const attention = row.key === 'safety' && counts?.safety?.attention === true;
          return (
            <Link
              key={row.key}
              href={hrefs[row.key]}
              className="cd-sidebar__row cd-type-control"
              {...(row.key === current ? { 'aria-current': 'page' as const } : {})}
            >
              <Icon name={row.icon} />
              <span className="cd-sidebar__label">{row.label ?? peopleLabel}</span>
              {attention ? <StatusDot tone="held" /> : null}
              {count ? <CountPill count={count.n} label={count.label} /> : null}
            </Link>
          );
        })}
      </nav>
      <div className="cd-sidebar__footer">
        <Switch label="Answering" description="Claude answers under your rules" checked={answering} onChange={onAnsweringChange} />
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
        <ul id={listId} className="cd-sidebar__desk-list" aria-label={`Desks in ${business}`}>
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
