import type { ReactNode } from 'react';

import { Pill } from '../Pill/Pill.tsx';
import { RecordedTag } from '../RecordedTag/RecordedTag.tsx';

import './PersonRow.css';

/** A row's element: one link to `href` when it has one, else a plain block. */
function Row({ href, className, children }: { href?: string; className: string; children: ReactNode }) {
  return href === undefined ? (
    <div className={className}>{children}</div>
  ) : (
    <a href={href} className={`${className} cd-person-row--link`}>
      {children}
    </a>
  );
}

export interface PersonRowProps {
  /** Their name, as they gave it: shown as their own words. */
  name: string;
  /** The contact on record, masked as the kernel sends it: "d•••@example.com". */
  contact: string;
  /** The person's page. With it the whole row is one link. */
  href?: string;
}

/**
 * Someone on record in the People list: their name, and the contact on record under it, masked.
 * The whole row is one link to their page when it has one. Put each in a list item.
 */
export function PersonRow({ name, contact, href }: PersonRowProps) {
  return (
    <Row href={href} className="cd-person-row">
      <span className="cd-person-row__name cd-type-control" data-copy="user">
        {name}
      </span>
      <span className="cd-person-row__detail cd-type-caption">Contact on record: {contact}</span>
    </Row>
  );
}

export interface LeadRowProps {
  /** Their name, as they gave it: shown as their own words. */
  name: string;
  /** When they came in, as the screen writes it: "Today, 11:24 am". */
  time: string;
  /** What they asked about, as the lead's note says it: shown as written. */
  note: string;
  /** Recorded history replayed into this copy: the Recorded tag at the end of the note's line. */
  recorded?: boolean;
  /** Where the lead opens, when it does. With it the whole row is one link. */
  href?: string;
  /** Left in a demo visitor's chat, an AI the owner started to play a customer: a "Demo visitor" pill after the name. */
  demoVisitor?: boolean;
}

/**
 * A lead in the People list: their name with the time they came in at its right, and what they
 * asked about under it. A replayed lead carries the Recorded tag at the end of the second line,
 * under the time, or on a line of its own under the note when the row is narrow. Put each in a
 * list item.
 */
export function LeadRow({ name, time, note, recorded = false, href, demoVisitor = false }: LeadRowProps) {
  const named = (
    <span className="cd-person-row__name cd-lead-row__name cd-type-control" data-copy="user">
      {name}
    </span>
  );
  return (
    <Row href={href} className="cd-person-row cd-lead-row">
      <span className="cd-lead-row__grid">
        {demoVisitor ? (
          <span className="cd-lead-row__who">
            {named}
            <Pill>Demo visitor</Pill>
          </span>
        ) : (
          named
        )}
        <span className="cd-lead-row__time cd-type-caption">{time}</span>
        <span className="cd-person-row__detail cd-lead-row__note cd-type-caption" data-copy="user">
          {note}
        </span>
        {recorded ? <RecordedTag className="cd-lead-row__recorded" /> : null}
      </span>
    </Row>
  );
}
