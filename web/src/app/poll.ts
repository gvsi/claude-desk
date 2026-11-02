/**
 * How often owner screens poll, in milliseconds, through React Query's `refetchInterval` (which
 * pauses while the tab is hidden), how often typing pings go out on either side of a chat, and how
 * often the agents page reads the built-in agent's run. The Notifications page runs its own
 * interval instead, so it stops the moment the page goes; like React Query's, it pauses while the tab is
 * hidden. An answer whose action is still under way is read again on its own schedule
 * (`ANSWER_REREAD_MS`). Tests speed every interval up with `setPollScale`.
 */
export const POLL_MS = {
  needsYou: 3_000,
  today: 5_000,
  conversation: 2_000,
  list: 5_000,
  inbox: 5_000,
  rules: 5_000,
  safety: 10_000,
} as const;

export type PollKey = keyof typeof POLL_MS;

let scale = 1;

/** The interval for `key`, scaled. */
export function pollMs(key: PollKey): number {
  return Math.max(1, Math.round(POLL_MS[key] * scale));
}

/** How often, at most, a typing ping goes out while someone types (plan 02b Task 1), in ms. */
export const TYPING_PING_MS = 2_000;

/** The typing ping interval, scaled like the polls. */
export function typingPingMs(): number {
  return Math.max(1, Math.round(TYPING_PING_MS * scale));
}

/** How often the agents page reads the built-in agent's run while it works (plan 02b: each second), in ms. */
export const AGENT_RUN_POLL_MS = 1_000;

/** The agent run's read interval, scaled like the polls. */
export function agentRunPollMs(): number {
  return Math.max(1, Math.round(AGENT_RUN_POLL_MS * scale));
}

/**
 * The waits before each read of a held request whose answer settled while its action was still
 * under way (`useAnswer`), in ms: six reads, 1, 3, 7, 15, 30 and 60 seconds after the answer. An
 * action usually runs within the answer's own request, so the first read comes soon and the gaps
 * then double. Each read also has the kernel ask after a run whose outcome isn't known, and settle
 * one that nothing is finishing once it is 30 seconds old; the last read, a minute in, comes after that.
 */
export const ANSWER_REREAD_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

/** The waits before an answer's re-reads, scaled like the polls. */
export function answerRereadMs(): number[] {
  return ANSWER_REREAD_MS.map((ms) => Math.max(1, Math.round(ms * scale)));
}

/** How long to wait before sending again after an answer's `retry_after` of `seconds`, scaled like the polls. */
export function retryAfterMs(seconds: number): number {
  return Math.max(1, Math.round(seconds * 1_000 * scale));
}

/**
 * Resolves after `ms`, or at once when `signal` aborts or already has: a wait between tries that
 * ends with the page.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

let retryScale = 1;

/**
 * How long a failed read waits before its one retry, React Query's own curve (a second, doubling, at
 * most 30), scaled by `setRetryScale`: real time unless a test asks for another pace.
 */
export function retryDelayMs(failures: number): number {
  return Math.min(1_000 * 2 ** failures, 30_000) * retryScale;
}

/** Scales the retry delay by `factor` (1 is real time); a test of a failed read passes 0. */
export function setRetryScale(factor: number): void {
  if (!Number.isFinite(factor) || factor < 0) throw new Error(`setRetryScale: ${factor} is not zero or a positive number`);
  retryScale = factor;
}

/** Scales every interval by `factor` (1 is real time); tests use 0.05. */
export function setPollScale(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error(`setPollScale: ${factor} is not a positive number`);
  scale = factor;
}
