import type { BusinessOut, UnfinishedSetupStep } from '../../api/views.ts';
import { readLocal, writeLocal } from '../../lib/storage.ts';
import { STEP_INDEX } from '../../setup/copy.ts';
import { skeletonSetupOf, type SkeletonSetup } from './TodaySkeleton.tsx';

/**
 * What the loading page draws Today's "Not live yet" card from before the copy's Desks are read: the
 * shape each Desk's unfinished setup had when this browser last listed it. A reload reads the Desks
 * again, and until they arrive the loading page would otherwise draw Today without the card, then
 * drop everything under it when the card's shape comes in. One record, Desk by Desk, rewritten from
 * every settled read of the Desks, so only the copy's unfinished Desks are in it. It is a convenience:
 * unread or stale, the Desks' own answer replaces it.
 */
type Remembered = Record<string, SkeletonSetup>;

function read(): Remembered {
  try {
    const parsed: unknown = JSON.parse(readLocal('todaySetup') ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Remembered) : {};
  } catch {
    return {};
  }
}

function isStep(value: unknown): value is UnfinishedSetupStep {
  return typeof value === 'string' && Object.hasOwn(STEP_INDEX, value) && value !== 'live';
}

/** The "Not live yet" card's shape this browser last saw for `deskId`, or undefined. */
export function rememberedSetup(deskId: string): SkeletonSetup | undefined {
  const entry: unknown = read()[deskId];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { step, answering, business, owner, timezone } = entry as Partial<SkeletonSetup>;
  if (!isStep(step) || typeof answering !== 'boolean' || typeof business !== 'string') return undefined;
  // The greeting's name and time of day; an entry remembered without them draws no card until the
  // Desks are read.
  if (typeof owner !== 'string' || typeof timezone !== 'string') return undefined;
  return { step, answering, business, owner, timezone };
}

/**
 * Remembers what the copy's Desks say, once they are read: each listed Desk whose setup isn't finished,
 * with its card's shape. A Desk that went live, was deleted or belongs to an earlier copy leaves it.
 */
export function rememberSetups(businesses: readonly BusinessOut[]): void {
  const all: Remembered = {};
  for (const business of businesses) {
    for (const desk of business.desks) {
      const setup = skeletonSetupOf(desk, business);
      if (setup !== undefined) all[desk.desk_id] = setup;
    }
  }
  const next = Object.keys(all).length === 0 ? null : JSON.stringify(all);
  if (next !== readLocal('todaySetup')) writeLocal('todaySetup', next);
}
