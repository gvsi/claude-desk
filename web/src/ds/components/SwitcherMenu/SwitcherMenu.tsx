import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';
import { initialsOf } from '../Sidebar/Sidebar.tsx';

import './SwitcherMenu.css';

/** A business the owner can switch to, with its Desks in their order. */
export interface SwitcherBusiness {
  id: string;
  name: string;
  desks: { id: string; name: string }[];
}

/** Where the owner is going: always a Desk, with the business it belongs to. */
export interface SwitcherPick {
  businessId: string;
  deskId: string;
}

export interface SwitcherMenuProps {
  /** The owner's businesses, in the order the menu lists them. */
  businesses: SwitcherBusiness[];
  currentBusinessId: string;
  currentDeskId: string;
  /** Another Desk was picked: one of the current business's, or another business's first Desk. */
  onPick: (pick: SwitcherPick) => void;
  /** "New business" was picked. */
  onNewBusiness: () => void;
  /** The menu is done: Escape, Tab, a click outside, or after any pick. The screen removes it. */
  onClose: () => void;
}

const ITEMS = '[role="menuitem"], [role="menuitemradio"]';

/** "1 Desk", "2 Desks", or "No Desks yet" for a business that can't be opened yet. */
function deskCount(n: number): string {
  if (n === 0) return 'No Desks yet';
  return n === 1 ? '1 Desk' : `${n} Desks`;
}

/**
 * The owner's businesses as a menu, with the current business's Desks under it and "New business"
 * last. It opens with focus on the current Desk; the arrow keys, Home and End move through it,
 * Enter or Space picks, and Escape closes it and returns focus to whatever opened it.
 */
export function SwitcherMenu({ businesses, currentBusinessId, currentDeskId, onPick, onNewBusiness, onClose }: SwitcherMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const groupId = useId();
  const current = businesses.find((business) => business.id === currentBusinessId);
  const currentDesk = current?.desks.find((desk) => desk.id === currentDeskId);
  const [active, setActive] = useState(() =>
    currentDesk ? `desk:${currentDesk.id}` : current ? `business:${current.id}` : (businesses[0] ? `business:${businesses[0].id}` : 'new'),
  );

  // The latest onClose, for the document listener below.
  const close = useRef(onClose);
  close.current = onClose;

  // Focus moves to the current Desk when the menu opens. When it goes, focus returns to what
  // opened it, unless the owner has moved focus somewhere else since.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return undefined;
    const doc = menu.ownerDocument;
    opener.current = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    menu.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    return () => {
      const focused = doc.activeElement;
      const focusInside = focused === null || focused === doc.body || menu.contains(focused);
      if (focusInside && opener.current?.isConnected) opener.current.focus();
    };
  }, []);

  // A press outside the menu closes it. A press on the opener is left to the screen.
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return undefined;
    const doc = menu.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || opener.current?.contains(target))) return;
      close.current();
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    return () => doc.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      // Tab leaves the menu for the next control, and the menu closes behind it.
      onClose();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    if (items.length === 0) return;
    const index = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index <= 0 ? items.length - 1 : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  const pick = (choice: SwitcherPick | null) => {
    if (choice) onPick(choice);
    onClose();
  };

  const item = (key: string, props: Omit<ItemProps, 'tabIndex' | 'onFocus'>) => (
    <Item key={key} {...props} tabIndex={active === key ? 0 : -1} onFocus={() => setActive(key)} />
  );

  return (
    <div ref={ref} role="menu" aria-label="Switch business or Desk" className="cd-switcher-menu" onKeyDown={onKeyDown}>
      {businesses.map((business) => {
        const isCurrent = business.id === currentBusinessId;
        const first = business.desks[0];
        return (
          <Fragment key={business.id}>
            {item(`business:${business.id}`, {
              role: 'menuitemradio',
              checked: isCurrent,
              disabled: !isCurrent && first === undefined,
              className: 'cd-switcher-menu__business',
              onSelect: () => pick(isCurrent || !first ? null : { businessId: business.id, deskId: first.id }),
              children: (
                <>
                  <span className="cd-switcher-menu__monogram cd-type-count" aria-hidden="true">
                    {initialsOf(business.name)}
                  </span>
                  <span className="cd-switcher-menu__text">
                    <span className="cd-switcher-menu__name cd-type-control" data-copy="user">
                      {business.name}
                    </span>
                    <span className="cd-switcher-menu__caption cd-type-caption">{deskCount(business.desks.length)}</span>
                  </span>
                  {isCurrent ? <Icon name="check" size={16} className="cd-switcher-menu__check" /> : null}
                </>
              ),
            })}
            {isCurrent && business.desks.length > 0 ? (
              <div role="group" aria-labelledby={groupId} className="cd-switcher-menu__desks">
                <span id={groupId} className="cd-switcher-menu__group-label cd-type-caption">
                  Desks in <span data-copy="user">{business.name}</span>
                </span>
                {business.desks.map((desk) => {
                  const isCurrentDesk = desk.id === currentDeskId;
                  return item(`desk:${desk.id}`, {
                    role: 'menuitemradio',
                    checked: isCurrentDesk,
                    className: 'cd-switcher-menu__desk',
                    onSelect: () => pick(isCurrentDesk ? null : { businessId: business.id, deskId: desk.id }),
                    children: (
                      <>
                        <span className="cd-switcher-menu__name cd-type-control" data-copy="user">
                          {desk.name}
                        </span>
                        {isCurrentDesk ? <Icon name="check" size={16} className="cd-switcher-menu__check" /> : null}
                      </>
                    ),
                  });
                })}
              </div>
            ) : null}
          </Fragment>
        );
      })}
      <div role="separator" className="cd-switcher-menu__separator" />
      {item('new', {
        role: 'menuitem',
        className: 'cd-switcher-menu__new',
        onSelect: () => {
          onNewBusiness();
          onClose();
        },
        children: (
          <>
            <span className="cd-switcher-menu__new-icon">
              <Icon name="plus" size={16} />
            </span>
            <span className="cd-switcher-menu__name cd-type-control">New business</span>
          </>
        ),
      })}
    </div>
  );
}

interface ItemProps {
  role: 'menuitem' | 'menuitemradio';
  checked?: boolean;
  disabled?: boolean;
  className: string;
  tabIndex: 0 | -1;
  onFocus: () => void;
  onSelect: () => void;
  children: ReactNode;
}

/** One row of the menu: a button, so Enter and Space pick it like a click. */
function Item({ role, checked, disabled = false, className, tabIndex, onFocus, onSelect, children }: ItemProps) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemradio' ? checked === true : undefined}
      // A business that can't be opened stays focusable, as menus expect, and does nothing.
      aria-disabled={disabled || undefined}
      tabIndex={tabIndex}
      className={`cd-switcher-menu__item ${className}`}
      onFocus={onFocus}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      {children}
    </button>
  );
}
