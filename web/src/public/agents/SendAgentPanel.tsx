/**
 * "Send an agent": the built-in agent, Alex Kim's assistant, visits the Desk on a task the visitor
 * picks, under its signed spending limit (`SignedLimitPanel`, from the page's static words). The
 * panel sends it (`sendAgent`) and reads its run each second (`agentRun`) until the run is done,
 * failed or gone. The tasks are offered before a run, under the limit, and again at the end of one
 * that ended; while a run is unresolved, and after a start whose answer was lost, none is, so the
 * agent is never sent twice by mistake.
 *
 * The panel's card holds the run and so the Desk's reply cards: it is the one `Card` that
 * `holdsCards`, which only this file may use.
 *
 * The agent's own words never show. Its turns carry none (plan 02b), and anything a turn of its
 * holds is ignored: each request is drawn by code, titled with the chosen task first and "Signed
 * request" after. The Desk's turns are its checked replies, shown as they came, each with its
 * receipts' `visitor_plain` under it, read-only. They are in English, the language the built-in
 * agent writes in, so their cards' chrome is too.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiError, isUncertain, request } from '../../api/http.ts';
import type { AgentTurn, DemoAgentRun } from '../../api/views.ts';
import { agentRunPollMs } from '../../app/poll.ts';
import {
  AGENT_START_LOST_COPY,
  AgentMessage,
  Button,
  CHAT_ENDED_COPY,
  Card,
  ClaudeMessage,
  DEMO_BUDGET_COPY,
  LoadingLine,
  MarginReceipt,
  NEW_CHAT_LABEL,
  Notice,
  RELOAD_PAGE_LABEL,
  SignedLimitPanel,
  SuggestionChips,
  SystemLine,
  Transcript,
  TranscriptRow,
  UNREACHABLE_COPY,
  receiptFromEvent,
  type CopyLanguage,
} from '../../ds/index.ts';
import type { AgentSession } from './agentSession.ts';
import { AgentsCardContent } from './AgentsCard.tsx';
import { AGENTS_COPY, DEMO_TASKS, DEMO_TASK_COPY, type DemoTask } from './copy.ts';
import { useRunInView } from './runInView.ts';

/** The panel's title's id, which the public page's "Send an agent" link names (`#send`). */
export const SEND_ID = 'send';

/** What the page does for "Reload the page", here so a test can stand in for the browser's reload. */
export const pageActions = {
  reload(): void {
    window.location.reload();
  },
};

/** The language of the Desk's replies to the built-in agent, which writes in English. */
const RUN_LANGUAGE: CopyLanguage = 'en';

/** Cards that report something done: their executed receipt draws the check. */
const DONE_CARDS: ReadonlySet<string> = new Set(['booking_confirmed', 'payment_confirmed', 'charge_confirmed']);

/**
 * A run is read at the poll's pace for its first minute (sixty reads' worth of time, so it scales
 * with the poll), then five times slower.
 */
const BACK_OFF_AFTER = 60;
const BACK_OFF_FACTOR = 5;

/** How many reads in a row may fail before the panel says it can't reach the run (it goes on reading). */
const MAX_MISSES = 5;

/**
 * Where the panel stands:
 * - `idle`: nothing sent yet;
 * - `sending`, `running`: the agent is on its way or at work, and its run is read until it ends;
 * - `done`: it finished;
 * - `stopped`: the run failed, or the API no longer has it (404) or refuses to show it for good;
 * - `busy`: the API refused to start it (429);
 * - `budget`: the demo's model budget is spent, and the API refused to start it (503 `demo_budget`);
 * - `not_sent`: it clearly didn't start (the session couldn't open, or another refusal);
 * - `lost`: the start's answer was lost (no answer, a timeout or a 5xx), so the agent may be on its
 *   way and no read can find its run: nothing more is sent from this page view;
 * - `ended`: the chat ended (a 401 the session couldn't recover from).
 */
type Status = 'idle' | 'sending' | 'running' | 'done' | 'stopped' | 'busy' | 'budget' | 'not_sent' | 'lost' | 'ended';

interface PanelState {
  status: Status;
  /** The task last chosen. */
  task: DemoTask | null;
  /** The run's id once the API started it, or null. */
  runId: string | null;
  /** The run as last read. */
  run: DemoAgentRun | null;
  /** The run's reads keep failing; it is still read. */
  readsFailing: boolean;
}

const IDLE: PanelState = { status: 'idle', task: null, runId: null, run: null, readsFailing: false };

/** The states that offer the tasks: before a run, after one ended, and after a start that clearly didn't go ahead. */
const OFFERS_TASKS: ReadonlySet<Status> = new Set<Status>(['idle', 'done', 'stopped', 'busy', 'budget', 'not_sent']);

/** What a failed start means for the panel. */
function sendFailure(err: unknown): Status {
  if (!(err instanceof ApiError)) return 'not_sent';
  if (err.kind === 'unauthorized') return 'ended';
  if (err.kind === 'rate_limited') return 'busy';
  // The API checks the demo's budget before it starts anything.
  if (err.code === 'demo_budget') return 'budget';
  // Only a lost answer to the send itself may have started the agent; a session that didn't open sent nothing.
  if (err.route === 'sendAgent' && isUncertain(err)) return 'lost';
  return 'not_sent';
}

/**
 * What a failed read of the run means: the chat ended (401), the run is over as far as this page can
 * tell (404, or another refusal that won't change: 403, 409, 422), or null to read again (no
 * answer, a 5xx or a 429).
 */
function readFailure(err: unknown): 'ended' | 'stopped' | null {
  if (!(err instanceof ApiError)) return null;
  if (err.kind === 'unauthorized') return 'ended';
  if (err.kind === 'not_found' || err.kind === 'conflict' || err.kind === 'unprocessable') return 'stopped';
  return null;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** Resolves once the tab is in view, or at once when `signal` aborts: reads pause while it is hidden. */
function whenVisible(signal: AbortSignal): Promise<void> {
  if (document.visibilityState !== 'hidden' || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener('visibilitychange', onChange);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState !== 'hidden') done();
    };
    document.addEventListener('visibilitychange', onChange);
    signal.addEventListener('abort', done);
  });
}

export interface SendAgentPanelProps {
  slug: string;
  /** The business's name, as the kernel serves it. */
  business: string;
  /** The owner's display name, for a card that names them. */
  ownerName: string;
  /** The page's one visitor session, shared with the demo key. */
  session: AgentSession;
  /** The page's language. */
  language: CopyLanguage;
}

export function SendAgentPanel({ slug, business, ownerName, session, language }: SendAgentPanelProps) {
  const copy = AGENTS_COPY[language];
  const [state, setState] = useState<PanelState>(IDLE);
  // The run the visitor sends plays in view: it comes into view when they press a task, and its
  // newest step stays there while they are at its end.
  const runInView = useRunInView();
  // The current run's reads; aborted by a new run, a new chat and the page going away, which ends
  // its waits and stops it applying anything.
  const reading = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      reading.current?.abort();
    },
    [],
  );

  const send = async (task: DemoTask) => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const { signal } = controller;
    setState({ status: 'sending', task, runId: null, run: null, readsFailing: false });
    let runId: string;
    try {
      const started = await session.call(() => request('sendAgent', { params: { slug }, body: { task } }));
      if (typeof started?.run_id !== 'string') throw new ApiError('unavailable', { route: 'sendAgent', method: 'POST', status: 202 });
      runId = started.run_id;
    } catch (err) {
      if (!signal.aborted) setState({ status: sendFailure(err), task, runId: null, run: null, readsFailing: false });
      return;
    }
    if (signal.aborted) return;
    setState({ status: 'running', task, runId, run: null, readsFailing: false });
    // The run is read until it ends: done, failed, or gone. There is no deadline, since the agent
    // goes on whatever the page does.
    const startedAt = Date.now();
    let misses = 0;
    for (;;) {
      const pace = agentRunPollMs();
      await sleep(Date.now() - startedAt < pace * BACK_OFF_AFTER ? pace : pace * BACK_OFF_FACTOR, signal);
      await whenVisible(signal);
      if (signal.aborted) return;
      try {
        const run = await request('agentRun', { params: { slug, run_id: runId } });
        if (signal.aborted) return;
        misses = 0;
        if (run.state === 'done' || run.state === 'failed') {
          setState({ status: run.state === 'done' ? 'done' : 'stopped', task, runId, run, readsFailing: false });
          return;
        }
        // Running, or a state this build doesn't know, which isn't an end: read on.
        setState({ status: 'running', task, runId, run, readsFailing: false });
      } catch (err) {
        if (signal.aborted) return;
        const ended = readFailure(err);
        if (ended !== null) {
          setState((prev) => ({ ...prev, status: ended, readsFailing: false }));
          return;
        }
        misses += 1;
        if (misses >= MAX_MISSES) setState((prev) => ({ ...prev, readsFailing: true }));
      }
    }
  };

  const pick = (label: string) => {
    const task = DEMO_TASKS.find((t) => DEMO_TASK_COPY[language][t] === label);
    if (task === undefined) return;
    runInView.follow();
    void send(task);
  };

  const newChat = () => {
    reading.current?.abort();
    setState(IDLE);
    void session.reopen().catch(() => setState({ ...IDLE, status: 'not_sent' }));
  };

  const { status, task, runId, run, readsFailing } = state;
  const working = status === 'sending' || status === 'running';
  let notice: ReactNode = null;
  if (status === 'stopped') notice = <Notice tone="error">{copy.stopped}</Notice>;
  else if (status === 'busy') notice = <Notice tone="error">{copy.busy}</Notice>;
  else if (status === 'budget') notice = <Notice tone="error">{DEMO_BUDGET_COPY[language]}</Notice>;
  else if (status === 'lost') {
    // The agent may be on its way and no read can find its run: a reload is the retry.
    notice = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={() => pageActions.reload()}>
            {RELOAD_PAGE_LABEL[language]}
          </Button>
        }
      >
        {AGENT_START_LOST_COPY[language]}
      </Notice>
    );
  } else if (status === 'not_sent' || readsFailing) notice = <Notice tone="error">{UNREACHABLE_COPY[language]}</Notice>;
  else if (status === 'ended') {
    notice = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={newChat}>
            {NEW_CHAT_LABEL[language]}
          </Button>
        }
      >
        {CHAT_ENDED_COPY[language]}
      </Notice>
    );
  }
  const chips = OFFERS_TASKS.has(status) ? (
    <SuggestionChips label={copy.tasksLabel} suggestions={DEMO_TASKS.map((t) => DEMO_TASK_COPY[language][t])} onPick={pick} />
  ) : null;
  // After a run that finished, failed or is gone, the tasks come at its end, under its last line
  // (boards 04 and 05); otherwise they sit under the signed limit (board 03).
  const chipsAtEnd = status === 'done' || status === 'stopped';
  // While a run is starting or exists (or may, after a lost start), the chosen task takes the lead's
  // place (boards 04 and 05). A start that never ran keeps the lead.
  const ran = status === 'sending' || status === 'lost' || runId !== null;
  const lead =
    task !== null && ran ? DEMO_TASK_COPY[language][task] : copy.sendLead(<span data-copy="user">{business}</span>);

  return (
    <Card as="section" label={copy.sendTitle} padding={16} holdsCards>
      <AgentsCardContent title={copy.sendTitle} lead={lead} id={SEND_ID}>
        {/* The signed limit shows in every state, as board 05 draws it during a run. */}
        <SignedLimitPanel {...copy.limit} language={language} />
        {chipsAtEnd ? null : chips}
        {run !== null && task !== null && run.turns.length > 0 ? (
          <Transcript label={copy.conversation}>
            <RunRows turns={run.turns} task={task} ownerName={ownerName} language={language} />
          </Transcript>
        ) : null}
        {working ? <LoadingLine>{copy.working}</LoadingLine> : null}
        {status === 'done' ? <SystemLine text={copy.finished} /> : null}
        {notice}
        {chipsAtEnd ? chips : null}
      </AgentsCardContent>
      {/* The run's end, which the page keeps in view while the run plays. */}
      <div ref={runInView.end} className="cd-agents-card__run-end" aria-hidden="true" />
    </Card>
  );
}

interface RunRowsProps {
  turns: readonly AgentTurn[];
  task: DemoTask;
  ownerName: string;
  language: CopyLanguage;
}

/**
 * The run's turns in order: each of the agent's requests built by code, never from what the turn
 * holds, and each Desk reply with its receipts under it. A turn by anyone else shows nothing.
 */
function RunRows({ turns, task, ownerName, language }: RunRowsProps) {
  const copy = AGENTS_COPY[language];
  let requests = 0;
  return (
    <>
      {turns.map((turn, index) => {
        if (turn.author === 'agent') {
          requests += 1;
          return (
            <TranscriptRow key={index}>
              <AgentMessage
                agentName={copy.agentName}
                signed
                title={requests === 1 ? DEMO_TASK_COPY[language][task] : copy.signedRequest}
                meta={copy.request(requests)}
                language={language}
              />
            </TranscriptRow>
          );
        }
        if (turn.author !== 'desk') return null;
        const done = turn.blocks.some((block) => block.kind === 'card' && DONE_CARDS.has(block.template ?? ''));
        const margin = turn.receipts.map((ev, at) => {
          const receipt = receiptFromEvent(ev);
          return (
            <MarginReceipt
              key={`${receipt.ledgerSeq}-${at}`}
              source={receipt.source}
              plain={receipt.plain}
              ledgerSeq={receipt.ledgerSeq}
              drawCheck={done && receipt.source.kind === 'decision' && receipt.source.state === 'executed'}
            />
          );
        });
        return (
          <TranscriptRow key={index} margin={margin}>
            <ClaudeMessage blocks={turn.blocks} language={RUN_LANGUAGE} ownerName={ownerName} />
          </TranscriptRow>
        );
      })}
    </>
  );
}
