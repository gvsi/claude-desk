/**
 * The switch at the top of each About this prototype page: the set's three pages as links, in order, the one on
 * show marked as the current page. The set's top bar (AboutBar) gives it its classes.
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
