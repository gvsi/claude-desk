/**
 * How often owner screens poll, in milliseconds, through React Query's `refetchInterval` (which
 * pauses while the tab is hidden), how often typing pings go out on either side of a chat, and how
 * often the agents page reads the built-in agent's run. Tests speed every interval up with
 * `setPollScale`.
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
