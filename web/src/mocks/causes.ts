/**
 * Why the kernel refused a request, as a closed code for Safety (`Attempt.cause`): the mock's copy
 * of the API core's `refusal_cause`, read from the same facts. Exact codes only, never the owner's
 * or a visitor's words: the `decide` entry's early `reason` first (an adapter's refusal by its
 * exact `check`), else the decision's deciding policies in a fixed precedence, else no rule covers
 * the tool. A code it can't place has no cause, never a guess.
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
  no_mandate: 'agent_limit',
  mandate_exhausted: 'agent_limit',
  not_an_agent_with_a_mandate: 'agent_limit',
};

/**
 * The baseline's policies, first match wins, after an owner's never rule. `B.auto_money_cap` isn't
 * here: it decides only automatic approvals, never a refusal.
 */
const BASELINE: readonly (readonly [string, RefusalCause])[] = [
  ['B.same_copy', 'other_copy'],
  // not_their_record once the API has it, for a verified person asking for someone else's record.
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
 * A refused decision's cause, from its deciding policies and its `decide` entry (null when the
 * record doesn't hold the entry, as with no entry the API has nothing to read).
 */
export function refusalCause(
  decision: Pick<Decision, 'policy_ids'>,
  entry: { event: { summary: Record<string, unknown> } } | null,
): RefusalCause | null {
  if (entry === null) return null;
  const { summary } = entry.event;
  if (Object.hasOwn(summary, 'reason')) {
    return summary.reason === 'adapter_refused' ? lookUp(CHECKS, summary.check) : lookUp(REASONS, summary.reason);
  }
  const policies = decision.policy_ids;
  if (policies.some((policy) => policy.startsWith('F.never.'))) return 'owner_rule';
  for (const [policy, cause] of BASELINE) if (policies.includes(policy)) return cause;
  return policies.length > 0 ? null : 'no_rule';
}
