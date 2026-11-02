import type { UnfinishedSetupStep } from '../../api/views.ts';
import { readLocal, writeLocal } from '../../lib/storage.ts';
import { STEP_INDEX } from '../../setup/copy.ts';
import type { SkeletonSetup } from './TodaySkeleton.tsx';

/**
 * What the loading page draws Today's "Not live yet" card from before the copy's Desks are read: the
 * shape each Desk's unfinished setup had when this browser last listed it. A reload reads the Desks
 * again, and until they arrive the loading page would otherwise draw Today without the card, then
 * drop everything under it when the card's shape comes in. One record, Desk by Desk; a Desk that
 * went live leaves it. It is a convenience: unread or stale, the Desks' own answer replaces it.
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
  const { step, answering, business } = entry as Partial<SkeletonSetup>;
  if (!isStep(step) || typeof answering !== 'boolean' || typeof business !== 'string') return undefined;
  return { step, answering, business };
}

/** Remembers `deskId`'s card shape as the Desks list it, or forgets it once the Desk is live. */
export function rememberSetup(deskId: string, setup: SkeletonSetup | undefined): void {
  const all = read();
  const before = JSON.stringify(all[deskId] ?? null);
  if (setup === undefined) delete all[deskId];
  else all[deskId] = { step: setup.step, answering: setup.answering, business: setup.business };
  if (JSON.stringify(all[deskId] ?? null) === before) return;
  writeLocal('todaySetup', Object.keys(all).length === 0 ? null : JSON.stringify(all));
}
