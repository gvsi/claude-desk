import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';

import type { PolicyVersion } from '../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { PolicyVersionOut, RulesDraft, SetupState } from '../api/views.ts';
import { Button, Card, EmptyState, Notice, PageHeader, SafetyCheckRow, SkeletonScreen, StatusLabel } from '../ds/index.ts';
import { capOf, draftFromDiff, draftFromVersion, type RuleDraft } from '../owner/rules/drafts.ts';
import { checkStatus } from '../owner/rules/checkStatus.ts';
import { RuleDraftReview, rulesQuery } from '../owner/rules/RuleDraftReview.tsx';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { useLanding } from './landing.ts';
import { gaveUp, setupRulesQuery } from './shared.ts';
import { SafetyCheckSkeleton } from './StepSkeletons.tsx';

const copy = SETUP_COPY.safety;

export interface SafetyStepProps {
  state: SetupState;
  /** The interview's rules are confirmed: on to the preview. */
  onConfirmed: () => void;
  /** Reads the interview again after a write whose answer was lost; null when it can't be read. */
  reread: () => Promise<SetupState | null>;
  /**
   * The owner came to the safety check on this page (from Real situations): the check runs as they
   * watch, and its rows land as they arrive. Setup opened at the safety check (a reload, or resumed
   * from Today) draws its first results still.
   */
  live: boolean;
}

/** A setup confirm's answer that is a rules draft, which a proving retry can give, rather than the confirmed version. */
const isDraft = (value: PolicyVersion | RulesDraft): value is RulesDraft => 'summary' in value && !('status' in value);

/**
 * Setup's redrafted rules against the rules in force, as the change review shows them: by the
 * draft's diff when it has one, else card by card against the active version.
 */
function conflictReview(active: PolicyVersionOut, draft: RulesDraft): RuleDraft {
  if (draft.diff !== null) return draftFromDiff(draft, active);
  const version: PolicyVersionOut = { ...active, version: draft.version, cards: draft.cards, proof: draft.proof, auto_money_cap_cents: capOf(draft) };
  return draftFromVersion(active, version, []);
}

/**
 * The safety check (`setupSafetyCheck`): the tricks people use, tried on the draft rules with nothing
 * real and no one contacted, each with whether it was stopped and the kernel's reason. A check that
 * just ran lands one by one, in the order tried, the count above ticking with it. "Confirm rules"
 * sends `setupConfirm`, which activates them with Answering still off; when the rules changed since
 * the draft, the new draft shows in the change review, and its "Confirm change" confirms setup again.
 */
export function SafetyStep({ state, onConfirmed, reread, live }: SafetyStepProps) {
  const queryClient = useQueryClient();
  const id = state.interview_id;
  const exit = `/app/${encodeURIComponent(state.desk_id)}/today`;
  // The draft first, however the step was opened: only one whose check passed is tried and confirmed.
  const draft = useQuery(setupRulesQuery(id));
  const status = draft.data === undefined ? null : checkStatus(draft.data.proof);
  const checked = status?.status === 'checked';
  const check = useQuery({
    queryKey: ['setupSafetyCheck', id] as const,
    queryFn: () => request('setupSafetyCheck', { params: { id } }),
    enabled: checked,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RuleDraft | null>(null);
  /** The server said the rules can't be checked: only "Save and exit". */
  const [unchecked, setUnchecked] = useState(false);
  const tricks = useRef<HTMLUListElement>(null);
  const landing = useLanding(tricks, check, live, check.data?.rows.length ?? 0);

  /**
   * Confirms a draft made again on a conflict. After "Change something" the API confirms a draft only
   * once its safety check has run, which such a draft's hasn't: its 409 `conflict` runs the check on
   * it, then confirms once more. Any other setup confirms it with no check the owner wouldn't see.
   */
  const confirmChecked = async (): Promise<PolicyVersion | RulesDraft> => {
    try {
      return await request('setupConfirm', { params: { id } });
    } catch (err) {
      if (!(err instanceof ApiError && err.kind === 'conflict' && err.code === 'conflict')) throw err;
      await request('setupSafetyCheck', { params: { id } });
      return request('setupConfirm', { params: { id } });
    }
  };

  /** Confirms setup's rules; an answer that is the redrafted rules (after a proving retry) is confirmed once more. */
  const confirmSetup = async (): Promise<PolicyVersion> => {
    // "Confirm rules" confirms the draft whose check is on screen; the conflict review's, its new draft.
    const first = conflict !== null ? await confirmChecked() : await request('setupConfirm', { params: { id } });
    if (!isDraft(first)) return first;
    const second = await confirmChecked();
    if (isDraft(second)) throw new ApiError('unavailable', { route: 'setupConfirm', method: 'POST', status: 200 });
    return second;
  };

  /** The rules changed since the draft: the API's new draft, against the rules in force, to review. */
  const showConflict = async (draft: RulesDraft) => {
    const active = (await queryClient.fetchQuery({ ...rulesQuery(state.desk_id), staleTime: 0 })).active;
    setConflict(conflictReview(active, draft));
  };

  /**
   * Setup's way to settle a confirm that failed, for "Confirm rules" and the conflict review's
   * "Confirm change" alike. Resolves to the line to show, or null when the step has moved on: a
   * rules change shows its new draft; the server's own can't-check answer leaves only "Save and
   * exit"; a lost answer, the proving give-up or a 409 (setup is past the safety check once
   * confirmed) reads the interview, and at the preview it was confirmed. A give-up that hasn't moved
   * on is unknown, not failed: the button stays, since pressing again joins the work still running.
   */
  const recover = async (err: unknown): Promise<string | null> => {
    if (err instanceof ApiError && err.code === 'rules_changed_since_draft' && err.draft !== null) {
      try {
        await showConflict(err.draft);
        return null;
      } catch (readError) {
        return ownerErrorCopy(readError);
      }
    }
    if (err instanceof ApiError && err.code === 'rules_cannot_be_checked' && !gaveUp(err)) {
      setConflict(null);
      setUnchecked(true);
      return null;
    }
    const unsure = isUncertain(err) || (err instanceof ApiError && err.kind === 'conflict');
    const now = unsure ? await reread() : null;
    if (now !== null && (now.step === 'preview' || now.step === 'live')) return null;
    return gaveUp(err) ? stillCheckingLine() : ownerErrorCopy(err);
  };

  const confirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      await confirmSetup();
      onConfirmed();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      const line = await recover(err);
      if (line !== null) setError(line);
    } finally {
      setConfirming(false);
    }
  };

  if (conflict !== null) {
    // The review's "Confirm change" confirms setup again, and a failure is settled as "Confirm rules" settles it.
    return (
      <div className="cd-setup-step">
        <PageHeader title={SETUP_COPY.rules.title} subtitle={copy.conflictSubtitle} />
        <Notice tone="info">{copy.changedSince}</Notice>
        <RuleDraftReview
          key={conflict.version}
          deskId={state.desk_id}
          draft={conflict}
          inline
          confirm={confirmSetup}
          onConfirmError={recover}
          cancelLabel={copy.back}
          onDone={(outcome) => {
            if (outcome === 'confirmed') {
              onConfirmed();
              return;
            }
            // Back: the earlier rows described the earlier draft, so the safety check runs again,
            // on the draft that is now the one to confirm.
            setConflict(null);
            void queryClient.resetQueries({ queryKey: ['setupSafetyCheck', id] });
          }}
        />
      </div>
    );
  }

  const cantCheck = (
    <>
      <Notice tone="info">{SETUP_COPY.rules.cantCheck}</Notice>
      <div className="cd-setup-step__actions">
        <Button variant="primary" size="main" href={exit}>
          {SETUP_COPY.saveAndExit}
        </Button>
      </div>
    </>
  );
  /** A read that failed: rules that can't be checked go no further; anything else can be tried again. */
  const failure = (failed: unknown, retry: () => void): ReactNode =>
    failed instanceof ApiError && failed.code === 'rules_cannot_be_checked' ? (
      cantCheck
    ) : (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={retry}>
            {SETUP_COPY.questions.tryAgain}
          </Button>
        }
      >
        {ownerErrorCopy(failed)}
      </Notice>
    );

  let body: ReactNode;
  // While the draft or the check is read, the step draws as its shapes.
  let reading = false;
  if (draft.data === undefined) {
    body = draft.isError ? failure(draft.error, () => void draft.refetch()) : null;
    reading = !draft.isError;
  } else if (status?.status === 'failed') {
    // The check ran and failed: what didn't pass, and only "Save and exit".
    body = (
      <>
        <ul role="list" className="cd-setup-rules__checks">
          {status.lines.map((line) => (
            <li key={line} className="cd-type-meta">
              <StatusLabel tone="refused">{line}</StatusLabel>
            </li>
          ))}
        </ul>
        <div className="cd-setup-step__actions">
          <Button variant="primary" size="main" href={exit}>
            {SETUP_COPY.saveAndExit}
          </Button>
        </div>
      </>
    );
  } else if (!checked || unchecked) {
    body = cantCheck;
  } else if (check.isError) {
    // The latest run failed: its rows, from an earlier run, no longer stand, and nothing confirms on them.
    body = failure(check.error, () => void check.refetch());
  } else if (check.data === undefined) {
    body = null;
    reading = true;
  } else {
    const { rows, blocked: stopped, total } = check.data;
    // The check's own counts, never worked out here. While the rows land, the count on screen
    // follows them (those stopped among the rows landed so far, of all the check tried), hidden from
    // assistive tech, which reads the check's own counts at once, as it reads all the rows at once.
    // Neither is in a live region, so nothing is announced as it ticks.
    const final = copy.stopped(stopped, total);
    const ticking = landing.live ? copy.stopped(rows.slice(0, landing.landed).filter((row) => row.blocked).length, total) : null;
    body = (
      <>
        <div className="cd-setup-safety__summary">
          <p className="cd-setup-safety__count cd-type-summary">
            {ticking === null ? (
              final
            ) : (
              <>
                <span aria-hidden="true">{ticking}</span>
                <span className="cd-sr-only">{final}</span>
              </>
            )}
          </p>
          <p className="cd-setup-step__line cd-type-body">{copy.lead(total)}</p>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={copy.empty} body={copy.emptyBody} />
        ) : (
          <Card padding={16}>
            {/* Each read's rows are drawn anew, so a check that just ran lands. */}
            <ul key={check.dataUpdatedAt} ref={tricks} role="list" className="cd-setup-step__rows" aria-label={copy.label}>
              {rows.map((row, index) => (
                <li key={`${index}-${row.label}`}>
                  <SafetyCheckRow
                    label={row.label}
                    attempt={row.tries}
                    outcome={row.result.outcome}
                    blocked={row.blocked}
                    {...(row.blocked ? { stoppedBy: 'action' as const } : {})}
                    reason={row.result.reason_plain}
                    index={index}
                    live={landing.live}
                  />
                </li>
              ))}
            </ul>
          </Card>
        )}
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <div className="cd-setup-step__actions">
          <Button variant="primary" size="main" busy={confirming} waiting={check.isFetching} onClick={() => void confirm()}>
            {copy.confirm}
          </Button>
          <Button variant="secondary" size="main" busy={check.isFetching} waiting={confirming} onClick={() => void check.refetch()}>
            {copy.runAgain}
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.title} />
      {/* A check that just ran lands under the fading shapes, its rows one by one. */}
      <SkeletonScreen loading={reading} status={copy.loading} skeleton={<SafetyCheckSkeleton />} className="cd-setup-step__region">
        {body}
      </SkeletonScreen>
    </div>
  );
}
