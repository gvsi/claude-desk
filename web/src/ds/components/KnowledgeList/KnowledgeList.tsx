import { useId } from 'react';

import { Card } from '../Card/Card.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';

import './KnowledgeList.css';

/** One thing the Desk answers from, as the owner's list shows it. */
export interface KnowledgeRowView {
  /** The item's id (`KnowledgeItem.item_id`), the row's key. */
  id: string;
  /**
   * The item's own title, kept whether customers can see it or only the owner. Null only when the
   * kernel forces the item owner-only and withholds its title and text: the row then reads "A note
   * only you can see", and only "Only you".
   */
  title: string | null;
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
  /** The items, in the order the screen lists them. With none, nothing is drawn. */
  items: readonly KnowledgeRowView[];
}

/** The title the design system writes for an item whose own title the kernel withholds. */
const WITHHELD_TITLE = 'A note only you can see';

/**
 * "What I know now" on Settings › Knowledge: each thing the Desk answers from, a row with its title,
 * a line under it and who can see it. Read only: an item's switch is where it is added.
 */
export function KnowledgeList({ items }: KnowledgeListProps) {
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section className="cd-knowledge-list" aria-labelledby={headingId}>
      <SectionHeader id={headingId} title="What I know now" />
      <Card padding={0}>
        <ul role="list" className="cd-knowledge-list__rows" aria-labelledby={headingId}>
          {items.map((item) => {
            const withheld = item.title === null;
            // Only an item whose own title reached the web can read as public.
            const customersCanSee = !withheld && item.readers.includes('public');
            return (
              <li key={item.id} className="cd-knowledge-list__row">
                <div className="cd-knowledge-list__words">
                  {withheld ? (
                    <p className="cd-knowledge-list__title cd-type-body">{WITHHELD_TITLE}</p>
                  ) : (
                    <p className="cd-knowledge-list__title cd-type-body" data-copy="user">
                      {item.title}
                    </p>
                  )}
                  {item.detail === null ? null : <p className="cd-knowledge-list__detail cd-type-meta">{item.detail}</p>}
                </div>
                <Pill>{customersCanSee ? 'Customers can see this' : 'Only you'}</Pill>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}
