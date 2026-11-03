/**
 * The link from an About this prototype page into the prototype: to the last Desk this browser opened, or to
 * the start of the prototype when it has opened none (`prototypeHref`). It is the page's one primary button, drawn
 * with design system v2's primary button classes (Button.css) on a router link, so it moves within the app: the
 * app window icon, then "Try Desk prototype".
 */
import { Link } from 'react-router';

import { Icon } from '../ds/index.ts';
import { prototypeHref } from './prototypeHref.ts';

import './PrototypeLink.css';

export interface PrototypeLinkProps {
  /** The phone's top bar, where it drops its icon below 360 px (PrototypeLink.css). */
  compact?: boolean;
}

export function PrototypeLink({ compact = false }: PrototypeLinkProps) {
  return (
    <Link
      className={`cd-button cd-button--primary cd-button--inline cd-type-control cd-about-try${compact ? ' cd-about-try--compact' : ''}`}
      to={prototypeHref()}
    >
      <Icon name="app-window" size={16} className="cd-about-try__icon" />
      <span className="cd-button__label">Try Desk prototype</span>
    </Link>
  );
}
