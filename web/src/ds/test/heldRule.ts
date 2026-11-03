/**
 * The rule a fixture's held request names on its card, for stories and boards, as Needs you and a
 * conversation name it (`heldRule`): the owner's Ask me first card whose reason is `heldBy`, or past
 * an automatic rule's limit that rule's hold line; none when no rule of the owner's decided it.
 */
import type { Decision, RuleCard } from '../../api/contracts.ts';
import { NO_BUSINESS_TOOLS } from '../../owner/connectors/catalog.ts';
import { heldRule } from '../../owner/rules/requestRule.ts';
import type { ApprovalRule } from '../components/ApprovalCard/ApprovalCard.tsx';
import { rivera } from '../fixtures/index.ts';

export function fixtureHeldRule(decision: Decision, heldBy: string | null = null, cards: readonly RuleCard[] = Object.values(rivera.ruleCards)): ApprovalRule | undefined {
  return heldRule({ decision, held_by: heldBy }, cards, { business: NO_BUSINESS_TOOLS, cards }) ?? undefined;
}
