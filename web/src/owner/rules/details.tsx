import type { ReactElement, ReactNode } from 'react';

import type { RuleCard } from '../../api/contracts.ts';
import type { PolicyVersionOut, ToolRow } from '../../api/views.ts';
import {
  AdvancedDetails, ConnectorName, effectPhrases, StatusLabel, type ConnectorView, type DetailsCode, type DetailsField,
} from '../../ds/index.ts';
import { BUSINESS_WORDS } from '../connectors/businessWords.ts';
import { capOf } from './drafts.ts';

/** What one Details panel shows (REV-RULES-D, as it ships: no Parameters, no compiled Cedar). */
export interface Details {
  fields: DetailsField[];
  code?: DetailsCode;
}

/** Copies through the browser's clipboard. A refusal rejects, and the block selects its text instead. */
export const copyText = (text: string): Promise<void> => navigator.clipboard.writeText(text);

/** The fields the API sent with a value: one sent empty (null) is left out, as the board lists them. */
function withValues(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== undefined));
}

/** A card's fields in the contract's order, as REV-RULES-D lists them; one this build doesn't know follows. */
const CARD_ORDER = [
  'card_id', 'applies_to', 'mode', 'who', 'person_id', 'agent_key_id',
  'max_amount_cents', 'max_discount_bp', 'hours', 'review', 'is_default', 'reason',
] as const satisfies readonly (keyof RuleCard)[];

/** A card as it is set: its fields with a value, in the contract's order, whatever order they came in. */
function cardAsSet(card: RuleCard): Record<string, unknown> {
  const rank = (key: string) => {
    const at = (CARD_ORDER as readonly string[]).indexOf(key);
    return at < 0 ? CARD_ORDER.length : at;
  };
  const fields = Object.entries(withValues(card));
  return Object.fromEntries(fields.sort(([a], [b]) => rank(a) - rank(b)));
}

/** How a tool's listed definition stands against its pin, read apart from whether the tool is on. */
type PinState = 'matches' | 'changed' | 'delisted' | 'unknown';

/**
 * The pin's state from the row's own pin columns, whatever its status: the kernel records a drift
 * on a disabled tool too (its pending entry), keeping it disabled (`mcp_pins.check_pin`).
 * - `delisted`: its connector no longer lists it, so there is nothing to match;
 * - `changed`: a different definition waits for review (`pending_sha256`), or the kernel says so;
 * - `unknown`: no pin is recorded, so nothing is claimed about it;
 * - `matches`: pinned, with no change waiting. Only this one says "Matches its pin".
 */
function pinState(row: Pick<ToolRow, 'definition_sha256' | 'pending_sha256' | 'review_reason'>): PinState {
  if (row.review_reason === 'delisted') return 'delisted';
  const pending = row.pending_sha256 ?? '';
  if (row.review_reason === 'changed' || (pending !== '' && pending !== row.definition_sha256)) return 'changed';
  if ((row.definition_sha256 ?? '') === '') return 'unknown';
  return 'matches';
}

/** The Pinned row's words and dot for each state; an unknown pin has no row. */
const PIN_WORDS = {
  matches: <StatusLabel tone="handled">Matches its pin</StatusLabel>,
  changed: <StatusLabel tone="held">Needs your review</StatusLabel>,
  // The owner's alert for it says the same: "{tool} is no longer offered. Claude won't use it."
  delisted: <StatusLabel tone="info">No longer offered</StatusLabel>,
} as const satisfies Record<Exclude<PinState, 'unknown'>, ReactNode>;

/**
 * A tool's details: what Claude Desk lists for it, from its `ToolRow`. Its input schema and a changed
 * definition waiting for review (`pending_definition_text`) are never shown: the list names the
 * tool, where it comes from, what Claude reads about it, its effects, whether it's on and how its
 * definition stands against its pin (`pinState`); the block is the row's own fields.
 */
export function toolDetails(row: ToolRow, connector: ConnectorView | null): Details {
  const source = row.source === 'business' ? BUSINESS_WORDS.jobs
    : connector === null || connector.source.kind === 'built_in' ? 'Built in'
      : <ConnectorName connector={connector} size="inline" />;
  const fields: DetailsField[] = [
    { label: 'Name', value: row.tool, mono: true },
    { label: 'Source', value: source },
    // The description the owner confirmed is the tool's own text, never the app's words.
    ...(row.description_confirmed.trim() === '' ? [] : [{ label: 'Claude sees', value: <span data-copy="user">{row.description_confirmed}</span> }]),
    { label: 'Effects', value: effectPhrases(row.effects, row.reversible).join(' · ') },
    { label: 'Status', value: row.status === 'enabled' ? 'Turned on' : 'Turned off' },
  ];
  const pin = pinState(row);
  if (pin !== 'unknown') fields.push({ label: 'Pinned', value: PIN_WORDS[pin] });
  const { tool, source: from, effects, reversible, status, description_confirmed, definition_sha256 } = row;
  return {
    fields,
    code: { label: 'As your Desk lists it', value: withValues({ tool, source: from, effects, reversible, status, description_confirmed, definition_sha256 }) },
  };
}

/** A hash as REV-RULES-D shortens it: "sha256 c41d…09af". */
export function shortHash(hash: string): string {
  return hash.length > 8 ? `sha256 ${hash.slice(0, 4)}…${hash.slice(-4)}` : `sha256 ${hash}`;
}

/** What a rule's details read off: the active version. */
type Version = Pick<PolicyVersionOut, 'version' | 'proof' | 'cedar_sha256' | 'auto_money_cap_cents'>;

/**
 * A rule's details: its cards' IDs, the version it is part of and whether that version was proved,
 * the compiled rules' hash, and the cards as they are set. A row drawn from no card (the always-on
 * rules, or a tool no card covers, which asks by default) shows the version and hash alone; the
 * payment limit's block is the version's limit, its one field. Never the compiled Cedar.
 */
export function ruleDetails(version: Version, cards: readonly RuleCard[], { moneyCap = false }: { moneyCap?: boolean } = {}): Details {
  const fields: DetailsField[] = [
    ...(cards.length === 0 ? [] : [{ label: 'Rule', value: cards.map((card) => card.card_id).join(', '), mono: true }]),
    { label: 'Version', value: version.proof?.ok === true ? `${version.version}, proved against the always-on rules` : String(version.version) },
    ...(version.cedar_sha256 === '' ? [] : [{ label: 'Policy hash', value: shortHash(version.cedar_sha256), mono: true }]),
  ];
  const value = moneyCap ? { auto_money_cap_cents: capOf(version) }
    : cards.length === 1 ? cardAsSet(cards[0]!)
      : cards.length > 1 ? cards.map(cardAsSet) : undefined;
  return value === undefined ? { fields } : { fields, code: { label: 'The rule as you set it', value } };
}

/** What a row passes a Details: the id of its words, and how it draws itself around the button. */
interface DetailsRow {
  /** The id of the words the row is about (a tool's title, a rule's sentence). */
  describedBy?: string;
  /** Draws the row with the Details button where it goes; the panel opens under what it returns. */
  children: (toggle: ReactElement) => ReactNode;
}

/** A tool row's Details (REV-RULES-D), from its `ToolRow` and the connector it's listed under. */
export function ToolDetails({ row, connector, describedBy, children }: DetailsRow & { row: ToolRow; connector: ConnectorView | null }) {
  return <AdvancedDetails {...toolDetails(row, connector)} onCopy={copyText} describedBy={describedBy}>{children}</AdvancedDetails>;
}

/**
 * A rule row's Details, from the active version and the row's cards: none for a sentence drawn from
 * no card, and `moneyCap` for the payment limit's row, whose block is the version's limit.
 */
export function RuleDetails({ version, cards, moneyCap = false, describedBy, children }: DetailsRow & {
  version: Version; cards: readonly RuleCard[]; moneyCap?: boolean;
}) {
  return <AdvancedDetails {...ruleDetails(version, cards, { moneyCap })} onCopy={copyText} describedBy={describedBy}>{children}</AdvancedDetails>;
}
