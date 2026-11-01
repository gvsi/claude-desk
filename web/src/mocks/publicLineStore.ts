/** The setup routes and public charter share one revisioned state per copy and interview. */
import type { SetupPublicLine, SetupPublicLines } from '../api/views.ts';
import type { MockWorld } from './world.ts';

const STATES = new WeakMap<MockWorld, Map<string, SetupPublicLines>>();

export function storedPublicState(world: MockWorld, interviewId: string): SetupPublicLines | undefined {
  return STATES.get(world)?.get(interviewId);
}

/** Every committed write gets a fresh opaque revision, including a repeated accepted write. */
export function storePublicState(world: MockWorld, interviewId: string, state: Omit<SetupPublicLines, 'revision'>): SetupPublicLines {
  let interviews = STATES.get(world);
  if (!interviews) {
    interviews = new Map();
    STATES.set(world, interviews);
  }
  const next = { ...state, revision: crypto.randomUUID() };
  interviews.set(interviewId, next);
  return next;
}

export function storedPublicLines(world: MockWorld, interviewId: string): SetupPublicLine[] | undefined {
  return storedPublicState(world, interviewId)?.lines;
}

/** A line-only fixture/update retains structured fields and also changes the revision. */
export function storePublicLines(world: MockWorld, interviewId: string, lines: SetupPublicLine[]): void {
  const state = storedPublicState(world, interviewId);
  storePublicState(world, interviewId, { lines, hours: state?.hours ?? null, prices: state?.prices ?? null });
}
