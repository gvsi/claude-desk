import type { ReactNode } from 'react';

import type { BriefingItem, BriefingKind } from '../../api/views.ts';
import { Pill, StatusLabel, type StatusTone } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { DEMO_VISITOR_PILL } from '../conversations/copy.ts';
import { conversationPath } from '../conversations/status.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { causeLabel } from '../safety/copy.ts';
import { useTodayNow } from './todayClock.ts';

/** Each kind's word and dot. A turned-down request is no alarm: its dot is the hollow, neutral one. */
const KINDS = {
  turned_down: { word: 'Turned down', tone: 'info' },
  booking: { word: 'Booked', tone: 'handled' },
  lead: { word: 'New lead', tone: 'info' },
  answer: { word: 'Answered', tone: 'handled' },
} as const satisfies Record<BriefingKind, { word: string; tone: StatusTone }>;

/** Whether this build knows how to show `item`: a kind added to the API later is left out rather than misnamed. */
export function isShown(item: BriefingItem): boolean {
  return Object.hasOwn(KINDS, item.kind);
}

/** A name someone gave, as their own text. */
function Name({ children }: { children: string }) {
  return (
    <span className="cd-user-name" data-copy="user">
      {children}
    </span>
  );
}

/**
 * Who it was: the name they gave, as their own text, else "Visitor"; a demo visitor's with its pill
 * beside the name, so it's never taken for a real customer's.
 */
function Who({ item, name }: { item: BriefingItem; name: string | null }) {
  return (
    <span className="cd-briefing-row__who">
      {name !== null ? <Name>{name}</Name> : 'Visitor'}
      {item.demo_visitor === true ? <Pill>{DEMO_VISITOR_PILL}</Pill> : null}
    </span>
  );
}

/** The row's words: what happened, in the signed cause labels, the kernel's words or the visitor's own. */
function words(item: BriefingItem): ReactNode {
  const name = item.display_name?.trim() ? item.display_name : null;
  switch (item.kind) {
    case 'turned_down': {
      // Why it was turned down, in the owner's signed words for its cause. With no cause this build
      // has words for, the kernel's reason when there is one, else nothing beside the kind's word.
      const why = causeLabel({ kind: 'refused', cause: item.cause }) ?? item.line;
      const tag = item.demo_visitor === true ? <Pill>{DEMO_VISITOR_PILL}</Pill> : null;
      if (!why) return tag === null ? null : <span className="cd-briefing-row__line">{tag}</span>;
      return (
        <span className="cd-briefing-row__line">
          {why}
          {tag}
        </span>
      );
    }
    case 'booking':
      return (
        <>
          <Who item={item} name={name} />
          {item.line ? <span className="cd-briefing-row__line">{item.line}</span> : null}
        </>
      );
    case 'lead':
      return (
        <>
          <Who item={item} name={name} />
          {item.line ? (
            <span className="cd-briefing-row__line" data-copy="user">
              {item.line}
            </span>
          ) : null}
        </>
      );
    case 'answer':
      return (
        <span className="cd-briefing-row__line">
          Claude answered {name !== null ? <Name>{name}</Name> : 'a visitor'}.
          {item.demo_visitor === true ? <Pill>{DEMO_VISITOR_PILL}</Pill> : null}
        </span>
      );
  }
}

/** Where a row leads: a turned-down request to its page on Safety, anything else to its conversation, if it has one. */
function hrefFor(deskId: string, item: BriefingItem): string | null {
  if (item.kind === 'turned_down') return `/app/${encodeURIComponent(deskId)}/safety/${encodeURIComponent(item.ref_id)}`;
  return item.session_id === null ? null : conversationPath(deskId, item.session_id);
}

export interface BriefingRowProps {
  item: BriefingItem;
}

/**
 * One thing that happened since last night: when, on the business's clock, what kind of thing it
 * was, and what happened. The row is one link to where it happened, when it happened somewhere.
 */
export function BriefingRow({ item }: BriefingRowProps) {
  const { business, desk } = useOwnerDesk();
  const now = useTodayNow();
  if (!isShown(item)) return null;
  const kind = KINDS[item.kind];
  const href = hrefFor(desk.desk_id, item);
  const content = (
    <>
      <span className="cd-briefing-row__when cd-type-caption">{formatWhen(item.at, business.timezone, now)}</span>
      <span className="cd-briefing-row__kind cd-type-meta">
        <StatusLabel tone={kind.tone}>{kind.word}</StatusLabel>
      </span>
      <span className="cd-briefing-row__words cd-type-meta">{words(item)}</span>
    </>
  );
  return href === null ? (
    <div className="cd-briefing-row">{content}</div>
  ) : (
    <a className="cd-briefing-row cd-briefing-row--link" href={href}>
      {content}
    </a>
  );
}
