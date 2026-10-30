import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import type { BusinessOut } from '../../api/views.ts';
import { Button, Card, DetailList, Dialog, Notice, SectionHeader, Switch, type DetailItem } from '../../ds/index.ts';
import { formatHours } from '../../lib/format.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { desksQuery, findDesk, invalidateCopy, todayPath } from '../useDesks.ts';

/** What Answering on means, under its switch: the short line, on a laptop as on a phone (owner decision, 2026-10-30). */
const ANSWERING_LINE = 'Claude answers under your rules.';

/** What deleting a Desk does, beside its button and in the dialog that asks first. */
const DELETE_LINE = 'Its public link stops working and its chats close. Its safety record is kept.';

/**
 * An IANA time zone as the owner reads it: its generic name and its city, "Pacific Time (Los
 * Angeles)" for America/Los_Angeles; the generic name alone when it already names the city, and
 * the zone as it came when the browser can't name it.
 */
function timeZoneWords(zone: string): string {
  const city = zone.split('/').at(-1)?.replaceAll('_', ' ') ?? zone;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    if (name === undefined || name === '') return zone;
    return name.includes(city) ? name : `${name} (${city})`;
  } catch {
    return zone;
  }
}

/**
 * Settings › General: the business's details from the copy's Desks, read-only (the business, this
 * Desk, the name customers see, the time zone and the Desk's hours); Answering, the same switch as
 * the sidebar's; and deleting this Desk, which asks first, then opens the business's next Desk's
 * Today, or setup when it was the last one.
 */
export function GeneralPage() {
  const { business, desk, setAnswering } = useOwnerDesk();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const businessId = useId();
  const deleteId = useId();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const details: DetailItem[] = [
    { label: 'Business', value: business.name },
    { label: 'This Desk', value: desk.name },
    { label: 'Customers see you as', value: business.owner_display_name },
    { label: 'Time zone', value: timeZoneWords(business.timezone) },
  ];
  if (desk.hours.length > 0) details.push({ label: 'Hours', value: desk.hours.map(formatHours).join('; ') });

  /** The Desk is gone: the business's next Desk's Today, or setup for a new one; then the copy is read again. */
  const leave = async (businesses: readonly BusinessOut[] = [business]) => {
    setConfirming(false);
    const now = businesses.find((b) => b.business_id === business.business_id) ?? business;
    const next = now.desks.find((d) => d.desk_id !== desk.desk_id);
    // Leave this Desk first: read again while it is still shown, the copy without it would say it's gone.
    await navigate(next ? todayPath(next.desk_id) : '/app/setup', { replace: true });
    await invalidateCopy(queryClient);
  };

  const remove = useMutation({
    mutationFn: () => request('deleteDesk', { params: { desk_id: desk.desk_id } }),
    onMutate: () => setFailure(null),
    onSuccess: () => leave(),
    onError: async (err) => {
      // An ended session returns to the start, as on every owner page.
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // A lost answer may still have deleted it: if the copy no longer has this Desk, it did.
      if (isUncertain(err)) {
        const read = await queryClient.fetchQuery(desksQuery()).catch(() => null);
        if (read !== null && findDesk(read, desk.desk_id) === null) {
          await leave(read);
          return;
        }
      }
      setConfirming(false);
      setFailure(ownerErrorCopy(err));
    },
  });

  return (
    <>
      <section aria-labelledby={businessId} className="cd-settings__section">
        <SectionHeader id={businessId} title="Your business" />
        <DetailList items={details} />
      </section>
      <Card as="section" label="Answering">
        <Switch label="Answering" description={ANSWERING_LINE} checked={desk.answering} onChange={setAnswering} />
      </Card>
      <section aria-labelledby={deleteId} className="cd-settings__section cd-settings__delete">
        <SectionHeader id={deleteId} title="Delete this Desk" />
        <div className="cd-settings__delete-row">
          <p className="cd-settings__delete-line cd-settings__quiet cd-type-meta">{DELETE_LINE}</p>
          <Button variant="secondary" size="main" onClick={() => setConfirming(true)}>
            Delete this Desk
          </Button>
        </div>
        {failure !== null ? <Notice tone="error">{failure}</Notice> : null}
      </section>
      {confirming ? (
        <Dialog
          title={
            <>
              Delete <span data-copy="user">{desk.name}</span>?
            </>
          }
          body={DELETE_LINE}
          confirmLabel="Delete Desk"
          cancelLabel="Keep it"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}
