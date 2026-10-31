import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';

import { ApiError, ownerErrorCopy, request } from '../api/http.ts';
import { NotFound } from '../app/NotFound.tsx';
import type { SetupState, SetupStep } from '../api/views.ts';
import { Button, ConceptFooter, LoadingLine, Mark, Notice, Steps, Wordmark } from '../ds/index.ts';
import { inApp, useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { followInAppLinks } from '../owner/inAppLinks.ts';
import { desksQuery, findDesk } from '../owner/useDesks.ts';
import { SETUP_COPY, STEP_INDEX, STEP_NAMES } from './copy.ts';
import { LiveStep } from './LiveStep.tsx';
import { QuestionsStep } from './QuestionsStep.tsx';
import { RulesStep } from './RulesStep.tsx';
import { SafetyStep } from './SafetyStep.tsx';
import { StartStep } from './StartStep.tsx';
import { ToolsStep } from './ToolsStep.tsx';

import './SetupPage.css';

/** A setup interview as it stands, read by its id. */
export function setupQuery(id: string) {
  return queryOptions({ queryKey: ['setup', id], queryFn: () => request('setup', { params: { id } }) });
}

/** Where "Save and exit" goes: the new Desk's Today once there is one, else the start. */
const todayPath = (deskId: string) => `/app/${encodeURIComponent(deskId)}/today`;

/**
 * The bar's compact breakpoint, the About pages' and the setup board's: below it a top bar is a
 * phone's, and a phone's top bar carries no lockup badge (owner, 2026-10-30).
 */
const COMPACT_BAR = '(max-width: 1099.98px)';

function subscribeCompactBar(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT_BAR);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isCompactBar(): boolean {
  return window.matchMedia(COMPACT_BAR).matches;
}

interface SetupShellProps {
  /** The business's name, once the API knows it. Someone's own words. */
  business: string | null;
  /** The step the bar marks, counted from 0. */
  step: number;
  /**
   * The Desk is live: the bar's last step reads done, its check drawing once when the Desk went
   * live on this page (`draw`) or drawn already when the page opened on it (`drawn`).
   */
  live?: 'draw' | 'drawn';
  exitTo: string;
  /** The preview's wider column. */
  wide?: boolean;
  children: ReactNode;
}

/**
 * Setup's frame, as the signed setup boards draw it: the bar with the bell (no tile, 20 px at every
 * width, as on a standalone page) and the wordmark, with its Preview badge from 1100 px up, the
 * business once known, the five steps and "Save and exit"; one column; the concept footer at the
 * window's foot.
 */
function SetupShell({ business, step, live, exitTo, wide = false, children }: SetupShellProps) {
  const navigate = useNavigate();
  const compact = useSyncExternalStore(subscribeCompactBar, isCompactBar, () => false);
  // Setup's name, as its steps are labelled, at every step; the preview's public page leaves it be.
  useDocumentTitle(inApp(SETUP_COPY.stepsLabel));
  return (
    <div className="cd-setup" onClick={followInAppLinks(navigate)}>
      <header className="cd-setup__bar">
        <div className="cd-setup__lead">
          <span className="cd-setup__brand">
            <Mark size={20} />
            <Wordmark preview={!compact} />
          </span>
          {/* A name too long for the bar is cut with an ellipsis; its title holds it in full. */}
          {business ? (
            <span className="cd-setup__business cd-type-control" data-copy="user" title={business}>
              {business}
            </span>
          ) : null}
        </div>
        <div className="cd-setup__steps">
          <Steps label={SETUP_COPY.stepsLabel} steps={STEP_NAMES} current={step} finished={live !== undefined} drawCheck={live === 'draw'} />
        </div>
        <span className="cd-setup__exit">
          <Button variant="ghost" href={exitTo}>
            {SETUP_COPY.saveAndExit}
          </Button>
        </span>
      </header>
      <main className={`cd-setup__main${wide ? ' cd-setup__main--wide' : ''}`}>
        <div className="cd-setup__column">{children}</div>
        <ConceptFooter />
      </main>
    </div>
  );
}

/** `/app/setup`: the business in the owner's words, before there is an interview. */
function SetupStart() {
  return (
    <SetupShell business={null} step={0} exitTo="/">
      <StartStep />
    </SetupShell>
  );
}

/** `/app/setup/:setupId`: the interview, at the step it is at. */
function SetupInterview({ setupId }: { setupId: string }) {
  const queryClient = useQueryClient();
  const setup = useQuery({ ...setupQuery(setupId), staleTime: Infinity, refetchOnWindowFocus: false });
  const deskId = setup.data?.desk_id ?? null;
  // The business's name: the API names it from the owner's words, on the new Desk.
  const desks = useQuery({ ...desksQuery(), enabled: deskId !== null });
  const desk = deskId === null || desks.data === undefined ? null : (findDesk(desks.data, deskId)?.desk ?? null);
  const business = desk?.business_name ?? null;
  // The step the interview was at when this page first read it: a Desk that goes live here is a
  // moment (the last step's check draws once); a page opened on a live Desk shows it already drawn.
  const [openedAt, setOpenedAt] = useState<SetupStep | null>(null);
  if (setup.data !== undefined && openedAt === null) setOpenedAt(setup.data.step);

  /** The interview moved on: the screen shows its next step, as the API's state now says. */
  const moveTo = useCallback(
    (step: SetupStep) => queryClient.setQueryData<SetupState>(setupQuery(setupId).queryKey, (now) => (now === undefined ? now : { ...now, step })),
    [queryClient, setupId],
  );
  /** The API answered with the interview as it stands. */
  const onState = useCallback((next: SetupState) => queryClient.setQueryData(setupQuery(setupId).queryKey, next), [queryClient, setupId]);
  /** The interview read again, after a write whose answer was lost; null when it can't be read. */
  const reread = useCallback(
    () =>
      queryClient
        // One read, no retry: when it fails, the step says the outcome is unknown and the owner tries again.
        .fetchQuery({ ...setupQuery(setupId), staleTime: 0, retry: false })
        .then((next) => next)
        .catch(() => null),
    [queryClient, setupId],
  );

  const state = setup.data;
  // The step setup opened at on this page: a step come to after it was reached live, and its
  // results land as they arrive.
  const [openedAt, setOpenedAt] = useState<SetupStep | null>(null);
  if (openedAt === null && state !== undefined) setOpenedAt(state.step);
  const opened = openedAt ?? state?.step;
  // An interview outside this copy: the app's not-found screen.
  if (state === undefined && setup.error instanceof ApiError && setup.error.kind === 'not_found') return <NotFound />;
  if (state === undefined) {
    return (
      <SetupShell business={null} step={0} exitTo="/">
        {setup.isError ? (
          <Notice
            tone="error"
            action={
              <Button variant="secondary" onClick={() => void setup.refetch()}>
                {SETUP_COPY.questions.tryAgain}
              </Button>
            }
          >
            {ownerErrorCopy(setup.error)}
          </Notice>
        ) : (
          <LoadingLine>{SETUP_COPY.questions.loading}</LoadingLine>
        )}
      </SetupShell>
    );
  }

  const name = business ?? '';
  const wentLiveHere = state.step === 'live' && openedAt !== null && openedAt !== 'live';
  // Answering is on: the Desk went live here, or the Desks say so. A live Desk whose owner has
  // turned Answering off since doesn't claim it.
  const answering = wentLiveHere || desk?.answering === true;
  let body: ReactNode;
  switch (state.step) {
    case 'questions':
      body = <QuestionsStep state={state} onState={onState} reread={reread} />;
      break;
    case 'tools':
      body = <ToolsStep state={state} business={name} onContinue={() => moveTo('rules')} />;
      break;
    case 'rules':
    case 'situations':
      body = <RulesStep state={state} business={name} onNext={moveTo} live={opened !== 'situations'} />;
      break;
    case 'safety_check':
      body = <SafetyStep state={state} onConfirmed={() => moveTo('preview')} reread={reread} live={opened !== 'safety_check'} />;
      break;
    case 'preview':
    case 'live':
      body = <LiveStep state={state} business={name} answering={answering} onLive={() => moveTo('live')} reread={reread} />;
      break;
  }
  return (
    <SetupShell
      business={business}
      step={STEP_INDEX[state.step]}
      live={state.step !== 'live' ? undefined : wentLiveHere ? 'draw' : 'drawn'}
      exitTo={todayPath(state.desk_id)}
      wide={state.step === 'preview'}
    >
      {body}
    </SetupShell>
  );
}

/** Setup, from the business's description to its live link (`/app/setup`, `/app/setup/:setupId`). */
export function SetupPage() {
  const { setupId } = useParams();
  return setupId === undefined ? <SetupStart /> : <SetupInterview key={setupId} setupId={setupId} />;
}
