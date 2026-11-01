/** Setup's public lines, scoped to the mock copy and interview. The real API uses the kernel scan. */
import type { SetupPublicLine, SetupPublicLines, SetupState } from '../api/views.ts';
import type { Failure, Req, Server, ServedRoutes } from './served.ts';
import { SETUP_QUESTIONS, SETUP_ROUTES, setupAbout } from './setup.ts';
import { storedPublicState, storePublicState } from './publicLineStore.ts';
import { publicLineRefused } from './publicLineScan.ts';
import { publicLineLimit } from '../setup/publicLineLimit.ts';
import { SETUP_PUBLIC_LINE_KEYS } from '../api/views.ts';

/** The signed Chen & Co. starter lines, including the approved public-text revisions. */
const CPA_LINES = [
  ['about', 'Chen & Co. CPA is a two-person CPA firm in San Jose. We do tax returns and bookkeeping for individuals and small businesses.'],
  ['pricing', 'We price each engagement after the intro consult, and new work starts with a retainer.'],
  ['intake', 'Before a consult, the Desk asks whether it’s for you, your business or both, which tax years or months need work, and whether you use bookkeeping software.'],
  ['after_hours', 'Outside business hours, the Desk takes a message and Linda replies the next business day.'],
  ['urgent', 'A notice from the IRS or the state with a deadline this week is urgent: the Desk tells Linda right away.'],
  ['service_area', 'Clients in San Jose and the South Bay, in person or online.'],
  ['how_we_help', 'New clients book a short introductory call.\nBefore their call, new clients answer three short questions.\nClients get a secure link to pay a retainer before work starts.'],
] as const;

/** Only customer-facing after-hours statements are known; private instructions stay out. */
function afterHoursOf(answer: string | undefined): string | undefined {
  const clauses = answer?.split(/(?<=[.!?])\s+|[;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => /^(?:after[ -]hours|outside business hours)[,:]?\s+(?:you (?:can|may) (?:leave (?:a|us a) message|(?:contact|email|call|reach) us)\b|we (?:(?:always|never)\s+)?(?:reply|respond|take|are|charge|help|accept)\b|the (?:desk|office|team) (?:takes|replies|responds|is)\b)/i.test(clause))
    .filter((clause) => !/\b(?:for me|on my behalf)\b/i.test(clause));
  return clauses?.length ? clauses.join(' ') : undefined;
}

function seed(sv: Server, state: SetupState): SetupPublicLine[] {
  const desk = sv.world.desk(state.desk_id);
  if (/^Chen & Co\.?(?: CPA)?$/i.test(desk?.summary.business_name ?? '')) {
    return CPA_LINES.map(([key, text]): SetupPublicLine => ({
      key: `policy:${key}`, text, source: 'suggested', editable: key !== 'how_we_help',
    }));
  }
  const about = desk ? setupAbout(sv.world, desk) : null;
  const answers = new Map<string, string>();
  let question: string | undefined;
  for (const message of state.messages) {
    if (message.role === 'claude') {
      const asked = SETUP_QUESTIONS.find((q) => message.text.endsWith(q.text));
      if (asked) question = asked.key;
    } else if (message.role === 'owner' && question !== undefined) {
      answers.set(question, message.text);
    }
  }
  const values: [string, string | null | undefined][] = [
    ['about', about],
    ['after_hours', afterHoursOf(answers.get('contact_and_after_hours'))],
  ];
  return values.flatMap(([key, text]): SetupPublicLine[] => text?.trim()
    ? [{ key: `policy:${key}`, text, source: 'owner', editable: true }] : []);
}

function read(sv: Server, req: Req): SetupPublicLines | Failure {
  const found = SETUP_ROUTES.setup!(sv, req);
  if (found.status !== 200) return found as Failure;
  const state = found.body as SetupState;
  if (state.step !== 'rules' && state.step !== 'situations') return { status: 409, body: { error: 'conflict' } };
  let saved = storedPublicState(sv.world, state.interview_id);
  if (!saved) {
    const cpa = /^Chen & Co\.?(?: CPA)?$/i.test(sv.world.desk(state.desk_id)?.summary.business_name ?? '');
    saved = storePublicState(sv.world, state.interview_id, {
      lines: seed(sv, state),
      hours: cpa ? { source: 'suggested', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' }] } : null,
      prices: cpa ? { source: 'suggested', items: [
        { title: 'Tax return review', unit_cents: 25000 },
        { title: 'Business tax return', unit_cents: 60000 },
        { title: 'Monthly bookkeeping', unit_cents: 15000 },
      ] } : null,
    });
  }
  return saved;
}

export const PUBLIC_LINES_ROUTES = {
  setupPublicLines(sv, req) {
    const found = read(sv, req);
    return 'status' in found ? found : { status: 200, body: structuredClone(found) };
  },
  setupPublicLine(sv, req) {
    const found = read(sv, req);
    if ('status' in found) return found;
    const body = typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {};
    const { key, text } = body;
    const line = found.lines.find((line) => line.key === key);
    if (req.malformed || !line || typeof text !== 'string' || !text.trim() || Array.from(text).length > publicLineLimit(line.key)) {
      return { status: 422, body: { error: 'invalid' } };
    }
    if (!line.editable) return { status: 422, body: { error: 'not_editable', key: line.key } };
    const refused = found.lines.find((candidate) =>
      (candidate === line || candidate.source === 'owner') && publicLineRefused(candidate === line ? text.trim() : candidate.text),
    );
    if (refused) return { status: 422, body: { error: 'line_refused', key: refused.key, reason: ['mock_scan'] } };
    line.text = text.trim();
    line.source = 'owner';
    return { status: 200, body: structuredClone(storePublicState(sv.world, req.params.id!, found)) };
  },
  setupPublicLinesConfirm(sv, req) {
    const found = read(sv, req);
    if ('status' in found) return found;
    const body = typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {};
    const { keys, revision } = body;
    if (req.malformed || !Array.isArray(keys) || keys.length === 0 || typeof revision !== 'string' || revision.length === 0
      || keys.some((key) => typeof key !== 'string' || !SETUP_PUBLIC_LINE_KEYS.some((known) => known === key) || !found.lines.some((line) => line.key === key))) {
      return { status: 422, body: { error: 'invalid' } };
    }
    if (revision !== found.revision) return { status: 409, body: { error: 'conflict' } };
    const refused = found.lines.find((line) => (line.source === 'owner' || keys.includes(line.key)) && publicLineRefused(line.text));
    if (refused) return { status: 422, body: { error: 'line_refused', key: refused.key, reason: ['mock_scan'] } };
    for (const line of found.lines) if (keys.includes(line.key)) line.source = 'owner';
    return { status: 200, body: structuredClone(storePublicState(sv.world, req.params.id!, found)) };
  },
} satisfies ServedRoutes;
