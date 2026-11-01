/** Setup's public lines, scoped to the mock copy and interview. The real API uses the kernel scan. */
import type { SetupPublicLine, SetupState } from '../api/views.ts';
import type { Failure, Req, Server, ServedRoutes } from './served.ts';
import { SETUP_QUESTIONS, SETUP_ROUTES, setupAbout } from './setup.ts';
import { storedPublicLines, storePublicLines } from './publicLineStore.ts';
import { publicLineRefused } from './publicLineScan.ts';

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

/** Only an explicit after-hours clause is known; contact details and ambiguous answers stay out. */
function afterHoursOf(answer: string | undefined): string | undefined {
  const clauses = answer?.split(/(?<=[.!?])\s+|[;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => /^(?:after[ -]hours|outside business hours)\b/i.test(clause));
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

function read(sv: Server, req: Req): { lines: SetupPublicLine[] } | Failure {
  const found = SETUP_ROUTES.setup!(sv, req);
  if (found.status !== 200) return found as Failure;
  const state = found.body as SetupState;
  if (state.step !== 'rules' && state.step !== 'situations') return { status: 409, body: { error: 'conflict' } };
  let lines = storedPublicLines(sv.world, state.interview_id);
  if (!lines) {
    lines = seed(sv, state);
    storePublicLines(sv.world, state.interview_id, lines);
  }
  return { lines };
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
    if (req.malformed || !line || typeof text !== 'string' || !text.trim() || Array.from(text).length > 500) {
      return { status: 422, body: { error: 'invalid' } };
    }
    if (!line.editable) return { status: 422, body: { error: 'not_editable', key: line.key } };
    if (publicLineRefused(text)) return { status: 422, body: { error: 'line_refused', key: line.key, reason: ['mock_scan'] } };
    line.text = text.trim();
    line.source = 'owner';
    return { status: 200, body: structuredClone(found) };
  },
  setupPublicLinesConfirm(sv, req) {
    const found = read(sv, req);
    if ('status' in found) return found;
    if (req.malformed || typeof req.body !== 'object' || req.body === null || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      return { status: 422, body: { error: 'invalid' } };
    }
    const refused = found.lines.find((line) => publicLineRefused(line.text));
    if (refused) return { status: 422, body: { error: 'line_refused', key: refused.key, reason: ['mock_scan'] } };
    return { status: 200, body: structuredClone(found) };
  },
} satisfies ServedRoutes;
