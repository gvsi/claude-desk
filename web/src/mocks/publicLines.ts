/** Setup's public lines, scoped to the mock copy and interview. The real API uses the kernel scan. */
import type { SetupPublicLine, SetupPublicLines, PublicPriceItem, SetupState } from '../api/views.ts';
import type { Failure, Req, Server, ServedRoutes } from './served.ts';
import { SETUP_QUESTIONS, SETUP_ROUTES, TEST_CLIENT_OFFER, setupAbout } from './setup.ts';
import { heldPublicLineSeed, storedPublicState, storePublicState } from './publicLineStore.ts';
import { publicLineRefused } from './publicLineScan.ts';
import { publicLineLimit } from '../setup/publicLineLimit.ts';
import { SETUP_PUBLIC_LINE_KEYS } from '../api/views.ts';

/** The signed Chen & Co. starter lines, including the approved public-text revisions. */
const CPA_LINES = [
  ['about', 'Chen & Co. CPA is a two-person CPA firm in San Jose. We do tax returns and bookkeeping for individuals and small businesses.'],
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

/** Recompute ASCII-folded title slugs, capped at 40, with unique suffixes. */
function priceItems(items: Pick<PublicPriceItem, 'title' | 'unit_cents'>[]): PublicPriceItem[] {
  const taken = new Set<string>();
  return items.map(({ title, unit_cents }) => {
    const base = title.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'item';
    let item_id = base;
    let count = 1;
    while (taken.has(item_id)) {
      const suffix = `-${++count}`;
      item_id = base.slice(0, 40 - suffix.length).replace(/-+$/g, '') + suffix;
    }
    taken.add(item_id);
    return { item_id, title, unit_cents };
  });
}

function seed(sv: Server, state: SetupState): Omit<SetupPublicLines, 'revision'> {
  const desk = sv.world.desk(state.desk_id);
  if (/^Chen & Co\.?(?: CPA)?$/i.test(desk?.summary.business_name ?? '')) {
    const lines = CPA_LINES.map(([key, text]): SetupPublicLine => ({
      key: `policy:${key}`, text, source: 'owner', editable: key !== 'how_we_help',
    }));
    lines.splice(1, 0, { key: 'contact', text: '(408) 555-0199, linda@chenandco.com', source: 'suggested', editable: true });
    return {
      lines,
      hours: { source: 'suggested', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '18:00:00' }] },
      prices: { source: 'suggested', items: priceItems([
        { title: 'Tax return review', unit_cents: 25000 },
        { title: 'Business tax return', unit_cents: 60000 },
        { title: 'Monthly bookkeeping', unit_cents: 15000 },
      ]) },
    };
  }
  const about = desk ? setupAbout(sv.world, desk) : null;
  const answers = new Map<string, string>();
  let question: string | undefined;
  for (const message of state.messages) {
    if (message.role === 'claude') {
      const asked = SETUP_QUESTIONS.find((q) => message.text.endsWith(q.text));
      if (asked) question = asked.key;
      // The owner's answer to the test-client offer answers no question of the interview.
      else if (message.text === TEST_CLIENT_OFFER) question = undefined;
    } else if (message.role === 'owner' && question !== undefined) {
      answers.set(question, message.text);
    }
  }
  const values: [string, string | null | undefined][] = [
    ['about', about],
    ['after_hours', afterHoursOf(answers.get('contact_and_after_hours'))],
  ];
  return { lines: values.flatMap(([key, text]): SetupPublicLine[] => text?.trim()
    ? [{ key: `policy:${key}`, text, source: 'owner', editable: true }] : []), hours: null, prices: null };
}

function read(sv: Server, req: Req): SetupPublicLines | Failure {
  const found = SETUP_ROUTES.setup!(sv, req);
  if (found.status !== 200) return found as Failure;
  const state = found.body as SetupState;
  if (state.step !== 'rules' && state.step !== 'situations') return { status: 409, body: { error: 'conflict' } };
  let data = storedPublicState(sv.world, state.interview_id);
  if (!data) {
    const initial = seed(sv, state);
    data = storePublicState(sv.world, state.interview_id, {
      ...initial,
      lines: initial.lines.map((line): SetupPublicLine => {
        const text = heldPublicLineSeed(sv.world, state.interview_id, line.key);
        return text === undefined ? { ...line, held: false } : { ...line, text, source: 'owner', held: true };
      }),
    });
  }
  if (data.hours) data.hours.windows = data.hours.windows.map((window) => ({
    ...window,
    start: window.start.replace(/^(\d{2}:\d{2})$/, '$1:00'),
    end: window.end.replace(/^(\d{2}:\d{2})$/, '$1:00'),
  }));
  if (data.prices) data.prices.items = priceItems(data.prices.items);
  return data;
}

export const PUBLIC_LINES_ROUTES = {
  removePublicPrice(sv, req) {
    const title = req.query.get('title');
    const amount = req.query.get('unit_cents');
    if (title === null || !title.trim() || Array.from(title).length > 80
      || amount === null || !amount.trim() || !Number.isSafeInteger(Number(amount)) || Number(amount) < 0 || Number(amount) > 1_000_000) {
      return { status: 422, body: { error: 'invalid' } };
    }
    const found = read(sv, req);
    if ('status' in found) return found;
    const index = found.prices?.items.findIndex((item) => item.item_id === req.params.item_id) ?? -1;
    if (!found.prices || index === -1) return { status: 409, body: { error: 'conflict' } };
    const item = found.prices.items[index]!;
    if (title !== item.title || Number(amount) !== item.unit_cents) {
      return { status: 409, body: { error: 'conflict' } };
    }
    if (found.prices?.source === 'owner') return { status: 422, body: { error: 'not_suggested', key: 'prices' } };
    const items = found.prices.items.filter((_, position) => position !== index);
    found.prices = items.length ? { source: 'suggested', items: priceItems(items) } : null;
    return { status: 200, body: structuredClone(storePublicState(sv.world, req.params.id!, found)) };
  },
  removePublicLine(sv, req) {
    const found = read(sv, req);
    if ('status' in found) return found;
    const key = req.params.key;
    if (key !== 'hours' && key !== 'prices' && !SETUP_PUBLIC_LINE_KEYS.some((known) => known === key)) return { status: 422, body: { error: 'invalid' } };
    if (key === 'policy:how_we_help') return { status: 422, body: { error: 'not_editable', key } };
    const item = key === 'hours' || key === 'prices' ? found[key] : found.lines.find((line) => line.key === key);
    if (!item || item.source !== 'suggested') return { status: 422, body: { error: 'not_suggested', key } };
    if (key === 'hours' || key === 'prices') found[key] = null;
    else found.lines = found.lines.filter((line) => line.key !== key);
    return { status: 200, body: structuredClone(storePublicState(sv.world, req.params.id!, found)) };
  },
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
      (candidate === line || (candidate.source === 'owner' && !candidate.held)) && publicLineRefused(candidate === line ? text.trim() : candidate.text),
    );
    if (refused) return { status: 422, body: { error: 'line_refused', key: refused.key, reason: ['mock_scan'] } };
    line.text = text.trim();
    line.source = 'owner';
    line.held = false;
    return { status: 200, body: structuredClone(storePublicState(sv.world, req.params.id!, found)) };
  },
  setupPublicLinesConfirm(sv, req) {
    const found = read(sv, req);
    if ('status' in found) return found;
    const body = typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {};
    const { keys, revision } = body;
    const listedKeys = new Set([
      ...found.lines.filter((line) => SETUP_PUBLIC_LINE_KEYS.some((known) => known === line.key)).map((line) => line.key),
      ...(found.hours !== null ? ['hours'] : []),
      ...(found.prices !== null ? ['prices'] : []),
    ]);
    if (req.malformed || !Array.isArray(keys) || keys.length === 0 || typeof revision !== 'string' || revision.length === 0
      || keys.some((key) => typeof key !== 'string' || !listedKeys.has(key))) {
      return { status: 422, body: { error: 'invalid' } };
    }
    if (revision !== found.revision) return { status: 409, body: { error: 'conflict' } };
    const held = found.lines.find((line) => line.held && keys.includes(line.key));
    if (held) return { status: 422, body: { error: 'line_refused', key: held.key, reason: ['mock_scan'] } };
    const refused = found.lines.find((line) => ((line.source === 'owner' && !line.held) || keys.includes(line.key)) && publicLineRefused(line.text));
    if (refused) return { status: 422, body: { error: 'line_refused', key: refused.key, reason: ['mock_scan'] } };
    for (const line of found.lines) if (keys.includes(line.key)) line.source = 'owner';
    if (keys.includes('hours') && found.hours) found.hours = { ...found.hours, source: 'owner' };
    if (keys.includes('prices') && found.prices) found.prices = { ...found.prices, source: 'owner' };
    return { status: 200, body: structuredClone(storePublicState(sv.world, req.params.id!, found)) };
  },
} satisfies ServedRoutes;
