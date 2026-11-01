import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, OWNER_ERROR_COPY, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import type { BusinessOut } from '../../api/views.ts';
import { ACTING_SWITCH_COPY, Button, Card, DetailList, Dialog, Notice, SectionHeader, Switch, type DetailItem } from '../../ds/index.ts';
import { hoursParts } from '../../lib/format.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { DESKS_KEY, findDesk, invalidateCopy, todayPath } from '../useDesks.ts';

/**
 * A Desk's hours window in the signed board's words, "Weekdays 8:00 am to 6:00 pm". No board draws
 * an all-day window, so one reads as Rules writes it, with the comma: "Every day, all day".
 */
function hoursWords({ days, times, allDay }: ReturnType<typeof hoursParts>): string {
  return allDay ? `${days}, ${times}` : `${days} ${times}`;
}

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
  const { business, desk, setAnswering, holdDesk } = useOwnerDesk();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const businessId = useId();
  const deleteId = useId();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A delete whose answer was lost, and the copy couldn't be read after it to say whether it went through.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [rereading, setRereading] = useState(false);
  const removeButtonId = useId();
  const reloadId = useId();

  // Focus that went with a replaced control moves to the one in its place: Reload when the notice
  // takes the place of Delete this Desk, and Delete this Desk when a read shows the Desk still there.
  // Focus the owner has put somewhere else stays there.
  const wasUnconfirmed = useRef(false);
  useEffect(() => {
    const was = wasUnconfirmed.current;
    wasUnconfirmed.current = unconfirmed;
    if (unconfirmed === was) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    document.getElementById(unconfirmed ? reloadId : removeButtonId)?.focus();
  }, [unconfirmed, reloadId, removeButtonId]);

  const details: DetailItem[] = [
    { label: 'Business', value: business.name },
    { label: 'This Desk', value: desk.name },
    { label: 'Customers see you as', value: business.owner_display_name },
    { label: 'Time zone', value: timeZoneWords(business.timezone) },
  ];
  // In the signed board's words: "Weekdays 8:00 am to 6:00 pm, Saturdays 9:00 am to 1:00 pm".
  const hours = desk.hours.map((window) => hoursWords(hoursParts(window)));
  if (hours.length > 0) details.push({ label: 'Hours', value: hours.join(', ') });

  /** The Desk is gone: the business's next Desk's Today, or setup for a new one; then the copy is read again. */
  const leave = async (businesses: readonly BusinessOut[] = [business]) => {
    setConfirming(false);
    const now = businesses.find((b) => b.business_id === business.business_id) ?? business;
    const next = now.desks.find((d) => d.desk_id !== desk.desk_id);
    // Leave this Desk first: read again while it is still shown, the copy without it would say it's gone.
    await navigate(next ? todayPath(next.desk_id) : '/app/setup', { replace: true });
    await invalidateCopy(queryClient);
  };

  /**
   * Reads the copy's Desks to settle a delete whose answer was lost: gone, the owner moves on;
   * still there, `stillThere` says so; unreadable, the delete stays unconfirmed until a read settles it.
   *
   * A read of its own, sent now, outside the shared Desks query: a read of that query already out
   * went before the delete and can't say how it went, and a list without this Desk in that query
   * would show "not found" before the owner has moved on.
   */
  const settle = async (stillThere: () => void) => {
    const read = await request('desks').catch(() => null);
    if (read === null) {
      setConfirming(false);
      setUnconfirmed(true);
      return;
    }
    if (findDesk(read, desk.desk_id) === null) {
      await leave(read);
      return;
    }
    // Still there: the page shows the Desks as just read, and an earlier read still out can't undo that.
    await queryClient.cancelQueries({ queryKey: DESKS_KEY });
    queryClient.setQueryData(DESKS_KEY, read);
    holdDesk(false);
    setUnconfirmed(false);
    stillThere();
  };

  const remove = useMutation({
    mutationFn: () => request('deleteDesk', { params: { desk_id: desk.desk_id } }),
    onMutate: () => {
      setFailure(null);
      // Until the delete is settled, a read of the copy without this Desk leaves this page up to say
      // how it went, rather than "not found"; leaving it, or finding the Desk still there, lets go.
      holdDesk(true);
    },
    onSuccess: () => leave(),
    onError: async (err) => {
      const kind = err instanceof ApiError ? err.kind : null;
      // An ended session returns to the start, as on every owner page.
      if (kind === 'unauthorized') {
        holdDesk(false);
        return;
      }
      const failed = () => {
        setConfirming(false);
        // Not found for a Desk the copy still lists is the server's failure, not a Desk that went.
        setFailure(kind === 'not_found' ? OWNER_ERROR_COPY.unavailable : ownerErrorCopy(err));
      };
      // A lost answer may still have deleted it. Not found may mean it went already (another tab, a
      // delete whose answer was lost) or a route that isn't there. The copy without this Desk says it went.
      if (kind === 'not_found' || isUncertain(err)) {
        await settle(failed);
        return;
      }
      holdDesk(false);
      failed();
    },
  });

  /** "Reload" on an unconfirmed delete: the copy read again; a Desk still there can be deleted again. */
  const reread = async () => {
    setRereading(true);
    try {
      await settle(() => setFailure(null));
    } finally {
      setRereading(false);
    }
  };

  return (
    <>
      <section aria-labelledby={businessId} className="cd-settings__section">
        <SectionHeader id={businessId} title="Your business" />
        <DetailList items={details} />
      </section>
      <Card as="section" label={ACTING_SWITCH_COPY.label} padding={0}>
        <div className="cd-settings__answering">
          <Switch label={ACTING_SWITCH_COPY.label} description={ACTING_SWITCH_COPY[desk.answering ? 'on' : 'off']} checked={desk.answering} onChange={setAnswering} />
        </div>
      </Card>
      <section aria-labelledby={deleteId} className="cd-settings__section cd-settings__delete">
        <SectionHeader id={deleteId} title="Delete this Desk" />
        <div className="cd-settings__delete-row">
          <p className="cd-settings__delete-line cd-settings__quiet cd-type-meta">{DELETE_LINE}</p>
          {/* Never a second delete while the first one's outcome is unknown. */}
          {unconfirmed ? null : (
            <Button id={removeButtonId} variant="secondary" size="main" onClick={() => setConfirming(true)}>
              Delete this Desk
            </Button>
          )}
        </div>
        {unconfirmed ? (
          <Notice
            tone="error"
            action={
              <Button id={reloadId} variant="secondary" busy={rereading} onClick={() => void reread()}>
                Reload
              </Button>
            }
          >
            We couldn't confirm that <span data-copy="user">{desk.name}</span> was deleted. Reload to see where it stands.
          </Notice>
        ) : failure !== null ? (
          <Notice tone="error">{failure}</Notice>
        ) : null}
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
