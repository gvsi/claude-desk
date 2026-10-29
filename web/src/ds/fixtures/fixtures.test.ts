import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { CLAUSE_TEMPLATES, DECISION_STATES, EV_ERROR_CODES } from '../../api/contracts';
import type { CardOption, ClauseTemplate, Decision, DecisionState, EvMessage, RenderedBlock, SessionState, SseEvent } from '../../api/contracts';
import { chen, rivera } from './index';
import type { TranscriptTurn } from './index';

const FIXTURES = { rivera, chen };

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'backend', 'desk');
const CONTRACTS_PY = path.join(BACKEND, 'contracts.py');
const SCHEMA = JSON.parse(readFileSync(path.join(BACKEND, 'contracts.schema.json'), 'utf8')) as {
  $defs: { SseEvent: { discriminator: { mapping: Record<string, string> } } };
};

/** MONEY_TOOLS and AUTO_MONEY_HARD_CAP_CENTS as backend/desk/contracts.py defines them. */
function backendMoneyRules(): { moneyTools: string[]; hardCapCents: number } {
  const source = readFileSync(CONTRACTS_PY, 'utf8');
  const tools = /^MONEY_TOOLS: frozenset\[str\] = frozenset\(\{([^}]*)\}\)/m.exec(source)?.[1];
  const cap = /^AUTO_MONEY_HARD_CAP_CENTS = ([0-9_]+)/m.exec(source)?.[1];
  if (!tools || !cap) throw new Error('backend/desk/contracts.py no longer defines the money rules this test reads');
  return {
    moneyTools: tools.split(',').map((tool) => JSON.parse(tool.trim()) as string),
    hardCapCents: Number(cap.replaceAll('_', '')),
  };
}

/** Every object in the fixture trees that `match` accepts, each once. */
function collect<T>(match: (node: Record<string, unknown>) => boolean): T[] {
  const found: T[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (match(record)) found.push(record as T);
    Object.values(record).forEach(visit);
  };
  visit(FIXTURES);
  return found;
}

/** A rendered block, cards and prose alike, whether or not its optional fields are written out. */
function isRenderedBlock(node: Record<string, unknown>): boolean {
  return (node.kind === 'card' || node.kind === 'prose') && typeof node.text === 'string';
}

const allBlocks = collect<RenderedBlock>(isRenderedBlock);
const cardBlocks = allBlocks.filter((block) => block.kind === 'card');

type CardField = 'title' | 'lines' | 'options' | 'href';

// The master plan's "Clauses" row: quote and charges fill title and lines, booking_options its
// options, payment_link and document_link title and href, the rest title.
const CLAUSE_FIELDS = {
  quote: ['title', 'lines'],
  booking_options: ['options'],
  booking_confirmed: ['title'],
  payment_link: ['title', 'href'],
  document_link: ['title', 'href'],
  hours: ['title'],
  policy: ['title'],
  contact: ['title'],
  handoff: ['title'],
  verify_prompt: ['title'],
  owner_said: ['title'],
  charges: ['title', 'lines'],
  refund_issued: ['title'],
  charge_confirmed: ['title'],
  callback_confirmed: ['title'],
  payment_confirmed: ['title'],
} satisfies Record<ClauseTemplate, readonly CardField[]>;

// The proxied paths that are the only place a link token reaches a visitor.
const LINK_PATHS: Partial<Record<ClauseTemplate, RegExp>> = {
  payment_link: /^\/pay\/[A-Za-z0-9_-]+$/,
  document_link: /^\/api\/d\/[A-Za-z0-9_-]+$/,
};

const SLOT_ID = /^S-[0-9]{8}-[0-9]{4}$/;

// What a reply check would block in prose, stricter than the kernel's lexicons: both languages
// always, every Unicode digit, money and percent signs, weekday and month names, spelled-out
// numbers, relative days and times, and promise words with their endings.
const WORDS = {
  weekday: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'],
  month: ['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
    'november', 'december', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'],
  number: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
    'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
    'hundred', 'thousand', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
    'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho',
    'diecinueve', 'veinte', 'cien', 'ciento', 'mil'],
  percent: ['percent', 'per cent', 'por ciento'],
  relative: ['today', 'tomorrow', 'tonight', 'yesterday', 'noon', 'midnight', 'weekend', 'hoy', 'mañana',
    'ayer', 'mediodía', 'medianoche'],
} as const;
const PROMISE_STEMS = ['free', 'guarantee', 'promise', 'discount', 'gratis', 'garantizo', 'prometo', 'descuento'];

const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{N}])';
const PROSE_RULES: [string, RegExp][] = [
  ['digit', /\p{Nd}/u],
  ['money or percent sign', /[$€£¥¢%]/u],
  // "May" is a month only capitalized; lower case it's the modal verb.
  ['month', new RegExp(`${NOT_LETTER_BEFORE}May${NOT_LETTER_AFTER}`, 'u')],
  ...Object.entries(WORDS).map(([category, words]): [string, RegExp] => [
    category,
    new RegExp(`${NOT_LETTER_BEFORE}(?:${words.join('|')})s?${NOT_LETTER_AFTER}`, 'iu'),
  ]),
  ['promise word', new RegExp(`${NOT_LETTER_BEFORE}(?:${PROMISE_STEMS.join('|')})\\p{L}*`, 'iu')],
];

/** The rules `text` breaks, after NFKC with zero-width characters and soft hyphens removed. */
function proseProblems(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
  return PROSE_RULES.filter(([, rule]) => rule.test(normalized)).map(([name]) => name);
}

const proseBlocks = allBlocks.filter((block) => block.kind === 'prose');

/** One alternation of words, each standing alone (not inside a longer word), case-insensitive. */
function wordsRule(words: readonly string[]): RegExp {
  return new RegExp(`${NOT_LETTER_BEFORE}(?:${words.join('|')})${NOT_LETTER_AFTER}`, 'iu');
}

// Claims only a card may make, even without a number: that something is booked, paid, charged or
// refunded, what it costs, or that a price is lowered. Past forms and participles in both
// languages; infinitives and nouns ("to book", "reservar", "a test payment", "un pago") stay
// allowed, so Claude can still say what a card will do.
const CLAIM_RULES: [string, RegExp][] = [
  ['booking claim', wordsRule([
    'booked', 'rebooked', 'reserved', 'scheduled', 'confirmed', 'all set',
    'reservad[oa]s?', 'reservé', 'reservamos', 'agendad[oa]s?', 'agendé', 'confirmad[oa]s?', 'confirmé',
    'programad[oa]s?', 'apartad[oa]s?',
  ])],
  ['payment claim', wordsRule([
    'paid', 'charged', 'refunded', 'billed', 'invoiced', 'payment (?:went through|is complete|received)',
    'pagad[oa]s?', 'pagué', 'pagaste', 'pagó', 'cobrad[oa]s?', 'cobré', 'cobramos', 'reembolsad[oa]s?', 'reembolsé',
    'facturad[oa]s?', 'pago (?:recibido|completado|confirmado)',
  ])],
  ['price claim', wordsRule([
    'costs?', 'costing', 'priced', 'cheap(?:er|est)?', 'affordable', 'inexpensive',
    'cuesta', 'cuestan', 'costar[áa]n?', 'costó', 'costo', 'barat[oa]s?', 'económic[oa]s?',
  ])],
  ['discount claim', wordsRule([
    'markdown', 'marked down', 'price cut', 'special price', 'waived?', 'knock(?:ed)? off', 'half off',
    'rebaj\\p{L}*', 'precio especial', 'sin cargo', 'sin costo', 'mitad de precio',
  ])],
];

/** The claims `text` makes that only a card may make, after the same normalization as `proseProblems`. */
function claimProblems(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '');
  return CLAIM_RULES.filter(([, rule]) => rule.test(normalized)).map(([name]) => name);
}

// Cards whose text is a statement only the card may make: the charter's hours, contact and
// policies, the kernel's handoff, verification and callback commitments, and the owner's own
// words. Prose that restates one carries a policy or a promise outside its card, which invariant 2
// and the soft-promise check block even when the words hold no number.
const STATEMENT_TEMPLATES: readonly ClauseTemplate[] = [
  'hours', 'contact', 'policy', 'handoff', 'verify_prompt', 'callback_confirmed', 'owner_said',
];

/** `text` as lower-case words joined by single spaces, so punctuation and case don't matter. */
function wordsOf(text: string): string {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []).join(' ');
}

const statementSentences = [
  ...new Set(
    cardBlocks
      .filter((block) => STATEMENT_TEMPLATES.includes(block.template as ClauseTemplate))
      .flatMap((block) => block.text.split(/(?<=[.!?])\s+|\n/u))
      .map(wordsOf)
      .filter((sentence) => sentence !== ''),
  ),
];

/** The statement-card sentences that `text` repeats word for word. */
function restatedStatements(text: string): string[] {
  const prose = ` ${wordsOf(text)} `;
  return statementSentences.filter((sentence) => prose.includes(` ${sentence} `));
}

// What people wrote: visitors, visiting agents, owner whispers and what the owner said.
const userTexts = [
  ...collect<TranscriptTurn & { text: string }>(
    (node) => (node.kind === 'visitor' || node.kind === 'agent' || node.kind === 'whisper') && typeof node.text === 'string',
  ).map((turn) => turn.text),
  ...cardBlocks.filter((block) => block.template === 'owner_said').map((block) => block.text),
];

function isFilled(block: RenderedBlock, field: CardField): boolean {
  const value = block[field];
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim() !== '';
}

describe('fixtures', () => {
  test('every_template_has_en_and_es_fixtures', () => {
    for (const template of CLAUSE_TEMPLATES) {
      const pair = rivera.blocks[template];
      expect(pair, template).toBeDefined();
      expect(pair.en.template, `${template} en`).toBe(template);
      expect(pair.es.template, `${template} es`).toBe(template);
    }
  });

  test('card_fixtures_are_cards', () => {
    // A block literal that leaves out its optional fields is still checked here and by the prose tests.
    expect(isRenderedBlock({ kind: 'card', template: 'policy', text: 'Cash only.', title: 'Cash only.' })).toBe(true);
    expect(isRenderedBlock({ kind: 'prose', text: 'Cash only.' })).toBe(true);

    for (const template of CLAUSE_TEMPLATES) {
      for (const language of ['en', 'es'] as const) {
        expect(rivera.blocks[template][language].kind, `${template} ${language}`).toBe('card');
      }
    }
    expect(cardBlocks.length).toBeGreaterThan(40);
    for (const block of cardBlocks) {
      const where = `${block.template} card "${block.text.slice(0, 40)}"`;
      expect(CLAUSE_TEMPLATES, where).toContain(block.template);
      const template = block.template as ClauseTemplate;
      for (const field of CLAUSE_FIELDS[template]) {
        expect(isFilled(block, field), `${where} fills ${field}`).toBe(true);
      }
      const linkPath = LINK_PATHS[template];
      if (linkPath) expect(block.href, `${where} links to its proxied path`).toMatch(linkPath);
      else expect(block.href ?? null, `${where} has no link`).toBeNull();
      // The kernel's rendering: `text` is the title, then each line.
      expect(block.text, `${where} text`).toBe([block.title, ...(block.lines ?? [])].join('\n'));
      for (const option of block.options ?? ([] as CardOption[])) {
        expect(option.option_id, `${where} option`).toMatch(SLOT_ID);
        expect(option.label.trim(), `${where} option label`).not.toBe('');
      }
    }
  });

  test('fixture_prose_is_clean', () => {
    // The lexicon catches what it should, so a clean result means something.
    expect(proseProblems('See you Tuesday at noon')).toEqual(['weekday', 'relative']);
    expect(proseProblems('Nos vemos el martes, con un descuento del quince por ciento')).toEqual(
      expect.arrayContaining(['weekday', 'number', 'percent', 'promise word']),
    );
    expect(proseProblems('It\'s $180, or １８０')).toEqual(['digit', 'money or percent sign']);
    expect(proseProblems('Someone will be done in May')).toEqual(['month']);
    expect(proseProblems('You may want to turn off the water, and feel at home.')).toEqual([]);

    expect(proseBlocks.length).toBeGreaterThan(15);
    for (const block of proseBlocks) {
      expect(proseProblems(block.text), block.text).toEqual([]);
    }
  });

  test('fixture_prose_claims_no_booking_payment_price_or_discount', () => {
    // The claims lexicon catches each kind in both languages, so a clean result means something.
    expect(claimProblems("You're booked.")).toEqual(['booking claim']);
    expect(claimProblems('Listo, quedó reservado.')).toEqual(['booking claim']);
    expect(claimProblems('The deposit is paid within your signed limit.')).toEqual(['payment claim']);
    expect(claimProblems('Ya te cobré la visita y te reembolsé el resto.')).toEqual(['payment claim']);
    expect(claimProblems("It's cheaper than a new tap.")).toEqual(['price claim']);
    expect(claimProblems('Cuesta menos que una llave nueva.')).toEqual(['price claim']);
    expect(claimProblems('Maria waived the call-out fee.')).toEqual(['discount claim']);
    expect(claimProblems('Te hago una rebaja si pagas hoy.')).toEqual(['discount claim']);
    // What a card will do is not a claim that it was done.
    expect(claimProblems("To hold the visit, here's a link. It's a test payment, so no money moves.")).toEqual([]);
    expect(claimProblems('Para reservar la visita, aquí tienes un enlace. Es un pago de prueba.')).toEqual([]);
    expect(claimProblems("I can help with that after you confirm it's you.")).toEqual([]);

    for (const block of proseBlocks) {
      expect(claimProblems(block.text), block.text).toEqual([]);
    }
  });

  test('fixture_prose_restates_no_card_statement', () => {
    // The oracle catches a charter policy repeated in prose, so a clean result means something.
    expect(restatedStatements('Thanks. Maria texts before she arrives.')).toEqual(['maria texts before she arrives']);
    expect(statementSentences.length).toBeGreaterThan(10);

    for (const block of proseBlocks) {
      expect(restatedStatements(block.text), block.text).toEqual([]);
    }
  });

  test('fixture_user_text_has_no_exclamation', () => {
    expect(userTexts.length).toBeGreaterThan(10);
    for (const text of userTexts) {
      expect(text, 'user text has no exclamation mark').not.toMatch(/[!¡]/u);
    }
  });

  test('fixture_status_lines_are_clean', () => {
    // Visitor status lines and notices, as tier 1 scans visitor SSE; masked `to` contacts are skipped.
    const visitorPlain = collect<{ visitor_plain: string }>((node) => typeof node.visitor_plain === 'string');
    const previews = collect<{ preview: string }>(
      (node) => typeof node.entry_id === 'string' && typeof node.to === 'string' && typeof node.preview === 'string',
    );
    const verifyMessages = [rivera.verifyStarted, chen.verifyStarted].flatMap((pair) => [pair.en.message, pair.es.message]);
    const lines = [
      ...visitorPlain.map((node) => node.visitor_plain),
      ...previews.map((node) => node.preview),
      ...verifyMessages,
    ];
    expect(visitorPlain.length).toBeGreaterThan(20);
    expect(previews.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line.trim(), 'a status line is never empty').not.toBe('');
      expect(proseProblems(line), line).toEqual([]);
    }
  });

  test('decision_fixtures_cover_every_state', () => {
    const { moneyTools, hardCapCents } = backendMoneyRules();
    expect(moneyTools).toContain('payments.create_refund');

    expect(Object.keys(rivera.decisions).sort()).toEqual([...DECISION_STATES].sort());
    for (const state of DECISION_STATES) {
      expect(rivera.decisions[state].state, state).toBe(state);
    }

    // The seeded hold (unverified) offers three answers; verified Dana's offers all four.
    const held = rivera.decisions.held;
    expect(held.answers).toEqual(['allow_once', 'deny_once', 'deny_always']);
    expect(rivera.heldVerified.state).toBe('held');
    expect(rivera.heldVerified.answers).toEqual(['allow_once', 'deny_once', 'allow_person', 'deny_always']);

    // Every state the hold can move to keeps its answers, so only `state` can hide the buttons.
    const afterHold: DecisionState[] = ['approved', 'denied', 'expired', 'cancelled', 'executed', 'failed', 'unknown', 'refused_at_execution'];
    for (const state of afterHold) {
      expect(rivera.decisions[state].decision_id, state).toBe(held.decision_id);
      expect(rivera.decisions[state].answers, state).toEqual(held.answers);
    }

    // allow_person only for a verified person or an agent, and never on money above the hard cap.
    const sessions = new Map(
      collect<SessionState>((node) => typeof node.session_id === 'string' && typeof node.verified === 'boolean' && 'assurance' in node).map(
        (session) => [session.session_id, session],
      ),
    );
    const decisions: Decision[] = [...Object.values(rivera.decisions), rivera.heldVerified];
    for (const decision of decisions) {
      const session = sessions.get(decision.session_id);
      expect(session, `${decision.decision_id} has a session fixture`).toBeDefined();
      // The kernel can't know who an unverified visitor is: a reason names a person on record only
      // when the session is verified or that person owns the record asked for.
      for (const person of Object.values(rivera.people)) {
        const firstName = person.name.split(' ')[0];
        if (!new RegExp(`${NOT_LETTER_BEFORE}${firstName}${NOT_LETTER_AFTER}`, 'u').test(decision.reason_plain)) continue;
        expect(
          session?.verified === true || decision.action?.resource.owner_person_id === person.personId,
          `${decision.decision_id} names ${person.name}`,
        ).toBe(true);
      }
      if (!decision.answers?.includes('allow_person')) continue;
      expect(session?.verified === true || session?.kind === 'agent', `${decision.decision_id} allow_person`).toBe(true);
      const action = decision.action;
      if (action && moneyTools.includes(action.tool)) {
        expect(action.amount_cents ?? Number.POSITIVE_INFINITY, `${decision.decision_id} amount`).toBeLessThanOrEqual(hardCapCents);
      }
    }
  });

  test('event_fixtures_cover_every_type', () => {
    const events: SseEvent[] = Object.values(rivera.events).flat();
    const types = new Set(events.map((event) => event.type));
    expect([...types].sort()).toEqual(Object.keys(SCHEMA.$defs.SseEvent.discriminator.mapping).sort());

    // One error event per code a visitor turn can end with.
    const codes = events.flatMap((event) => (event.type === 'error' ? [event.code] : []));
    expect([...codes].sort()).toEqual([...EV_ERROR_CODES].sort());

    // Messages carry their generation, and at least one is a handoff.
    const messages = collect<EvMessage>((node) => node.type === 'message');
    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      expect(Number.isInteger(message.generation) && message.generation >= 1, message.message_id).toBe(true);
    }
    expect(messages.some((message) => message.handoff)).toBe(true);
  });
});
