/**
 * The link from an About this prototype page into the prototype: to the last Desk this browser opened, or to
 * the start of the prototype when it has opened none (`prototypeHref`).
 */
import { Link } from 'react-router';

import { Icon } from '../ds/index.ts';
import { prototypeHref } from './prototypeHref.ts';

import './PrototypeLink.css';

export interface PrototypeLinkProps {
  /** The phone's top bar: the same words, without the outline. */
  compact?: boolean;
}

export function PrototypeLink({ compact = false }: PrototypeLinkProps) {
  return (
    <Link className={`cd-about-try cd-type-control${compact ? ' cd-about-try--compact' : ''}`} to={prototypeHref()}>
      <Icon name="conversations" size={compact ? 18 : 16} className="cd-about-try__icon" />
      Try Desk prototype
    </Link>
  );
}
