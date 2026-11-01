import { Card } from '../Card/Card.tsx';

import './DetailList.css';

/** One detail, in the screen's words: "Business", "Turner Plumbing". */
export interface DetailItem {
  /** What the detail is: "Business", "Customers see you as", "Hours". */
  label: string;
  /** Its value, already in words: "Pacific Time (Los Angeles)", the Desk's hours as the screen writes them. */
  value: string;
}

export interface DetailListProps {
  items: readonly DetailItem[];
}

/**
 * Read-only details in one card, such as Settings › General's business: a row each, its label in
 * small secondary type over its value, ruled between the rows. Nothing in it can be changed here.
 */
export function DetailList({ items }: DetailListProps) {
  return (
    <Card padding={0}>
      <dl className="cd-detail-list">
        {items.map((item) => (
          <div key={item.label} className="cd-detail-list__row">
            <dt className="cd-detail-list__label cd-type-meta">{item.label}</dt>
            <dd className="cd-detail-list__value cd-type-body" data-copy="user">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
