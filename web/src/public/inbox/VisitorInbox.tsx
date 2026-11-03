/**
 * The visitor's Demo inbox: where the demo's verification codes arrive instead of a phone or an
 * email inbox, in the design system's `DemoInboxPanel` (`viewer="visitor"`, so it shows only this
 * chat's codes and no times). The stream's notices carry no code: the entries come only from the
 * visitor's own Demo inbox read, made once when the chat opens and again for each new notice, and
 * matched to the notices by `entry_id`. A read that fails marks the entries it should have brought
 * as failed to open, and "Try again" reads again; one with no entry to mark, while a code is
 * awaited, says so in the inbox's place.
 *
 * On a window at least 1280 px wide it is a column beside the chat, once there is something in it
 * or while a code is awaited.
 * Below that it is the design system's `DemoInboxSheet`: its "Demo inbox" button under the
 * conversation, from the moment the chat asks for a code or a code's notice arrives, and the sheet
 * that rises from the bottom and opens itself on the first code.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DemoInboxEntry, EvDemoInbox } from '../../api/contracts.ts';
import { ApiError, request } from '../../api/http.ts';
import {
  Button,
  DemoInboxPanel,
  DemoInboxSheet,
  Notice,
  SectionHeader,
  type CopyLanguage,
  type DemoInboxItem,
} from '../../ds/index.ts';
import { PUBLIC_COPY } from '../copy.ts';

import './VisitorInbox.css';

/** From this window width the inbox is a column of its own beside the chat. */
const WIDE = '(min-width: 1280px)';

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Whether the window is wide enough for the inbox's own column. */
export function useWideWindow(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
}

/** What the last Demo inbox read brought, and how many notices the chat had when it was sent. */
interface Read {
  entries: DemoInboxEntry[];
  /** The notices before this index are ones the read should have brought. */
  covers: number;
  failed: boolean;
}

export interface VisitorInboxView {
  items: DemoInboxItem[];
  /** A notice has arrived on this page: the chat sent a code here. */
  noticed: boolean;
  /** The last read failed. With no items it names no entry, as after a reload whose read failed. */
  failed: boolean;
  retry: () => void;
}

/**
 * The inbox of the chat whose session is `sessionId` with `slug`'s Desk, from its `notices` in the
 * order they arrived. Reads only while `active` (the chat is open), never the owner's inbox.
 */
export function useVisitorInbox(slug: string, sessionId: string | null, notices: readonly EvDemoInbox[], active: boolean): VisitorInboxView {
  const [read, setRead] = useState<Read>({ entries: [], covers: 0, failed: false });
  // The newest read wins: an older one that answers later changes nothing.
  const latest = useRef(0);
  const count = notices.length;
  const countRef = useRef(count);
  countRef.current = count;

  const readInbox = useCallback(async () => {
    latest.current += 1;
    const id = latest.current;
    const covers = countRef.current;
    try {
      const entries = await request('visitorInbox', { params: { slug } });
      if (id === latest.current) setRead({ entries, covers, failed: false });
    } catch (err) {
      // A 401 is the chat ending, which the chat itself says; anything else failed to open.
      if (id !== latest.current || (err instanceof ApiError && err.kind === 'unauthorized')) return;
      setRead((before) => ({ ...before, covers, failed: true }));
    }
  }, [slug]);

  // A new chat starts with an empty inbox.
  useEffect(() => {
    latest.current += 1;
    setRead({ entries: [], covers: 0, failed: false });
  }, [sessionId]);

  // Once when the chat opens, and again for each notice that arrives.
  useEffect(() => {
    if (active && sessionId !== null) void readInbox();
  }, [active, sessionId, count, readInbox]);

  const byId = new Map(read.entries.map((entry) => [entry.entry_id, entry]));
  const noticed = new Set(notices.map((notice) => notice.entry_id));
  // Entries from before this page opened, which no notice on this page names, come first.
  const earlier: DemoInboxItem[] = read.entries
    .filter((entry) => !noticed.has(entry.entry_id))
    .map((entry) => ({ notice: { entry_id: entry.entry_id, to: entry.to, preview: '' }, entry }));
  const arrived: DemoInboxItem[] = notices.map(({ entry_id, to, preview }, index) => {
    const entry = byId.get(entry_id) ?? null;
    // A read that should have brought it and didn't: failed to open, so "Try again" shows.
    return { notice: { entry_id, to, preview }, entry, failed: entry === null && index < read.covers };
  });
  const retry = useCallback(() => void readInbox(), [readInbox]);
  return { items: [...earlier, ...arrived], noticed: notices.length > 0, failed: read.failed, retry };
}

/**
 * The read failed with no entry to mark it on (a reload mid-verification whose read on load
 * failed) while the visitor waits for a code (`awaitingCode`): the inbox's place says so, rather
 * than showing nothing or an inbox that looks empty.
 */
function unreadable(view: VisitorInboxView, awaitingCode: boolean): boolean {
  return view.items.length === 0 && view.failed && awaitingCode;
}

/** Whether the inbox's column has a place beside the chat: once it has something in it, or while a code is awaited. */
export function inboxShown(view: VisitorInboxView, awaitingCode: boolean): boolean {
  return view.items.length > 0 || awaitingCode;
}

export interface VisitorInboxProps {
  view: VisitorInboxView;
  /** The chat asked for a code that hasn't been confirmed: the inbox is where it arrives. */
  awaitingCode: boolean;
  /** `column` beside the chat on a wide window, `sheet` under the conversation otherwise. */
  placement: 'column' | 'sheet';
  /** Page chrome's language: the browser's. */
  language: CopyLanguage;
}

/**
 * The inbox in its place. As a column, nothing until it has something in it or a code is
 * awaited. As a sheet, its button from the moment the chat asks for a code or a code's notice
 * arrives. Either way, a read
 * that failed with no entry to mark shows the inbox's title over that line and "Try again" while a
 * code is awaited, so the code never just isn't there.
 */
export function VisitorInbox({ view, awaitingCode, placement, language }: VisitorInboxProps) {
  if (unreadable(view, awaitingCode)) {
    return (
      <div className={placement === 'column' ? 'cd-public-chat__inbox-column' : 'cd-public-chat__inbox'}>
        <UnreadableInbox view={view} language={language} />
      </div>
    );
  }
  if (placement === 'sheet') {
    if (!awaitingCode && !view.noticed) return null;
    return (
      <div className="cd-public-chat__inbox-sheet">
        <VisitorSheet view={view} language={language} />
      </div>
    );
  }
  if (view.items.length === 0 && !awaitingCode) return null;
  // The panel is a region named by its own title, so the place around it is a plain block. While
  // a code is awaited it shows even with nothing in it yet, saying so (owner, 2026-11-02): a
  // contact not on record gets no code, and the inbox must still be there to look in.
  return (
    <div className="cd-public-chat__inbox-column">
      <DemoInboxPanel viewer="visitor" items={view.items} language={language} onRetry={view.retry} />
    </div>
  );
}

/** Nothing in the sheet on its first render. */
const NO_ITEMS: DemoInboxItem[] = [];

/**
 * The design system's sheet, which opens itself when its count goes from nothing to something. It
 * is drawn once the inbox matters to the chat, which can be the moment the first code's notice
 * arrives (the API streams it while Claude is still answering, before the verify card), so it
 * starts with nothing in it and takes the entries on its next render: the first code opens it
 * whichever comes first.
 */
function VisitorSheet({ view, language }: { view: VisitorInboxView; language: CopyLanguage }) {
  const [drawn, setDrawn] = useState(false);
  useLayoutEffect(() => setDrawn(true), []);
  return <DemoInboxSheet viewer="visitor" items={drawn ? view.items : NO_ITEMS} language={language} onRetry={view.retry} />;
}

/** The inbox's title over the line that it couldn't be read and "Try again", on the panel's ground. */
function UnreadableInbox({ view, language }: { view: VisitorInboxView; language: CopyLanguage }) {
  const copy = PUBLIC_COPY[language];
  const titleId = `${useId()}-title`;
  return (
    <section className="cd-public-chat__inbox-failed" aria-labelledby={titleId} lang={language}>
      <SectionHeader id={titleId} title={copy.demoInbox} />
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={view.retry}>
            {copy.tryAgain}
          </Button>
        }
      >
        {copy.inboxFailed}
      </Notice>
    </section>
  );
}
