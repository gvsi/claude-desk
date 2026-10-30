/**
 * How often owner screens poll, in milliseconds, through React Query's `refetchInterval` (which
 * pauses while the tab is hidden). Tests speed every interval up with `setPollScale`.
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

/** Scales every interval by `factor` (1 is real time); tests use 0.05. */
export function setPollScale(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error(`setPollScale: ${factor} is not a positive number`);
  scale = factor;
}
