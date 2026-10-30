/**
 * The way back from an About this prototype page: to the last Desk this browser opened, or to the start of
 * the prototype when it has opened none. It reads only the Desk's id the owner app stored in this browser,
 * never the Desk's name, and makes no request, so the page reads the same for anyone.
 */
import { Link } from 'react-router';

import { Icon } from '../ds/index.ts';
import { readLocal } from '../lib/storage.ts';

import './BackLink.css';

export interface BackLinkProps {
  /** The phone's top bar: the shorter words, without the outline. */
  compact?: boolean;
}

export function BackLink({ compact = false }: BackLinkProps) {
  const lastDesk = readLocal('lastDesk');
  const to = lastDesk ? `/app/${encodeURIComponent(lastDesk)}/today` : '/';
  const words = lastDesk ? (compact ? 'Your Desk' : 'Back to your Desk') : 'Back to the prototype';
  return (
    <Link className={`cd-about-back cd-type-control${compact ? ' cd-about-back--compact' : ''}`} to={to}>
      <Icon name="chevron-down" size={compact ? 18 : 16} className="cd-about-back__icon" />
      {words}
    </Link>
  );
}
