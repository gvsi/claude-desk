/**
 * The mock API's demo visitor: a scripted customer, with no model, that chats on one of the copy's
 * own Desks through the visitor's own side of the chat, as the API's runner does through the public
 * visitor endpoints. It opens a visitor chat marked as the demo visitor's (`SessionRecord.demoVisitor`,
 * so the owner's reads tag it), then says its lines one at a time, each after Claude's turn has
 * ended, typing first: a price, a 10% discount the rules hold for the owner, the open times, then a
 * booking with its example.com email. While the owner has the chat it waits, and answers them once
 * after they say something. It ends `finished` after its last line, or `stopped_by_owner` when the
 * owner stops it. One runs at a time in a copy, a copy starts three an hour, and a click's key
 * answers the run it started, as the API's routes do.
 */
import type { DemoVisitorRun } from '../api/views.ts';

/** How a run ended, as the API's `DemoVisitorRun.ended` says it. */
export type DemoVisitorEnded = NonNullable<DemoVisitorRun['ended']>;

/** The run's state once it ended so, as the API's runner sets it. */
const ENDED_STATE: Record<DemoVisitorEnded, DemoVisitorRun['state']> = {
  finished: 'done',
  limit: 'done',
  owner_silent: 'done',
  stopped_by_owner: 'stopped',
  chat_ended: 'stopped',
  budget: 'failed',
  failed: 'failed',
};
import type { DeskRecord, MockWorld, SessionRecord } from './world.ts';

/** The persona's first name: Riley Morgan, who names the chat in the owner's lists. */
export const DEMO_VISITOR_NAME = 'Riley';

/** What the demo visitor says, in order: each line meets one of the script's rules (script.ts). */
export const DEMO_VISITOR_LINES = [
  'Hi, my kitchen sink is leaking under the cabinet. How much to fix a leak?',
  'Could I get 10% off as a returning customer?',
  'Okay, thanks. Can someone come Tuesday?',
  'The first one works. My email is riley.morgan@example.com.',
] as const;

/** What it says, once, to the owner who took the chat over and wrote to it. */
export function ownerReply(ownerFirstName: string): string {
  return `Hi ${ownerFirstName}! Will you bring something for a deep clog? It's been slow for a week.`;
}

/** A copy starts at most this many in an hour (the API's `STARTS_PER_HOUR`). */
export const STARTS_PER_HOUR = 3;

const HOUR_MS = 60 * 60_000;

/** What the runs act through: the copy, Claude's turns, and the pace of a person reading and typing. */
export interface DemoVisitorHost {
  readonly world: MockWorld;
  /** Whether Claude's turn in the chat is still going. */
  turnGoing(sessionId: string): boolean;
  /** The visitor's message, as the visitor's own route sends it: Claude's turn follows. */
  visitorSays(session: SessionRecord, text: string): void;
  /** Milliseconds the demo visitor reads before it types, and types before it sends. */
  readonly paceMs: number;
}

interface Held {
  run: DemoVisitorRun;
  key: string;
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Why a start can't be answered: the key started a run on another Desk, or the copy has started its three this hour. */
export type StartRefused = { refused: 'conflict' } | { refused: 'rate_limited'; retryAfter: number };

export class DemoVisitorRuns {
  /** Oldest first. */
  private readonly runs = new Map<string, Held>();
  /** When each start within the hour came, oldest first. */
  private starts: number[] = [];

  /**
   * Starts the demo visitor on `desk`, or answers the run the click's `key` started (however it
   * ended) or the one already going in the copy, on whichever Desk. Refused when the key started a
   * run on another Desk, or when a fourth would start within the hour.
   */
  start(host: DemoVisitorHost, desk: DeskRecord, key: string): DemoVisitorRun | StartRefused {
    const now = Date.now();
    this.starts = this.starts.filter((at) => now - at < HOUR_MS);
    const keyed = [...this.runs.values()].find((held) => held.key === key && now - held.at < HOUR_MS);
    if (keyed !== undefined) return keyed.run.desk_id === desk.summary.desk_id ? { ...keyed.run } : { refused: 'conflict' };
    const running = this.running();
    if (running !== null) return { ...running };
    const oldest = this.starts[0];
    if (this.starts.length >= STARTS_PER_HOUR && oldest !== undefined) {
      return { refused: 'rate_limited', retryAfter: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)) };
    }
    this.starts.push(now);
    return { ...this.launch(host, desk, key, now) };
  }

  /** The run as it stands, or null when there is none by that ID. */
  read(runId: string | undefined): DemoVisitorRun | null {
    const held = runId === undefined ? undefined : this.runs.get(runId);
    return held === undefined ? null : { ...held.run };
  }

  /** The newest run on the Desk, or null. */
  newest(deskId: string | undefined): DemoVisitorRun | null {
    const runs = [...this.runs.values()].filter((held) => held.run.desk_id === deskId);
    const last = runs.at(-1);
    return last === undefined ? null : { ...last.run };
  }

  /** Stops a running run (`stopped_by_owner`); one that ended is answered as it is. Null when there is none by that ID. */
  stopRun(runId: string | undefined): DemoVisitorRun | null {
    const held = runId === undefined ? undefined : this.runs.get(runId);
    if (held === undefined) return null;
    if (held.run.state === 'running') this.end(held, 'stopped_by_owner');
    return { ...held.run };
  }

  /** Ends a running run as the API's can end, for a test: it says nothing more. Null when there is none by that ID. */
  endRun(runId: string, how: DemoVisitorEnded): DemoVisitorRun | null {
    const held = this.runs.get(runId);
    if (held === undefined) return null;
    if (held.run.state === 'running') this.end(held, how);
    return { ...held.run };
  }

  /** Stops every run's next step and forgets them, as a fresh copy has none. */
  stop(): void {
    for (const held of this.runs.values()) if (held.timer !== null) clearTimeout(held.timer);
    this.runs.clear();
    this.starts = [];
  }

  private running(): DemoVisitorRun | null {
    return [...this.runs.values()].find((held) => held.run.state === 'running')?.run ?? null;
  }

  private end(held: Held, how: DemoVisitorEnded): void {
    if (held.timer !== null) clearTimeout(held.timer);
    held.timer = null;
    held.run.state = ENDED_STATE[how];
    held.run.ended = how;
  }

  private launch(host: DemoVisitorHost, desk: DeskRecord, key: string, now: number): DemoVisitorRun {
    const { world } = host;
    const session = world.addSession(desk, { demoVisitor: DEMO_VISITOR_NAME });
    const sessionId = session.state.session_id;
    const run: DemoVisitorRun = {
      run_id: world.id('visitor'),
      desk_id: desk.summary.desk_id,
      first_name: DEMO_VISITOR_NAME,
      session_id: sessionId,
      state: 'running',
      messages_sent: 0,
      ended: null,
    };
    // The chat's mark names its run, as the API's does.
    session.demoVisitorRun = run.run_id;
    const held: Held = { run, key, at: now, timer: null };
    this.runs.set(run.run_id, held);
    const lines: string[] = [...DEMO_VISITOR_LINES];
    // The line it is typing, sent at its next step; and the newest item it had read when the owner last had its answer.
    let typing: string | null = null;
    let answeredOwnerAt = 0;
    const ownerSpoke = (chat: SessionRecord) =>
      chat.items.some((item) => item.n > answeredOwnerAt && item.kind === 'delivered' && item.event?.type === 'message' && item.event.author === 'owner');
    const step = () => {
      held.timer = setTimeout(() => {
        held.timer = null;
        if (run.state !== 'running' || host.world !== world) return;
        const chat = world.sessions.get(sessionId);
        if (chat === undefined || chat.ended || world.deletedDesks.has(chat.deskId)) {
          this.end(held, 'chat_ended');
          return;
        }
        if (typing !== null) {
          host.visitorSays(chat, typing);
          run.messages_sent += 1;
          typing = null;
        } else if (host.turnGoing(sessionId)) {
          // Claude is still answering: it reads the answer first.
        } else if (chat.state.mode === 'owner') {
          // The owner has the chat: it answers them once they have said something, then waits.
          if (answeredOwnerAt === 0 && ownerSpoke(chat)) {
            answeredOwnerAt = chat.items.at(-1)?.n ?? 1;
            typing = ownerReply(world.ownerNameOf(chat).split(' ')[0] ?? '');
            world.visitorTyping(chat);
          }
        } else {
          const next = lines.shift();
          if (next === undefined) {
            this.end(held, 'finished');
            return;
          }
          typing = next;
          world.visitorTyping(chat);
        }
        step();
      }, host.paceMs);
    };
    step();
    return run;
  }
}
