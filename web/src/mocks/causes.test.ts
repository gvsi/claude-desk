/**
 * The mock's cause for a refused Safety entry, from the same facts the API reads: the decision's
 * deciding policies and its `decide` entry's early `reason` or adapter `check`, exact codes only
 * (the API core's `refusal_cause`).
 */
import { describe, expect, it } from 'vitest';

import type { Attempt } from '../api/views.ts';
import { refusalCause } from './causes.ts';

type Cause = Attempt['cause'];

/** A refused decision's deciding policies, and its `decide` entry's summary. */
function cause(summary: Record<string, unknown>, policies: string[]): Cause {
  return refusalCause({ policy_ids: policies }, { event: { summary } });
}

describe('refusalCause', () => {
  it.each<[Record<string, unknown>, string[], Cause]>([
    // An early refusal's reason comes first.
    [{ reason: 'paused' }, [], 'paused'],
    [{ reason: 'unknown_tool' }, [], 'tool_not_available'],
    [{ reason: 'not_given' }, [], 'tool_not_available'],
    [{ reason: 'invalid_args' }, [], 'incomplete_request'],
    [{ reason: 'no_active_version' }, [], 'no_rules'],
    [{ reason: 'version_unloadable' }, [], 'rules_unchecked'],
    [{ reason: 'version_outdated' }, [], 'rules_unchecked'],
    [{ reason: 'evaluation_error' }, [], 'rules_unchecked'],
    // An adapter's refusal, by its exact check.
    [{ reason: 'adapter_refused', check: 'no_such_slot' }, [], 'no_such_slot'],
    [{ reason: 'adapter_refused', check: 'unknown_item' }, [], 'unknown_item'],
    [{ reason: 'adapter_refused', check: 'over_limit' }, [], 'over_quote_ceiling'],
    [{ reason: 'adapter_refused', check: 'no_such_quote' }, [], 'quote_unpayable'],
    [{ reason: 'adapter_refused', check: 'quote_paid' }, [], 'quote_unpayable'],
    [{ reason: 'adapter_refused', check: 'quote_paying' }, [], 'quote_unpayable'],
    [{ reason: 'adapter_refused', check: 'no_such_charge' }, [], 'no_such_charge'],
    [{ reason: 'adapter_refused', check: 'not_refundable' }, [], 'not_refundable'],
    [{ reason: 'adapter_refused', check: 'no_such_document' }, [], 'no_such_document'],
    [{ reason: 'adapter_refused', check: 'not_verified' }, [], 'not_verified'],
    [{ reason: 'adapter_refused', check: 'no_mandate' }, [], 'agent_limit'],
    [{ reason: 'adapter_refused', check: 'mandate_exhausted' }, [], 'agent_limit'],
    [{ reason: 'adapter_refused', check: 'not_an_agent_with_a_mandate' }, [], 'agent_limit'],
    // Otherwise the deciding policies: an owner's never rule, then the baseline's.
    [{}, ['F.never.card'], 'owner_rule'],
    [{}, ['B.same_copy'], 'other_copy'],
    [{}, ['B.private_data_record_owner'], 'not_verified'],
    [{}, ['B.recipient_owner_or_verified_contact'], 'recipient'],
    [{}, ['B.no_agent_pay_out'], 'agent_pay_out'],
    [{}, ['B.agent_charge_within_mandate'], 'agent_limit'],
    [{}, ['B.money_has_amount'], 'no_amount'],
    // No reason and no deciding policy: no rule covers the tool.
    [{}, [], 'no_rule'],
    // In a fixed precedence, whatever order the policies come in.
    [{}, ['B.money_has_amount', 'B.same_copy', 'F.never.card'], 'owner_rule'],
    [{}, ['B.money_has_amount', 'B.same_copy'], 'other_copy'],
    [{}, ['B.agent_charge_within_mandate', 'B.private_data_record_owner'], 'not_verified'],
    [{ reason: 'paused' }, ['F.never.card'], 'paused'],
    // Anything it can't place has no cause: never a guess.
    [{ reason: 'new_reason' }, ['F.never.card'], null],
    [{ reason: 'Paused' }, [], null],
    [{ reason: 'adapter_refused', check: 'new_check' }, ['F.never.card'], null],
    [{ reason: 'adapter_refused', check: 'no_such_slot extra' }, [], null],
    [{ reason: 'adapter_refused' }, [], null],
    [{}, ['B.new_policy'], null],
    [{}, ['B.auto_money_cap'], null],
    [{}, ['X.F.never.card'], null],
  ])('%o with %o is %s', (summary, policies, expected) => {
    expect(cause(summary, policies)).toBe(expected);
  });

  it('refusal_without_its_entry_has_no_cause', () => {
    expect(refusalCause({ policy_ids: [] }, null)).toBeNull();
  });
});
