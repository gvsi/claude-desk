/**
 * "Send an agent": the built-in agent, Alex Kim's assistant, visits the Desk on a task the visitor
 * picks, under its signed spending limit. The panel sends it (`sendAgent`) and reads its run each
 * second (`agentRun`) until the run is done or failed.
 *
 * The agent's own words never show. Its turns carry none (plan 02b), and anything a turn of its
 * holds is ignored: each request is drawn by code, titled with the chosen task first and "Signed
 * request" after. The Desk's turns are its checked replies, shown as they came, each with its
 * receipts' `visitor_plain` under it, read-only. They are in English, the language the built-in
 * agent writes in, so their cards' chrome is too.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiError, request } from '../../api/http.ts';
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
import { useAgentSession } from './agentSession.ts';
import { AgentsCard } from './AgentsCard.tsx';
import { AGENTS_COPY, DEMO_TASKS, DEMO_TASK_COPY, type DemoTask } from './copy.ts';

/** The panel's title's id, which the public page's "Send an agent" link names (`#send`). */
export const SEND_ID = 'send';

/** The language of the Desk's replies to the built-in agent, which writes in English. */
const RUN_LANGUAGE: CopyLanguage = 'en';

/** Cards that report something done: their executed receipt draws the check. */
const DONE_CARDS: ReadonlySet<string> = new Set(['booking_confirmed', 'payment_confirmed', 'charge_confirmed']);

/** How many reads of a run the panel makes before it stops waiting: five minutes at one a second. */
const MAX_READS = 300;

/** How many reads in a row may fail before the panel says it couldn't reach the run. */
const MAX_MISSES = 5;

/**
 * Where the panel stands: nothing sent yet, sending, a run at work, done, stopped (it failed, isn't
 * there, or never finished), busy (the API's 429), the chat ended (a 401 the session couldn't
 * recover from), or the API out of reach.
 */
type Status = 'idle' | 'sending' | 'running' | 'done' | 'stopped' | 'busy' | 'ended' | 'unreachable';

interface PanelState {
  status: Status;
  /** The task last chosen. */
  task: DemoTask | null;
  /** The run as last read. */
  run: DemoAgentRun | null;
}

const IDLE: PanelState = { status: 'idle', task: null, run: null };

/** What a failed send means for the panel. */
function sendFailure(err: unknown): Status {
  if (err instanceof ApiError && err.kind === 'unauthorized') return 'ended';
  if (err instanceof ApiError && err.kind === 'rate_limited') return 'busy';
  return 'unreachable';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendAgentPanelProps {
  slug: string;
  /** The business's name, as the kernel serves it. */
  business: string;
  /** The owner's display name, for a card that names them. */
  ownerName: string;
  /** The page's language. */
  language: CopyLanguage;
}

export function SendAgentPanel({ slug, business, ownerName, language }: SendAgentPanelProps) {
  const copy = AGENTS_COPY[language];
  const session = useAgentSession(slug);
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
    setState({ status: 'sending', task, run: null });
    let runId: string;
    try {
      const started = await session.call(() => request('sendAgent', { params: { slug }, body: { task } }));
      if (typeof started?.run_id !== 'string') throw new ApiError('unavailable', { route: 'sendAgent', method: 'POST', status: 202 });
      runId = started.run_id;
    } catch (err) {
      if (current()) setState({ status: sendFailure(err), task, run: null });
      return;
    }
    const stop = (status: Status) => setState((prev) => ({ ...prev, status }));
    let misses = 0;
    for (let reads = 0; reads < MAX_READS; reads += 1) {
      await sleep(agentRunPollMs());
      if (!current()) return;
      try {
        const run = await request('agentRun', { params: { slug, run_id: runId } });
        if (!current()) return;
        misses = 0;
        if (run.state === 'running') setState({ status: 'running', task, run });
        else {
          // Done, or failed, or a state this build doesn't know, which counts as not finished.
          setState({ status: run.state === 'done' ? 'done' : 'stopped', task, run });
          return;
        }
      } catch (err) {
        if (!current()) return;
        if (err instanceof ApiError && err.kind === 'not_found') return stop('stopped');
        if (err instanceof ApiError && err.kind === 'unauthorized') return stop('ended');
        misses += 1;
        if (misses >= MAX_MISSES) return stop('unreachable');
      }
    }
    if (current()) stop('stopped');
  };

  const pick = (label: string) => {
    const task = DEMO_TASKS.find((t) => DEMO_TASK_COPY[language][t] === label);
    if (task !== undefined) void send(task);
  };

  const newChat = () => {
    runNo.current += 1;
    setState(IDLE);
    void session.reopen().catch(() => setState({ ...IDLE, status: 'unreachable' }));
  };

  const { status, task, run } = state;
  const working = status === 'sending' || status === 'running';
  let notice: ReactNode = null;
  if (status === 'stopped') notice = <Notice tone="error">{copy.stopped}</Notice>;
  else if (status === 'busy') notice = <Notice tone="error">{copy.busy}</Notice>;
  else if (status === 'unreachable') notice = <Notice tone="error">{UNREACHABLE_COPY[language]}</Notice>;
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

  return (
    <AgentsCard title={copy.sendTitle} lead={copy.sendLead(business)} id={SEND_ID} holdsCards>
      {working || status === 'ended' ? null : (
        <SuggestionChips label={copy.tasksLabel} suggestions={DEMO_TASKS.map((t) => DEMO_TASK_COPY[language][t])} onPick={pick} />
      )}
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
