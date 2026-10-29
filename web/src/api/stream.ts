/**
 * A visitor's live events over one `EventSource`. The browser reconnects by itself, resending the
 * last seq as `Last-Event-ID`; this module only reads what arrives. Each event's JSON payload is
 * dispatched by its own `type`, with `seq` from the event's id. Anything it can't trust is dropped:
 * data that isn't a JSON object, a type the caller didn't ask for, a named event whose payload
 * claims another type, and an id that isn't a seq.
 */

export type StreamState = 'open' | 'reconnecting' | 'closed';

export interface StreamHandlers<E> {
  event(seq: number, ev: E): void;
  /**
   * `reconnecting` while the browser retries a dropped connection; `closed` when the server
   * answered other than 200, which `EventSource` never retries (a 401 is an ended chat).
   */
  state(state: StreamState): void;
}

const SEQ = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Opens the stream at `url`; the returned function closes it, after which nothing is reported. */
export function openStream<E extends { type: string }>(
  url: string,
  types: readonly E['type'][],
  on: StreamHandlers<E>,
): () => void {
  const known: ReadonlySet<string> = new Set(types);
  const source = new EventSource(url);
  let stopped = false;

  const dispatch = (e: Event) => {
    if (stopped || !(e instanceof MessageEvent) || typeof e.data !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!isRecord(payload) || typeof payload.type !== 'string' || !known.has(payload.type)) return;
    // An unnamed event arrives as "message" and may carry any known type; a named one must match.
    if (e.type !== 'message' && e.type !== payload.type) return;
    // Plain digits only: `Number()` would also read '', '0x5', '1e1' and '7 ' as a seq.
    if (!SEQ.test(e.lastEventId)) return;
    const seq = Number(e.lastEventId);
    if (!Number.isSafeInteger(seq)) return;
    on.event(seq, payload as E);
  };

  source.addEventListener('message', dispatch);
  for (const type of known) if (type !== 'message') source.addEventListener(type, dispatch);

  source.onopen = () => {
    if (!stopped) on.state('open');
  };
  source.onerror = (e: Event) => {
    // A named `error` event (an `EvError` payload, delivered above) also reaches `onerror`; only a
    // plain `Event` means the connection failed.
    if (stopped || e instanceof MessageEvent) return;
    if (source.readyState === EventSource.CLOSED) {
      stopped = true;
      source.close();
      on.state('closed');
    } else {
      on.state('reconnecting');
    }
  };

  return () => {
    stopped = true;
    source.close();
  };
}
