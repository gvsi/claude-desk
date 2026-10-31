import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import type { PolicyVersion } from '../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { PolicyVersionOut, RulesDraft, SetupState } from '../api/views.ts';
import { Button, Card, EmptyState, LoadingLine, Notice, PageHeader, SafetyCheckRow, StatusLabel } from '../ds/index.ts';
import { capOf, draftFromDiff, draftFromVersion, type RuleDraft } from '../owner/rules/drafts.ts';
import { checkStatus } from '../owner/rules/checkStatus.ts';
import { RuleDraftReview, rulesQuery } from '../owner/rules/RuleDraftReview.tsx';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { gaveUp, setupRulesQuery } from './shared.ts';

const copy = SETUP_COPY.safety;

export interface SafetyStepProps {
  state: SetupState;
  /** The interview's rules are confirmed: on to the preview. */
  onConfirmed: () => void;
  /** Reads the interview again after a write whose answer was lost; null when it can't be read. */
  reread: () => Promise<SetupState | null>;
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
 * real and no one contacted, each with whether it was stopped and the kernel's reason, arriving one
 * by one. "Confirm rules" sends `setupConfirm`, which activates them with Answering still off; when
 * the rules changed since the draft, the new draft shows in the change review, and its "Confirm
 * change" confirms setup again.
 */
export function SafetyStep({ state, onConfirmed, reread }: SafetyStepProps) {
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

  /** Confirms setup's rules; an answer that is the redrafted rules (after a proving retry) is confirmed once more. */
  const confirmSetup = async (): Promise<PolicyVersion> => {
    const first = await request('setupConfirm', { params: { id } });
    if (!isDraft(first)) return first;
    const second = await request('setupConfirm', { params: { id } });
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
  if (draft.data === undefined) {
    body = draft.isError ? failure(draft.error, () => void draft.refetch()) : <LoadingLine>{copy.loading}</LoadingLine>;
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
    body = <LoadingLine>{copy.loading}</LoadingLine>;
  } else {
    const { rows, blocked, total } = check.data;
    body = (
      <>
        <div className="cd-setup-safety__summary">
          {/* The check's own counts, never worked out here. */}
          <p className="cd-setup-safety__count cd-type-summary">{copy.blocked(blocked, total)}</p>
          <p className="cd-setup-step__line cd-type-body">{copy.lead(total)}</p>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={copy.empty} body={copy.emptyBody} />
        ) : (
          <Card padding={16}>
            <ul role="list" className="cd-setup-step__rows" aria-label={copy.label}>
              {rows.map((row, index) => (
                <li key={`${index}-${row.label}`}>
                  <SafetyCheckRow
                    label={row.label}
                    attempt={row.tries}
                    blocked={row.blocked}
                    {...(row.blocked ? { stoppedBy: 'action' as const } : {})}
                    reason={row.result.reason_plain}
                    index={index}
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
      {body}
    </div>
  );
}
