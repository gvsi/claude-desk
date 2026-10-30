/**
 * The link from an About this prototype page into the prototype: to the last Desk this browser opened, or to
 * the start of the prototype when it has opened none. It reads only the Desk's id the owner app stored in this
 * browser, never the Desk's name, and makes no request, so the page reads the same for anyone.
 */
import { Link } from 'react-router';

import { Icon } from '../ds/index.ts';
import { readLocal } from '../lib/storage.ts';

import './PrototypeLink.css';

export interface PrototypeLinkProps {
  /** The phone's top bar: the same words, without the outline. */
  compact?: boolean;
}

export function PrototypeLink({ compact = false }: PrototypeLinkProps) {
  const lastDesk = readLocal('lastDesk');
  const to = lastDesk ? `/app/${encodeURIComponent(lastDesk)}/today` : '/';
  return (
    <Link className={`cd-about-try cd-type-control${compact ? ' cd-about-try--compact' : ''}`} to={to}>
      <Icon name="conversations" size={compact ? 18 : 16} className="cd-about-try__icon" />
      Try Desk prototype
    </Link>
  );
}
