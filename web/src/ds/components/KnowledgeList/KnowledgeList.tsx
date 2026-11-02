import { useId, type ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';

import { Card } from '../Card/Card.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';

import './KnowledgeList.css';

/** One thing the Desk answers from, as the owner's list shows it. */
export interface KnowledgeRowView {
  /** The item's id (`KnowledgeItem.item_id`), the row's key. */
  id: string;
  kind?: 'globe' | 'list' | 'note' | 'document';
  fileTag?: 'PDF' | 'DOCX';
  pill?: 'Mock' | 'Coming later' | null;
  /**
   * The item's own title, kept whether customers can see it or only the owner. Null only when the
   * kernel forces the item owner-only and withholds its title and text: the row then reads "A note
   * only you can see", and only "Only you".
   */
  title: string | null;
  /** Keep a recognized short source title on one line beside its readers pill. */
  singleLineTitle?: boolean;
  /**
   * The line under the title, in the screen's words: where the item came from ("From your answers
   * in setup", "turner-plumbing.example, read during setup") or when it was added ("Added Oct 27").
   * Null leaves the line out when the date was not recorded.
   */
  detail: string | null;
  /**
   * Who may read it: the item's `label.readers`, as the kernel returned them. With "public" the row
   * says "Customers can see this"; otherwise "Only you".
   */
  readers: readonly string[];
}

export interface KnowledgeListProps {
  /** The items in order. With none, only the heading and note are drawn when a note is supplied. */
  items: readonly KnowledgeRowView[];
  title?: string;
  caption?: ReactNode;
  note?: ReactNode;
}

/** The title the design system writes for an item whose own title the kernel withholds. */
const WITHHELD_TITLE = 'A note only you can see';

/**
 * "What Claude knows" on Knowledge: each thing the Desk answers from, a row with its title,
 * a line under it and who can see it. Read only: an item's switch is where it is added.
 */
export function KnowledgeList({ items, title = 'What Claude knows', caption, note }: KnowledgeListProps) {
  const headingId = useId();
  if (items.length === 0 && !note) return null;
  return (
    <section className="cd-knowledge-list" aria-labelledby={headingId}>
      <SectionHeader id={headingId} title={title} caption={caption} />
      {note}
      {items.length > 0 ? <div className={note ? 'cd-knowledge-list__noted-card' : undefined}>
        <Card padding={0}>
          <ul role="list" className="cd-knowledge-list__rows" aria-labelledby={headingId}>
            {items.map((item) => {
              const withheld = item.title === null;
              // Only an item whose own title reached the web can read as public.
              const customersCanSee = !withheld && item.readers.includes('public');
              return (
                <li key={item.id} className="cd-knowledge-list__row">
                  {item.kind ? (
                    <span className="cd-knowledge-list__tile" data-kind={item.kind} aria-hidden="true">
                      <Icon name={item.kind} />
                      {item.fileTag ? <span className="cd-knowledge-list__file-tag cd-type-file-tag">{item.fileTag}</span> : null}
                    </span>
                  ) : null}
                  <div className="cd-knowledge-list__words">
                    {withheld ? (
                      <p className="cd-knowledge-list__title cd-type-body">{WITHHELD_TITLE}</p>
                    ) : (
                      <p className={`cd-knowledge-list__title cd-type-body${item.singleLineTitle ? ' cd-knowledge-list__title--single-line' : ''}`} title={item.singleLineTitle ? item.title ?? undefined : undefined} data-copy="user">
                        {item.title}
                      </p>
                    )}
                    {item.detail === null ? null : <p className="cd-knowledge-list__detail cd-type-meta">{item.detail}</p>}
                  </div>
                  {item.pill === null ? null : <Pill>{item.pill ?? (customersCanSee ? 'Customers can see this' : 'Only you')}</Pill>}
                </li>
              );
            })}
          </ul>
        </Card>
      </div> : null}
    </section>
  );
}
