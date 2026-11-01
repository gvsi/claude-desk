/**
 * Ask Claude's answer as it is written: the owner's words posted to the rule chat with
 * `Accept: text/event-stream`. Each `delta` carries the whole answer so far, and `reset` starts it
 * again; both are Claude's words to the owner and nothing more. The answer itself, and any change
 * Claude drafted, come only from `final`, after the kernel has compiled and proved the draft, exactly
 * as the JSON route answers. An `error` event, or a refusal before any stream, fails as the JSON
 * route's would. Where the stream can't be read (the browser can't, it doesn't open, it breaks off
 * or goes quiet), the same words are asked again as today's JSON request.
 */
import { ApiError, canReadStreams, request, requestEvents, StreamBroken, streamedError } from './http.ts';
import type { RuleChatOut, RulesDraft } from './views.ts';

export interface AskRuleChatOptions {
  /** The answer so far, as it grows: `''` when it starts again or the stream gives way to JSON. */
  onText: (text: string) => void;
  /** Closes the stream: the ask rejects with an `AbortError`. */
  signal?: AbortSignal;
}

/** Whether this browser can show Claude's answer as it is written. */
export function canStream(): boolean {
  return canReadStreams();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `RuleChatOut` as the JSON route answers it: the answer's words, and a proved draft or null. */
function isRuleChatOut(value: Record<string, unknown>): value is Record<string, unknown> & RuleChatOut {
  const { answer, draft } = value;
  return typeof answer === 'string' && (draft === null || (isRecord(draft) && typeof draft.version === 'number' && Array.isArray(draft.cards)));
}

/** One event of the answer: the growing words handed on, the final answer returned, an error thrown. */
function readEvent(name: string, data: string, onText: (text: string) => void): RuleChatOut | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  switch (name) {
    case 'delta':
      if (typeof payload.text === 'string') onText(payload.text);
      return undefined;
    case 'reset':
      onText('');
      return undefined;
    case 'final':
      // Fails closed: a final it can't read shows as an answer that didn't come.
      if (!isRuleChatOut(payload)) throw new ApiError('unavailable', { route: 'ruleChat', method: 'POST', status: 200 });
      return { answer: payload.answer, draft: payload.draft };
    case 'error':
      throw streamedError('ruleChat', payload);
    default:
      return undefined;
  }
}

/**
 * Asks Claude about `text` on `deskId`'s rules, showing the answer as it grows through `onText`,
 * and resolves to what the JSON route would answer (a proving retry's last answer can be the draft
 * alone). Rejects as `request('ruleChat')` would, or with an `AbortError` once `signal` closes it.
 */
export async function askRuleChat(deskId: string, text: string, { onText, signal }: AskRuleChatOptions): Promise<RuleChatOut | RulesDraft> {
  const opts = { params: { desk_id: deskId }, body: { text } };
  if (!canStream()) return request('ruleChat', { ...opts, signal });
  try {
    const answered = await requestEvents('ruleChat', opts, { signal, onEvent: (name, data) => readEvent(name, data, onText) });
    return answered.value;
  } catch (err) {
    if (!(err instanceof StreamBroken)) throw err;
    onText('');
    return request('ruleChat', { ...opts, signal });
  }
}
