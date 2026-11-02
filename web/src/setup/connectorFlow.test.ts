/**
 * The owner-API calls behind each press that turns a connector on in setup, in their order. Today's
 * screens and the one screen that will merge them run these same calls (`connectorFlow.ts`).
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/http.ts';
import type { ConfirmToolBody, PolicyVersionOut, RulesView, SetupTools, ToolConfirmedOut, ToolRow } from '../api/views.ts';
import { confirmChange, connectApp, draftChange, needsConnect, type ConnectorCalls, type DraftedChange } from './connectorFlow.ts';

const version = (n: number) => ({ version: n, cards: [], proof: null }) as unknown as PolicyVersionOut;
const row = (tool: string, hash: string) => ({ tool, definition_sha256: hash, effects: ['read'], reversible: true }) as unknown as ToolRow;

/** Calls that record their names and bodies in order, and answer as `answers` says. */
function recording(answers: { draft?: PolicyVersionOut | null; confirmRules?: (version: number) => Promise<unknown> } = {}) {
  const log: (string | [string, unknown])[] = [];
  let drafted = 10;
  const calls: ConnectorCalls = {
    connect: async () => { log.push('setupConnect'); },
    readTools: async () => { log.push('setupTools'); return { tools: [], connectable: [] } as SetupTools; },
    confirmTools: async (batch: ConfirmToolBody) => {
      log.push(['confirmTool', batch]);
      drafted += 1;
      return { draft: answers.draft === undefined ? version(drafted) : answers.draft } as ToolConfirmedOut;
    },
    readRules: async () => { log.push('rules'); return { active: version(1) } as RulesView; },
    confirmRules: async (n: number) => {
      log.push(['confirmRules', n]);
      return answers.confirmRules?.(n);
    },
  };
  return { calls, log };
}

const STRIPE = [row('payments.list_charges', 'a'.repeat(64)), row('payments.create_refund', 'b'.repeat(64))];
const BATCH: ConfirmToolBody = {
  tools: [{ tool: 'payments.list_charges', definition_sha256: 'a'.repeat(64) }, { tool: 'payments.create_refund', definition_sha256: 'b'.repeat(64) }],
  enable: true,
} as ConfirmToolBody;

describe('connectorFlow', () => {
  it('connects first only an app whose definitions exist once it is connected', () => {
    const open = { tools: [], connectable: ['mock_payments'] } as SetupTools;
    const connected = { tools: [], connectable: [] } as SetupTools;
    expect(needsConnect('stripe', open)).toBe(true);
    expect(needsConnect('stripe', connected)).toBe(false);
    expect(needsConnect('stripe', undefined)).toBe(false);
    expect(needsConnect('payments', open)).toBe(false);
    expect(needsConnect('desk.intake', open)).toBe(false);
  });

  it('an app setup can connect: connect, read its tools, draft at their pinned hashes, read the rules, then the owner confirms', async () => {
    const { calls, log } = recording();
    await connectApp(calls);
    const change = await draftChange(calls, STRIPE);
    if (change === null) throw new Error('a draft');
    expect(change.draft.version).toBe(11);
    expect(change.draft.turnedOn).toEqual(STRIPE);
    await confirmChange(calls, change, () => { throw new Error('not redrafted'); });
    expect(log).toEqual(['setupConnect', 'setupTools', ['confirmTool', BATCH], 'rules', ['confirmRules', 11]]);
  });

  it('a built-in connector connects nothing: draft at the listed hashes, read the rules, then the owner confirms', async () => {
    const { calls, log } = recording();
    const change = await draftChange(calls, STRIPE);
    if (change === null) throw new Error('a draft');
    await confirmChange(calls, change, () => { throw new Error('not redrafted'); });
    expect(log).toEqual([['confirmTool', BATCH], 'rules', ['confirmRules', 11]]);
  });

  it('nothing left to turn on drafts nothing, and reads no rules', async () => {
    const { calls, log } = recording({ draft: null });
    expect(await draftChange(calls, STRIPE)).toBeNull();
    expect(log).toEqual([['confirmTool', BATCH]]);
  });

  it('a draft the rules overtook is asked for once more with the same batch, and the confirm still fails', async () => {
    const overtaken = new ApiError('conflict', { route: 'confirmRules', method: 'POST', status: 409, code: 'rules_changed_since_draft' });
    const { calls, log } = recording({ confirmRules: async () => { throw overtaken; } });
    const change = await draftChange(calls, STRIPE);
    if (change === null) throw new Error('a draft');
    const redrafted: DraftedChange[] = [];
    await expect(confirmChange(calls, change, (next) => redrafted.push(next))).rejects.toBe(overtaken);
    expect(redrafted.map((next) => [next.draft.version, next.changed])).toEqual([[12, true]]);
    expect(log).toEqual([['confirmTool', BATCH], 'rules', ['confirmRules', 11], ['confirmTool', BATCH], 'rules']);

    // Asked for once: the redrafted change's own conflict asks for nothing more.
    log.length = 0;
    await expect(confirmChange(calls, redrafted[0]!, (next) => redrafted.push(next))).rejects.toBe(overtaken);
    expect(log).toEqual([['confirmRules', 12]]);
    expect(redrafted).toHaveLength(1);
  });
});
