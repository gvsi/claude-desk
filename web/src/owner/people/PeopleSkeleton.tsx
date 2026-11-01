import { useRef } from 'react';

import { PageHeaderSkeleton, Skeleton } from '../../ds/index.ts';
import { useTextLines } from '../../lib/useTextLines.ts';
import { PEOPLE_SUBTITLE } from './copy.ts';

import './People.css';

/**
 * A fresh copy's people on record: Contacts on record, its count, and the seed's two contacts, each
 * a `cd-person-row` holding a name and a contact line.
 */
const CONTACTS = [{ name: '30%' }, { name: '40%' }] as const;

/**
 * Customers' list as shapes, built from the page's own classes: the section's head over its
 * hairline with the count beside its title, then a `PersonRow` shape per contact on record. With
 * `withHeader`, the whole page as the full-page loader draws it, the header as shapes too; inside
 * the app the real header stays, and this draws only what is under it.
 */
export function PeopleSkeleton({ withHeader }: { withHeader: boolean }) {
  return withHeader ? <PeoplePageShapes /> : <ListShapes />;
}

/**
 * The whole page, as the full-page loader draws it: the header as shapes, its subtitle in as many
 * lines as its words take at the column's width in this browser's fonts, then the list.
 */
function PeoplePageShapes() {
  const page = useRef<HTMLDivElement>(null);
  const subtitleLines = useTextLines(page, { parts: [PEOPLE_SUBTITLE], className: 'cd-page-header__subtitle cd-type-body' }, 1);
  return (
    <div ref={page} className="cd-people">
      <PageHeaderSkeleton subtitleLines={subtitleLines} />
      <ListShapes />
    </div>
  );
}

/** The list under the header. */
function ListShapes() {
  return (
    <div className="cd-people__section">
      <div className="cd-people__head">
        <div className="cd-section-header">
          <div className="cd-section-header__title">
            <Skeleton shape="line" text="section" width={130} anchor="people-head" />
            <Skeleton
              shape="block"
              className="cd-type-count"
              measure={{ label: String(CONTACTS.length), className: 'cd-count-pill cd-type-count', tagName: 'span' }}
              height="1lh"
              radius="full"
            />
          </div>
        </div>
      </div>
      <div className="cd-people__rows">
        {CONTACTS.map(({ name }, i) => (
          <div key={i} className="cd-person-row" data-skeleton-anchor={`person-row-${i}`}>
            <Skeleton shape="line" text="control" width={name} />
            <Skeleton shape="line" text="caption" width="45%" />
          </div>
        ))}
      </div>
    </div>
  );
}
