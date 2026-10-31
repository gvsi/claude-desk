/**
 * The switch at the top of each About this prototype page: the set's three pages as links, in order, the one on
 * show marked as the current page. Each page draws it in its own look, so the classes are the page's.
 */
import { Link } from 'react-router';

import { ABOUT_SET_LINKS, type AboutPageId } from './links.ts';

export interface AboutSwitchProps {
  current: AboutPageId;
  className: string;
  linkClassName: string;
}

export function AboutSwitch({ current, className, linkClassName }: AboutSwitchProps) {
  return (
    <nav className={className} aria-label="About this prototype">
      {ABOUT_SET_LINKS.map((link) => (
        <Link key={link.id} className={linkClassName} to={link.href} aria-current={link.id === current ? 'page' : undefined}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
