import type { ComponentType, ReactNode } from 'react';

import type { RulesLinkProps } from '../ToolRulesCard/ToolRulesCard.tsx';

import './Breadcrumb.css';

/** One step back up the trail: its name and, for every step but the page itself, where it goes. */
export interface BreadcrumbItem {
  /**
   * The step's name: "Stripe", "Refund". A node when it holds a name someone chose (a customer's, a
   * business's), so the screen can mark that name as user text and isolate it:
   * `<bdi data-copy="user">`, so a direction mark in the name can't reorder the words around it.
   */
  label: ReactNode;
  href?: string;
  /** A stable key for the step, such as its route. Without one, the step's place in the trail is its key. */
  key?: string;
}

export interface BreadcrumbProps {
  /** The trail from the top, ending with the page itself: "Rules", "Stripe", "Refund". */
  items: readonly BreadcrumbItem[];
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<RulesLinkProps>;
}

function PlainLink({ children, ...props }: RulesLinkProps) {
  return <a {...props}>{children}</a>;
}

/**
 * Where a page sits under Connectors: "Connectors / Stripe / Refund". Every step but the last links back up;
 * the last is the page itself, plain text marked `aria-current="page"`. The slashes between them
 * are drawn only, hidden from screen readers.
 */
export function Breadcrumb({ items, linkComponent: Link = PlainLink }: BreadcrumbProps) {
  const last = items.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="cd-breadcrumb">
      <ol role="list" className="cd-breadcrumb__list cd-type-meta">
        {items.map((item, index) => (
          // A step's own key when the screen gives one; otherwise its place in the trail.
          <li key={item.key ?? index} className="cd-breadcrumb__item">
            {index > 0 ? (
              <span className="cd-breadcrumb__separator" aria-hidden="true">
                /
              </span>
            ) : null}
            {index === last || item.href === undefined ? (
              <span className="cd-breadcrumb__page" aria-current={index === last ? 'page' : undefined}>
                {item.label}
              </span>
            ) : (
              <Link href={item.href} className="cd-breadcrumb__link">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
