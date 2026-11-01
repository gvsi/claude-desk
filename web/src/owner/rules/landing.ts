/**
 * Where a confirmed rule change lands: Ask Claude's review, or a change's own review page that Rules
 * opened, hands Rules what the change changed (`land`), and Rules shows it on those rows
 * (`useLanding`, then `takeLanding`). Only those two hand one over, both while Rules is open or
 * about to open, and Rules takes each once, so a change never lands on a later visit. It shows only
 * what the confirm's answer and the draft's own cards say: it decides and applies nothing.
 */
import { useCallback, useSyncExternalStore } from 'react';

import type { ConfirmedChange } from './RuleDraftReview.tsx';

/** A confirmed change on its way to Rules. */
export interface Landing extends ConfirmedChange {
  /** Which landing this is, so a second change to the same row lights it up again. */
  id: number;
  deskId: string;
}

let current: Landing | null = null;
let count = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hands Rules a change the owner just confirmed on `deskId`, in place of any it hasn't taken. */
export function land(deskId: string, change: ConfirmedChange): void {
  count += 1;
  current = { ...change, id: count, deskId };
  notify();
}

/** Rules has shown `landing`: it is taken, and lands nowhere else. */
export function takeLanding(landing: Landing): void {
  if (current?.id !== landing.id) return;
  current = null;
  notify();
}

/** The change waiting to land on `deskId`'s Rules, if there is one. */
export function useLanding(deskId: string): Landing | null {
  const read = useCallback(() => (current?.deskId === deskId ? current : null), [deskId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether the owner asked for reduced motion, or the browser can't say: the end state, at once. */
export function reducesMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
