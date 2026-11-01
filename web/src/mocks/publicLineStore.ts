/** The setup routes and public charter read the same lines, scoped to one copy and interview. */
import type { PublicLine } from '../api/views.ts';
import type { MockWorld } from './world.ts';

const LINES = new WeakMap<MockWorld, Map<string, PublicLine[]>>();

export function storedPublicLines(world: MockWorld, interviewId: string): PublicLine[] | undefined {
  return LINES.get(world)?.get(interviewId);
}

export function storePublicLines(world: MockWorld, interviewId: string, lines: PublicLine[]): void {
  let interviews = LINES.get(world);
  if (!interviews) {
    interviews = new Map();
    LINES.set(world, interviews);
  }
  interviews.set(interviewId, lines);
}
