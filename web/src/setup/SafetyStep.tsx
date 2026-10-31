import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import type { PolicyVersion } from '../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { PolicyVersionOut, RulesDraft, SetupState } from '../api/views.ts';
import { Button, Card, EmptyState, LoadingLine, Notice, PageHeader, SafetyCheckRow } from '../ds/index.ts';
import { capOf, draftFromDiff, draftFromVersion, type RuleDraft } from '../owner/rules/drafts.ts';
import { checkStatus } from '../owner/rules/checkStatus.ts';
import { RuleDraftReview, rulesQuery } from '../owner/rules/RuleDraftReview.tsx';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { setupRulesQuery } from './RulesStep.tsx';

const copy = SETUP_COPY.safety;

export interface SafetyStepProps {
  state: SetupState;
  /** The interview's rules are confirmed: on to the preview. */
  onConfirmed: () => void;
  /** Reads the interview again after a write whose answer was lost; null when it can't be read. */
  reread: () => Promise<SetupState | null>;
}

/**
 * The checking ran out of time on this side: the client's own give-up after a minute of proving
 * retries (no answer from the server, so no status), as against the server's 409 that the rules
 * can't be checked.
 */
export function gaveUp(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'rules_cannot_be_checked' && err.status === null;
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
  const checked = draft.data !== undefined && checkStatus(draft.data.proof).status === 'checked';
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

  const confirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      await confirmSetup();
      onConfirmed();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      if (err instanceof ApiError && err.code === 'rules_changed_since_draft' && err.draft !== null) {
        await showConflict(err.draft).catch((readError: unknown) => setError(ownerErrorCopy(readError)));
        return;
      }
      if (err instanceof ApiError && err.code === 'rules_cannot_be_checked' && !gaveUp(err)) {
        setUnchecked(true);
        return;
      }
      // A lost answer, the give-up, or a 409 (setup is past the safety check once confirmed) may
      // mean they were confirmed: the interview as it stands says whether it moved on.
      const unsure = isUncertain(err) || (err instanceof ApiError && err.kind === 'conflict');
      const now = unsure ? await reread() : null;
      if (now !== null && (now.step === 'preview' || now.step === 'live')) return;
      setError(gaveUp(err) ? stillCheckingLine() : ownerErrorCopy(err));
    } finally {
      setConfirming(false);
    }
  };

  if (conflict !== null) {
    // The review's "Confirm change" confirms setup again; a second conflict shows its own new draft.
    const confirmAgain = async () => {
      try {
        await confirmSetup();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'rules_changed_since_draft' && err.draft !== null) await showConflict(err.draft);
        throw err;
      }
    };
    return (
      <div className="cd-setup-step">
        <PageHeader title={SETUP_COPY.rules.title} subtitle={copy.conflictSubtitle} />
        <Notice tone="info">{copy.changedSince}</Notice>
        <RuleDraftReview
          key={conflict.version}
          deskId={state.desk_id}
          draft={conflict}
          inline
          confirm={confirmAgain}
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
