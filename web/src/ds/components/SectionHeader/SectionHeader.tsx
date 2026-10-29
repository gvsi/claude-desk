import type { ReactNode } from 'react';

import { CountPill } from '../CountPill/CountPill.tsx';

import './SectionHeader.css';

export interface SectionHeaderProps {
  /** The section's name: "Needs you", "What Claude can do here". */
  title: ReactNode;
  /** The heading level, `2` by default (a page's title is its `h1`). */
  level?: 2 | 3 | 4;
  /** The heading's `id`, so the section can be `aria-labelledby` it. */
  id?: string;
  /** A count beside the title, with the words a screen reader hears instead of the number. */
  count?: { n: number; label: string };
  /** One quiet line at the right: "Everything else overnight stayed inside your rules." */
  caption?: ReactNode;
}

export function SectionHeader({ title, level = 2, id, count, caption }: SectionHeaderProps) {
  const Heading = `h${level}` as const;
  return (
    <div className="cd-section-header">
      <div className="cd-section-header__title">
        <Heading id={id} className="cd-section-header__heading cd-type-section">
          {title}
        </Heading>
        {count ? <CountPill count={count.n} label={count.label} /> : null}
      </div>
      {caption ? <p className="cd-section-header__caption cd-type-meta">{caption}</p> : null}
    </div>
  );
}
