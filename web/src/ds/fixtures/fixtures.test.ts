import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { CLAUSE_TEMPLATES, DECISION_STATES, EV_ERROR_CODES } from '../../api/contracts';
import type {
  CardOption,
  ClauseTemplate,
  Decision,
  DecisionState,
  DemoInboxEntry,
  EvMessage,
  NormalizedAction,
  RenderedBlock,
  RuleCard,
  SessionState,
  SseEvent,
} from '../../api/contracts';
import { chen, meridian, requestHrefOf, rivera, RIVERA_MONEY_CAP_CENTS } from './index';
import type { ConversationFixture, TranscriptTurn } from './index';

const FIXTURES = { rivera, chen, meridian };

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'backend', 'desk');
const CONTRACTS_PY = path.join(BACKEND, 'contracts.py');
const SCHEMA = JSON.parse(readFileSync(path.join(BACKEND, 'contracts.schema.json'), 'utf8')) as {
  $defs: { SseEvent: { discriminator: { mapping: Record<string, string> } } };
};

/**
 * MONEY_TOOLS and AUTO_MONEY_HARD_CAP_CENTS, the platform ceiling, as backend/desk/contracts.py
 * defines them. A Desk's own money cap is its active rules version's, at or under the ceiling.
 */
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

/** Every object under `root` (all the fixtures by default) that `match` accepts, each once. */
function collect<T>(match: (node: Record<string, unknown>) => boolean, root: unknown = FIXTURES): T[] {
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
  visit(root);
  return found;
}

/** A rendered block, cards and prose alike, whether or not its optional fields are written out. */
function isRenderedBlock(node: Record<string, unknown>): boolean {
  return (node.kind === 'card' || node.kind === 'prose') && typeof node.text === 'string';
}

const allBlocks = collect<RenderedBlock>(isRenderedBlock);
const cardBlocks = allBlocks.filter((block) => block.kind === 'card');

type CardField = 'title' | 'lines' | 'options' | 'href';

// The master plan's "Clauses" row: quote, charges and link_cancelled fill title and lines,
// booking_options its options, payment_link and document_link title and href, the rest title.
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
  link_cancelled: ['title', 'lines'],
} satisfies Record<ClauseTemplate, readonly CardField[]>;

// The proxied paths that are the only place a link token reaches a visitor.
const LINK_PATHS: Partial<Record<ClauseTemplate, RegExp>> = {
  payment_link: /^\/pay\/[A-Za-z0-9_-]+$/,
  document_link: /^\/api\/d\/[A-Za-z0-9_-]+$/,
};

const SLOT_ID = /^S-[0-9]{8}-[0-9]{4}$/;

// The master plan's slot_id is S-<yyyymmdd>-<hhmm>, the start in the business's time zone: Rivera's
// is America/Los_Angeles in its seed.
const BUSINESS_TIME_ZONE = 'America/Los_Angeles';
const SLOT_IDS_IN_TEXT = /\bS-[0-9]{8}-[0-9]{4}\b/g;
const WEEKDAY_NAMES = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};
const MONTH_NAMES = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
};

/** The slot id for a start: its date and time as the business's clock reads them, whatever offset it's written in. */
function slotIdAt(startsAt: string): string {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const part = Object.fromEntries(clock.formatToParts(new Date(startsAt)).map(({ type, value }) => [type, value]));
  return `S-${part.year}${part.month}${part.day}-${part.hour}${part.minute}`;
}

/** The start a slot id names, as a booking option's label writes it: "Tuesday, November 3, 2:00 pm" or "martes 3 de noviembre, 14:00". */
function slotLabels(slotId: string): { en: string; es: string } | null {
  const match = /^S-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})$/.exec(slotId);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  // The weekday of the id's own date, so a label on the wrong day or year doesn't match.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const mm = String(minute).padStart(2, '0');
  return {
    en: `${WEEKDAY_NAMES.en[weekday]}, ${MONTH_NAMES.en[month - 1]} ${day}, ${hour % 12 || 12}:${mm} ${hour < 12 ? 'am' : 'pm'}`,
    es: `${WEEKDAY_NAMES.es[weekday]} ${day} de ${MONTH_NAMES.es[month - 1]}, ${hour}:${mm}`,
  };
}

/** Every string under `root` (all the fixtures by default), each object visited once. */
function allStrings(root: unknown = FIXTURES): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    Object.values(node).forEach(visit);
  };
  visit(root);
  return found;
}

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

// Zero-width spaces and joiners, the word joiner, the byte order mark and the soft hyphen: removed
// before any rule runs, so they can't split a word the rules would catch.
const HIDDEN_IN_WORDS = /[\u200B-\u200D\u2060\uFEFF\u00AD]/gu;

/** `text` as the prose rules read it: NFKC, with the characters that can hide inside a word removed. */
function normalizeProse(text: string): string {
  return text.normalize('NFKC').replace(HIDDEN_IN_WORDS, '');
}

/** The rules `text` breaks, after `normalizeProse`. */
function proseProblems(text: string): string[] {
  const normalized = normalizeProse(text);
  return PROSE_RULES.filter(([, rule]) => rule.test(normalized)).map(([name]) => name);
}

const proseBlocks = allBlocks.filter((block) => block.kind === 'prose');

/** One alternation of words, each standing alone (not inside a longer word), case-insensitive. */
function wordsRule(words: readonly string[]): RegExp {
  return new RegExp(`${NOT_LETTER_BEFORE}(?:${words.join('|')})${NOT_LETTER_AFTER}`, 'iu');
}

// Verbs of an action Claude could claim to have taken, past tense.
const ACTION_VERBS_EN = [
  'asked', 'told', 'sent', 'booked', 'scheduled', 'arranged', 'notified', 'contacted', 'messaged', 'emailed', 'texted',
  'called', 'charged', 'refunded', 'let', 'passed', 'forwarded', 'flagged',
];
const ACTION_VERBS_ES = [
  'pedí', 'avisé', 'escribí', 'envié', 'mandé', 'pasé', 'notifiqué', 'llamé', 'contacté', 'agendé', 'reservé', 'cobré', 'reembolsé',
  'pedimos', 'avisamos', 'escribimos', 'enviamos', 'mandamos', 'pasamos', 'notificamos', 'llamamos', 'contactamos', 'agendamos',
  'reservamos', 'cobramos', 'reembolsamos',
];

// Claims only a card may make, even without a number: that something is booked, paid, charged or
// refunded, what it costs, that a price is lowered, or that Claude did something (only an executed
// receipt and its card may say that). Past forms and participles in both
// languages; infinitives and nouns ("to book", "reservar", "a test payment", "un pago") stay
// allowed, so Claude can still say what a card will do.
const CLAIM_RULES: [string, RegExp][] = [
  ['booking claim', wordsRule([
    'booked', 'rebooked', 'reserved', 'scheduled', 'confirmed', 'all set', 'locked in',
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
  // An action in the past tense with Claude as its subject, or a passive saying it was done: no
  // receipt or card would back it. English after I or we; Spanish in the first person, singular and
  // plural, in the simple past and the perfect (he or hemos with a participle).
  ['action claim', wordsRule([
    `(?:i(?:['’]ve| have)?|we(?:['’]ve| have)?) (?:already )?(?:${ACTION_VERBS_EN.join('|')})`,
    '(?:has|have) been (?:notified|told|informed|contacted)',
    `(?:ya )?(?:le |les |te )?(?:${ACTION_VERBS_ES.join('|')})`,
    '(?:he|hemos) \\p{L}+(?:ado|ido)',
    '(?:avisad|notificad|informad)[oa]s?',
  ])],
  ['discount claim', wordsRule([
    'markdown', 'marked down', 'price cut', 'special price', 'waived?', 'knock(?:ed)? off', 'half off',
    'rebaj\\p{L}*', 'precio especial', 'sin cargo', 'sin costo', 'mitad de precio',
  ])],
];

/** The claims `text` makes that only a card may make, after `normalizeProse`. */
function claimProblems(text: string): string[] {
  const normalized = normalizeProse(text);
  return CLAIM_RULES.filter(([, rule]) => rule.test(normalized)).map(([name]) => name);
}

// Cards whose text is a statement: the charter's hours, contact and policies, the kernel's
// handoff, verification, callback and cancelled-link statements, and the owner's own words.
// Fixture prose restates no card's statement, so the stories show prose that adds nothing the
// cards don't already carry.
const STATEMENT_TEMPLATES: readonly ClauseTemplate[] = [
  'hours', 'contact', 'policy', 'handoff', 'verify_prompt', 'callback_confirmed', 'owner_said', 'link_cancelled',
];

/**
 * The statement a statement card makes. A cancelled link's card first names the link from its
 * fact, its amount and then what it was for, which prose may name as it may a payment link's
 * title; only its last line is the kernel's statement.
 */
function statementOf(block: RenderedBlock): string {
  if (block.template === 'link_cancelled') return block.lines?.at(-1) ?? block.text;
  return block.text;
}

// The signed line an executed receipt shows a visitor, per tool: what ran and whose records it
// used, never a bare "Done". `{owner}` is the owner's display name.
const EXECUTED_LINES = {
  'native.quote': { en: "Quoted from {owner}'s price list", es: 'Cotizado con la lista de precios de {owner}' },
  'native.find_slots': { en: "Times read from {owner}'s calendar", es: 'Horarios tomados del calendario de {owner}' },
  'native.book': { en: "Booked on {owner}'s calendar", es: 'Reservado en el calendario de {owner}' },
  'native.capture_lead': { en: 'Details saved for {owner}', es: 'Datos guardados para {owner}' },
  'native.request_callback': { en: 'Callback request saved for {owner}', es: 'Solicitud de llamada guardada para {owner}' },
  'native.start_verification': { en: 'Verification started', es: 'Verificación iniciada' },
  'native.release_document': { en: "Document shared from {owner}'s records", es: 'Documento compartido desde los registros de {owner}' },
  'native.payment_link': { en: 'Payment link made for this quote', es: 'Enlace de pago creado para esta cotización' },
  'native.charge_mandate': { en: 'Charged within the limit of your mandate', es: 'Cobrado dentro del límite de tu mandato' },
  'payments.list_charges': { en: "Charges read from {owner}'s payments", es: 'Cargos tomados de los pagos de {owner}' },
  'payments.create_refund': { en: 'Refunded to the original payment', es: 'Reembolsado al pago original' },
} as const;

type Tool = keyof typeof EXECUTED_LINES;
type Language = 'en' | 'es';

/** The signed executed line for `tool`, with the owner's name in it. */
function executedLine(tool: Tool, language: Language, owner: string): string {
  return EXECUTED_LINES[tool][language].replaceAll('{owner}', owner);
}

/** Every signed executed line in `language` for this owner. */
function executedLines(language: Language, owner: string): string[] {
  return (Object.keys(EXECUTED_LINES) as Tool[]).map((tool) => executedLine(tool, language, owner));
}

// Cards that report an action the kernel carried out, and the tool whose executed receipt says so.
const ACTION_TOOLS = {
  booking_confirmed: 'native.book',
  charge_confirmed: 'native.charge_mandate',
  refund_issued: 'payments.create_refund',
  callback_confirmed: 'native.request_callback',
  document_link: 'native.release_document',
} as const satisfies Partial<Record<ClauseTemplate, Tool>>;

function isActionTemplate(template: RenderedBlock['template']): template is keyof typeof ACTION_TOOLS {
  return template != null && Object.hasOwn(ACTION_TOOLS, template);
}

/** A conversation in the fixtures, with the name of the owner whose Desk it is. */
interface OwnedConversation {
  name: string;
  conversation: ConversationFixture;
  owner: string;
}

const allConversations: OwnedConversation[] = Object.values(FIXTURES).flatMap((fixture) =>
  Object.entries(fixture.conversations).map(([name, conversation]) => ({ name, conversation, owner: fixture.business.ownerName })),
);

/** `text` as lower-case words joined by single spaces, so punctuation and case don't matter. */
function wordsOf(text: string): string {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []).join(' ');
}

const statementSentences = [
  ...new Set(
    cardBlocks
      .filter((block) => STATEMENT_TEMPLATES.includes(block.template as ClauseTemplate))
      .flatMap((block) => statementOf(block).split(/(?<=[.!?])\s+|\n/u))
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

  test('public_desks_are_what_the_kernel_serves', () => {
    // Each business's public Desk: its brand colors as plain #rrggbb, which the public page lets
    // through; its charter as the kernel's charter cards, each reading its template's fact; and,
    // where the Desk has hours, an open status the header can show whole.
    const CHARTER_FACTS: Partial<Record<ClauseTemplate, RegExp>> = {
      hours: /^charter:hours$/,
      policy: /^charter:policy:/,
      contact: /^charter:contact$/,
    };
    const desks = [
      ['en', rivera.publicDesk.en],
      ['es', rivera.publicDesk.es],
      ['en', chen.publicDesk.en],
      ['es', chen.publicDesk.es],
      ['en', meridian.publicDesk.en],
    ] as const;
    for (const [language, desk] of desks) {
      const where = `${desk.business_name} (${language})`;
      expect(Object.keys(desk.brand).sort(), where).toEqual(['accent', 'primary']);
      for (const color of Object.values(desk.brand)) expect(color, where).toMatch(/^#[0-9A-F]{6}$/i);
      expect(desk.charter.length, where).toBeGreaterThan(0);
      for (const block of desk.charter) {
        const fact = CHARTER_FACTS[block.template as ClauseTemplate];
        expect(fact, `${where}: ${block.template} is a charter card`).toBeDefined();
        expect(block.fact_id, `${where}: ${block.template}`).toMatch(fact ?? /^$/);
      }
    }
    // The city office's Desk has hours, so its header shows the kernel's open status.
    const status = meridian.publicDesk.en.open_status;
    expect(status?.open).toBe(true);
    expect(status?.text).toBe('Open now, until 4:30 pm');
    expect(meridian.publicDesk.en.owner_display_name).toBe(meridian.business.ownerName);
    // Its number is in 555-0100 to 555-0199, the range kept for fiction in every area code.
    const contact = meridian.publicDesk.en.charter.find((block) => block.template === 'contact');
    expect(contact?.title).toMatch(/^\(\d{3}\) 555-01\d{2}$/);
  });

  test('booking_card_has_the_kernels_shape', () => {
    // The kernel renders a confirmed booking as {date} / {start} to {end} / With {owner}, with no
    // booking ID (render/en.py and es.py). The fixture's card below keeps its earlier "Arriving" line
    // until the boards that draw it are redrawn with the new words.
    const render = (language: string) => readFileSync(path.join(BACKEND, 'kernel_service', 'render', `${language}.py`), 'utf8');
    expect(render('en')).toContain('f"{clock(start)} to {clock(end)}"');
    expect(render('en')).toContain('f"With {desk.owner_display_name}"');
    expect(render('es')).toContain('f"De {clock(start)} a {clock(end)}"');
    expect(render('es')).toContain('f"Con {desk.owner_display_name}"');
    const owner = rivera.business.ownerName;
    const card = (language: 'en' | 'es') => rivera.blocks.booking_confirmed[language];
    expect(card('en').title).toBe('Tuesday, November 3');
    expect(card('en').lines).toEqual(['Arriving 2:00 pm to 4:00 pm', `With ${owner}`]);
    expect(card('es').title).toBe('martes 3 de noviembre');
    expect(card('es').lines).toEqual(['Llegada de 14:00 a 16:00', `Con ${owner}`]);
    // No booking ID in what the visitor sees; the fact it comes from keeps its id.
    for (const language of ['en', 'es'] as const) expect(card(language).text).not.toMatch(/B-77|Booking|Reserva/);
  });

  test('link_cancelled_card_has_the_kernels_shape', () => {
    // The kernel renders a cancelled link's card from that link's own payment_link fact: its total
    // as the title, then its title claim and a line naming the owner (render/en.py and es.py
    // `link_cancelled`), in this order.
    const renderer = (language: string) => {
      const source = readFileSync(path.join(BACKEND, 'kernel_service', 'render', `${language}.py`), 'utf8');
      const body = /^def link_cancelled\(fact: Fact \| None, desk: DeskInfo\) -> Card:\n(?:(?: {4}.*)?\n)+/m.exec(source)?.[0];
      if (!body) throw new Error(`render/${language}.py no longer defines link_cancelled`);
      return body;
    };
    const fragments = {
      en: [
        `f"This payment link was cancelled because {desk.owner_display_name}'s rules changed. "`,
        '"Ask again if you still want to pay."',
      ],
      es: [
        'f"Este enlace de pago se canceló porque cambiaron las reglas de {desk.owner_display_name}. "',
        '"Pídelo de nuevo si todavía quieres pagar."',
      ],
    };
    for (const language of ['en', 'es'] as const) {
      const body = renderer(language);
      const order = ['return Card(title=money(claims(fact)["total"]), lines=(', 'title_claim(fact),', ...fragments[language]];
      for (const fragment of order) expect(body, language).toContain(fragment);
      const at = order.map((fragment) => body.indexOf(fragment));
      expect(at, language).toEqual([...at].sort((a, b) => a - b));
    }

    // The deposit link is for the seed's deposit item, whose one title the owner wrote and the
    // kernel shows unchanged in both languages, at $20.00 (render/cards.py `money`).
    const seed = readFileSync(path.join(BACKEND, 'kernel_service', 'seed.py'), 'utf8');
    expect(seed).toContain('PriceItem(item_id="deposit", title="Service call deposit", unit_cents=2000)');
    const owner = rivera.business.ownerName;
    const line = {
      en: `This payment link was cancelled because ${owner}'s rules changed. Ask again if you still want to pay.`,
      es: `Este enlace de pago se canceló porque cambiaron las reglas de ${owner}. Pídelo de nuevo si todavía quieres pagar.`,
    };
    for (const language of ['en', 'es'] as const) {
      // It cites the same fact as the deposit's payment link card, which reads `{title}, {total}`.
      const link = rivera.blocks.payment_link[language];
      expect(link.fact_id, language).toBe('payment_link:L-3301');
      expect(link.title, language).toBe('Service call deposit, $20.00');
      expect(rivera.blocks.link_cancelled[language], language).toEqual({
        kind: 'card',
        template: 'link_cancelled',
        text: ['$20.00', 'Service call deposit', line[language]].join('\n'),
        fact_id: 'payment_link:L-3301',
        title: '$20.00',
        lines: ['Service call deposit', line[language]],
        href: null,
        options: [],
      });
    }
  });

  test('card_amounts_print_cents_as_the_kernel_does', () => {
    // The kernel formats every amount with cents ("$20.00", "$1,234.56": render/cards.py `money`), so
    // no fixture card's title or lines, in the catalog or in a conversation, shows a bare "$20".
    const bare: string[] = [];
    for (const block of cardBlocks) {
      // The owner's own words are shown as written, not formatted by the kernel.
      if (block.template === 'owner_said') continue;
      for (const text of [block.title ?? '', ...(block.lines ?? [])]) {
        for (const amount of text.match(/\$[\d,]+(?:\.\d+)?/g) ?? []) {
          if (!/^\$\d{1,3}(?:,\d{3})*\.\d{2}$/.test(amount)) bare.push(`${block.template}: ${text}`);
        }
      }
    }
    expect(bare).toEqual([]);
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
    // Characters hidden inside a word don't get it past the rules.
    const [zwsp, zwj, wordJoiner, bom, softHyphen] = [0x200b, 0x200d, 0x2060, 0xfeff, 0x00ad].map((code) => String.fromCharCode(code));
    expect(normalizeProse(`Tu${zwsp}es${zwj}day ${wordJoiner}to${bom}day dis${softHyphen}count`)).toBe('Tuesday today discount');
    expect(proseProblems(`See you Tu${zwsp}esday`)).toEqual(['weekday']);
    expect(claimProblems(`You're boo${softHyphen}ked.`)).toEqual(['booking claim']);

    expect(proseBlocks.length).toBeGreaterThan(15);
    for (const block of proseBlocks) {
      expect(proseProblems(block.text), block.text).toEqual([]);
    }
  });

  test('fixture_prose_claims_no_booking_payment_price_discount_or_action', () => {
    // The claims lexicon catches each kind in both languages, so a clean result means something.
    expect(claimProblems("You're booked.")).toEqual(['booking claim']);
    expect(claimProblems('Listo, quedó reservado.')).toEqual(['booking claim']);
    expect(claimProblems('The deposit is paid within your signed limit.')).toEqual(['payment claim']);
    expect(claimProblems('La visita ya está pagada y el resto, reembolsado.')).toEqual(['payment claim']);
    expect(claimProblems("It's cheaper than a new tap.")).toEqual(['price claim']);
    expect(claimProblems('Cuesta menos que una llave nueva.')).toEqual(['price claim']);
    expect(claimProblems('Maria waived the call-out fee.')).toEqual(['discount claim']);
    expect(claimProblems('Te hago una rebaja si pagas hoy.')).toEqual(['discount claim']);
    expect(claimProblems("Of course. I've asked Maria to join.")).toEqual(['action claim']);
    expect(claimProblems('Claro. Le pedí a Maria que se sume al chat.')).toEqual(['action claim']);
    expect(claimProblems('We already told her.')).toEqual(['action claim']);
    // Plural and perfect past forms, passives, and passing a message on.
    expect(claimProblems('Ya le avisamos a Maria.')).toEqual(['action claim']);
    expect(claimProblems('Hemos avisado a Maria.')).toEqual(['action claim']);
    expect(claimProblems('Le pasé tu mensaje a Maria.')).toEqual(['action claim']);
    expect(claimProblems('Maria ya está avisada.')).toEqual(['action claim']);
    expect(claimProblems("I've passed your message to Maria.")).toEqual(['action claim']);
    expect(claimProblems('Maria has been notified.')).toEqual(['action claim']);
    expect(claimProblems("I've forwarded this to Maria.")).toEqual(['action claim']);
    expect(claimProblems('Le pedimos a Maria que se sume.')).toEqual(['action claim']);
    expect(claimProblems('Te he enviado el enlace.')).toEqual(['action claim']);
    expect(claimProblems('Your visit is locked in.')).toEqual(['booking claim']);
    // Asking for something, or saying what someone is called, claims nothing.
    expect(claimProblems('Listo.')).toEqual([]);
    expect(claimProblems('Claro. ¿Cómo te llamas, y cuál es el mejor número para llamarte?')).toEqual([]);
    expect(claimProblems("Of course. What's your name, and the best number to reach you?")).toEqual([]);
    // What a card will do is not a claim that it was done.
    expect(claimProblems("To hold the visit, here's a link. It's a test payment, so no money moves.")).toEqual([]);
    expect(claimProblems('Para reservar la visita, aquí tienes un enlace. Es un pago de prueba.')).toEqual([]);
    expect(claimProblems("I can help with that after you confirm it's you.")).toEqual([]);

    for (const block of proseBlocks) {
      expect(claimProblems(block.text), block.text).toEqual([]);
    }
  });

  test('action_cards_follow_an_executed_receipt', () => {
    // A card that reports an action as done (a booking, a charge, a refund, a callback, a released
    // document) shows only after the kernel's executed receipt for it, since the previous message,
    // and that receipt is the tool's own line.
    let checked = 0;
    for (const { name, conversation, owner } of allConversations) {
      let executedSinceLastMessage: string[] = [];
      for (const turn of conversation.turns) {
        if (turn.kind !== 'event') continue;
        const { event } = turn;
        if (event.type === 'receipt' || event.type === 'resolved') {
          if (event.state === 'executed') executedSinceLastMessage.push(event.visitor_plain);
          continue;
        }
        if (event.type !== 'message') continue;
        for (const block of event.blocks) {
          if (block.kind !== 'card' || !isActionTemplate(block.template)) continue;
          checked += 1;
          const line = executedLine(ACTION_TOOLS[block.template], event.language, owner);
          expect(executedSinceLastMessage, `${name}: ${event.message_id} shows ${block.template}`).toContain(line);
        }
        executedSinceLastMessage = [];
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  test('executed_receipts_say_what_ran', () => {
    // Every executed receipt, resolved event and decision is a signed per-tool line with its
    // owner's name, never "Done" or "Hecho".
    let checked = 0;
    for (const [name, fixture] of Object.entries(FIXTURES)) {
      const owner = fixture.business.ownerName;
      const signed = [...executedLines('en', owner), ...executedLines('es', owner)];
      const executed = collect<{ visitor_plain: string }>(
        (node) => node.state === 'executed' && typeof node.visitor_plain === 'string',
        fixture,
      );
      for (const node of executed) {
        expect(signed, `${name}: "${node.visitor_plain}"`).toContain(node.visitor_plain);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);

    // In a conversation or a live sequence, the line is in the language of its messages.
    const sequences = [
      ...allConversations.map(({ name, conversation, owner }) => ({
        name,
        owner,
        language: conversation.language,
        events: conversation.turns.flatMap((turn) => (turn.kind === 'event' ? [turn.event] : [])),
      })),
      ...Object.entries(rivera.events).flatMap(([name, events]) => {
        const languages = [...new Set(events.flatMap((event) => (event.type === 'message' ? [event.language] : [])))];
        return languages.length === 1 ? [{ name, owner: rivera.business.ownerName, language: languages[0] as Language, events }] : [];
      }),
    ];
    let inLanguage = 0;
    for (const { name, owner, language, events } of sequences) {
      for (const event of events) {
        if ((event.type !== 'receipt' && event.type !== 'resolved') || event.state !== 'executed') continue;
        expect(executedLines(language, owner), `${name}: "${event.visitor_plain}"`).toContain(event.visitor_plain);
        inLanguage += 1;
      }
    }
    expect(inLanguage).toBeGreaterThanOrEqual(10);

    // A decision that ran says its own tool's line.
    const ran = [...Object.values(rivera.decisions), rivera.heldVerified].filter((decision) => decision.state === 'executed');
    expect(ran.length).toBeGreaterThan(0);
    for (const decision of ran) {
      const tool = decision.action?.tool as Tool;
      expect(decision.visitor_plain, decision.decision_id).toBe(executedLine(tool, 'en', rivera.business.ownerName));
    }
  });

  test('callbacks_use_details_the_visitor_gave', () => {
    // A callback needs a name and a number to call. Claude asks for them, and the visitor gives
    // them in their own message, before the request_callback receipt and its card.
    const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/u;
    expect(PHONE.test('Lucía Herrera, (510) 555-0187')).toBe(true);
    expect(PHONE.test('¿Puedo hablar con Maria?')).toBe(false);
    const conversations = Object.values(FIXTURES).flatMap((fixture) => Object.entries(fixture.conversations));
    let callbacks = 0;
    for (const [name, conversation] of conversations) {
      let gaveDetails = false;
      for (const turn of conversation.turns) {
        if (turn.kind === 'visitor') {
          gaveDetails ||= PHONE.test(turn.text);
          continue;
        }
        if (turn.kind !== 'event') continue;
        const { event } = turn;
        if (event.type !== 'message') continue;
        if (event.blocks.some((block: RenderedBlock) => block.template === 'callback_confirmed')) {
          callbacks += 1;
          expect(gaveDetails, `${name}: ${event.message_id} confirms a callback`).toBe(true);
        }
        gaveDetails = false;
      }
    }
    expect(callbacks).toBeGreaterThan(0);
  });

  test('fixture_prose_restates_no_card_statement', () => {
    // The oracle catches a charter policy repeated in prose, so a clean result means something.
    expect(restatedStatements('Thanks. Maria texts before she arrives.')).toEqual(['maria texts before she arrives']);
    // It catches the kernel's cancelled-link line repeated in prose, in both languages, but not
    // prose naming the link, as a payment link's own title may be named.
    expect(restatedStatements("Sorry. This payment link was cancelled because Maria Rivera's rules changed.")).toEqual([
      "this payment link was cancelled because maria rivera's rules changed",
    ]);
    expect(restatedStatements('Lo siento. Este enlace de pago se canceló porque cambiaron las reglas de Maria Rivera.')).toEqual([
      'este enlace de pago se canceló porque cambiaron las reglas de maria rivera',
    ]);
    expect(restatedStatements("To hold the visit, here's a link for the service call deposit.")).toEqual([]);
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

    // Rivera's money cap is its rules version's, at or under the platform ceiling, and every auto
    // card that moves money stays within it.
    expect(RIVERA_MONEY_CAP_CENTS).toBeLessThanOrEqual(hardCapCents);
    for (const card of Object.values(rivera.ruleCards)) {
      if (card.mode !== 'auto' || !moneyTools.includes(card.applies_to)) continue;
      expect(card.max_amount_cents ?? Number.POSITIVE_INFINITY, card.card_id).toBeLessThanOrEqual(RIVERA_MONEY_CAP_CENTS);
    }

    expect(Object.keys(rivera.decisions).sort()).toEqual([...DECISION_STATES].sort());
    for (const state of DECISION_STATES) {
      expect(rivera.decisions[state].state, state).toBe(state);
    }

    // The seeded hold, an unverified visitor's discount over the quote card's limit, offers the two
    // one-time answers; verified Dana's Saturday request, over the Saturday card's hours, adds
    // Allow only for this person ("answers_follow_what_held_the_request" says why).
    const held = rivera.decisions.held;
    expect(held.answers).toEqual(['allow_once', 'deny_once']);
    expect(rivera.heldVerified.state).toBe('held');
    expect(rivera.heldVerified.answers).toEqual(['allow_once', 'deny_once', 'allow_person']);

    // Every state the hold can move to keeps its answers, so only `state` can hide the buttons.
    const afterHold: DecisionState[] = ['approved', 'denied', 'expired', 'cancelled', 'executed', 'failed', 'unknown', 'refused_at_execution'];
    for (const state of afterHold) {
      expect(rivera.decisions[state].decision_id, state).toBe(held.decision_id);
      expect(rivera.decisions[state].answers, state).toEqual(held.answers);
    }

    // allow_person only for a verified person or an agent, and on money only within the rules'
    // money cap.
    const sessions = new Map(
      collect<SessionState>((node) => typeof node.session_id === 'string' && typeof node.verified === 'boolean' && 'assurance' in node).map(
        (session) => [session.session_id, session],
      ),
    );
    const decisions: Decision[] = [...Object.values(rivera.decisions), rivera.heldVerified, rivera.heldRefund];
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
        expect(action.amount_cents ?? Number.POSITIVE_INFINITY, `${decision.decision_id} amount`).toBeLessThanOrEqual(RIVERA_MONEY_CAP_CENTS);
      }
    }
  });

  test('answers_follow_what_held_the_request', () => {
    const { moneyTools } = backendMoneyRules();
    const sessions = new Map(
      collect<SessionState>((node) => typeof node.session_id === 'string' && typeof node.verified === 'boolean' && 'assurance' in node).map(
        (session) => [session.session_id, session],
      ),
    );
    // Every held request in each business's fixtures, beside that business's rule cards and money
    // cap. Chen & Co. has no money tools and no cap, so no money request of theirs could offer it.
    const businesses: { name: string; fixture: unknown; cards: Record<string, RuleCard>; moneyCapCents: number | null }[] = [
      { name: 'rivera', fixture: rivera, cards: rivera.ruleCards, moneyCapCents: RIVERA_MONEY_CAP_CENTS },
      { name: 'chen', fixture: chen, cards: chen.ruleCards, moneyCapCents: null },
    ];
    const shapes = new Set<string>();
    for (const { name, fixture, cards, moneyCapCents } of businesses) {
      // A decision, not a status event about one: it carries its reason and its answers.
      const held = collect<Decision>(
        (node) => typeof node.decision_id === 'string' && typeof node.reason_plain === 'string' && Array.isArray(node.answers) && node.state === 'held',
        fixture,
      );
      expect(held.length, `${name} has a held request`).toBeGreaterThan(0);
      for (const decision of held) {
        const where = `${name}: ${decision.decision_id}`;
        const answers = decision.answers ?? [];
        // The one-time answers are always offered.
        expect(answers.slice(0, 2), where).toEqual(['allow_once', 'deny_once']);

        // Each card that held it holds through its own permit: an ask card directly, an auto card
        // through its hold twin, which drops the card's limits (amount, discount, hours, review).
        const holding = decision.card_ids.map((id) => cards[id]);
        expect(holding.every((card) => card !== undefined), `${where} names its business's cards`).toBe(true);
        expect([...decision.policy_ids].sort(), where).toEqual(
          holding.map((card) => (card?.mode === 'ask' ? `H.${card.card_id}` : `H.${card?.card_id}.hold`)).sort(),
        );

        // Deny always only when the tool itself is held, by an ask card or a default ask; a
        // request over a limit leaves it out.
        const askHeld = holding.some((card) => card?.mode === 'ask' || card?.is_default === true);
        expect(answers.includes('deny_always'), `${where} deny_always`).toBe(askHeld);

        // Allow only for this person exactly when there is a person or an agent key to scope it to,
        // and a money action stays within the rules' money cap.
        const session = sessions.get(decision.session_id);
        const action = decision.action;
        const underCap =
          !action ||
          !moneyTools.includes(action.tool) ||
          (moneyCapCents !== null && (action.amount_cents ?? Number.POSITIVE_INFINITY) <= moneyCapCents);
        const scoped = session?.verified === true || session?.kind === 'agent';
        expect(answers.includes('allow_person'), `${where} allow_person`).toBe(scoped && underCap);

        shapes.add(answers.join(' '));
      }
    }
    // The fixtures show every shape the card lays out: two plain buttons, a Deny menu, an Allow
    // menu, and both menus.
    expect([...shapes].sort()).toEqual(
      [
        'allow_once deny_once',
        'allow_once deny_once deny_always',
        'allow_once deny_once allow_person',
        'allow_once deny_once allow_person deny_always',
      ].sort(),
    );
  });

  test('inbox_alerts_name_their_held_request', () => {
    // The kernel writes the owner's alert for a held request with that decision's reason as its
    // body and the decision's own id, under the entry_id its notice gave. Every other entry, a
    // code or a ledger checkpoint, carries decision_id null, as the API sends it.
    const entries = collect<DemoInboxEntry>(
      (node) =>
        typeof node.entry_id === 'string' &&
        typeof node.body === 'string' &&
        typeof node.created_at === 'string' &&
        ['verification_code', 'alert', 'head_checkpoint'].includes(node.kind as string),
    );
    const held = new Map(
      collect<Decision>(
        (node) => typeof node.decision_id === 'string' && typeof node.reason_plain === 'string' && Array.isArray(node.answers) && node.state === 'held',
      ).map((decision) => [decision.decision_id, decision]),
    );
    expect(entries.length).toBeGreaterThan(2);
    let alerts = 0;
    for (const entry of entries) {
      const where = entry.entry_id;
      if (typeof entry.decision_id !== 'string') {
        expect(entry.decision_id, `${where} carries decision_id null`).toBeNull();
        continue;
      }
      alerts += 1;
      expect(entry.kind, where).toBe('alert');
      expect(entry.to, where).toBe('owner');
      const decision = held.get(entry.decision_id);
      expect(decision, `${where} names a held fixture decision`).toBeDefined();
      expect(entry.body, `${where} is its decision's reason`).toBe(decision?.reason_plain);
      expect((decision?.inbox ?? []).map((notice) => notice.entry_id), `${where} is its decision's notice`).toContain(entry.entry_id);
    }
    // At least one alert names its request, so a clean result means something.
    expect(alerts).toBeGreaterThan(0);
  });

  test('request_href_is_the_held_requests_place_on_the_page', () => {
    // A story's "Open the request" goes to the place on the page of the decision its alert names,
    // the id encoded; an entry that names none, or one not fetched yet, has no link.
    const { entries } = chen.demoInbox;
    const alert = entries.find((entry) => entry.kind === 'alert') as DemoInboxEntry;
    expect(requestHrefOf(alert)).toBe('#request-dec-chen-consultation');
    expect(requestHrefOf({ ...alert, decision_id: 'dec 1/2#3?' })).toBe('#request-dec%201%2F2%233%3F');
    for (const decisionId of [null, undefined, '']) {
      expect(requestHrefOf({ ...alert, decision_id: decisionId }), String(decisionId)).toBeUndefined();
    }
    for (const entry of entries.filter((entry) => entry.kind !== 'alert')) {
      expect(requestHrefOf(entry), entry.entry_id).toBeUndefined();
      // Only the owner's alert names a request, as the kernel rules: a code or a checkpoint that
      // carries a decision_id anyway still has no link.
      expect(requestHrefOf({ ...entry, decision_id: alert.decision_id }), `${entry.entry_id} with a decision_id`).toBeUndefined();
    }
    expect(requestHrefOf({ ...alert, to: '•••• 0142' }), 'an alert not to the owner').toBeUndefined();
    expect(requestHrefOf(null)).toBeUndefined();
  });

  test('slot_ids_name_their_start_in_business_time', () => {
    // The same instant written with the business's offset or in UTC has one slot id, and the
    // labels follow the id's own date.
    expect(slotIdAt('2026-11-07T14:00:00-08:00')).toBe('S-20261107-1400');
    expect(slotIdAt('2026-11-07T22:00:00Z')).toBe('S-20261107-1400');
    expect(slotIdAt('2026-10-30T08:00:00-07:00')).toBe('S-20261030-0800');
    expect(slotLabels('S-20261103-1400')).toEqual({ en: 'Tuesday, November 3, 2:00 pm', es: 'martes 3 de noviembre, 14:00' });
    expect(slotLabels('S-20261105-0800')).toEqual({ en: 'Thursday, November 5, 8:00 am', es: 'jueves 5 de noviembre, 8:00' });
    expect(slotLabels('Sat 2pm')).toBeNull();

    const checked = new Set<string>();
    // A booking names its slot as its resource and its start in starts_at.
    const bookings = collect<NormalizedAction>(
      (node) => typeof node.action_id === 'string' && (node.resource as { kind?: unknown } | undefined)?.kind === 'slot',
    );
    expect(bookings.length).toBeGreaterThan(0);
    for (const action of bookings) {
      expect(action.starts_at, `${action.action_id} has a start`).toEqual(expect.any(String));
      expect(action.resource.id, `${action.action_id} starts at ${action.starts_at}`).toBe(slotIdAt(action.starts_at ?? ''));
      checked.add(action.resource.id);
    }
    // A booking option's id is its slot, and its label writes that slot's start out.
    const options = collect<CardOption>((node) => typeof node.option_id === 'string' && typeof node.label === 'string');
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const labels = slotLabels(option.option_id);
      expect(labels, option.option_id).not.toBeNull();
      expect([labels?.en, labels?.es], option.option_id).toContain(option.label);
      checked.add(option.option_id);
    }
    // No slot id appears anywhere else in the fixtures, where its start would go unchecked.
    const written = new Set(allStrings().flatMap((text) => text.match(SLOT_IDS_IN_TEXT) ?? []));
    expect([...written].filter((slotId) => !checked.has(slotId))).toEqual([]);
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
