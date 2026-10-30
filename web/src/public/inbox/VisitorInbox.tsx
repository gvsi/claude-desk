/**
 * The visitor's Demo inbox: where the demo's verification codes arrive instead of a phone or an
 * email inbox, in the design system's `DemoInboxPanel` (`viewer="visitor"`, so it shows only this
 * chat's codes and no times). The stream's notices carry no code: the entries come only from the
 * visitor's own Demo inbox read, made once when the chat opens and again for each new notice, and
 * matched to the notices by `entry_id`. A read that fails marks the entries it should have brought
 * as failed to open, and "Try again" reads again.
 *
 * It shows once there is something in it: a column beside the chat on a window at least 1280 px
 * wide, else in the chat under the conversation. The design system's Demo inbox sheet takes the
 * narrow place once it ships; until then the panel sits there as it is.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DemoInboxEntry, EvDemoInbox } from '../../api/contracts.ts';
import { ApiError, request } from '../../api/http.ts';
import { DemoInboxPanel, type CopyLanguage, type DemoInboxItem } from '../../ds/index.ts';

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
  return { items: [...earlier, ...arrived], retry };
}

export interface VisitorInboxProps {
  view: VisitorInboxView;
  /** `column` beside the chat on a wide window, `inline` under the conversation otherwise. */
  placement: 'column' | 'inline';
  /** Page chrome's language: the browser's. */
  language: CopyLanguage;
}

/** The panel in its place; nothing until the inbox has something in it. */
export function VisitorInbox({ view, placement, language }: VisitorInboxProps) {
  if (view.items.length === 0) return null;
  const panel = <DemoInboxPanel viewer="visitor" items={view.items} language={language} onRetry={view.retry} />;
  // The panel is a region named by its own title, so the place around it is a plain block.
  return <div className={placement === 'column' ? 'cd-public-chat__inbox-column' : 'cd-public-chat__inbox'}>{panel}</div>;
}
