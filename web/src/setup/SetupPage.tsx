import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { useLocation, useNavigate, useNavigationType, useParams, useSearchParams, type NavigateFunction, type NavigateOptions, type To } from 'react-router';

import { ApiError, observeRequests, ownerErrorCopy, request } from '../api/http.ts';
import { NotFound } from '../app/NotFound.tsx';
import type { SetupState, SetupStep } from '../api/views.ts';
import { Button, ConceptFooter, LoadingLine, Mark, Notice, Steps, Wordmark } from '../ds/index.ts';
import { inApp, useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { followInAppLinks } from '../owner/inAppLinks.ts';
import { carrySetup, desksQuery, findDesk, invalidateCopy } from '../owner/useDesks.ts';
import { SETUP_COPY, STEP_INDEX, STEP_NAMES } from './copy.ts';
import { LiveStep } from './LiveStep.tsx';
import { QuestionsStep } from './QuestionsStep.tsx';
import { RulesStep } from './RulesStep.tsx';
import { SafetyStep } from './SafetyStep.tsx';
import { StartStep, startedWith, useSetupStart } from './StartStep.tsx';
import { StartingChat } from './StartingChat.tsx';
import { SETUP_REACHES, laterStep, opensSetupChat, setupPath, useOpensAtTop } from './shared.ts';
import { SetupOpening } from './StepSkeletons.tsx';
import { ToolsStep } from './ToolsStep.tsx';

import './SetupPage.css';

/** A setup interview as it stands, read by its id. */
export function setupQuery(id: string) {
  return queryOptions({ queryKey: ['setup', id], queryFn: () => request('setup', { params: { id } }) });
}

/**
 * The later steps' reads of what setup drafted from the answers (each keyed `[read, id]`): read
 * again once "Change something" takes the interview back to its questions.
 */
const DRAFTED_READS = ['setupTools', 'setupRules', 'setupSituations', 'setupPublicLines', 'setupSafetyCheck'] as const;

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
  /**
   * The business's name, once the API knows it: someone's own words. Undefined while it's on its way,
   * so the bar keeps the name's line and nothing under it moves when it comes; null when there's none.
   */
  business: string | null | undefined;
  /** The step the bar marks, counted from 0, or null before the interview is read. */
  step: number | null;
  /**
   * The Desk is live: the bar's last step reads done, its check drawing once when the Desk went
   * live on this page (`draw`) or drawn already when the page opened on it (`drawn`).
   */
  live?: 'draw' | 'drawn';
  /** Where "Save and exit" and the lockup go: the new Desk's Today once there is one, else the start. */
  exitTo: string;
  /** The preview's wider column. */
  wide?: boolean;
  /** Questions have their own scrolling transcript and fixed dock. */
  chat?: boolean;
  /**
   * What an in-app link out of setup waits for before it goes, such as the interview carried into
   * the copy's Desks, so the page it opens is drawn from it.
   */
  beforeLeave?: () => Promise<void>;
  contentRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

/**
 * Setup's frame, as the signed setup boards draw it: the bar with the bell (no tile, 20 px at every
 * width, as on a standalone page) and the wordmark, with its Preview badge from 1100 px up, a link
 * that leaves as "Save and exit" does; the business once known, the five steps and "Save and exit";
 * one column; the concept footer at the window's foot.
 */
function SetupShell({ business, step, live, exitTo, wide = false, chat = false, beforeLeave, contentRef, children }: SetupShellProps) {
  const navigate = useNavigate();
  // An in-app link goes once `beforeLeave` is done, whether or not it worked.
  const leave: NavigateFunction = (to: To | number, options?: NavigateOptions) => {
    const go = () => (typeof to === 'number' ? navigate(to) : navigate(to, options));
    return beforeLeave === undefined ? go() : beforeLeave().then(go, go);
  };
  const compact = useSyncExternalStore(subscribeCompactBar, isCompactBar, () => false);
  // Setup's name, as its steps are labelled, at every step; the preview's public page leaves it be.
  useDocumentTitle(inApp(SETUP_COPY.stepsLabel));
  return (
    <div className={`cd-setup${chat ? ' cd-setup--chat' : ''}`} onClick={followInAppLinks(leave)}>
      <header className="cd-setup__bar">
        <div className="cd-setup__lead">
          {/* The lockup leads home as "Save and exit" does: the same place, and the same way out
              (the shell's in-app links wait for `beforeLeave`), so progress is kept. Named by the
              product's name, which its words begin with at every width, then by what it does. */}
          <a className="cd-setup__brand" href={exitTo} aria-label={SETUP_COPY.brandHome}>
            <Mark size={20} />
            <Wordmark preview={!compact} />
          </a>
          {/* A name too long for the bar is cut with an ellipsis; its title holds it in full. */}
          {business !== null ? (
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
        <div ref={contentRef} className="cd-setup__column">{children}</div>
        {chat ? null : <ConceptFooter />}
      </main>
    </div>
  );
}

/**
 * `/app/setup`: the business in the owner's words, before there is an interview; from the press of
 * "Start", setup's chat while the interview is made, in the frame the interview opens in.
 */
function SetupStart() {
  const start = useSetupStart();
  const { attempt } = start;
  return (
    <SetupShell business={attempt === null ? null : undefined} step={0} exitTo="/" chat={attempt !== null}>
      {attempt === null ? (
        <StartStep start={start} />
      ) : (
        <SetupOpening loading={false}>
          <StartingChat words={attempt.body.description} failure={start.failure} onTryAgain={start.tryAgain} from={start.from} />
        </SetupOpening>
      )}
    </SetupShell>
  );
}

/** `/app/setup/:setupId`: the interview, at the step it is at. */
function SetupInterview({ setupId }: { setupId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  // The owner's own words, when the start on this page made the interview: their first message,
  // its hand-off from setup's chat played once, as the start opens it (not on a reload or Back).
  const { state: arrived } = useLocation();
  const navigationType = useNavigationType();
  const [opening] = useState(() => {
    const words = startedWith(arrived);
    return words === null ? null : { words, arrived: navigationType === 'REPLACE' };
  });
  const setup = useQuery({ ...setupQuery(setupId), staleTime: Infinity, refetchOnWindowFocus: false });
  const deskId = setup.data?.desk_id ?? null;
  // The business's name: the API names it from the owner's words, on the new Desk, so in an interview it's
  // always coming. Until a Desks read lists this Desk (a reload, or a list read before the Desk was made)
  // it's on its way (undefined), and the bar holds its line.
  const desks = useQuery({ ...desksQuery(), enabled: deskId !== null });
  const desk = deskId === null || desks.data === undefined ? null : (findDesk(desks.data, deskId)?.desk ?? null);
  const business = desk?.business_name;

  /**
   * The step the API has confirmed the interview at: the step it was read at, then what the API's
   * answers say (an answer, a re-read) and the step each request that moves it on reaches once it
   * succeeds (`SETUP_REACHES`). The page's own step can run ahead of it: "Continue" on the tools
   * shows the rules before their draft is made, which may never be. Only the confirmed step is
   * carried into the copy's Desks, and setup reopens at it.
   */
  // Query-cache notifications can render synchronously before a queued React state update.
  // Record the hold before publishing a tools state, then Continue releases it on this page.
  const closing = useRef(false);
  const [continued, setContinued] = useState(false);
  const confirmed = useRef<SetupStep | null>(null);
  if (confirmed.current === null && setup.data !== undefined) confirmed.current = setup.data.step;
  const confirm = useCallback((step: SetupStep) => {
    confirmed.current = confirmed.current === null ? step : laterStep(confirmed.current, step);
  }, []);
  useEffect(
    () =>
      observeRequests((outcome) => {
        const reached = outcome.ok ? SETUP_REACHES[outcome.key] : undefined;
        if (reached !== undefined) confirm(reached);
      }),
    [confirm],
  );
  /** The interview as setup holds it, at the step the API confirmed. */
  const asConfirmed = useCallback((now: SetupState): SetupState => ({ ...now, step: confirmed.current ?? now.step }), []);

  /**
   * The interview as it now stands. The copy's Desks name its step (`DeskSummary.setup`), so a new
   * step has the confirmed one written into them (`carrySetup`), which also reads them again in the
   * background: Today, opened next, would otherwise name the step before.
   */
  const update = useCallback(
    (next: (now: SetupState | undefined) => SetupState | undefined) => {
      const key = setupQuery(setupId).queryKey;
      const was = queryClient.getQueryData<SetupState>(key)?.step;
      const now = queryClient.setQueryData<SetupState>(key, next);
      if (now !== undefined && now.step !== was) void carrySetup(queryClient, asConfirmed(now));
    },
    [queryClient, setupId, asConfirmed],
  );
  /** The page moves on: the screen shows the next step; the API confirms it with that step's own request. */
  const moveTo = useCallback((step: SetupStep) => update((now) => (now === undefined ? now : { ...now, step })), [update]);
  /**
   * Reads of the interview and the answers of the requests that change it can land out of order: a
   * read of a busy interview every 2 s can answer after the read once its turn is saved. Each read is
   * numbered as it goes out and lands only if nothing newer has landed since, so an older read never
   * replaces a newer interview; a request's own answer is newer than every read sent before it.
   */
  const reads = useRef<{ sent: number; landed: number; latest: SetupState | null }>({ sent: 0, landed: 0, latest: null });
  /** Shows `next`, the interview as the API last said it stands. */
  const publish = useCallback(
    (next: SetupState) => {
      reads.current.latest = next;
      if (confirmed.current === 'questions' && next.step === 'tools') closing.current = true;
      confirm(next.step);
      update(() => next);
    },
    [confirm, update],
  );
  /** The API answered a request with the interview as it stands. */
  const onState = useCallback(
    (next: SetupState) => {
      reads.current.landed = reads.current.sent;
      publish(next);
    },
    [publish],
  );
  /**
   * Leaving setup carries the interview as it stands into the copy's Desks once more (then they are
   * read again): the steps' own reads (the draft, the situations, the safety check) can have moved it
   * on in the API while a read of the Desks still out was answered with the step before, and the
   * page that opens next names the step setup holds, even while the Desks can't be read. An in-app
   * link out ("Save and exit", "Go to Today") goes once it is written (`SetupShell`'s `beforeLeave`);
   * any other way out (Back, say) carries it as setup closes.
   */
  const carry = useCallback((): Promise<void> => {
    const now = queryClient.getQueryData<SetupState>(setupQuery(setupId).queryKey);
    if (now !== undefined) return carrySetup(queryClient, asConfirmed(now));
    void invalidateCopy(queryClient);
    return Promise.resolve();
  }, [queryClient, setupId, asConfirmed]);
  const leftByLink = useRef(false);
  const beforeLeave = useCallback(() => {
    leftByLink.current = true;
    return carry();
  }, [carry]);
  useEffect(
    () => () => {
      // Setup reopens at the step the API confirmed, not one only this page showed.
      queryClient.setQueryData<SetupState>(setupQuery(setupId).queryKey, (now) => (now === undefined ? now : asConfirmed(now)));
      if (!leftByLink.current) void carry();
    },
    [carry, queryClient, setupId, asConfirmed],
  );
  /**
   * The interview read again, after a write whose answer was lost or while it is busy; null when it
   * can't be read. A read something newer has overtaken changes nothing and answers with that newer
   * interview.
   */
  const reread = useCallback(() => {
    reads.current.sent += 1;
    const sent = reads.current.sent;
    return request('setup', { params: { id: setupId } })
      .then((next) => {
        if (sent <= reads.current.landed) return reads.current.latest ?? next;
        reads.current.landed = sent;
        // Hold the closing before publishing the read to the cache, so Tools never mounts first.
        publish(next);
        return next;
      })
      .catch(() => null);
  }, [setupId, publish]);

  const state = setup.data;
  // The step setup opened at on this page: a step come to after it was reached live, and its
  // results land as they arrive. A Desk that goes live here is a moment (the last step's check
  // draws once); a page opened on a live Desk shows it already drawn.
  const [openedAt, setOpenedAt] = useState<SetupStep | null>(null);
  if (openedAt === null && state !== undefined) setOpenedAt(state.step);
  const opened = openedAt ?? state?.step;
  // While Questions closes, the tools the API has moved on to wait for its "Continue".
  const closingQuestions = state !== undefined && closing.current && !continued && state.step === 'tools';
  // "Change something" (`changeSomethingPath`): the chat again, over a step past it; its "Continue"
  // goes back to the step the API has the interview at. The API's step stays where it is until the
  // owner sends a change, which the API's reopen takes back to the questions. Until then the change
  // runs busy at the step it was sent from (no other turn runs past the questions), so a page opened
  // or come back to while one runs follows it in the chat too, whatever its address says. A live
  // Desk is changed in the owner app, never here: the page shows it live, whatever the address.
  const chatOpen = opensSetupChat(search);
  const changeRuns = state !== undefined && state.busy === true && state.step !== 'questions';
  const changing = state !== undefined && state.step !== 'questions' && state.step !== 'live' && (chatOpen || changeRuns);
  const content = useRef<HTMLDivElement>(null);
  const returnToStep = useRef(false);
  useEffect(() => {
    if (changing || !returnToStep.current) return;
    returnToStep.current = false;
    if (document.activeElement !== document.body) return;
    // Preview's own arrival waits for its chat to load. Leave focus free until it is ready;
    // touch-first screens keep the heading instead, without opening the keyboard.
    if (state?.step === 'preview' && !window.matchMedia('(pointer: coarse)').matches) return;
    // Cancelling the change chat announces the restored view, or returns to the closing plan's Continue.
    const target = content.current?.querySelector<HTMLElement>(closingQuestions ? '.cd-setup-dock .cd-button--primary' : 'h1');
    if (!target) return;
    if (target.tagName === 'H1' && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }
    target.focus({ preventScroll: true });
  }, [changing, closingQuestions, state?.step]);
  // A change may close the questions in one turn and return tools directly. Remember where this
  // chat opened, or where a running change was found, so both that response and a read of the landed
  // turn clear the old drafts and show the new plan.
  const changeStartedAt = useRef<number | null>(null);
  if (state !== undefined && changeStartedAt.current === null && changing) changeStartedAt.current = state.messages.length;
  // The API's interview is back at its questions after a later step (a change landed, here or
  // anywhere), or a change followed here landed past them: what was drafted from the answers before
  // is read again on the way forward.
  const reopened = state !== undefined && !state.busy
    && ((state.step === 'questions' && confirmed.current !== null && confirmed.current !== 'questions')
      || (changeStartedAt.current !== null && (state.step === 'questions' || state.messages.length > changeStartedAt.current)));
  if (!chatOpen && !changeRuns && !reopened) changeStartedAt.current = null;
  const reopenedStep = state?.step;
  useEffect(() => {
    if (!reopened || reopenedStep === undefined) return;
    confirmed.current = reopenedStep;
    closing.current = reopenedStep === 'tools';
    changeStartedAt.current = null;
    setContinued(false);
    setOpenedAt('questions');
    for (const read of DRAFTED_READS) queryClient.removeQueries({ queryKey: [read, setupId] });
    void carry();
    if (chatOpen) void navigate(setupPath(setupId), { replace: true });
  }, [reopened, reopenedStep, chatOpen, carry, navigate, queryClient, setupId]);
  // Setup come back to while a turn it last saw was running (a change sent before "Save and exit",
  // say): the interview the cache holds is read again at once, rather than drawn as it was.
  const resumedBusy = useRef(setup.data?.busy === true);
  useEffect(() => {
    if (!resumedBusy.current) return;
    resumedBusy.current = false;
    void reread();
  }, [reread]);
  // Each step opens at its top, by the bar's step: Your rules' views open at their tops on their own
  // (RulesStep), and the preview going live stays the same screen.
  useOpensAtTop(state === undefined ? null : STEP_INDEX[closingQuestions || changing ? 'questions' : state.step]);
  // An interview outside this copy: the app's not-found screen.
  if (state === undefined && setup.error instanceof ApiError && setup.error.kind === 'not_found') return <NotFound />;
  if (state === undefined) {
    return (
      <SetupShell business={undefined} step={null} exitTo="/">
        <SetupOpening loading={!setup.isError}>
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
          ) : null}
        </SetupOpening>
      </SetupShell>
    );
  }

  const name = business ?? '';
  const wentLiveHere = state.step === 'live' && openedAt !== null && openedAt !== 'live';
  // "Acting for you now" follows the latest Desks read alone, whatever this page saw happen: going live
  // here writes Answering on into them, and a Desk whose owner has turned Answering off since, here
  // or elsewhere, doesn't claim it. The check's drawing is the page's own history, kept apart.
  const answering = desk?.answering === true;
  let body: ReactNode;
  const shownStep = closingQuestions || changing ? 'questions' : state.step;
  const backToStep = () => {
    returnToStep.current = true;
    // The situations request may have advanced the API while the page still held its rules step.
    // Restore that confirmed step so cancelling the chat reopens the same view of the rules.
    update((now) => now === undefined ? now : asConfirmed(now));
    void navigate(setupPath(setupId));
  };
  switch (shownStep) {
    case 'questions':
      body = <QuestionsStep state={state} opening={opening} onState={onState} reread={reread} changing={changing} onContinue={changing ? backToStep : () => setContinued(true)} />;
      break;
    case 'tools':
      body = <ToolsStep state={state} business={name} onContinue={() => moveTo('rules')} />;
      break;
    case 'rules':
    case 'situations':
      body = <RulesStep state={state} business={name} onNext={moveTo} reread={reread} live={opened !== 'situations'} />;
      break;
    case 'safety_check':
      body = <SafetyStep state={state} onConfirmed={() => moveTo('preview')} reread={reread} live={opened !== 'safety_check'} />;
      break;
    case 'preview':
    case 'live':
      // Live, the title names the business and "Acting for you now" follows the Desks, so while they are
      // first read (on a reload) the step waits whole on the loading line, rather than drawing a
      // title and a link that their arrival would rewrite and push down.
      body =
        state.step === 'live' && desks.isPending ? (
          <LoadingLine>{SETUP_COPY.questions.loading}</LoadingLine>
        ) : (
          <LiveStep state={state} business={name} answering={answering} onLive={() => moveTo('live')} reread={reread} />
        );
      break;
  }
  return (
    <SetupShell
      business={business}
      // The closing plan still belongs to Questions, including while its change chat is open.
      // Over later steps, the bar keeps the steps done until a change lands.
      step={STEP_INDEX[closingQuestions ? 'questions' : changing ? state.step : shownStep]}
      live={state.step !== 'live' ? undefined : wentLiveHere ? 'draw' : 'drawn'}
      exitTo={todayPath(state.desk_id)}
      wide={state.step === 'preview' && !changing}
      chat={shownStep === 'questions'}
      beforeLeave={beforeLeave}
      contentRef={content}
    >
      {/* The same region as while the interview was read, so its shapes hand off to the step's. */}
      <SetupOpening loading={false}>{body}</SetupOpening>
    </SetupShell>
  );
}

/** Setup, from the business's description to its live link (`/app/setup`, `/app/setup/:setupId`). */
export function SetupPage() {
  const { setupId } = useParams();
  return setupId === undefined ? <SetupStart /> : <SetupInterview key={setupId} setupId={setupId} />;
}
