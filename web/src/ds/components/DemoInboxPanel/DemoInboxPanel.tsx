import { useId } from 'react';

import type { DemoInboxEntry, InboxNotice } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Notice } from '../Notice/Notice.tsx';
import { INBOX_COPY, type InboxCopy } from './inboxCopy.ts';

import './DemoInboxPanel.css';

/** One entry in the Demo inbox, as the screen holds it. */
export interface DemoInboxItem {
  /** The code-free notice that said the entry exists. */
  notice: InboxNotice;
  /** When it arrived, as the owner's screen shows it ("2:14 pm"). Shown to the owner only. */
  time?: string;
  /** The entry fetched for the notice (the same `entry_id`), or `null` until it is. */
  entry: DemoInboxEntry | null;
  /** Fetching the entry failed. */
  failed?: boolean;
}

export interface DemoInboxPanelProps {
  /** Whose inbox: the owner's, or a visitor's own codes. */
  viewer: 'owner' | 'visitor';
  /** In the order they arrived, oldest first. */
  items: DemoInboxItem[];
  language: CopyLanguage;
  /** Fetch an entry again after it failed to open. */
  onRetry: (entryId: string) => void;
}

/** What an item shows: its entry, that it is opening, or that it failed to open. */
type ItemView = { kind: 'open'; entry: DemoInboxEntry } | { kind: 'opening' } | { kind: 'failed' };

/**
 * An item shows its entry only when the entry is the one its notice names. An entry fetched for
 * another notice never shows under this one: the item reads as not opened, so the screen can fetch
 * it again.
 */
function viewOf({ notice, entry, failed }: DemoInboxItem): ItemView {
  if (entry && entry.entry_id === notice.entry_id) return { kind: 'open', entry };
  return entry || failed ? { kind: 'failed' } : { kind: 'opening' };
}

/**
 * A visitor sees only their own codes, never the owner's alerts or ledger checkpoints, whatever the
 * screen passes in. An item whose kind isn't known yet shows its code-free notice.
 */
function shownTo(viewer: DemoInboxPanelProps['viewer'], { entry }: DemoInboxItem): boolean {
  return viewer === 'owner' || entry === null || entry.kind === 'verification_code';
}

/**
 * Where the demo's codes and alerts arrive instead of a phone or email inbox: the newest first, in
 * a polite live region, each entry's body shown word for word once it is fetched. Nothing fetches
 * here; codes come only from the entries the screen passes in.
 */
export function DemoInboxPanel({ viewer, items, language, onRetry }: DemoInboxPanelProps) {
  const copy = INBOX_COPY[language];
  const titleId = `${useId()}-title`;
  // Newest first: the screen keeps them in the order they arrived.
  const shown = [...items].reverse().filter((item) => shownTo(viewer, item));

  return (
    <section className="cd-demo-inbox" aria-labelledby={titleId} lang={language}>
      <h2 id={titleId} className="cd-demo-inbox__title cd-type-section">
        {copy.title}
      </h2>
      <p className="cd-demo-inbox__subtitle cd-type-meta">{copy.subtitle}</p>
      {/* Always present, so an entry that arrives later is read out. */}
      <div className="cd-demo-inbox__entries" aria-live="polite">
        {shown.length === 0 ? (
          <p className="cd-demo-inbox__empty cd-type-meta">{copy.empty}</p>
        ) : (
          <ul className="cd-demo-inbox__list">
            {shown.map((item) => (
              <InboxItem
                key={item.notice.entry_id}
                notice={item.notice}
                time={viewer === 'owner' ? item.time : undefined}
                view={viewOf(item)}
                copy={copy}
                onRetry={onRetry}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface InboxItemProps {
  notice: InboxNotice;
  /** The owner's display time, or nothing for a visitor. */
  time: string | undefined;
  view: ItemView;
  copy: InboxCopy;
  onRetry: (entryId: string) => void;
}

function InboxItem({ notice, time, view, copy, onRetry }: InboxItemProps) {
  return (
    <li className="cd-demo-inbox__item">
      <p className="cd-demo-inbox__head cd-type-caption">
        <span className="cd-demo-inbox__to">{`${copy.to} ${notice.to}`}</span>
        {time ? <span className="cd-demo-inbox__time">{time}</span> : null}
      </p>
      {view.kind === 'open' ? (
        <>
          <p className="cd-demo-inbox__kind cd-type-meta">{copy.kinds[view.entry.kind]}</p>
          {/* A ledger checkpoint is a signed record, so it reads in the trace's monospace. */}
          <p className={`cd-demo-inbox__body ${view.entry.kind === 'head_checkpoint' ? 'cd-type-trace' : 'cd-type-body'}`}>
            {view.entry.body}
          </p>
        </>
      ) : (
        <>
          <p className="cd-demo-inbox__kind cd-type-meta">{notice.preview}</p>
          <div className="cd-demo-inbox__state">
            {view.kind === 'opening' ? (
              <Notice tone="waiting">{copy.opening}</Notice>
            ) : (
              <Notice
                tone="error"
                action={
                  <Button variant="secondary" onClick={() => onRetry(notice.entry_id)}>
                    {copy.retry}
                  </Button>
                }
              >
                {copy.openFailed}
              </Notice>
            )}
          </div>
        </>
      )}
    </li>
  );
}
