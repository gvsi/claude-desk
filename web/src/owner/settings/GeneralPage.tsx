import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, OWNER_ERROR_COPY, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import type { BusinessOut } from '../../api/views.ts';
import { ACTING_SWITCH_COPY, Button, Card, Dialog, Notice, SectionHeader, SegmentedControl, Switch } from '../../ds/index.ts';
import { useTheme } from '../../lib/theme.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { DESKS_KEY, findDesk, invalidateCopy, todayPath } from '../useDesks.ts';
import { APPEARANCE_COPY, DELETE_LINE } from './copy.ts';

/**
 * Settings › General: whether Claude acts for this Desk, the theme chosen in this browser, and
 * deleting the Desk with confirmation.
 */
export function GeneralPage() {
  const { business, desk, setAnswering, holdDesk } = useOwnerDesk();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteId = useId();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A delete whose answer was lost, and the copy couldn't be read after it to say whether it went through.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [rereading, setRereading] = useState(false);
  const removeButtonId = useId();
  const reloadId = useId();
  const appearanceId = useId();
  const theme = useTheme();

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

  /** The Desk is gone: another Desk's Today, preferring this business, or setup when none remain. */
  const leave = async (businesses: readonly BusinessOut[] = queryClient.getQueryData<BusinessOut[]>(DESKS_KEY) ?? [business]) => {
    setConfirming(false);
    await queryClient.cancelQueries({ queryKey: DESKS_KEY });
    const remaining = businesses
      .map((b) => ({ ...b, desks: b.desks.filter((d) => d.desk_id !== desk.desk_id) }))
      .filter((b) => b.desks.length > 0);
    queryClient.setQueryData(DESKS_KEY, remaining);
    const now = remaining.find((b) => b.business_id === business.business_id);
    const next = now?.desks[0] ?? remaining.flatMap((b) => b.desks)[0];
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
      <Card as="section" label={ACTING_SWITCH_COPY.label} padding={0}>
        <div className="cd-settings__answering">
          <Switch label={ACTING_SWITCH_COPY.label} description={ACTING_SWITCH_COPY[desk.answering ? 'on' : 'off']} checked={desk.answering} onChange={setAnswering} />
        </div>
      </Card>
      <section aria-labelledby={appearanceId} className="cd-settings__section cd-settings__row-section">
        <SectionHeader id={appearanceId} title={APPEARANCE_COPY.title} />
        <div className="cd-settings__row">
          <p className="cd-settings__row-line cd-settings__quiet cd-type-meta">{APPEARANCE_COPY.line}</p>
          <SegmentedControl label={APPEARANCE_COPY.title} options={APPEARANCE_COPY.options} value={theme.choice} onChange={theme.choose} />
        </div>
      </section>
      <section aria-labelledby={deleteId} className="cd-settings__section cd-settings__row-section">
        <SectionHeader id={deleteId} title="Delete this Desk" />
        <div className="cd-settings__row">
          <p className="cd-settings__row-line cd-settings__quiet cd-type-meta">{DELETE_LINE}</p>
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
              Delete <bdi data-copy="user">{desk.name}</bdi> for <bdi data-copy="user">{business.name}</bdi>?
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
