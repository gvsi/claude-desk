import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactNode } from 'react';

import { ApiError, ownerErrorCopy, request } from '../api/http.ts';
import type { PeopleOut, RulesDraft, SetupState, SetupStep, ToolRow } from '../api/views.ts';
import {
  Button,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  SectionHeader,
  SituationRow,
  SkeletonScreen,
  StatusLabel,
  type StatusTone,
} from '../ds/index.ts';
import { listWords } from '../lib/format.ts';
import { businessTools } from '../owner/connectors/catalog.ts';
import { checkStatus, type CheckStatus } from '../owner/rules/checkStatus.ts';
import { RULES_SECTIONS } from '../owner/rules/copy.ts';
import { capOf } from '../owner/rules/drafts.ts';
import { AcrossYourDeskRules, moneyTitles, NeverMovesMoney, ToolConnectors, ToolRule, toolGroups, type ToolGroup, type ToolsView } from '../owner/rules/HouseRules.tsx';
import { peopleQuery } from '../owner/rules/RuleDraftReview.tsx';
import { moneyCapBandSentence } from '../owner/rules/ruleSentence.ts';
import { situationSentence } from './situationSentence.ts';
import { SETUP_COPY } from './copy.ts';
import { useLanding } from './landing.ts';
import { aroundBusiness, setupRulesQuery, useChangeSomething, useOpensAtTop } from './shared.ts';
import { PublicLinesStep } from './PublicLinesStep.tsx';
import { DraftRulesSkeleton, SituationsSkeleton } from './StepSkeletons.tsx';

// Rules' sections and their gaps (`cd-rules__section`, `cd-rules__tool-cards`), so Your rules is laid out as Rules is.
import '../owner/rules/RulesPage.css';

const copy = SETUP_COPY.rules;

export interface RulesStepProps {
  state: SetupState;
  /** The business's name, once known. */
  business: string;
  /** The interview moved on. */
  onNext: (step: SetupStep) => void;
  reread: () => Promise<SetupState | null>;
  /**
   * The owner came to Real situations on this page (from the rules): the situations are tried as
   * they watch, and their rows land as they arrive. Setup opened at Real situations (a reload, or
   * resumed from Today) draws its first results still.
   */
  live: boolean;
}

const CHECK_TONES: Readonly<Record<CheckStatus['status'], StatusTone>> = { checked: 'handled', failed: 'refused', unavailable: 'held' };

/**
 * The draft and its check, drawn as Rules draws its rules (REV-SETUP-3, option A), with the same
 * components, so a card reads the same here and there: "Across your Desk", then each tool the
 * owner turned on with the rules it starts under (`ToolConnectors`, read only: no Details, no
 * "Change", no links). Payments and Stripe open with the payment limit and "never moves money"; a
 * job that moves money ends its list with them, as on Rules. Then the check's lines.
 */
function DraftRules({ draft, people, tools, check }: { draft: RulesDraft; people: PeopleOut | null | undefined; tools: readonly ToolRow[]; check: CheckStatus }) {
  const acrossId = useId();
  const toolsId = useId();
  const view: ToolsView = { tools: [...tools], active: { cards: draft.cards } };
  const cap = capOf(draft);
  const none = toolGroups(view, people ?? null).length === 0;
  // The limit leads each card whose tools move money, read only: no "Change" in setup (owner ruling, 2026-10-30).
  const moneyBand = (group: ToolGroup) => {
    const titles = moneyTitles(group, view);
    return (
      <>
        <ToolRule parts={moneyCapBandSentence(cap)} line={listWords(titles)} status="held" detailsPlace={false} data={{ 'data-money-limit': true }} />
        <NeverMovesMoney titles={titles} />
      </>
    );
  };
  return (
    <>
      <section className="cd-rules__section" aria-labelledby={acrossId}>
        <SectionHeader id={acrossId} title={RULES_SECTIONS.across.title} caption={RULES_SECTIONS.across.caption} />
        <AcrossYourDeskRules details={false} />
      </section>
      <section className="cd-rules__section" aria-labelledby={toolsId}>
        <SectionHeader id={toolsId} title={RULES_SECTIONS.tools.title} caption={copy.toolsCaption} />
        {none ? <EmptyState title={copy.empty} body={copy.emptyBody} /> : (
          <div className="cd-rules__tool-cards">
            <ToolConnectors readOnly view={view} people={people ?? null} moneyBand={moneyBand} cap={cap} />
          </div>
        )}
      </section>
      {/* A check that couldn't run is said once, above the rules. */}
      {check.status === 'unavailable' ? null : (
        <ul role="list" className="cd-setup-rules__checks">
          {check.lines.map((line) => (
          <li key={line} className="cd-type-meta">
            <StatusLabel tone={CHECK_TONES[check.status]}>{line}</StatusLabel>
          </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * "Your rules": setup's draft from the answers (`setupRules`), read against the Desk's tools
 * (`setupTools`) as Rules reads its rules: the rules across the Desk, then each tool with the rules
 * it starts under, the payment limit leading the money tools', and the check. A
 * draft that can't be checked can't go on: only "Save and exit". "Check real situations" runs the
 * draft on situations from the owner's answers, which land one by one as they arrive; "Looks right"
 * opens the public lines review before the safety check.
 */
export function RulesStep({ state, business, onNext, reread, live }: RulesStepProps) {
  const id = state.interview_id;
  const exit = `/app/${encodeURIComponent(state.desk_id)}/today`;
  const [view, setView] = useState<'rules' | 'situations' | 'public_lines'>(state.step === 'situations' ? 'situations' : 'rules');
  // Real situations and What customers will read each open at their top, as setup's steps do.
  useOpensAtTop(view);
  const draft = useQuery(setupRulesQuery(id));
  // What each tool starts under is read against the Desk's tools, as Rules reads them.
  const tools = useQuery({ queryKey: ['setupTools', id] as const, queryFn: () => request('setupTools', { params: { id } }), refetchOnWindowFocus: false });
  const people = useQuery({ ...peopleQuery(state.desk_id), refetchOnWindowFocus: false });
  const situations = useQuery({
    queryKey: ['setupSituations', id] as const,
    queryFn: () => request('setupSituations', { params: { id } }),
    enabled: view === 'situations' && draft.data !== undefined && checkStatus(draft.data.proof).status === 'checked',
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const situationRows = useRef<HTMLUListElement>(null);
  // "Change something": back to the chat with Claude, over Real situations.
  const changeSomething = useChangeSomething(id);
  const landing = useLanding(situationRows, situations, live, situations.data?.length ?? 0);

  const saveAndExit = (
    <div className="cd-setup-step__actions">
      <Button variant="primary" size="main" href={exit}>
        {SETUP_COPY.saveAndExit}
      </Button>
    </div>
  );
  const cantCheck = (
    <>
      <Notice tone="info">{copy.cantCheck}</Notice>
      {saveAndExit}
    </>
  );
  const failure = (error: unknown, retry: () => void): ReactNode =>
    error instanceof ApiError && error.code === 'rules_cannot_be_checked' ? (
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
        {ownerErrorCopy(error)}
      </Notice>
    );

  // The situations go on only from a draft whose check passed, however the stage was opened.
  const checked = draft.data !== undefined && checkStatus(draft.data.proof).status === 'checked';
  if (view === 'public_lines' && checked) return <PublicLinesStep state={state} onNext={onNext} reread={reread} />;
  if (view === 'situations' && checked) {
    const s = SETUP_COPY.situations;
    let body: ReactNode;
    if (situations.data === undefined) {
      body = situations.isError ? failure(situations.error, () => void situations.refetch()) : null;
    } else {
      body = (
        <>
          {situations.data.length === 0 ? (
            <EmptyState title={s.empty} body={s.emptyBody} />
          ) : (
            <Card padding={16}>
              {/* Each read's rows are drawn anew, so situations just tried land. */}
              <ul key={situations.dataUpdatedAt} ref={situationRows} role="list" className="cd-setup-step__rows" aria-label={s.label}>
                {situations.data.map(({ situation, result, matches }, index) => (
                  <li key={`${index}-${situation.title}`}>
                    <SituationRow
                      title={situation.title}
                      who={s.who[situation.who] ?? s.who.public}
                      outcome={result.outcome}
                      dependsOnReview={result.depends_on_review}
                      reason={result.reason_plain}
                      sentence={situationSentence({ situation, result, matches }, draft.data, { business: businessTools(tools.data?.tools ?? []), people: people.data, tools: tools.data?.tools, cards: draft.data.cards })}
                      matches={matches}
                      index={index}
                      live={landing.live}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div className="cd-setup-step__actions">
            <Button variant="secondary" size="main" onClick={changeSomething}>
              {SETUP_COPY.changeSomething}
            </Button>
            <Button variant="primary" size="main" onClick={() => setView('public_lines')}>
              {s.looksRight}
            </Button>
          </div>
        </>
      );
    }
    return (
      <div className="cd-setup-step">
        <PageHeader title={s.title} subtitle={aroundBusiness(s.subtitle, business)} />
        <SkeletonScreen
          loading={situations.data === undefined && !situations.isError}
          status={s.loading}
          skeleton={<SituationsSkeleton />}
          className="cd-setup-step__region"
        >
          {body}
        </SkeletonScreen>
      </div>
    );
  }

  let body: ReactNode;
  if (draft.data === undefined) {
    body = draft.isError ? failure(draft.error, () => void draft.refetch()) : null;
  } else if (tools.data === undefined) {
    // The rules are read against the tools: without them, nothing would say what each tool starts under.
    body = tools.isError ? failure(tools.error, () => void tools.refetch()) : null;
  } else {
    const check = checkStatus(draft.data.proof);
    // Only a draft whose check passed goes on; one that can't be checked, or failed, waits here.
    body = (
      <>
        {/* Only a check that couldn't run says so; one that failed says what didn't pass, in its lines below. */}
        {check.status === 'unavailable' ? <Notice tone="info">{copy.cantCheck}</Notice> : null}
        <DraftRules draft={draft.data} people={people.data} tools={tools.data.tools} check={check} />
        {check.status === 'checked' ? (
          <div className="cd-setup-step__actions">
            <Button variant="primary" size="main" onClick={() => setView('situations')}>
              {copy.checkSituations}
            </Button>
          </div>
        ) : (
          saveAndExit
        )}
      </>
    );
  }
  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
      {/* The rows name customers from the people read, so the draft waits for it too. Opened at
          Real situations, the draft is read first, under the situations' shapes and words. */}
      <SkeletonScreen
        loading={draft.data === undefined ? !draft.isError : people.isPending || (tools.data === undefined && !tools.isError)}
        status={view === 'situations' ? SETUP_COPY.situations.loading : copy.loading}
        skeleton={view === 'situations' ? <SituationsSkeleton /> : <DraftRulesSkeleton />}
        className="cd-setup-step__region"
      >
        {body}
      </SkeletonScreen>
    </div>
  );
}
