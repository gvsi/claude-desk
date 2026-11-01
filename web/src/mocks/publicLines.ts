/** Setup's public lines, scoped to the mock copy and interview. The real API uses the kernel scan. */
import type { PublicLine, SetupState } from '../api/views.ts';
import type { Failure, Req, Server, ServedRoutes } from './served.ts';
import { SETUP_QUESTIONS, SETUP_ROUTES, setupPublicDesk } from './setup.ts';
import type { MockWorld } from './world.ts';

const LINES = new WeakMap<MockWorld, Map<string, PublicLine[]>>();
const REFUSED = /\$\s*[-+]?(?:\d|\.\d)|\d\s*%|\b\d{1,2}(?:\s*(?:am|pm)\b|:\d{2}\b|\s+to\s+\d{1,2}\b)|\b(?:guarantee|promise|always|never)\b/i;

/** The signed Chen & Co. board's starter lines. */
const CPA_LINES = [
  ['about', 'Chen & Co. CPA is a two-person CPA firm in San Jose. We do tax returns and bookkeeping for individuals and small businesses.'],
  ['pricing', 'The intro consult is free and takes 20 minutes. We price each engagement after it, and new work starts with a retainer.'],
  ['intake', 'Before a consult, the Desk asks whether it’s for you, your business or both, which tax years or months need work, and whether you use bookkeeping software.'],
  ['after_hours', 'Outside business hours, the Desk takes a message and Linda replies the next business day.'],
  ['urgent', 'A notice from the IRS or the state with a deadline this week is urgent: the Desk tells Linda right away.'],
  ['service_area', 'Clients in San Jose and the South Bay, in person or online.'],
  ['how_we_help', 'Book a free intro call: New clients pick a time within your opening hours and book a 20-minute call.\nNew client intake: Before their call, new clients answer three short questions.\nSend a retainer link: Clients you’ve priced get a secure link to pay a retainer before you start.'],
] as const;

function seed(sv: Server, state: SetupState): PublicLine[] {
  const desk = sv.world.desk(state.desk_id);
  const about = desk ? setupPublicDesk(sv.world, desk, 'en')?.charter[0] : undefined;
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
  const values: Record<string, string | undefined> = {
    about: about && 'title' in about ? about.title ?? undefined : undefined,
    intake: answers.get('what_you_do'),
    service_area: answers.get('hours_and_area'),
    pricing: answers.get('quote_limit'),
    after_hours: answers.get('contact_and_after_hours'),
  };
  const cpa = desk?.summary.business_name.includes('Chen & Co.');
  return CPA_LINES.flatMap(([key, fallback]) => {
    const text = values[key] ?? (cpa ? fallback : undefined);
    return text?.trim() ? [{ key: `policy:${key}`, text, source: values[key] === undefined ? 'suggested' as const : 'owner' as const, editable: key !== 'how_we_help' }] : [];
  });
}

function read(sv: Server, req: Req): { lines: PublicLine[] } | Failure {
  const found = SETUP_ROUTES.setup!(sv, req);
  if (found.status !== 200) return found as Failure;
  const state = found.body as SetupState;
  if (state.step !== 'rules' && state.step !== 'situations') return { status: 409, body: { error: 'conflict' } };
  let interviews = LINES.get(sv.world);
  if (!interviews) {
    interviews = new Map();
    LINES.set(sv.world, interviews);
  }
  let lines = interviews.get(state.interview_id);
  if (!lines) {
    lines = seed(sv, state);
    interviews.set(state.interview_id, lines);
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
    if (REFUSED.test(text)) return { status: 422, body: { error: 'line_refused', key: line.key, reason: 'mock_scan' } };
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
    const refused = found.lines.find((line) => line.editable && REFUSED.test(line.text));
    if (refused) return { status: 422, body: { error: 'line_refused', key: refused.key, reason: 'mock_scan' } };
    return { status: 200, body: structuredClone(found) };
  },
} satisfies ServedRoutes;
