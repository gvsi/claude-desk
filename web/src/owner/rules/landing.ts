/**
 * Where a confirmed rule change lands: Ask Claude's review, or a change's own review page that Rules
 * opened, hands Rules what the change changed (`land`), and Rules shows it on those rows
 * (`useLanding`, then `takeLanding`). Two changes confirmed before Rules shows them land together.
 * A change waits only while the owner stays on Rules or the review Rules opened (`landsHere`, which
 * the owner frame applies on every move with `useLandingVisit`), so it never lands on a later visit.
 * It shows only what the confirm's answer and the draft's own cards say: it decides and applies
 * nothing.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';

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

/**
 * Hands Rules a change the owner just confirmed on `deskId`. One still waiting on the same Desk
 * lands with it: every row either changed, the payment limit if either changed it, at the later
 * version. One waiting on another Desk is dropped.
 */
export function land(deskId: string, change: ConfirmedChange): void {
  count += 1;
  const waiting = current?.deskId === deskId ? current : null;
  const rows =
    waiting === null
      ? change.rows
      : { tools: [...new Set([...waiting.rows.tools, ...change.rows.tools])], moneyLimit: waiting.rows.moneyLimit || change.rows.moneyLimit };
  current = { id: count, deskId, version: Math.max(change.version, waiting?.version ?? 0), rows };
  notify();
}

/** Rules has shown `landing`: it is taken, and lands nowhere else. */
export function takeLanding(landing: Landing): void {
  if (current?.id !== landing.id) return;
  current = null;
  notify();
}

/** The change waiting to land on `deskId`'s Rules, if there is one. */
export function pendingLanding(deskId: string): Landing | null {
  return current?.deskId === deskId ? current : null;
}

/** The change waiting to land on `deskId`'s Rules, read as it changes. */
export function useLanding(deskId: string): Landing | null {
  const read = useCallback(() => pendingLanding(deskId), [deskId]);
  return useSyncExternalStore(subscribe, read, read);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Whether a change waiting for `deskId` may still land from `pathname` (with its router `state`):
 * on that Desk's Rules, or on a review Rules opened, which goes back to Rules once confirmed.
 */
export function landsHere(deskId: string, pathname: string, state: unknown): boolean {
  const rules = `/app/${encodeURIComponent(deskId)}/rules`;
  if (pathname === rules || pathname === `${rules}/`) return true;
  return pathname.startsWith(`${rules}/drafts/`) && isRecord(state) && state.fromRules === true;
}

/**
 * For the owner frame: drops a waiting change once the owner goes anywhere it can't land, so it
 * never lands on a later visit, even when Rules never read the version it made. Not on Rules
 * leaving alone, which a review Rules opened hands its change back across.
 */
export function useLandingVisit(): void {
  const { pathname, state, key } = useLocation();
  useEffect(() => {
    if (current === null || landsHere(current.deskId, pathname, state)) return;
    current = null;
    notify();
    // Once per move: `state` belongs to the entry `key` names.
  }, [key, pathname]);
  // Leaving the owner's pages altogether drops it too. StrictMode's rehearsal of this unmount runs
  // as the frame first mounts, before anything is waiting.
  useEffect(
    () => () => {
      if (current === null) return;
      current = null;
      notify();
    },
    [],
  );
}

/** Drops any waiting change, between tests. */
export function resetLandings(): void {
  current = null;
  notify();
}

/** Whether the owner asked for reduced motion, or the browser can't say: the end state, at once. */
export function reducesMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
