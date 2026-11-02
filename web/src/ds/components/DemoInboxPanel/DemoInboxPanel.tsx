import { useId, type ReactNode } from 'react';

import type { DemoInboxEntry, InboxNotice } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Notice } from '../Notice/Notice.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';
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
  /**
   * Where the owner app opens the held request an alert is about. Only an owner's opened alert shows
   * it, as "Open the request"; a code, a checkpoint and every row a visitor sees never do.
   */
  requestHref?: string;
}

export interface DemoInboxPanelProps {
  /** Whose inbox: the owner's, or a visitor's own codes. */
  viewer: 'owner' | 'visitor';
  /** In the order they arrived, oldest first. */
  items: DemoInboxItem[];
  language: CopyLanguage;
  /** Fetch an entry again after it failed to open. */
  onRetry: (entryId: string) => void;
  /** A control at the right of the title's line, such as a sheet's Close. */
  action?: ReactNode;
  /** The title can take focus from a script (`tabIndex={-1}`), as a sheet that opens itself moves it there. */
  titleFocusable?: boolean;
  /**
   * A line the screen draws under the subtitle and above the entries, such as a `Notice` that the
   * latest read failed, so the entries below read as the last ones read.
   */
  notice?: ReactNode;
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

/** A stand-in origin to resolve a link against: no real link can share it. */
const APP_ORIGIN = 'https://desk.invalid';

/**
 * A request link stays in the owner app: a place on this page ("#…"), or a path in it ("/app/…")
 * that a browser resolves to this same site. Anything else draws no link: another site, a script
 * URL, or a path a browser reads as another site ("//…", "/\…").
 */
function inAppHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  if (href.startsWith('#')) return href;
  if (!href.startsWith('/')) return undefined;
  try {
    return new URL(href, APP_ORIGIN).origin === APP_ORIGIN ? href : undefined;
  } catch {
    return undefined;
  }
}

/** The recipient the kernel writes for the owner; anything else is a masked contact on record. */
const OWNER_RECIPIENT = 'owner';

/**
 * Who a notice or entry went to, as far as a visitor's panel can tell: the owner, a contact on
 * record, or unclear (blank, or the owner's word written another way), which counts as not a contact.
 */
function recipientOf(to: string): 'owner' | 'contact' | 'unclear' {
  if (to === OWNER_RECIPIENT) return 'owner';
  const plain = to.trim();
  return plain === '' || plain.toLowerCase() === OWNER_RECIPIENT ? 'unclear' : 'contact';
}

/**
 * A visitor sees only their own codes, never the owner's alerts or ledger checkpoints, whatever the
 * screen passes in. A notice addressed to the owner shows no row at all, whether its entry is
 * opening, failed to open or open. Before its own entry arrives, a row shows only for a notice to
 * a contact on record; one whose recipient is unclear waits, unshown, until its fetched entry (the
 * same `entry_id`) proves it is a verification code that didn't go to the owner.
 */
function shownTo(viewer: DemoInboxPanelProps['viewer'], { notice, entry }: DemoInboxItem): boolean {
  if (viewer === 'owner') return true;
  const to = recipientOf(notice.to);
  if (to === 'owner') return false;
  if (entry === null || entry.entry_id !== notice.entry_id) return to === 'contact';
  return entry.kind === 'verification_code' && recipientOf(entry.to) !== 'owner';
}

/**
 * The latest item for each `entry_id`, newest first. Replaying events after a reconnect can append
 * a notice the screen already holds; it shows once, as the item that arrived last, in that item's
 * place.
 */
function latestFirst(items: readonly DemoInboxItem[]): DemoInboxItem[] {
  const seen = new Set<string>();
  const latest: DemoInboxItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || seen.has(item.notice.entry_id)) continue;
    seen.add(item.notice.entry_id);
    latest.push(item);
  }
  return latest;
}

/**
 * The items `viewer` may see, newest first and one per entry, as the panel shows them: a visitor
 * never gets the owner's alerts or checkpoints. The sheet counts these.
 */
export function shownItems(viewer: DemoInboxPanelProps['viewer'], items: readonly DemoInboxItem[]): DemoInboxItem[] {
  return latestFirst(items).filter((item) => shownTo(viewer, item));
}

/**
 * Where the demo's codes and alerts arrive instead of a phone or email inbox: the newest first, in
 * a polite live region, each entry's body shown word for word once it is fetched. Nothing fetches
 * here; codes come only from the entries the screen passes in.
 */
export function DemoInboxPanel({ viewer, items, language, onRetry, action, titleFocusable = false, notice }: DemoInboxPanelProps) {
  const copy = INBOX_COPY[language];
  const titleId = `${useId()}-title`;
  // Newest first, one row per entry: the screen keeps them in the order they arrived.
  const shown = shownItems(viewer, items);
  const title = (
    <h2 id={titleId} className="cd-demo-inbox__title cd-type-section" tabIndex={titleFocusable ? -1 : undefined}>
      {copy.title}
    </h2>
  );

  return (
    <section className="cd-demo-inbox" aria-labelledby={titleId} lang={language}>
      {action === undefined ? (
        title
      ) : (
        <div className="cd-demo-inbox__head-row">
          {title}
          {action}
        </div>
      )}
      <p className="cd-demo-inbox__subtitle cd-type-meta">{viewer === 'owner' ? copy.ownerSubtitle : copy.subtitle}</p>
      {notice ?? null}
      {/* Always present, so an entry that arrives later is read out. */}
      <div className="cd-demo-inbox__entries" aria-live="polite">
        {shown.length === 0 ? (
          // A notice (a read that failed) stands alone: the inbox may not be empty.
          notice ? null : <p className="cd-demo-inbox__empty cd-type-meta">{copy.empty}</p>
        ) : (
          <ul role="list" className="cd-demo-inbox__list">
            {shown.map((item) => (
              <InboxItem
                key={item.notice.entry_id}
                notice={item.notice}
                time={viewer === 'owner' ? item.time : undefined}
                requestHref={viewer === 'owner' ? inAppHref(item.requestHref) : undefined}
                titled={viewer === 'owner'}
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
  /** The owner's link to the held request, or nothing for a visitor. */
  requestHref: string | undefined;
  /** An entry's `title` may show, as it may on the owner's panel only. */
  titled: boolean;
  view: ItemView;
  copy: InboxCopy;
  onRetry: (entryId: string) => void;
}

/**
 * The line above an opened entry's body: on the owner's panel, the title the kernel gives the
 * owner's alerts (the alert's fixed preview line); otherwise, or when it is missing or blank, the
 * entry's kind.
 */
function headingOf(entry: DemoInboxEntry, titled: boolean, copy: InboxCopy): string {
  const title = titled ? entry.title?.trim() : undefined;
  return title ? title : copy.kinds[entry.kind];
}

function InboxItem({ notice, time, requestHref, titled, view, copy, onRetry }: InboxItemProps) {
  return (
    <li className="cd-demo-inbox__item">
      <p className="cd-demo-inbox__head cd-type-caption">
        <span className="cd-demo-inbox__to">{`${copy.to} ${notice.to}`}</span>
        {time ? <span className="cd-demo-inbox__time">{time}</span> : null}
      </p>
      {view.kind === 'open' ? (
        <>
          <p className="cd-demo-inbox__kind cd-type-meta">{headingOf(view.entry, titled, copy)}</p>
          {/* A ledger checkpoint is a signed record, so it reads in the trace's monospace. */}
          <p className={`cd-demo-inbox__body ${view.entry.kind === 'head_checkpoint' ? 'cd-type-trace' : 'cd-type-body'}`}>
            {view.entry.body}
          </p>
          {requestHref && view.entry.kind === 'alert' ? (
            <p className="cd-demo-inbox__request cd-type-meta">
              <TextLink href={requestHref}>{copy.openRequest}</TextLink>
            </p>
          ) : null}
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
