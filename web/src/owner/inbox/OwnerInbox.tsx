/**
 * Today's Demo inbox: what Claude would have sent the owner by text or email (the kernel's alert
 * for each held request, the copy's codes and ledger checkpoints), in the design system's
 * `DemoInboxPanel` with `viewer="owner"`, each entry with when it came on the business's clock.
 * "Open the Demo inbox" opens it, the copy's inbox is read then and again every few seconds while
 * it is open, and nothing is read while it is closed.
 *
 * The design system's Demo inbox sheet takes its place once it ships; until then the panel opens
 * in place, under the button that opens and closes it.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { request } from '../../api/http.ts';
import { pollMs } from '../../app/poll.ts';
import { Button, DemoInboxPanel, Notice, type DemoInboxItem } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { useReadFailure } from '../useReadFailure.ts';

import './OwnerInbox.css';

export const OWNER_INBOX_KEY = ['ownerInbox'] as const;

export interface OwnerInboxProps {
  /** The business's IANA time zone: each entry's time is on its clock. */
  timezone: string;
}

export function OwnerInbox({ timezone }: OwnerInboxProps) {
  const [open, setOpen] = useState(false);
  const inbox = useQuery({
    queryKey: OWNER_INBOX_KEY,
    queryFn: () => request('ownerInbox'),
    enabled: open,
    refetchInterval: open ? pollMs('inbox') : false,
  });
  const failure = useReadFailure(inbox);

  const now = new Date();
  // Oldest first, as the panel takes them; it shows the newest at the top.
  const items: DemoInboxItem[] = [...(inbox.data ?? [])]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((entry) => ({
      notice: { entry_id: entry.entry_id, to: entry.to, preview: '' },
      entry,
      time: formatWhen(entry.created_at, timezone, now),
    }));

  return (
    <div className="cd-owner-inbox">
      <Button variant="secondary" onClick={() => setOpen((was) => !was)}>
        {open ? 'Close the Demo inbox' : 'Open the Demo inbox'}
      </Button>
      {open && failure !== null ? (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
              Try again
            </Button>
          }
        >
          {failure.line}
        </Notice>
      ) : null}
      {open && inbox.data === undefined && failure === null ? (
        <p className="cd-owner-inbox__opening cd-type-meta" role="status">
          Opening your Demo inbox
        </p>
      ) : null}
      {open && inbox.data !== undefined ? (
        <div className="cd-owner-inbox__panel">
          {/* Every entry here is fetched whole, so nothing waits to open and nothing needs a retry. */}
          <DemoInboxPanel viewer="owner" items={items} language="en" onRetry={() => void inbox.refetch()} />
        </div>
      ) : null}
    </div>
  );
}
