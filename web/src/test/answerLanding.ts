/**
 * Watching a held request's answer land on a real screen, which runs with motion (a transcript
 * row's own landing is `landings.ts`): every frame,
 * whether the card's status line still waits, how tall the card's item is, and where whatever comes
 * after it sits, from now until the answer has landed and nothing in the item moves.
 */
import { expect } from 'vitest';

const HELD_LINE = 'Waiting for your answer';

/** How long an answer may take to land and settle before the watch gives up. */
const SETTLE_TIMEOUT_MS = 5_000;

/** A move this small (in px) can't show whether it eased: it fits in a frame or two whatever the curve. */
const TOO_SMALL_TO_EASE = 4;

export interface LandingFrame {
  /** The status line no longer waits: the answer's final line is in. */
  landed: boolean;
  /** The card's own height. */
  card: number;
  /** The item's height: the card, and what follows it in its place. */
  item: number;
  /** The top of what comes after the item, when one is watched. */
  next: number | null;
}

/**
 * Reads every frame from now until the card's answer has landed and nothing in `item` has moved
 * for two frames running. `card` is the request's card, `item` its place (the card and what follows
 * it there), and `next`, when given, whatever comes after.
 */
export function watchAnswerLanding(card: Element, item: Element, next?: Element): Promise<LandingFrame[]> {
  const frames: LandingFrame[] = [];
  const started = performance.now();
  let still = 0;
  return new Promise((resolve, reject) => {
    const step = () => {
      const status = card.querySelector('[role="status"]')?.textContent ?? HELD_LINE;
      const frame = {
        landed: status !== HELD_LINE,
        card: card.getBoundingClientRect().height,
        item: item.getBoundingClientRect().height,
        next: next ? next.getBoundingClientRect().top : null,
      };
      frames.push(frame);
      still = frame.landed && item.getAnimations({ subtree: true }).length === 0 ? still + 1 : 0;
      if (still >= 2) resolve(frames);
      else if (performance.now() - started > SETTLE_TIMEOUT_MS) reject(new Error('the answer never landed and settled'));
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Some frame sat between `from` and `to`, clear of both: the change was eased, not swapped. */
function passedBetween(values: readonly number[], from: number, to: number): boolean {
  return values.some((value) => Math.abs(value - from) > 0.5 && Math.abs(value - to) > 0.5);
}

/** `values` move one way only, toward the last, and (once the move is big enough to tell) through values between, so never in one jump. */
function expectOneWay(values: readonly number[], what: string): void {
  const from = values[0] ?? 0;
  const to = values.at(-1) ?? 0;
  const way = Math.sign(to - from);
  for (const [i, value] of values.entries()) {
    const step = value - (values[i - 1] ?? value);
    if (Math.abs(step) > 0.5) expect(Math.sign(step), `${what} moved against the settle at frame ${i}`).toBe(way);
  }
  if (Math.abs(to - from) > TOO_SMALL_TO_EASE) expect(passedBetween(values, from, to), `${what} jumped in one frame`).toBe(true);
}

/** The frames from the last one the card was held, with the card's own height eased from held to answered. */
function settling(frames: readonly LandingFrame[]): LandingFrame[] {
  const first = frames.findIndex((frame) => frame.landed);
  expect(first).toBeGreaterThan(-1);
  const settle = frames.slice(Math.max(0, first - 1));
  const cards = settle.map((frame) => frame.card);
  expect((cards[0] ?? 0) - (cards.at(-1) ?? 0)).toBeGreaterThan(TOO_SMALL_TO_EASE);
  expectOneWay(cards, 'the card');
  return settle;
}

/**
 * The answer landed in place, from the last frame the card was held:
 * - the card eased from its held height to its answered height;
 * - what comes after it moved one way only, toward where it ends, eased, so it never jumped;
 * - it ends moved by exactly what the item lost (the held card, against the settled card and what
 *   follows it). That is up when the answers were taller than what came under the card, and down
 *   when the rule an "always" answer drafted and Dismiss are taller than the answers.
 * Returns that change, held less settled.
 */
export function expectLandedInPlace(frames: readonly LandingFrame[]): number {
  const settle = settling(frames);
  const tops = settle.map((frame) => frame.next);
  if (tops.some((top) => top === null)) throw new Error('watch what comes after the item to see where it lands');
  expectOneWay(tops as number[], 'what follows');
  const held = settle[0] as LandingFrame;
  const end = settle.at(-1) as LandingFrame;
  const lost = held.item - end.item;
  expect((held.next ?? 0) - (end.next ?? 0)).toBeCloseTo(lost, 0);
  return lost;
}

/**
 * The answer settled in its slot, where what follows can change for other reasons as it settles (a
 * conversation reads the answer's outcome in): the card eased from its held height to its answered
 * height, and its slot's height moved one way only, eased, to its settled height. Returns what the
 * slot lost, held less settled.
 */
export function expectSettledInItsSlot(frames: readonly LandingFrame[]): number {
  const settle = settling(frames);
  const heights = settle.map((frame) => frame.item);
  expectOneWay(heights, 'the slot');
  return (heights[0] ?? 0) - (heights.at(-1) ?? 0);
}
