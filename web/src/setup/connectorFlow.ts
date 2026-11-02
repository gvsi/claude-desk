/**
 * How a connector turns on in setup, apart from how its screens look: the owner-API calls behind
 * each of the owner's presses, in their order. The Tools step's screens (the list, a connector's one
 * screen to connect it and review its tools, the change to confirm) run them through `useConnectorFlow`.
 *
 * - An app setup can still connect (the mock payments server, Stripe): `setupConnect`, then
 *   `setupTools` read again. Its tool definitions exist only once it is connected: the kernel lists
 *   them from the server and pins each at its hash then. So it connects first, then its definitions
 *   show, then it turns on.
 * - A built-in connector, an app already connected, or one of the Desk's own jobs: `setupTools`
 *   already lists its definitions at their pinned hashes, so they show before the press that turns
 *   it on, and nothing connects.
 * - Turning on: one `confirmTool { tools: each at the hash it was listed at, enable: true }`, which
 *   drafts and proves the change and turns nothing on; the rules in force read again (`rules`); the
 *   draft shown to the owner; then their confirm, `confirmRules { version }`, which alone turns the
 *   tools on. A draft the rules overtook (`rules_changed_since_draft`) is asked for once more with the
 *   same `confirmTool`, and shown again to confirm.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError, ownerErrorCopy, request } from '../api/http.ts';
import type { ConfirmToolBody, RulesView, SetupTools, ToolConfirmedOut, ToolRow } from '../api/views.ts';
import type { ConnectorKey } from '../owner/connectors/catalog.ts';
import { draftFromVersion, type RuleDraft } from '../owner/rules/drafts.ts';
import { rulesQuery } from '../owner/rules/RuleDraftReview.tsx';

/** A connector, or one of the Desk's own jobs, by its key. */
export type ReviewKey = ConnectorKey | `desk.${string}`;

/** The mock payments server, the one connection setup can add. */
export const MOCK_PAYMENTS: ConnectorKey = 'stripe';

/** The owner-API calls a connector's turning on makes, so a test can follow their order. */
export interface ConnectorCalls {
  /** `setupConnect { server: 'mock_payments' }`. */
  connect: () => Promise<unknown>;
  /** `setupTools`, read again. */
  readTools: () => Promise<SetupTools>;
  /** `confirmTool`: drafts and proves the change, and turns nothing on. */
  confirmTools: (batch: ConfirmToolBody) => Promise<ToolConfirmedOut>;
  /** `rules`, read again: the rules in force, which the draft is shown against. */
  readRules: () => Promise<RulesView>;
  /** `confirmRules { version }`: the owner's confirm, which alone turns the tools on. */
  confirmRules: (version: number) => Promise<unknown>;
}

/**
 * Whether the connector must connect before its definitions exist: the mock payments server while
 * setup can still connect it. Every other connector's definitions are listed already.
 */
export function needsConnect(key: ReviewKey, tools: SetupTools | undefined): boolean {
  return key === MOCK_PAYMENTS && (tools?.connectable.includes('mock_payments') ?? false);
}

/** Connects the mock payments server, then reads the tools again: its definitions, pinned and not on. */
export async function connectApp(calls: ConnectorCalls): Promise<SetupTools> {
  await calls.connect();
  return calls.readTools();
}

/** A drafted change that turns tools on, waiting for the owner's confirm. */
export interface DraftedChange {
  /** The one `confirmTool` that drafted it, sent again if the rules overtake it. */
  batch: ConfirmToolBody;
  /** The tools it turns on, as they were listed. */
  rows: ToolRow[];
  draft: RuleDraft;
  /** It was drafted again after the rules changed since the first draft. */
  changed: boolean;
}

/** The tools at the hash each was listed at, to be turned on. */
export function turnOnBatch(rows: readonly ToolRow[]): ConfirmToolBody {
  return { tools: rows.map((row) => ({ tool: row.tool, definition_sha256: row.definition_sha256 ?? '' })), enable: true };
}

async function drafted(calls: ConnectorCalls, batch: ConfirmToolBody, rows: ToolRow[], changed: boolean): Promise<DraftedChange | null> {
  const confirmed = await calls.confirmTools(batch);
  if (confirmed.draft === null) return null;
  const active = (await calls.readRules()).active;
  return { batch, rows, draft: draftFromVersion(active, confirmed.draft, rows), changed };
}

/** Drafts turning `rows` on: one `confirmTool`, then the rules read again. Null when nothing is left to turn on. */
export function draftChange(calls: ConnectorCalls, rows: readonly ToolRow[]): Promise<DraftedChange | null> {
  return drafted(calls, turnOnBatch(rows), [...rows], false);
}

/**
 * The owner's confirm of a drafted change: `confirmRules`. When the rules changed since it was
 * drafted, and it wasn't drafted again already, the same tools are asked for once more and the new
 * draft goes to `onRedrafted`; the confirm's error is thrown either way, so nothing reads as on.
 */
export async function confirmChange(calls: ConnectorCalls, change: DraftedChange, onRedrafted: (next: DraftedChange) => void): Promise<void> {
  try {
    await calls.confirmRules(change.draft.version);
  } catch (err) {
    if (!change.changed && err instanceof ApiError && err.code === 'rules_changed_since_draft') {
      const next = await drafted(calls, change.batch, change.rows, true);
      if (next !== null) onRedrafted(next);
    }
    throw err;
  }
}

/** What the Tools step shows: the list, one connector's review, or the drafted change that turns it on. */
export type ConnectorView =
  | { kind: 'list' }
  | { kind: 'review'; key: ReviewKey }
  | ({ kind: 'confirm'; key: ReviewKey } & DraftedChange);

/**
 * The Tools step's connector flow: which view shows, what is in flight and what failed, and the
 * owner's presses, each running `connectorFlow`'s calls in their order.
 *
 * - `choose(key)` and `open(key)`: a connector's one screen opens at once, and connects nothing. The
 *   mock payments server, while it can be connected (`mustConnect`), opens not connected: its tools
 *   can't be known yet. `connect()` connects it there ("Connect Stripe") and stays, its definitions
 *   then read and shown for review.
 * - `turnOn(key, rows)`: drafts the change ("Turn it on"); `confirm()` is the owner's confirm of it.
 */
export function useConnectorFlow({ interviewId, deskId, tools }: { interviewId: string; deskId: string; tools: SetupTools | undefined }) {
  const queryClient = useQueryClient();
  const toolsKey = ['setupTools', interviewId] as const;
  const [view, setView] = useState<ConnectorView>({ kind: 'list' });
  const [connecting, setConnecting] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [reviewError, setReviewError] = useState<string | undefined>(undefined);

  const calls: ConnectorCalls = {
    connect: () => request('setupConnect', { params: { id: interviewId }, body: { server: 'mock_payments' } }),
    readTools: () => queryClient.fetchQuery({ queryKey: toolsKey, queryFn: () => request('setupTools', { params: { id: interviewId } }), staleTime: 0 }),
    confirmTools: (batch) => request('confirmTool', { params: { desk_id: deskId }, body: batch }),
    readRules: () => queryClient.fetchQuery({ ...rulesQuery(deskId), staleTime: 0 }),
    confirmRules: (version) => request('confirmRules', { params: { desk_id: deskId }, body: { version } }),
  };

  /**
   * Connects the mock payments server; false when it failed, with the error set where the owner
   * pressed: the list's, or the open connector's. Each try clears the last one's error there first,
   * so a retry that works shows none.
   */
  const connect = async (): Promise<boolean> => {
    if (view.kind === 'list') setListError(null);
    else setReviewError(undefined);
    setConnecting(true);
    try {
      await connectApp(calls);
      return true;
    } catch (err) {
      if (!(err instanceof ApiError && err.kind === 'unauthorized')) {
        if (view.kind === 'list') setListError(ownerErrorCopy(err));
        else setReviewError(ownerErrorCopy(err));
      }
      return false;
    } finally {
      setConnecting(false);
    }
  };

  const open = (key: ReviewKey) => {
    setReviewError(undefined);
    setView({ kind: 'review', key });
  };

  const choose = (key: ConnectorKey) => {
    setListError(null);
    open(key);
  };

  const backToList = async () => {
    setView({ kind: 'list' });
    void queryClient.invalidateQueries({ queryKey: toolsKey });
  };

  const turnOn = async (key: ReviewKey, rows: ToolRow[]) => {
    setTurningOn(true);
    setReviewError(undefined);
    try {
      const change = await draftChange(calls, rows);
      // Nothing left to turn on: the list, read again, says so.
      if (change === null) await backToList();
      else setView({ kind: 'confirm', key, ...change });
    } catch (err) {
      if (!(err instanceof ApiError && err.kind === 'unauthorized')) setReviewError(ownerErrorCopy(err));
    } finally {
      setTurningOn(false);
    }
  };

  /** The owner's confirm of the drafted change on show; a redraft replaces it, to confirm again. */
  const confirm = async () => {
    if (view.kind !== 'confirm') return;
    const { key } = view;
    await confirmChange(calls, view, (next) => setView({ kind: 'confirm', key, ...next }));
  };

  return {
    view,
    /** The open connector's definitions exist only once it is connected: `connect` first, then they show. */
    mustConnect: view.kind === 'review' && needsConnect(view.key, tools),
    connecting,
    listError,
    turningOn,
    reviewError,
    choose,
    open,
    connect,
    turnOn,
    confirm,
    cancel: () => setView({ kind: 'list' }),
    backToList,
  };
}
