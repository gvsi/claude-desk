/** Chen & Co. CPA's own tools, as the kernel lists them for setup and the owner's rules. */
import type { JobProposal, ToolRow } from '../api/views.ts';
import { placeholderHex } from '../ds/fixtures/index.ts';
import { isBusinessDef } from '../owner/connectors/businessWords.ts';
import type { DeskRecord, ToolRecord } from './world.ts';

// Claude-facing, third-person drafts of the kernel's fixed block sentences (adapters/blocks.py),
// and the blocks' capabilities. The owner sees BUSINESS_OWNER_LINES instead.
const BLOCK_SENTENCES = {
  intake: "Saves the person's name, contact details and answers to the business's questions, so the owner can follow up.",
  typed_booking: "Books one open time on the business's calendar for this kind of appointment.",
  purpose_payment: "Creates a secure payment link for this purpose, for the amount the owner set.",
  urgent: "Saves an urgent callback request and alerts the owner right away.",
};

/** Accepted setup proposals; unfinished payment amounts fail definition validation below. */
export function businessToolRows(
  jobs: readonly Pick<JobProposal, 'title' | 'how' | 'config'>[],
  taken: Iterable<string> = [],
): ToolRow[] {
  const names = new Set(taken);
  const rows: ToolRow[] = [];
  for (const job of jobs) {
    const definition = { title: job?.title, description: job?.how, config: job?.config };
    if (!isBusinessDef(definition)) continue;
    const business = structuredClone(definition);
    const block = business.config.block;
    const base = job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40) || 'job';
    let slug = base;
    for (let index = 2; names.has(`desk.${slug}`); index += 1) {
      const suffix = `-${index}`;
      slug = base.slice(0, 40 - suffix.length) + suffix;
    }
    const tool = `desk.${slug}` as const;
    names.add(tool);
    rows.push({
      tool, source: 'business', status: 'needs_review', review_reason: 'new', business,
      effects: [block === 'purpose_payment' ? 'charge' : 'change'], reversible: block !== 'purpose_payment',
      // Mock identity only: use the existing stable browser/Node hash placeholder, not a signature.
      description_confirmed: BLOCK_SENTENCES[block], definition_sha256: placeholderHex(JSON.stringify(business), 32),
      pending_definition_text: null, pending_sha256: null, cards: [],
    });
  }
  return rows;
}

export const chenBusinessTools: readonly ToolRow[] = [
  {
    tool: 'desk.intro-call',
    source: 'business',
    status: 'needs_review',
    effects: ['change'],
    reversible: true,
    description_confirmed: BLOCK_SENTENCES.typed_booking,
    definition_sha256: 'a'.repeat(64),
    pending_definition_text: null,
    pending_sha256: null,
    review_reason: 'new',
    cards: [],
    business: {
      title: 'Book a free intro call',
      description: 'Books a free 20-minute intro call with Linda for a new client.',
      config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 },
    },
  },
  {
    tool: 'desk.new-client-intake',
    source: 'business',
    status: 'enabled',
    effects: ['change', 'private_data'],
    reversible: true,
    description_confirmed: BLOCK_SENTENCES.intake,
    definition_sha256: 'b'.repeat(64),
    pending_definition_text: null,
    pending_sha256: null,
    review_reason: null,
    cards: [],
    business: {
      title: 'New client intake',
      description: 'Asks a new client a few questions before their first call and saves the answers for Linda.',
      config: {
        block: 'intake',
        questions: ['Is this for you or for a business?', 'Which tax years do you need help with?', 'Do you already have a bookkeeper?'],
      },
    },
  },
];

/** Seed through the world's store so setup reads and confirms the same rows at their listed hashes. */
export function seedBusinessTools(desk: DeskRecord, rows: readonly ToolRow[] = chenBusinessTools): void {
  const names = new Set(rows.map((row) => row.tool));
  const seeded: ToolRecord[] = structuredClone([...rows]).map((row) => ({
    ...row,
    adapter: 'business', resource_kind: 'desk', input_schema: {}, review_reason: row.review_reason ?? null,
  }));
  desk.tools = [...desk.tools.filter((row) => !names.has(row.tool)), ...seeded];
}

/** Reconcile accepted jobs as the kernel does, preserving unchanged rows and disabling omissions. */
export function replaceBusinessTools(desk: DeskRecord | undefined, jobs: readonly JobProposal[]): void {
  if (!desk) throw new Error('the setup Desk must exist');
  const remaining = new Map(desk.tools.filter(({ source }) => source === 'business').map((row) => [row.tool, row]));
  const rows = businessToolRows(jobs, desk.tools.filter(({ source }) => source !== 'business').map(({ tool }) => tool));
  const changed: ToolRow[] = [];
  for (const row of rows) {
    const before = remaining.get(row.tool);
    remaining.delete(row.tool);
    if (before && before.status !== 'disabled' && before.definition_sha256 === row.definition_sha256) continue;
    changed.push({ ...row, review_reason: before && before.status !== 'disabled' ? 'changed' : 'new' });
  }
  for (const row of remaining.values()) {
    row.status = 'disabled';
    row.review_reason = null;
  }
  seedBusinessTools(desk, changed);
}
