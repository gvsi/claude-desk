/** The setup routes and public charter read the same lines, scoped to one copy and interview. */
import type { SetupPublicLine } from '../api/views.ts';
import type { MockWorld } from './world.ts';

const LINES = new WeakMap<MockWorld, Map<string, SetupPublicLine[]>>();

export function storedPublicLines(world: MockWorld, interviewId: string): SetupPublicLine[] | undefined {
  return LINES.get(world)?.get(interviewId);
}

export function storePublicLines(world: MockWorld, interviewId: string, lines: SetupPublicLine[]): void {
  let interviews = LINES.get(world);
  if (!interviews) {
    interviews = new Map();
    LINES.set(world, interviews);
  }
  interviews.set(interviewId, lines);
}
