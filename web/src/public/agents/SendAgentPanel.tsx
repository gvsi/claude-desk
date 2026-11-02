/**
 * "Send an agent": the built-in agent, Alex Kim's assistant, visits the Desk on a task the visitor
 * picks, under its signed spending limit (`SignedLimitPanel`, from the page's static words). The
 * panel sends it (`sendAgent`) and reads its run each second (`agentRun`) until the run is done,
 * failed or gone. The tasks are offered before a run, under the limit, and again at the end of one
 * that ended; while a run is unresolved, and after a start whose answer was lost, none is, so the
 * agent is never sent twice by mistake. A task picked moves focus to the panel's title, since the
 * task's button goes with the others, and so does "New chat", which goes with its notice; the next
 * Tab then goes on from the panel rather than from the top of the page. Opening the page moves no
 * focus: a run only ever starts from a pick. Each task click sends a new idempotency key, and the
 * click's retries send it again (a 401's one retry in a new session, "Try again" after a lost
 * answer), so the API answers the run the click started, if it did, rather than starting another.
 *
 * The panel's card holds the run and so the Desk's reply cards: it is the one `Card` that
 * `holdsCards`, which only this file may use.
 *
 * The tasks take the Desk's own words (plan 09, C2): the panel reads the Desk's set once, with the
 * visitor's session (`agentTasks`), and offers the tasks once it has it; a set it can't read gives
 * plain words for any business (`FALLBACK_TASK_SET`). Only the tasks the Desk lists are offered;
 * older or unreadable lists offer all four. The set is a key, so every word is the page's.
 *
 * Each of the agent's requests is titled by code, with the chosen task first and "Signed request"
 * after, and quotes the request as the agent sent it (its turn's `text`) under the title: the
 * agent's own words, untrusted, so `AgentMessage` draws them as quoted user text with a rule at
 * their left, a text node only, apart from the Desk's replies, and the panel first collapses their
 * whitespace and cuts them to 280 characters, so a long model message can't flood the page.
 * Anything else an agent turn holds is ignored. The Desk's turns are its checked replies, shown as
 * they came, each with its receipts' `visitor_plain` under it, read-only. They are in English, the
 * language the built-in agent writes in, so their cards' chrome is too.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { ApiError, isUncertain, newIdempotencyKey, request } from '../../api/http.ts';
import type { AgentTasks, AgentTurn, DemoAgentRun } from '../../api/views.ts';
import { agentRunPollMs, sleep } from '../../app/poll.ts';
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
  Skeleton,
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
import { PUBLIC_COPY } from '../copy.ts';
import {
  AGENTS_COPY,
  DEMO_TASKS,
  DEMO_TASK_COPY,
  DEMO_TASK_ROWS,
  FALLBACK_TASK_SET,
  agentStartLostLine,
  isDemoTaskSet,
  type DemoTask,
  type DemoTaskSet,
} from './copy.ts';
import { useRunInView } from './runInView.ts';

/** The panel's title's id, which the public page's "Send an agent" link names (`#send`). */
export const SEND_ID = 'send';

/** What the page does for "Reload the page", here so a test can stand in for the browser's reload. */
export const pageActions = {
  reload(): void {
    window.location.reload();
  },
};

/**
 * How long after a click its key may be sent again: 55 minutes, a margin under the hour the API
 * keeps a send's key (plan 02b's `RUN_LIFE`). Past it, a repeat could start a second agent.
 */
export const KEY_RETRY_WINDOW_MS = 55 * 60_000;

/** The language of the built-in agent's words and of the Desk's replies to them: it writes in English. */
const RUN_LANGUAGE: CopyLanguage = 'en';

/** The most of an agent's request the panel quotes, "…" included. */
export const AGENT_WORDS_MAX = 280;

/**
 * An agent turn's request as the panel quotes it: its whitespace collapsed to single spaces, so it
 * reads as one run of words, and cut to 279 characters and "…" past `AGENT_WORDS_MAX`, with no
 * space left before the "…". Undefined when the turn has no words, so the row draws without a quote.
 */
function agentWords(turn: AgentTurn): string | undefined {
  if (typeof turn.text !== 'string') return undefined;
  const chars = Array.from(turn.text.split(/\s+/).filter(Boolean).join(' '));
  if (chars.length === 0) return undefined;
  return chars.length > AGENT_WORDS_MAX ? `${chars.slice(0, AGENT_WORDS_MAX - 1).join('').trimEnd()}…` : chars.join('');
}

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
 * - `not_sent`: it clearly didn't start (the session couldn't open, a first send's 409 `conflict`
 *   for its key, or another refusal);
 * - `lost`: the start's answer was lost (no answer, a timeout or a 5xx), so the agent may be on its
 *   way and no read can find its run: only "Try again" is offered, which sends the same task with
 *   the same key and so finds the run if the agent started, or starts it if it didn't;
 * - `reload`: a lost start that no same-key retry can settle safely any more (its key now belongs to
 *   a session this page no longer has, or is older than `KEY_RETRY_WINDOW_MS`), so the agent may be
 *   on its way and only a reload is offered, with no task to send it twice, as before the API took
 *   keys;
 * - `ended`: the chat ended (a 401 the session couldn't recover from).
 */
type Status = 'idle' | 'sending' | 'running' | 'done' | 'stopped' | 'busy' | 'budget' | 'not_sent' | 'lost' | 'reload' | 'ended';

interface PanelState {
  status: Status;
  /** The task last chosen. */
  task: DemoTask | null;
  /** The idempotency key of that click, sent with each of its tries, and when it was made (ms). */
  key: string | null;
  keyMadeAt: number | null;
  /** The run's id once the API started it, or null. */
  runId: string | null;
  /** The run as last read. */
  run: DemoAgentRun | null;
  /** The run's reads keep failing; it is still read. */
  readsFailing: boolean;
}

const IDLE: PanelState = { status: 'idle', task: null, key: null, keyMadeAt: null, runId: null, run: null, readsFailing: false };

const FALLBACK_TASKS: AgentTasks = { task_set: FALLBACK_TASK_SET, tasks: [...DEMO_TASKS] };

/** Read keys only, keeping the page's order and all four tasks when the response isn't usable. */
function taskChoices(read: unknown): AgentTasks {
  if (read === null || typeof read !== 'object' || !('task_set' in read) || !isDemoTaskSet(read.task_set)) return FALLBACK_TASKS;
  const tasks = 'tasks' in read ? read.tasks : undefined;
  const usable = Array.isArray(tasks) && tasks.includes('book_visit') && tasks.every((task) => DEMO_TASKS.some((known) => known === task));
  return { task_set: read.task_set, tasks: usable ? DEMO_TASKS.filter((task) => tasks.includes(task)) : [...DEMO_TASKS] };
}

/** The states that offer the tasks: before a run, after one ended, and after a start that clearly didn't go ahead. */
const OFFERS_TASKS: ReadonlySet<Status> = new Set<Status>(['idle', 'done', 'stopped', 'busy', 'budget', 'not_sent']);

/**
 * What a failed start means for the panel; `retry` when it was "Try again" after a lost start. Such
 * a start stays unresolved until the send itself answers: a session that couldn't reopen (an
 * `openSession` refusal or no answer) or anything else leaves it lost, to try again. A second 401
 * ends the chat, but the agent may still be on its way, so it is the reload, never fresh tasks.
 * Any other answer from the send settles it as on a first send: that relies on the API answering a
 * repeat from its key before every refusal that offers the tasks again (its limits' 429s, the full
 * key map's 429, `demo_budget`, a kernel 4xx on the mint), so such a refusal means nothing started.
 */
function sendFailure(err: unknown, retry: boolean): Status {
  const answered = err instanceof ApiError && err.route === 'sendAgent';
  if (retry && !answered) return 'lost';
  if (!(err instanceof ApiError)) return 'not_sent';
  if (err.kind === 'unauthorized') return retry ? 'reload' : 'ended';
  // The API's own key conflict: the key came from another session (a 401 opened a new one), so the
  // lost start's run, if any, is the old session's, out of this page's reach. A first send's
  // conflict, or the kernel's 409, which freed the key, started nothing.
  if (retry && err.kind === 'conflict' && !err.kernel && err.code === 'conflict') return 'reload';
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
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Which words the Desk's tasks take: read once with the visitor's session, null until then.
  const [choices, setChoices] = useState<AgentTasks | null>(null);
  const taskSet = choices?.task_set ?? null;
  const { hash } = useLocation();
  // Land on the finished task list: four chips can wrap differently from their loading shapes.
  // Move only as far as needed, leaving the page's title and disclosure visible when they fit.
  useLayoutEffect(() => {
    if (choices !== null && hash === `#${SEND_ID}`) titleRef.current?.closest('section')?.scrollIntoView({ block: 'nearest' });
  }, [hash, choices]);
  const setRead = useRef<Promise<AgentTasks> | null>(null);
  useEffect(() => {
    let live = true;
    setRead.current ??= session.call(() => request('agentTasks', { params: { slug } })).then(
      taskChoices,
      () => FALLBACK_TASKS,
    );
    void setRead.current.then((read) => {
      if (live) setChoices(read);
    });
    return () => {
      live = false;
    };
  }, [session, slug]);
  const words = DEMO_TASK_COPY[language][taskSet ?? FALLBACK_TASK_SET];
  // The current run's reads; aborted by a new run, a new chat and the page going away, which ends
  // its waits and stops it applying anything.
  const reading = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      reading.current?.abort();
    },
    [],
  );

  /**
   * Sends the agent on `task` with `key`: a new key for a click, the same one to try that click again
   * after its answer was lost (`retry`).
   */
  const send = async (task: DemoTask, key: string, keyMadeAt: number, retry = false) => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const { signal } = controller;
    setState({ status: 'sending', task, key, keyMadeAt, runId: null, run: null, readsFailing: false });
    let runId: string;
    try {
      const started = await session.call(() => request('sendAgent', { params: { slug }, body: { task, idempotency_key: key } }));
      if (typeof started?.run_id !== 'string') throw new ApiError('unavailable', { route: 'sendAgent', method: 'POST', status: 202 });
      runId = started.run_id;
    } catch (err) {
      if (!signal.aborted) setState({ status: sendFailure(err, retry), task, key, keyMadeAt, runId: null, run: null, readsFailing: false });
      return;
    }
    if (signal.aborted) return;
    setState({ status: 'running', task, key, keyMadeAt, runId, run: null, readsFailing: false });
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
          setState({ status: run.state === 'done' ? 'done' : 'stopped', task, key, keyMadeAt, runId, run, readsFailing: false });
          return;
        }
        // Running, or a state this build doesn't know, which isn't an end: read on.
        setState({ status: 'running', task, key, keyMadeAt, runId, run, readsFailing: false });
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
    const task = DEMO_TASKS.find((t) => words[t] === label);
    if (task === undefined) return;
    // The tasks go while the agent works, the one pressed with them: its focus moves to the title
    // before it goes, so it doesn't fall to the page. The focus doesn't scroll the page: bringing
    // the run into view is `runInView`'s, and a scroll here would cut its smooth one short.
    titleRef.current?.focus({ preventScroll: true });
    runInView.follow();
    void send(task, newIdempotencyKey(), Date.now());
  };

  /**
   * "Try again" after a lost start: the same task with the same key, so the agent runs once, while
   * the key is inside its window; past it (a tab whose timers were held back), the reload instead.
   */
  const tryAgain = () => {
    const { task, key, keyMadeAt } = state;
    if (task === null || key === null || keyMadeAt === null) return;
    // Past the window the reload takes the same button, as on the timer's path, so focus stays on it.
    if (Date.now() - keyMadeAt >= KEY_RETRY_WINDOW_MS) {
      setState((prev) => ({ ...prev, status: 'reload' }));
      return;
    }
    // Sending again, "Try again" goes with its line: its focus moves to the title, as a task's does.
    titleRef.current?.focus({ preventScroll: true });
    runInView.follow();
    void send(task, key, keyMadeAt, true);
  };

  // A lost start's "Try again" lasts as long as its key's window: then the reload takes its place,
  // in the same notice and the same button, so a visitor whose focus is on it stays there.
  const { status: shown, key: shownKey, keyMadeAt: shownMadeAt } = state;
  useEffect(() => {
    if (shown !== 'lost' || shownMadeAt === null) return;
    const timer = setTimeout(
      () => setState((prev) => (prev.status === 'lost' && prev.key === shownKey ? { ...prev, status: 'reload' } : prev)),
      Math.max(0, shownMadeAt + KEY_RETRY_WINDOW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [shown, shownKey, shownMadeAt]);

  const newChat = () => {
    // "New chat" goes with its notice, and the tasks come back: its focus moves to the title before
    // it goes, as a task's does, so the next Tab goes on to the first task.
    titleRef.current?.focus({ preventScroll: true });
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
    // The agent may be on its way and no read can find its run without its id: the same key finds it.
    notice = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={tryAgain}>
            {PUBLIC_COPY[language].tryAgain}
          </Button>
        }
      >
        {agentStartLostLine(language)}
      </Notice>
    );
  } else if (status === 'reload') {
    // No retry here can find the agent's run any more: a reload is the retry.
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
  // Each kind wraps on its own. Until the set is read, the same rows hold the chips' places.
  const chips = !OFFERS_TASKS.has(status) ? null : (
    <div className="cd-agents-card__tasks">
      {DEMO_TASK_ROWS.map((row) => {
        if (taskSet === null) return (
          <div key={row[0]} className="cd-suggestion-chips" aria-hidden="true" data-loading="task-chips">
            {row.map((t) => (
              <Skeleton key={t} shape="block" measure={{ label: DEMO_TASK_COPY[language].rivera[t], className: 'cd-chip cd-type-pill' }} height="var(--space-28)" radius="full" />
            ))}
          </div>
        );
        const tasks = row.filter((t) => (choices?.tasks ?? DEMO_TASKS).includes(t));
        return tasks.length === 0 ? null : (
          <SuggestionChips key={row[0]} label={copy.tasksLabel} suggestions={tasks.map((t) => words[t])} onPick={pick} />
        );
      })}
    </div>
  );
  // After a run that finished, failed or is gone, the tasks come at its end, under its last line
  // (boards 04 and 05); otherwise they sit under the signed limit (board 03).
  const chipsAtEnd = status === 'done' || status === 'stopped';
  // While a run is starting or exists (or may, after a lost start), the chosen task takes the lead's
  // place (boards 04 and 05). A start that never ran keeps the lead.
  const ran = status === 'sending' || status === 'lost' || status === 'reload' || runId !== null;
  const lead =
    task !== null && ran ? words[task] : copy.sendLead(<span data-copy="user">{business}</span>);

  return (
    <Card as="section" label={copy.sendTitle} padding={16} holdsCards>
      <AgentsCardContent title={copy.sendTitle} lead={lead} id={SEND_ID} titleRef={titleRef}>
        {/* The signed limit shows in every state, as board 05 draws it during a run. */}
        <SignedLimitPanel {...copy.limit} language={language} />
        {chipsAtEnd ? null : chips}
        {run !== null && task !== null && run.turns.length > 0 ? (
          <Transcript label={copy.conversation}>
            <RunRows turns={run.turns} task={task} taskSet={taskSet ?? FALLBACK_TASK_SET} ownerName={ownerName} language={language} />
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
  /** Which words the Desk's tasks take, for the first request's title. */
  taskSet: DemoTaskSet;
  ownerName: string;
  language: CopyLanguage;
}

/**
 * The run's turns in order: each of the agent's requests titled and numbered by code, quoting the
 * words it sent (`agentWords`), marked as English (`RUN_LANGUAGE`) whatever the page's language,
 * and nothing else the turn holds, and each Desk reply with its receipts under it. A turn by anyone
 * else shows nothing.
 */
function RunRows({ turns, task, taskSet, ownerName, language }: RunRowsProps) {
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
                title={requests === 1 ? DEMO_TASK_COPY[language][taskSet][task] : copy.signedRequest}
                meta={copy.request(requests)}
                text={agentWords(turn)}
                textLanguage={RUN_LANGUAGE}
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
