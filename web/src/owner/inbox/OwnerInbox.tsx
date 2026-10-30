/**
 * Today's Demo inbox: what Claude would have sent the owner by text or email (the kernel's alert
 * for each held request, the copy's codes and ledger checkpoints), in the design system's
 * `DemoInboxSheet` with `viewer="owner"`: a "Demo inbox" button with a count, which opens the
 * entries in a sheet at the right, each with when it came on the business's clock.
 *
 * The copy's inbox is read once as Today opens, so the button counts what is there and the sheet
 * opens onto entries already read, never onto an inbox that only looks empty. It is read again as
 * the sheet opens and every few seconds while it is open, and not while it is closed. While that
 * first read is out, the button's place says the inbox is opening; if it fails, the inbox's title
 * says it couldn't be opened, with "Try again". A later read that fails says the same under the
 * sheet's button, so the entries read before never pass for current.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useSyncExternalStore, type RefObject } from 'react';

import { request } from '../../api/http.ts';
import { pollMs } from '../../app/poll.ts';
import { Button, DemoInboxSheet, LoadingLine, Notice, SectionHeader, type DemoInboxItem } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { useReadFailure } from '../useReadFailure.ts';

import './OwnerInbox.css';

export const OWNER_INBOX_KEY = ['ownerInbox'] as const;

export interface OwnerInboxProps {
  /** The business's IANA time zone: each entry's time is on its clock. */
  timezone: string;
}

/**
 * Whether the sheet inside `box` is open. The design system's sheet keeps that to itself and draws
 * its `dialog` only while it is open, so this watches `box` for it.
 */
function useSheetOpen(box: RefObject<HTMLElement | null>): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const el = box.current;
      if (!el) return () => undefined;
      const observer = new MutationObserver(onChange);
      observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
      return () => observer.disconnect();
    },
    [box],
  );
  return useSyncExternalStore(subscribe, () => box.current?.querySelector('dialog[open]') != null);
}

export function OwnerInbox({ timezone }: OwnerInboxProps) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = `${useId()}-title`;
  const open = useSheetOpen(box);
  const inbox = useQuery({
    queryKey: OWNER_INBOX_KEY,
    queryFn: () => request('ownerInbox'),
    // Once as Today opens; after that, only while the sheet is open.
    refetchInterval: open ? pollMs('inbox') : false,
    refetchOnWindowFocus: open,
    refetchOnReconnect: open,
  });
  const failure = useReadFailure(inbox);

  // Read again as the sheet opens, so it shows what is there now.
  const { refetch } = inbox;
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  const now = new Date();
  // Oldest first, as the sheet takes them; it shows the newest at the top.
  const items: DemoInboxItem[] = [...(inbox.data ?? [])]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((entry) => ({
      notice: { entry_id: entry.entry_id, to: entry.to, preview: '' },
      entry,
      time: formatWhen(entry.created_at, timezone, now),
    }));

  // The latest read failed, whether or not one worked before.
  const failed =
    failure === null ? null : (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
            Try again
          </Button>
        }
      >
        {`Couldn't open your Demo inbox. ${failure.line}`}
      </Notice>
    );

  let content;
  if (inbox.data !== undefined) {
    // Every entry here is read whole, so nothing waits to open; a retry reads them all again. The
    // sheet stays first, so a failed read's line coming or going never closes it.
    content = (
      <>
        <DemoInboxSheet viewer="owner" items={items} language="en" onRetry={() => void refetch()} />
        {failed}
      </>
    );
  } else if (failed !== null) {
    // Nothing read yet, so no sheet, which would say the inbox is empty: its title over the line.
    content = (
      <section className="cd-owner-inbox__failed" aria-labelledby={titleId}>
        <SectionHeader id={titleId} title="Demo inbox" />
        {failed}
      </section>
    );
  } else {
    content = <LoadingLine>Opening your Demo inbox</LoadingLine>;
  }
  return (
    <div ref={box} className="cd-owner-inbox">
      {content}
    </div>
  );
}
