/**
 * The running setup turn's event stream (`setupEvents`), over one `EventSource` with the owner's
 * cookie. Each event carries one turn's display only: Claude's reply so far (`delta`, whole each
 * time; `reset` starts it again), the reads it makes after the owner's "Yes, use it" (`reading`
 * as one starts, `label` with the saved label's words as it ends), and `done` or `error`. Choices,
 * cards, the plan, the question and the step never come from here: only from the interview, read
 * again. Anything this module can't trust is dropped.
 */
import { apiPath } from './routes.ts';

/** What a read looks at: the owner's Claude memory, their website, or a web search. */
export type SetupRead = 'memory' | 'website' | 'web_search';

export type SetupStreamEvent =
  | { type: 'delta'; run: string; text: string }
  | { type: 'reset'; run: string }
  | { type: 'reading'; run: string; read: SetupRead; host: string | null }
  | { type: 'label'; run: string; read: SetupRead; text: string }
  /** `run` is null when no turn was running as the stream opened. */
  | { type: 'done'; run: string | null }
  | { type: 'error'; run: string | null; error: string };

const NAMES = ['delta', 'reset', 'reading', 'label', 'done', 'error'] as const;
const READS: ReadonlySet<unknown> = new Set<SetupRead>(['memory', 'website', 'web_search']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One event by its name and data, holding only the fields its name carries, or null. */
export function readSetupEvent(name: string, data: string): SetupStreamEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const { run } = payload;
  const runId = typeof run === 'string' ? run : null;
  switch (name) {
    case 'delta':
      return runId !== null && typeof payload.text === 'string' ? { type: 'delta', run: runId, text: payload.text } : null;
    case 'reset':
      return runId !== null ? { type: 'reset', run: runId } : null;
    case 'reading': {
      const { read, host } = payload;
      if (runId === null || !READS.has(read) || (host !== null && typeof host !== 'string')) return null;
      return { type: 'reading', run: runId, read: read as SetupRead, host };
    }
    case 'label':
      if (runId === null || !READS.has(payload.read) || typeof payload.text !== 'string') return null;
      return { type: 'label', run: runId, read: payload.read as SetupRead, text: payload.text };
    case 'done':
      return run === null || runId !== null ? { type: 'done', run: runId } : null;
    case 'error':
      if ((run !== null && runId === null) || typeof payload.error !== 'string') return null;
      return { type: 'error', run: runId, error: payload.error };
    default:
      return null;
  }
}

export interface SetupEventsHandlers {
  event(ev: SetupStreamEvent): void;
  /** The browser reconnected a dropped stream: the API replays the turn so far. */
  reconnected?(): void;
  /** The stream didn't open, or the server ended it with other than an event (a 404, a 401). */
  failed(): void;
}

/** Whether this browser can follow the setup turn's events. */
export function canFollowSetup(): boolean {
  return typeof EventSource === 'function';
}

/**
 * Opens interview `id`'s event stream. The returned function closes it, after which nothing is
 * reported; the caller closes it once a `done` or `error` arrives, so the browser never reconnects
 * to a turn that has ended. A dropped connection the browser retries by itself.
 */
export function openSetupEvents(id: string, on: SetupEventsHandlers): () => void {
  const source = new EventSource(apiPath('setupEvents', { id }));
  let stopped = false;
  const stop = () => {
    stopped = true;
    source.close();
  };
  const dispatch = (e: Event) => {
    if (stopped || !(e instanceof MessageEvent) || typeof e.data !== 'string') return;
    const ev = readSetupEvent(e.type, e.data);
    if (ev !== null) on.event(ev);
  };
  for (const name of NAMES) source.addEventListener(name, dispatch);
  let opens = 0;
  source.onopen = () => {
    if (stopped) return;
    opens += 1;
    if (opens > 1) on.reconnected?.();
  };
  source.onerror = (e: Event) => {
    // A named `error` event (the turn failed) reaches here too; only a plain `Event` is the connection.
    if (stopped || e instanceof MessageEvent) return;
    if (source.readyState === EventSource.CLOSED) {
      stop();
      on.failed();
    }
  };
  return stop;
}
