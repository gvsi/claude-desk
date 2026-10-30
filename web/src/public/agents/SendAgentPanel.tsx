/**
 * "Send an agent": the built-in agent, Alex Kim's assistant, visits the Desk on a task the visitor
 * picks, under its signed spending limit. The panel sends it (`sendAgent`) and reads its run each
 * second (`agentRun`) until the run is done, failed or gone. While a run is unresolved, and after a
 * start whose answer was lost, no task is offered, so the agent is never sent twice by mistake.
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
  AgentMessage,
  Button,
  CHAT_ENDED_COPY,
  ClaudeMessage,
  LoadingLine,
  MarginReceipt,
  NEW_CHAT_LABEL,
  Notice,
  SuggestionChips,
  SystemLine,
  Transcript,
  TranscriptRow,
  UNREACHABLE_COPY,
  receiptFromEvent,
  type CopyLanguage,
} from '../../ds/index.ts';
import type { AgentSession } from './agentSession.ts';
import { AgentsCard } from './AgentsCard.tsx';
import { AGENTS_COPY, DEMO_TASKS, DEMO_TASK_COPY, type DemoTask } from './copy.ts';

/** The panel's title's id, which the public page's "Send an agent" link names (`#send`). */
export const SEND_ID = 'send';

/** The language of the Desk's replies to the built-in agent, which writes in English. */
const RUN_LANGUAGE: CopyLanguage = 'en';

/** Cards that report something done: their executed receipt draws the check. */
const DONE_CARDS: ReadonlySet<string> = new Set(['booking_confirmed', 'payment_confirmed', 'charge_confirmed']);

/** How many reads at the poll's pace before the panel slows down, and by how much: a minute, then every five seconds. */
const BACK_OFF_AFTER = 60;
const BACK_OFF_FACTOR = 5;

/** How many reads in a row may fail before the panel says it can't reach the run (it goes on reading). */
const MAX_MISSES = 5;

/**
 * Where the panel stands:
 * - `idle`: nothing sent yet;
 * - `sending`, `running`: the agent is on its way or at work, and its run is read until it ends;
 * - `done`: it finished;
 * - `stopped`: the run failed, or the API no longer has it (404);
 * - `busy`: the API refused to start it (429);
 * - `not_sent`: it clearly didn't start (the session couldn't open, or another refusal);
 * - `lost`: the start's answer was lost (no answer, a timeout or a 5xx), so the agent may be on its
 *   way and no read can find its run: nothing more is sent from this page view;
 * - `ended`: the chat ended (a 401 the session couldn't recover from).
 */
type Status = 'idle' | 'sending' | 'running' | 'done' | 'stopped' | 'busy' | 'not_sent' | 'lost' | 'ended';

interface PanelState {
  status: Status;
  /** The task last chosen. */
  task: DemoTask | null;
  /** The run as last read. */
  run: DemoAgentRun | null;
  /** The run's reads keep failing; it is still read. */
  readsFailing: boolean;
}

const IDLE: PanelState = { status: 'idle', task: null, run: null, readsFailing: false };

/** The states that offer the tasks: before a run, and after one that clearly didn't go ahead. */
const OFFERS_TASKS: ReadonlySet<Status> = new Set<Status>(['idle', 'stopped', 'busy', 'not_sent']);

/** The states with no run to speak of, which keep the panel's own lead. */
const NO_RUN: ReadonlySet<Status> = new Set<Status>(['idle', 'busy', 'not_sent']);

/** What a failed start means for the panel. */
function sendFailure(err: unknown): Status {
  if (!(err instanceof ApiError)) return 'not_sent';
  if (err.kind === 'unauthorized') return 'ended';
  if (err.kind === 'rate_limited') return 'busy';
  // Only a lost answer to the send itself may have started the agent; a session that didn't open sent nothing.
  if (err.route === 'sendAgent' && isUncertain(err)) return 'lost';
  return 'not_sent';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once the tab is in view: reads pause while it is hidden, as the app's polling does. */
function whenVisible(): Promise<void> {
  if (document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
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
  // Bumped by each new run and when the page goes away, so an older run's reads stop applying.
  const runNo = useRef(0);
  useEffect(
    () => () => {
      runNo.current += 1;
    },
    [],
  );

  const send = async (task: DemoTask) => {
    runNo.current += 1;
    const mine = runNo.current;
    const current = () => mine === runNo.current;
    setState({ status: 'sending', task, run: null, readsFailing: false });
    let runId: string;
    try {
      const started = await session.call(() => request('sendAgent', { params: { slug }, body: { task } }));
      if (typeof started?.run_id !== 'string') throw new ApiError('unavailable', { route: 'sendAgent', method: 'POST', status: 202 });
      runId = started.run_id;
    } catch (err) {
      if (current()) setState({ status: sendFailure(err), task, run: null, readsFailing: false });
      return;
    }
    // The run is read until it ends: done, failed, or gone (404). There is no deadline, since the
    // agent goes on whatever the page does; a slow run is read less often after a minute.
    let misses = 0;
    for (let reads = 0; ; reads += 1) {
      await sleep(reads < BACK_OFF_AFTER ? agentRunPollMs() : agentRunPollMs() * BACK_OFF_FACTOR);
      await whenVisible();
      if (!current()) return;
      try {
        const run = await request('agentRun', { params: { slug, run_id: runId } });
        if (!current()) return;
        misses = 0;
        if (run.state === 'done' || run.state === 'failed') {
          setState({ status: run.state === 'done' ? 'done' : 'stopped', task, run, readsFailing: false });
          return;
        }
        // Running, or a state this build doesn't know, which isn't an end: read on.
        setState({ status: 'running', task, run, readsFailing: false });
      } catch (err) {
        if (!current()) return;
        if (err instanceof ApiError && (err.kind === 'not_found' || err.kind === 'unauthorized')) {
          const status = err.kind === 'not_found' ? 'stopped' : 'ended';
          setState((prev) => ({ ...prev, status, readsFailing: false }));
          return;
        }
        misses += 1;
        if (misses >= MAX_MISSES) setState((prev) => ({ ...prev, status: 'running', readsFailing: true }));
      }
    }
  };

  const pick = (label: string) => {
    const task = DEMO_TASKS.find((t) => DEMO_TASK_COPY[language][t] === label);
    if (task !== undefined) void send(task);
  };

  const newChat = () => {
    runNo.current += 1;
    setState(IDLE);
    void session.reopen().catch(() => setState({ ...IDLE, status: 'not_sent' }));
  };

  const { status, task, run, readsFailing } = state;
  const working = status === 'sending' || status === 'running';
  let notice: ReactNode = null;
  if (status === 'stopped') notice = <Notice tone="error">{copy.stopped}</Notice>;
  else if (status === 'busy') notice = <Notice tone="error">{copy.busy}</Notice>;
  else if (status === 'not_sent' || status === 'lost' || readsFailing) notice = <Notice tone="error">{UNREACHABLE_COPY[language]}</Notice>;
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
  // During and after a run, the chosen task takes the lead's place (boards 04 and 05).
  const lead = task !== null && !NO_RUN.has(status) ? DEMO_TASK_COPY[language][task] : copy.sendLead(business);

  return (
    <AgentsCard title={copy.sendTitle} lead={lead} id={SEND_ID} holdsCards>
      <p className="cd-agents-page__quiet cd-type-meta">{copy.limitLine}</p>
      {OFFERS_TASKS.has(status) ? (
        <SuggestionChips label={copy.tasksLabel} suggestions={DEMO_TASKS.map((t) => DEMO_TASK_COPY[language][t])} onPick={pick} />
      ) : null}
      {run !== null && task !== null && run.turns.length > 0 ? (
        <Transcript label={copy.conversation(business)}>
          <RunRows turns={run.turns} task={task} ownerName={ownerName} language={language} />
        </Transcript>
      ) : null}
      {working ? <LoadingLine>{copy.working}</LoadingLine> : null}
      {status === 'done' ? <SystemLine text={copy.finished} /> : null}
      {notice}
    </AgentsCard>
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
