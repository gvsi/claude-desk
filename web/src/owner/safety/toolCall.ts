/** Names an execution only from its decision in the loaded record, never by fetching another page. */
import type { LedgerEntry } from '../../api/contracts.ts';
import { connectorOf, isCatalogTool, NO_BUSINESS_TOOLS, toolDisplayName } from '../connectors/catalog.ts';
import type { RequestRules } from '../rules/useRequestRules.ts';

export interface ToolCall {
  tool: string;
  name: string;
  mono: boolean;
  source: string;
  decision: LedgerEntry;
  /** The owner approved this decision: an `approval` entry for it in the loaded page reads `approved`. */
  approved: boolean;
  /** The rules version the decision ran under, from its own summary or else the execution's; null when neither says. */
  policyVersion: number | null;
}

/** Both summaries carry the decision ID; older entries name it only in their reference. */
function decisionId(entry: LedgerEntry): string | null {
  const id = entry.event.summary.decision_id;
  return typeof id === 'string' && id !== '' ? id : entry.event.ref_id ?? null;
}

export function toolCallFor(entry: LedgerEntry, entries: readonly LedgerEntry[], rules: RequestRules | null): ToolCall | null {
  if (entry.event.kind !== 'execute') return null;
  const id = decisionId(entry);
  if (id === null) return null;
  const decision = entries.find((candidate) => candidate.event.kind === 'decide' && decisionId(candidate) === id && typeof candidate.event.summary.tool === 'string');
  const tool = decision?.event.summary.tool;
  if (decision === undefined || typeof tool !== 'string' || tool.trim() === '') return null;
  const name = toolDisplayName(tool, rules?.words.business ?? NO_BUSINESS_TOOLS);
  const connector = isCatalogTool(tool) ? connectorOf(tool) : null;
  const source = tool.startsWith('desk.') ? "Your Desk's jobs"
    : connector !== null ? `${connector.view.name}${connector.view.source.kind === 'built_in' ? ' · Built in' : ''}`
      : isCatalogTool(tool) && tool.startsWith('native.') ? 'Built in' : 'Connected tool';
  // An owner's approval is its own ledger entry, joined by the same decision (the decide entry stays `hold`).
  const approved = entries.some((candidate) => candidate.event.kind === 'approval' && decisionId(candidate) === id
    && candidate.event.summary.state === 'approved');
  const version = [decision.event.summary.policy_version, entry.event.summary.policy_version]
    .find((value): value is number => typeof value === 'number');
  return { tool, name: name ?? tool, mono: name === null, source, decision, approved, policyVersion: version ?? null };
}
