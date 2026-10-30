import type { ComponentType } from 'react';

import type { SidebarLinkProps } from '../Sidebar/Sidebar.tsx';

import './SubNav.css';

/** One page in a section's navigation. */
export interface SubNavItem {
  key: string;
  label: string;
  href: string;
}

export interface SubNavProps {
  /** What the pages are of, which names the navigation: "Settings". */
  label: string;
  items: readonly SubNavItem[];
  /** The `key` of the page the owner is on; its link is marked `aria-current="page"`. */
  current: string;
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<SidebarLinkProps>;
}

function PlainLink({ children, ...props }: SidebarLinkProps) {
  return <a {...props}>{children}</a>;
}

/**
 * The pages of one section, such as Settings: vertical rows like the sidebar's, the current one on
 * the selected fill. At phone width they become one line that scrolls sideways inside itself.
 */
export function SubNav({ label, items, current, linkComponent: Link = PlainLink }: SubNavProps) {
  return (
    <nav aria-label={label} className="cd-sub-nav">
      <ul className="cd-sub-nav__list">
        {items.map((item) => (
          <li key={item.key} className="cd-sub-nav__item">
            <Link
              href={item.href}
              className="cd-sub-nav__link cd-type-control"
              aria-current={item.key === current ? 'page' : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
