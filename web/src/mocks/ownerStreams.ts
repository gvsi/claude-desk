/**
 * The mock's owner-chat streams: Ask Claude's answer and a running setup turn, written out as a
 * model would, one word at a time, each delta the whole text so far. A setup turn after the owner's
 * "Yes, use it" reads first: each read starts, then ends with its label. `playReply` plays one reply
 * to a sink on timers; a test can plan the next stream (`OwnerStreamPlan`) to pause it, start it
 * again, fail it or break it off.
 */

/** How the mock's streams are written: the pace, and whether setup turns stream at all. */
export interface StreamSettings {
  /** Milliseconds between words. */
  wordMs: number;
  /**
   * Setup's answers, decisions, consent and suggestions run as streamed turns: the request answers
   * 202 busy at once and the turn lands when its stream ends. Otherwise they land in their request.
   */
  setupTurns: boolean;
}

/** The dev server's: about the pace of a model writing, with every setup turn streamed. */
export const MODEL_PACE: StreamSettings = { wordMs: 45, setupTurns: true };
/** The screen tests' default: quick, with setup's turns landing in their requests as before. */
export const TEST_PACE: StreamSettings = { wordMs: 2, setupTurns: false };

/** A read is about this many words' time. */
const READ_WORDS = 20;

/** What a test plans for the next stream. Counts are deltas sent. */
export interface OwnerStreamPlan {
  /** Holds the stream after this many deltas until `until` settles. */
  pauseAfter?: number;
  until?: Promise<unknown>;
  /** Sends a reset after this many deltas, once, and writes the reply again from its start. */
  resetAfter?: number;
  /** Ends with this error instead, after `failAfter` deltas (all of them when absent). */
  fail?: { status: number; error: string };
  failAfter?: number;
  /** Breaks the connection off after this many deltas, with no last event. */
  dropAfter?: number;
}

/** A read the turn makes before it writes, and the label it ends with. */
export interface PlayedRead {
  read: 'memory' | 'website' | 'search';
  host: string | null;
  text: string;
}

export type PlayedEvent =
  | { name: 'delta'; text: string }
  | { name: 'reset' }
  | { name: 'reading'; read: PlayedRead['read']; host: string | null }
  | { name: 'label'; read: PlayedRead['read']; text: string }
  | { name: 'error'; status: number; error: string };

export interface ReplySink {
  event(ev: PlayedEvent): void;
  /** The reply is all sent (`done`), failed after its error event, or broke off. */
  end(how: 'done' | 'error' | 'drop'): void;
}

export interface Reply {
  text: string;
  wordMs: number;
  reads?: readonly PlayedRead[];
  plan?: OwnerStreamPlan | null;
}

/** The text as it grows, one word (with the space before it) at a time, ending with the whole text. */
export function growingWords(text: string): string[] {
  const words = text.match(/\s*\S+/g) ?? [];
  const out: string[] = [];
  let sofar = '';
  for (const word of words) {
    sofar += word;
    out.push(sofar);
  }
  if (out.length > 0) out[out.length - 1] = text;
  return out;
}

/** One step of a played reply: an event after `wait`, a hold on a promise, or the end. */
type Step = { wait: number; ev: PlayedEvent } | { hold: Promise<unknown> } | { wait: number; end: 'done' | 'error' | 'drop' };

function stepsOf({ text, wordMs, reads = [], plan }: Reply): Step[] {
  const steps: Step[] = [];
  for (const { read, host } of reads) steps.push({ wait: wordMs, ev: { name: 'reading', read, host } });
  for (const { read, text: label } of reads) steps.push({ wait: wordMs * READ_WORDS, ev: { name: 'label', read, text: label } });
  const words = growingWords(text);
  const failAt = plan?.fail ? (plan.failAfter ?? words.length) : null;
  /** The end planned once `sent` deltas are out, if any. */
  const endingAt = (sent: number): Step[] | null => {
    if (failAt === sent && plan?.fail) return [{ wait: wordMs, ev: { name: 'error', ...plan.fail } }, { wait: 0, end: 'error' }];
    if (plan?.dropAfter === sent) return [{ wait: 0, end: 'drop' }];
    return null;
  };
  let sent = 0;
  let reset = false;
  let ending = endingAt(0);
  for (let at = 0; ending === null && at < words.length; at += 1) {
    steps.push({ wait: wordMs, ev: { name: 'delta', text: words[at] ?? '' } });
    sent += 1;
    if (plan?.pauseAfter === sent && plan.until) steps.push({ hold: plan.until });
    ending = endingAt(sent);
    if (ending === null && !reset && plan?.resetAfter === sent) {
      reset = true;
      steps.push({ wait: wordMs, ev: { name: 'reset' } });
      at = -1;
    }
  }
  steps.push(...(ending ?? [{ wait: wordMs, end: 'done' }]));
  return steps;
}

/**
 * Plays `reply` to `sink`: its reads, then its words, each a `wordMs` apart, then its end. Returns
 * the function that stops it, after which nothing more is sent and it never ends.
 */
export function playReply(reply: Reply, sink: ReplySink): () => void {
  const steps = stepsOf(reply);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    if (stopped) return;
    const step = steps.shift();
    if (step === undefined) return;
    if ('hold' in step) {
      void step.hold.finally(next);
      return;
    }
    timer = setTimeout(() => {
      if (stopped) return;
      if ('ev' in step) {
        sink.event(step.ev);
        next();
      } else {
        stopped = true;
        sink.end(step.end);
      }
    }, step.wait);
  };
  next();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
