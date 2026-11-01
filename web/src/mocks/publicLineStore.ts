/** The setup routes and public charter share one revisioned state per copy and interview. */
import type { SetupPublicLine, SetupPublicLines } from '../api/views.ts';
import type { MockWorld } from './world.ts';

const STATES = new WeakMap<MockWorld, Map<string, SetupPublicLines>>();
const HELD_SEEDS = new WeakMap<MockWorld, Map<string, Map<string, string>>>();

/** Fixture hook: keep the owner's exact words held on this interview's first public-lines read. */
export function holdPublicLineOnSeed(world: MockWorld, interviewId: string, key: string, text: string): void {
  if (storedPublicState(world, interviewId)) throw new Error('public lines already seeded');
  let interviews = HELD_SEEDS.get(world);
  if (!interviews) {
    interviews = new Map();
    HELD_SEEDS.set(world, interviews);
  }
  let lines = interviews.get(interviewId);
  if (!lines) {
    lines = new Map();
    interviews.set(interviewId, lines);
  }
  lines.set(key, text);
}

export function heldPublicLineSeed(world: MockWorld, interviewId: string, key: string): string | undefined {
  return HELD_SEEDS.get(world)?.get(interviewId)?.get(key);
}

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
