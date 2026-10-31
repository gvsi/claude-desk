/**
 * Why the kernel refused a request, as a closed code for Safety (`Attempt.cause`): the mock's copy
 * of the API core's `refusal_cause`, read from the same facts. Exact codes only, never the owner's
 * or a visitor's words: the `decide` entry's early `reason` first (an adapter's refusal by its
 * exact `check`), else the decision's deciding policies in a fixed precedence, else, with no policy
 * and no card, no rule covers the tool. A code it can't place has no cause, never a guess.
 */
import type { Decision } from '../api/contracts.ts';
import type { Attempt } from '../api/views.ts';

export type RefusalCause = NonNullable<Attempt['cause']>;

/** An early refusal's reason. `adapter_refused` goes by its check (`CHECKS`). */
const REASONS: Readonly<Record<string, RefusalCause>> = {
  paused: 'paused',
  unknown_tool: 'tool_not_available',
  not_given: 'tool_not_available',
  invalid_args: 'incomplete_request',
  no_active_version: 'no_rules',
  version_unloadable: 'rules_unchecked',
  version_outdated: 'rules_unchecked',
  evaluation_error: 'rules_unchecked',
};

/** An adapter's refusal, by the check that failed. */
const CHECKS: Readonly<Record<string, RefusalCause>> = {
  no_such_slot: 'no_such_slot',
  unknown_item: 'unknown_item',
  over_limit: 'over_quote_ceiling',
  no_such_quote: 'quote_unpayable',
  quote_paid: 'quote_unpayable',
  quote_paying: 'quote_unpayable',
  no_such_charge: 'no_such_charge',
  not_refundable: 'not_refundable',
  no_such_document: 'no_such_document',
  not_verified: 'not_verified',
};

/**
 * The baseline's policies, first match wins, after an owner's never rule. `B.auto_money_cap` isn't
 * here: it decides only automatic approvals, never a refusal. A private record refused to a
 * verified person isn't theirs (`not_their_record`); to anyone else, they aren't verified yet.
 */
const BASELINE: readonly (readonly [string, RefusalCause])[] = [
  ['B.same_copy', 'other_copy'],
  ['B.private_data_record_owner', 'not_verified'],
  ['B.recipient_owner_or_verified_contact', 'recipient'],
  ['B.no_agent_pay_out', 'agent_pay_out'],
  ['B.agent_charge_within_mandate', 'agent_limit'],
  ['B.money_has_amount', 'no_amount'],
];

/** The code at `key` of `table`, or null when the table doesn't name it (or it isn't a string). */
function lookUp(table: Readonly<Record<string, RefusalCause>>, key: unknown): RefusalCause | null {
  return typeof key === 'string' && Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

/**
 * A refused decision's cause, from its deciding policies and cards, its `decide` entry (null when
 * the record doesn't hold it, or holds one that isn't this refusal's, as the API reads none then),
 * and whether its session was verified.
 */
export function refusalCause(
  decision: Pick<Decision, 'decision_id' | 'policy_ids' | 'card_ids'>,
  entry: { event: { kind: string; summary: Record<string, unknown> } } | null,
  { verified }: { verified: boolean },
): RefusalCause | null {
  // Only this refusal's own `decide` entry, with string codes, as the API reads it.
  if (entry === null || entry.event.kind !== 'decide') return null;
  const { summary } = entry.event;
  if (summary.outcome !== 'refuse') return null;
  if (Object.hasOwn(summary, 'decision_id') && summary.decision_id !== decision.decision_id) return null;
  if (['reason', 'check'].some((key) => Object.hasOwn(summary, key) && typeof summary[key] !== 'string')) return null;
  if (Object.hasOwn(summary, 'reason')) {
    return summary.reason === 'adapter_refused' ? lookUp(CHECKS, summary.check) : lookUp(REASONS, summary.reason);
  }
  const policies = decision.policy_ids;
  if (policies.some((policy) => policy.startsWith('F.never.'))) return 'owner_rule';
  for (const [policy, cause] of BASELINE) {
    if (!policies.includes(policy)) continue;
    return policy === 'B.private_data_record_owner' && verified ? 'not_their_record' : cause;
  }
  return policies.length > 0 || decision.card_ids.length > 0 ? null : 'no_rule';
}
