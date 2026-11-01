/**
 * The scripted Desk: how Turner Plumbing's Claude answers in the mock API. A visitor's message
 * picks the first rule with one of its words, as a word of its own, in the lowercased text (so
 * "offer" never reads as "off"), and that rule's steps run
 * 150 ms apart. Each turn starts as the API's turns do, with Claude writing before anything it
 * does, and ends with `turn_end`; a session's turns run one at a time, as under the API's turn
 * lock (served.ts `Server.runTurn`). Cards, prose and status lines are the design
 * system's Turner fixtures and the kernel's visitor templates, in the turn's language. Nothing here
 * is a model; it stands in for the API's turn runner so screens can be built and tested.
 */
import {
  MONEY_EFFECTS,
  type ApprovalAnswer,
  type CardBlock,
  type ClauseTemplate,
  type Decision,
  type DecisionState,
  type EvDemoInbox,
  type EvMessage,
  type Effect,
  type NormalizedAction,
  type Outcome,
  type PaymentLinkView,
  type RenderedBlock,
  type RuleCard,
  type SseEvent,
  type StatusEvent,
  type ToolName,
} from '../api/contracts.ts';
import { RIVERA_MONEY_CAP_CENTS, cardBlock, proseBlock, rivera } from '../ds/fixtures/index.ts';
import { executedLine, type ExecutedTool } from '../ds/fixtures/receipts.ts';
import { afterName } from '../lib/names.ts';

export type Language = 'en' | 'es';

/** How far apart a turn's events arrive. */
export const EVENT_GAP_MS = 150;

const SPANISH_MARKERS = ['¿', 'cuánto', 'descuento', 'reservar', 'hablar', 'factura', 'pagar', 'llámame', 'hola', 'tarjetas'] as const;

/** A turn is in Spanish when the visitor's text has one of the markers, else in English. */
export function turnLanguage(text: string): Language {
  const lower = text.toLowerCase();
  return SPANISH_MARKERS.some((marker) => lower.includes(marker)) ? 'es' : 'en';
}

// ---------------------------------------------------------------------------------------------
// Whom the visitor's lines name: the Desk's own owner

/**
 * Whom a Desk's visitor lines name (`MockWorld.ownerOf`), as the kernel renders them from the
 * Desk's `owner_display_name`: the owner's display name, or null when they gave none and the Desk
 * carries setup's fallback, "Owner", which is no one's name; and the business's name, as its
 * public page shows it, which a verification code's message names and `NO_NAME_OWNER` may name in
 * that owner's place.
 */
export interface DeskOwner {
  readonly name: string | null;
  readonly business: string;
}

/** Mike Turner, whom Turner Plumbing's seeded Desks name, in the fixtures' signed words. */
export const RIVERA_OWNER: DeskOwner = { name: rivera.business.ownerName, business: rivera.business.name };

/**
 * How the visitor's lines name an owner who gave no name: "the business owner" ("el dueño del
 * negocio"), the words the public page already uses for them ("The business owner is in this
 * chat."). Proposed here for the project owner's sign-off. Should he decline, set this to `null`:
 * the lines then name the business instead, as the handoff card did before.
 */
export const NO_NAME_OWNER: Record<Language, string> | null = { en: 'the business owner', es: 'el dueño del negocio' };

/** How a line in `language` names the Desk's owner within a sentence: by display name, else `NO_NAME_OWNER`. */
function ownerIn(language: Language, owner: DeskOwner): string {
  return owner.name ?? NO_NAME_OWNER?.[language] ?? owner.business;
}

/**
 * `template` naming the owner as `who`, as the kernel's templates do: `{owner}` within a sentence
 * and `{Owner}` starting one. A sentence that ends on the owner gets one stop, never a second
 * after a name that ends in one ("Bob Smith Jr."). Spanish joins "de" and "a" with an "el" that
 * follows ("del dueño del negocio"); a name's own "El" keeps its capital, so it is never joined.
 */
function naming(template: string, who: string, language: Language): string {
  const line = template.replace(/\{(owner|Owner)\}(\.?)/g, (_, form: string, stop: string) =>
    `${form === 'Owner' ? who.charAt(0).toUpperCase() + who.slice(1) : who}${afterName(who, stop)}`,
  );
  return language === 'es' ? line.replace(/(?<!\p{L})(de|a) el(?!\p{L})/gu, '$1l') : line;
}

/** `template` naming the Desk's owner (`owner`) as a line in `language` does (`ownerIn`). */
function withOwner(template: string, language: Language, owner: DeskOwner): string {
  return naming(template, ownerIn(language, owner), language);
}

// ---------------------------------------------------------------------------------------------
// Visitor-facing text: the kernel's templates and the fixture cards, by language

/** A visitor status line: each decision state's but `executed`, the mandate refusal's, a reply's and the owner's words'. */
export type VisitorLine = Exclude<DecisionState, 'executed'> | 'refused_over_mandate' | 'reply_checked' | 'reply_handed_off' | 'owner_said';

/**
 * The kernel's visitor status lines (its render/en.py and es.py), `{owner}` naming the Desk's
 * owner. An executed action has no line here: it carries its tool's own line, the design system's
 * `executedLine`.
 */
const VISITOR_TEMPLATES = {
  en: {
    allowed: "Checked against {owner}'s rules",
    held: 'Waiting for {owner} to approve',
    refused: 'Not something I can do here',
    refused_over_mandate: 'Refused: over the signed limit for this agent',
    approved: '{Owner} approved this',
    denied: '{Owner} decided not to go ahead',
    expired: 'This request timed out',
    cancelled: 'Cancelled',
    failed: "That didn't go through",
    unknown: 'Still confirming this',
    refused_at_execution: "The rules changed, so this didn't go ahead",
    reply_checked: "Reply checked against {owner}'s rules",
    reply_handed_off: 'Passed to {owner} to answer',
    owner_said: 'Written by {owner}',
  },
  es: {
    allowed: 'Revisado con las reglas de {owner}',
    held: 'Esperando la aprobación de {owner}',
    refused: 'No es algo que pueda hacer aquí',
    refused_over_mandate: 'Rechazado: supera el límite firmado para este agente',
    approved: '{Owner} lo aprobó',
    denied: '{Owner} decidió no seguir adelante',
    expired: 'Esta solicitud venció',
    cancelled: 'Cancelado',
    failed: 'No se pudo completar',
    unknown: 'Todavía lo estamos confirmando',
    refused_at_execution: 'Las reglas cambiaron, así que no se hizo',
    reply_checked: 'Respuesta revisada con las reglas de {owner}',
    reply_handed_off: 'Pasado a {owner} para responder',
    owner_said: 'Escrito por {owner}',
  },
} as const satisfies Record<Language, Record<VisitorLine, string>>;

/** The visitor's status line `line` on a Desk whose owner is `owner`, in `language`. */
export function visitorLine(language: Language, line: VisitorLine, owner: DeskOwner): string {
  return withOwner(VISITOR_TEMPLATES[language][line], language, owner);
}

/** Every visitor status line on a Desk whose owner is `owner`, in `language`. */
function visitorLines(language: Language, owner: DeskOwner): Record<VisitorLine, string> {
  const lines = Object.keys(VISITOR_TEMPLATES[language]) as VisitorLine[];
  return Object.fromEntries(lines.map((line) => [line, visitorLine(language, line, owner)])) as Record<VisitorLine, string>;
}

/**
 * The visitor status lines on Mike Turner's Desk, as the Turner fixtures write them (a store test
 * holds each one to the fixtures).
 */
export const VISITOR_PLAIN: Record<Language, Record<VisitorLine, string>> = {
  en: visitorLines('en', RIVERA_OWNER),
  es: visitorLines('es', RIVERA_OWNER),
};

/**
 * Tools that only read for Claude and so have no executed line of their own. Every other tool has
 * one in the design system's fixtures: the record is exhaustive, so a new tool without a line
 * fails the typecheck here.
 */
const NO_EXECUTED_LINE = {
  'native.fetch_website': true,
  'native.read_memory': true,
  'native.web_search': true,
} as const satisfies Record<Exclude<ToolName, ExecutedTool>, true>;

function hasExecutedLine(tool: string): tool is ExecutedTool {
  return !Object.hasOwn(NO_EXECUTED_LINE, tool);
}

/**
 * The visitor's line for a decision in `state` on a Desk whose owner is `owner` (Turner's unless
 * given): an executed one names what its tool did, in the signed per-tool words the design
 * system's fixtures carry, never a bare "Done".
 */
export function statusLine(language: Language, state: DecisionState | 'refused_over_mandate', tool: string | null, owner: DeskOwner = RIVERA_OWNER): string {
  if (state !== 'executed') return visitorLine(language, state, owner);
  if (tool === null || !hasExecutedLine(tool)) throw new Error(`the mock has no executed line for ${tool ?? 'a decision with no tool'}`);
  // The tool's line as the fixtures write it, with `{owner}` left in, named as every line here is.
  return withOwner(executedLine(tool, language, '{owner}'), language, owner);
}

const { blocks } = rivera;

/** Money as the kernel's cards write it, in both languages: "$1,234.56". */
function moneyText(cents: number): string {
  const dollars = Math.floor(cents / 100).toLocaleString('en-US');
  return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

/** Basis points as the kernel's cards write a percentage, with no trailing zeros: 1500 is "15", 1250 "12.5" ("12,5" in Spanish). */
function percentText(bp: number, decimalMark: '.' | ','): string {
  const whole = Math.floor(bp / 100);
  const rest = bp % 100;
  return rest === 0 ? String(whole) : `${whole}${decimalMark}${String(rest).padStart(2, '0')}`.replace(/0+$/, '');
}

/** A price after a discount, as the kernel works it out (the master plan's "Discounts"): the discount's cents round down. */
function discountedCents(listCents: number, discountBp: number): number {
  return listCents - Math.floor((listCents * discountBp) / 10_000);
}

/**
 * The quote card for a drain clearing at a discount Mike allowed, as the kernel renders its quote
 * fact: the price, the job, the discount off the list price (only when there is one) and how long
 * the quote holds. At 15% it is the fixtures' card.
 */
function discountedQuote(language: Language, quote: { listCents: number; discountBp: number; amountCents: number }): CardBlock {
  const { listCents, discountBp, amountCents } = quote;
  const discount =
    discountBp === 0
      ? []
      : language === 'es'
        ? [`Incluye ${percentText(discountBp, ',')} % de descuento sobre ${moneyText(listCents)}`]
        : [`Includes ${percentText(discountBp, '.')}% off ${moneyText(listCents)}`];
  const expires = language === 'es' ? 'Válido hasta martes 3 de noviembre, 14:00' : 'Good until Tuesday, November 3, 2:00 pm';
  return cardBlock('quote', { fact_id: 'quote:Q-1043', title: moneyText(amountCents), lines: ['Drain clearing', ...discount, expires] });
}

/** The callback window the script offers: Monday 8 to 9 am in the business's time zone. */
export const CALLBACK_WINDOW = '2026-11-02T08:00:00-08:00/2026-11-02T09:00:00-08:00';

/** The callback card's title, rendered from the handoff fact as Plan 01b does: with the script's window, or with none. */
const CALLBACK_TITLES: Record<'window' | 'open', Record<Language, string>> = {
  window: {
    en: '{Owner} will call you back on Monday, between 8:00 am and 9:00 am',
    es: '{Owner} te llamará el lunes, entre las 8:00 y las 9:00',
  },
  open: {
    en: '{Owner} will call you back',
    es: '{Owner} te llamará',
  },
};

/** The kernel's callback card on a Desk whose owner is `owner`, in `language`. */
function callbackCard(when: 'window' | 'open', language: Language, owner: DeskOwner): CardBlock {
  return cardBlock('callback_confirmed', { fact_id: 'handoff:callback', title: withOwner(CALLBACK_TITLES[when][language], language, owner) });
}

/**
 * Booking the first time offered: Claude's checked words carry no price or date and promise
 * nothing the card doesn't back, and the kernel's card says what was booked (`bookedCard`).
 */
const bookedProse: Record<Language, RenderedBlock> = {
  en: proseBlock("You're all set. Here's your visit."),
  es: proseBlock('Ya está todo listo. Aquí tienes tu visita.'),
};

/** The booked card's words, as the kernel renders a confirmed booking: {date} / Arriving {start} to {end} / With {owner}. */
const BOOKED: Record<Language, { title: string; lines: readonly string[] }> = {
  en: { title: 'Tuesday, November 3', lines: ['Arriving 2:00 pm to 4:00 pm', 'With {owner}'] },
  es: { title: 'martes 3 de noviembre', lines: ['Llegada de 14:00 a 16:00', 'Con {owner}'] },
};

/** The kernel's booked card on a Desk whose owner is `owner`, in `language`; on Turner's Desk, the fixtures' card. */
function bookedCard(language: Language, owner: DeskOwner): CardBlock {
  const { title, lines } = BOOKED[language];
  return cardBlock('booking_confirmed', { fact_id: 'booking:B-77', title, lines: lines.map((line) => withOwner(line, language, owner)) });
}

/**
 * Claude's checked words that name the Desk's owner: `help` when nothing more specific fits, a
 * question only the owner can answer, with the way to reach them; `held` after a request is held
 * for them, whose answer comes back into this chat. No digits, amounts, dates or promises, and no
 * promise of what the owner will say.
 */
interface OwnerProse {
  help: string;
  held: string;
}

/** Turner's words, as the signed boards write them, `{owner}` for Mike. */
const RIVERA_PROSE: Record<Language, OwnerProse> = {
  en: {
    help: '{Owner} can tell you once he sees it. You can ask for him here anytime.',
    held: "That's for {owner} to decide, so I've asked him. His answer will show up here.",
  },
  es: {
    help: '{Owner} te lo puede decir cuando lo vea. Puedes pedir hablar con él aquí cuando quieras.',
    held: 'Eso lo decide {owner}, así que ya le pregunté. Su respuesta aparecerá aquí.',
  },
};

/** The same words with no pronoun, for an owner whose pronouns the Desk doesn't know. */
const PRONOUN_FREE_PROSE: Record<Language, OwnerProse> = {
  en: {
    help: '{Owner} can tell you after taking a look. You can ask for {owner} here anytime.',
    held: "That's for {owner} to decide, so I've asked. The answer will show up here.",
  },
  es: {
    help: '{Owner} te lo puede decir cuando lo vea. Puedes pedir hablar con {owner} aquí cuando quieras.',
    held: 'Eso lo decide {owner}, así que ya le pregunté. Su respuesta aparecerá aquí.',
  },
};

/**
 * Claude's words for a named owner other than Mike Turner, by first name. Proposed here for the
 * project owner's sign-off. Should he decline, set this to `RIVERA_PROSE`: Turner's sentences with
 * the owner's name in them, pronouns kept.
 */
export const NAMED_OWNER_PROSE: Record<Language, OwnerProse> = PRONOUN_FREE_PROSE;

/** Whom a visitor can ask for when the owner gave no name, as the public page's "Ask for a person" has it. */
const A_PERSON: Record<Language, string> = { en: 'a person', es: 'una persona' };

/** The same words for an owner who gave no name, `NO_NAME_OWNER`'s words for them, with a person to ask for. */
const NO_NAME_PROSE: Record<Language, OwnerProse> = {
  en: {
    help: `{Owner} can tell you after taking a look. You can ask for ${A_PERSON.en} here anytime.`,
    held: PRONOUN_FREE_PROSE.en.held,
  },
  es: {
    help: `{Owner} te lo puede decir cuando lo vea. Puedes pedir hablar con ${A_PERSON.es} aquí cuando quieras.`,
    held: PRONOUN_FREE_PROSE.es.held,
  },
};

/** An owner's first name, the one Claude's words call them by: "Mike" for Mike Turner. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * Claude's words `line` on a Desk whose owner is `owner`, in `language`: Turner's signed words on
 * his Desk (setup names an owner by one word, so no Desk it makes has his name), else
 * `NAMED_OWNER_PROSE` by first name, else `NO_NAME_PROSE`.
 */
function ownerProse(language: Language, owner: DeskOwner, line: keyof OwnerProse): string {
  if (owner.name === null) return withOwner(NO_NAME_PROSE[language][line], language, owner);
  const prose = owner.name === RIVERA_OWNER.name ? RIVERA_PROSE : NAMED_OWNER_PROSE;
  return naming(prose[language][line], firstName(owner.name), language);
}

/** Claude's checked words after a request is held for the Desk's owner. */
export function heldProse(language: Language, owner: DeskOwner): string {
  return ownerProse(language, owner, 'held');
}

/** Claude's checked words after a request is held for Mike, on Turner's Desk. */
export const HELD_PROSE: Record<Language, string> = {
  en: heldProse('en', RIVERA_OWNER),
  es: heldProse('es', RIVERA_OWNER),
};

/** Claude's checked words when nothing more specific fits: a question only the Desk's owner can answer. */
function helpProse(language: Language, owner: DeskOwner): RenderedBlock {
  return proseBlock(ownerProse(language, owner, 'help'));
}

/**
 * The kernel's `link_cancelled` line, rendered from the owner's name (master plan, "Payment links";
 * kernel plan 01c), which only the kernel issues.
 */
const LINK_CANCELLED_TEMPLATES: Record<Language, string> = {
  en: "This payment link was cancelled because {owner}'s rules changed. Ask again if you still want to pay.",
  es: 'Este enlace de pago se canceló porque cambiaron las reglas de {owner}. Pídelo de nuevo si todavía quieres pagar.',
};

/** The kernel's `link_cancelled` line on a Desk whose owner is `owner`, in `language`. */
function linkCancelledLine(language: Language, owner: DeskOwner): string {
  return withOwner(LINK_CANCELLED_TEMPLATES[language], language, owner);
}

/** The kernel's `link_cancelled` line on Turner's Desk. */
export const LINK_CANCELLED: Record<Language, string> = {
  en: linkCancelledLine('en', RIVERA_OWNER),
  es: linkCancelledLine('es', RIVERA_OWNER),
};

/**
 * The `link_cancelled` card as the kernel renders it from the cancelled link's own `payment_link`
 * fact, in the chat's language, on a Desk whose owner is `owner` (Turner's unless given): the
 * link's amount as its title, then what the link was for and the kernel's line. It cites the
 * deposit card's fact, as the script's payment link card does.
 */
export function linkCancelledBlock(
  link: Pick<PaymentLinkView, 'title' | 'amount_cents'>,
  language: Language,
  factId = blocks.payment_link[language].fact_id ?? null,
  owner: DeskOwner = RIVERA_OWNER,
): CardBlock {
  return cardBlock('link_cancelled', {
    fact_id: factId,
    title: moneyText(link.amount_cents),
    lines: [link.title, linkCancelledLine(language, owner)],
  });
}

const inboxPreview: Record<Language, string> = {
  en: 'New verification code',
  es: 'Nuevo código de verificación',
};

/**
 * Claude's checked words before the kernel's verify card, as the signed verify board writes them:
 * what was asked waits until the visitor confirms it's them. No digits, amounts or dates.
 */
const verifyFirstProse: Record<Language, RenderedBlock> = {
  en: proseBlock("I can send that after you confirm it's you."),
  es: proseBlock('Puedo enviarlo cuando confirmes que eres tú.'),
};

/**
 * The kernel's Demo inbox message for a verification code (`inbox_code_body`, kernel verification,
 * plan 01b), rendered from the Desk's business name (`DeskOwner.business`) and the code in the
 * chat's language. No sentence ends on the name, so none needs `afterName`.
 */
function codeBody(language: Language, code: string, business: string): string {
  return language === 'es'
    ? `Tu código de ${business} es ${code}. Vence en diez minutos. Si no lo pediste, ignora este mensaje.`
    : `Your ${business} code is ${code}. It expires in ten minutes. If you didn't ask for it, ignore this message.`;
}

// ---------------------------------------------------------------------------------------------
// Decisions the script asks the kernel for

/**
 * What held a request: `limit` when an auto card's limit failed (an amount, a discount, its hours
 * or its review), `ask` when an ask card asks about the tool itself.
 */
export type HoldKind = 'limit' | 'ask';

/** What a step asks the store to record: the store fills in ids, times, ledger entries and signatures. */
export interface DecisionSpec {
  tool: ToolName;
  effects: Effect[];
  outcome: Outcome;
  /** For an `allow`: the action ran, so the decision is `executed`. */
  executed: boolean;
  cardIds: string[];
  /**
   * The policies that decided it, as the kernel names them, when they aren't the cards' own (a
   * baseline refusal): Safety's cause is read from them, as the API reads it.
   */
  policyIds?: string[];
  reasonPlain: string;
  /** A refusal with the kernel's more specific visitor status line. */
  visitorStatus?: 'refused_over_mandate';
  /** For a `hold`: what held it, which decides the answers it offers (`answersFor`). */
  hold?: HoldKind;
  listCents?: number | null;
  discountBp?: number | null;
  amountCents?: number | null;
  resource?: NormalizedAction['resource'];
}

const heldFixture = rivera.decisions.held;
const refundFixture = rivera.heldRefund;

export const DECISIONS = {
  /**
   * The seeded hold: a visitor not on record wants the drain clearing at 15% off, past the quote
   * card's limit. Every held discount is built from it (`heldDiscount`).
   */
  heldQuote: {
    tool: 'native.quote',
    effects: heldFixture.action?.effects ?? ['change'],
    outcome: 'hold',
    executed: false,
    cardIds: heldFixture.card_ids,
    reasonPlain: heldFixture.reason_plain,
    hold: 'limit',
    listCents: 18000,
    discountBp: 1500,
    amountCents: 15300,
  },
  /** Verified Dana wants her $180.00 drain clearing payment back; the refund card asks about every refund. */
  heldRefund: {
    tool: refundFixture.action.tool as ToolName,
    effects: refundFixture.action.effects,
    outcome: 'hold',
    executed: false,
    cardIds: refundFixture.card_ids,
    reasonPlain: refundFixture.reason_plain,
    hold: 'ask',
    amountCents: refundFixture.action.amount_cents,
    resource: refundFixture.action.resource,
  },
  quote: {
    tool: 'native.quote',
    effects: ['change'],
    outcome: 'allow',
    executed: true,
    cardIds: ['rv-quote'],
    reasonPlain: 'A visitor asked for a drain clearing quote at list price, $180.00.',
    listCents: 18000,
    discountBp: 0,
    amountCents: 18000,
  },
  slots: {
    tool: 'native.find_slots',
    effects: ['read'],
    outcome: 'allow',
    executed: true,
    cardIds: [],
    reasonPlain: 'A visitor asked which times are open.',
  },
  book: {
    tool: 'native.book',
    effects: ['change'],
    outcome: 'allow',
    executed: true,
    cardIds: ['rv-book-wk'],
    reasonPlain: rivera.bookingReasonPlain,
    resource: { kind: 'slot', id: 'S-20261103-1400', owner_person_id: null },
  },
  paymentLink: {
    tool: 'native.payment_link',
    effects: ['charge'],
    outcome: 'allow',
    executed: true,
    cardIds: ['rv-link'],
    reasonPlain: 'A visitor asked for a link to pay the $20.00 service call deposit.',
    amountCents: 2000,
  },
  /** A demo code to the contact on record for the person the visitor says they are. */
  startVerification: {
    tool: 'native.start_verification',
    effects: ['send_message'],
    outcome: 'allow',
    executed: true,
    cardIds: [],
    reasonPlain: "A visitor said they're Dana Whitfield, so a code went to her contact on record.",
  },
  /** Verified Dana's invoice, released to her once she confirmed it's her. */
  releaseInvoice: {
    tool: 'native.release_document',
    effects: ['private_data', 'send_message'],
    outcome: 'allow',
    executed: true,
    cardIds: ['rv-docs'],
    reasonPlain: "Dana Whitfield confirmed it's her with a code, so she got her drain clearing invoice.",
    resource: { kind: 'document', id: 'doc-dana-invoice', owner_person_id: rivera.people.dana.personId },
  },
  callback: {
    tool: 'native.request_callback',
    effects: ['send_message'],
    outcome: 'allow',
    executed: true,
    cardIds: [],
    reasonPlain: 'A visitor asked you to call them back.',
  },
} as const satisfies Record<string, DecisionSpec>;

/** The discount a visitor gets held at when they ask for one without naming a percent: the fixtures' 15%. */
const DEFAULT_DISCOUNT_BP = DECISIONS.heldQuote.discountBp;

/**
 * A percentage the visitor wrote: "10% off", "20 %", "12.5 %", "10 por ciento", "10 percent". The
 * number stands on its own, not the tail of a longer one.
 */
const PERCENT = /(?<![\p{L}\p{N}.,])(\d+(?:[.,]\d+)?)\s*(?:%|por\s*ciento(?![\p{L}\p{N}])|percent(?![\p{L}\p{N}]))/iu;

/** The most a discount can take off: all of it. */
const WHOLE_PRICE_BP = 10_000;

/**
 * The discount the visitor asked for, in basis points: the first percentage in their words, as
 * they wrote it (0% and over 100% included, which `matchRule` sends elsewhere), and the fixtures'
 * 15% only when they wrote none. Untrusted text, read only for a number, as the kernel takes a
 * requested discount (master plan, "Discounts").
 */
export function askedDiscountBp(text: string): number {
  const match = PERCENT.exec(text);
  return match === null ? DEFAULT_DISCOUNT_BP : Math.round(Number((match[1] ?? '').replace(',', '.')) * 100);
}

/**
 * The held quote for a discount the visitor asked for: the percent they named (15% when none), the
 * drain clearing's price at it, and Mike's line, in the fixtures' words, naming the verified
 * person when the chat has one ("Dana Whitfield, verified with a code,"), else "A visitor not on
 * record". At 15% from a visitor not on record it is the fixtures' seeded hold.
 */
export function heldDiscount(text: string, person: { name: string } | null): DecisionSpec {
  const { listCents } = DECISIONS.heldQuote;
  const discountBp = askedDiscountBp(text);
  if (discountBp <= 0 || discountBp > WHOLE_PRICE_BP) throw new Error(`a held discount is above 0% and up to 100%, not ${discountBp} bp`);
  const amountCents = discountedCents(listCents, discountBp);
  const who = person === null ? 'A visitor not on record' : `${person.name}, verified with a code,`;
  return {
    ...DECISIONS.heldQuote,
    discountBp,
    amountCents,
    reasonPlain: `${who} asked for a drain clearing quote at ${percentText(discountBp, '.')}% off, ${moneyText(amountCents)} instead of ${moneyText(listCents)}.`,
  };
}

/**
 * The answers a hold offers, as the kernel works them out (master plan, "Decision lifecycle"):
 * always the two one-time answers; "Allow only for this person" when the visitor is a verified
 * person and, for a money request, its amount is within the rules' money cap; and "Deny always"
 * only when an ask card held it, never for a limit hold.
 */
export function answersFor(spec: DecisionSpec, verifiedPerson: boolean): ApprovalAnswer[] {
  if (spec.outcome !== 'hold') return [];
  const money = spec.effects.some((effect) => MONEY_EFFECTS.has(effect));
  const amount = spec.amountCents ?? null;
  const withinCap = !money || (amount !== null && amount <= RIVERA_MONEY_CAP_CENTS);
  return [
    'allow_once',
    'deny_once',
    ...(verifiedPerson && withinCap ? (['allow_person'] as const) : []),
    ...(spec.hold === 'ask' ? (['deny_always'] as const) : []),
  ];
}

// ---------------------------------------------------------------------------------------------
// Steps

/** What a step can do, bound by the store to one session and the turn's language. */
export interface TurnContext {
  readonly language: Language;
  /** The visitor's words that started the turn (empty for a follow-up). Untrusted. */
  readonly text: string;
  /** The verified person on record the chat is with, once the visitor confirmed it's them; else null. */
  readonly person: { personId: string; name: string } | null;
  /**
   * Whom the Desk's lines name, its handoff card's among them (`MockWorld.ownerOf`): read only when
   * a step names them, so making a context never reads the Desk.
   */
  readonly owner: DeskOwner;
  /** Records a decision with its ledger entries. */
  decide(spec: DecisionSpec): Decision;
  /** The signed status event for a decision as it now stands. */
  status(type: StatusEvent['type'], decision: Decision): StatusEvent;
  /**
   * A checked reply's shown blocks and ledger entry; `blocked` when Claude's draft failed the
   * check, and `paused` when the check stopped it because the chat is paused. Shown blocks may
   * keep checked cards after a prose failure, with or without a drafted handoff.
   */
  reply(blocks: RenderedBlock[], opts?: { blocked?: boolean; paused?: boolean }): EvMessage;
  /**
   * Sends a demo code to `person`'s contact on record, as the kernel's `/verify/start` does: the
   * challenge the code answers, a Demo inbox entry for this session with the code in its body, and
   * the notice the visitor sees, which carries no code.
   */
  startVerification(fields: { person: VerifyPerson; code: string; body: string; preview: string }): EvDemoInbox;
  /** An open callback request in Needs you; the visitor becomes a lead under `lead`. */
  openHandoff(fields: { reason: string; callbackWindow: string | null; lead: string }): void;
  /** A payment link for this session, `issued`, with a token of its own. */
  issueLink(fields: { title: string; amountCents: number }): void;
  /** The token of the newest payment link issued in this session. */
  latestLink(): string;
}

/**
 * One event of a turn, made when its time comes. A step is the turn's own (a decision, Claude
 * writing, a reply), so the owner taking over before its time fences it off and it never runs,
 * unless it is `unfenced` (served.ts `Server.tick`).
 */
export type Step = ((ctx: TurnContext) => SseEvent) & { readonly unfenced?: true };

/**
 * A step that runs whatever generation the session has moved to, as the API publishes it: a turn's
 * end, and the outcome of a hold the owner answered (approved holds aren't generation-fenced).
 */
function unfenced(step: (ctx: TurnContext) => SseEvent): Step {
  return Object.assign(step, { unfenced: true as const });
}

/** Claude is writing: the visitor sees the indicator until the next message or the turn's end. */
export const writing: Step = () => ({ type: 'writing' });

/** Ends every turn, a fenced one included: the visitor's "Claude is writing" clears even when nothing was shown. */
export const turnEnd: Step = unfenced(() => ({ type: 'turn_end' }));

export type RuleName = 'discount' | 'invoice' | 'deposit' | 'booked' | 'book' | 'price' | 'area' | 'callback' | 'talk' | 'outage' | 'cards-only' | 'cards-kept-handoff' | 'other';

export interface ScriptRule {
  name: RuleName;
  /** Lowercase words or phrases, any one of which, found whole, picks the rule. Empty for the last rule, which takes anything. */
  words: readonly string[];
  /** A demo command: one of `words` picks the rule only as the whole message, never inside a question. */
  command?: true;
  /** Whom a visitor asks for on the Desk (`askWords`) picks the rule too, found whole as `words` are. */
  askFor?: true;
  /** The tools its turn calls, besides replying: whether the session has them decides whether it runs (`scriptedTurn`). */
  tools: readonly ToolName[];
  steps: readonly Step[];
}

/**
 * The deposit link's own title, as the kernel's link holds it: what the link is for, without the
 * amount its card adds ("Service call deposit, $20.00").
 */
const DEPOSIT_TITLE: Record<Language, string> = {
  en: 'Service call deposit',
  es: 'Service call deposit',
};

/** The verification code the invoice rule sends to the Demo inbox. */
export const DEMO_CODE = '482913';

/**
 * The first payment link's token in the screen tests' copy, the one the fixtures' card points at.
 * Every later link, and every link on the dev server, gets a random token of its own (store.ts).
 */
export const PAYMENT_TOKEN = 'k7Hq2vX9';

/**
 * Who asks for a callback: Dana Whitfield, the person the copy has on record, with the phone number
 * she typed, one of the fictional 555-01xx numbers (not the business's own, and not her contact on
 * record, which only the kernel holds).
 */
const CALLBACK_LEAD = { name: rivera.people.dana.name, contact: '(510) 555-0118' } as const;

/** The callback request the script records, as the visitor typed it. */
export const CALLBACK_REASON = `${CALLBACK_LEAD.name} · ${CALLBACK_LEAD.contact} · Leaking water heater`;

/** The kernel's `handoff` template: its title, then its line. */
const HANDOFF: Record<Language, { title: string; line: string }> = {
  en: { title: 'Let me check with {owner}.', line: '{Owner} will reply here.' },
  es: { title: 'Déjame consultarlo con {owner}.', line: '{Owner} te responderá aquí.' },
};

/**
 * The kernel's handoff card in `language`, handing the visitor to the Desk's owner (`owner`). For
 * Mike Turner it is the fixtures' own card.
 */
export function handoffBlock(language: Language, owner: DeskOwner): CardBlock {
  const { title, line } = HANDOFF[language];
  return cardBlock('handoff', { fact_id: null, title: withOwner(title, language, owner), lines: [withOwner(line, language, owner)] });
}

/** The turn's handoff card: the Desk's own, in the turn's language. */
const handoff = (ctx: TurnContext): CardBlock => handoffBlock(ctx.language, ctx.owner);

/** Claude hands the visitor to the Desk's owner: the kernel's handoff card, as asking for them gets. */
const HANDOFF_STEPS: readonly Step[] = [writing, (ctx) => ctx.reply([handoff(ctx)])];

/**
 * A turn in a chat the breaker paused, as the API runs one: no model call and no "writing", only
 * the kernel's handoff, which its check stops as paused.
 */
export const PAUSED_TURN: readonly Step[] = [(ctx) => ctx.reply([handoff(ctx)], { paused: true })];

export const SCRIPT: readonly ScriptRule[] = [
  {
    // A final prose-only failure: the checked card stays, and none of the draft's prose is shown.
    name: 'cards-only',
    words: ['cards-only', 'solo-tarjetas'],
    command: true,
    tools: ['native.quote'],
    steps: [
      writing,
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.quote)),
      (ctx) => ctx.reply([blocks.quote[ctx.language]], { blocked: true }),
    ],
  },
  {
    // The same failure with Claude's drafted handoff kept after the checked card.
    name: 'cards-kept-handoff',
    words: ['cards-kept-handoff', 'tarjetas-con-traspaso'],
    command: true,
    tools: ['native.quote'],
    steps: [
      writing,
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.quote)),
      (ctx) => ctx.reply([blocks.quote[ctx.language], handoff(ctx)], { blocked: true }),
    ],
  },
  {
    name: 'discount',
    words: ['off', 'discount', 'descuento'],
    tools: ['native.quote'],
    steps: [
      writing,
      // The percent the visitor asked for, held past the quote card's limit for the owner.
      (ctx) => ctx.status('held', ctx.decide(heldDiscount(ctx.text, ctx.person))),
      // Claude's checked words say the owner decides; the held receipt under them says what waits.
      (ctx) => ctx.reply([proseBlock(heldProse(ctx.language, ctx.owner))]),
    ],
  },
  {
    name: 'invoice',
    words: ['invoice', 'return', 'factura'],
    tools: ['native.start_verification'],
    steps: [
      writing,
      // The code goes to the contact on record, never to the visitor: the kernel decides that first.
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.startVerification)),
      (ctx) => ctx.reply([verifyFirstProse[ctx.language], blocks.verify_prompt[ctx.language]]),
      (ctx) =>
        ctx.startVerification({
          person: rivera.people.dana,
          code: DEMO_CODE,
          body: codeBody(ctx.language, DEMO_CODE, ctx.owner.business),
          preview: inboxPreview[ctx.language],
        }),
    ],
  },
  {
    name: 'deposit',
    words: ['deposit', 'pay', 'pagar'],
    tools: ['native.payment_link'],
    steps: [
      writing,
      (ctx) => {
        const decision = ctx.decide(DECISIONS.paymentLink);
        // The checkout's title is the card's, as the kernel writes both from the one link.
        ctx.issueLink({ title: DEPOSIT_TITLE[ctx.language], amountCents: 2000 });
        return ctx.status('receipt', decision);
      },
      // The card points at the link this turn issued, by its own token.
      (ctx) => ctx.reply([{ ...blocks.payment_link[ctx.language], fact_id: `payment_link:${ctx.latestLink()}`, href: `/pay/${ctx.latestLink()}` }]),
    ],
  },
  {
    // Picks a time already offered, so it comes before "book", which lists them.
    name: 'booked',
    words: ['first one', 'la primera'],
    tools: ['native.book'],
    steps: [
      writing,
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.book)),
      (ctx) => ctx.reply([bookedProse[ctx.language], bookedCard(ctx.language, ctx.owner)]),
    ],
  },
  {
    name: 'book',
    words: ['book', 'tuesday', 'reservar', 'martes'],
    tools: ['native.find_slots'],
    steps: [
      writing,
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.slots)),
      (ctx) => ctx.reply([blocks.booking_options[ctx.language]]),
    ],
  },
  {
    name: 'price',
    words: ['price', 'cost', 'how much', 'cuánto', 'precio'],
    tools: ['native.quote'],
    steps: [
      writing,
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.quote)),
      (ctx) => ctx.reply([blocks.prose.quoteIntro[ctx.language], blocks.quote[ctx.language]]),
    ],
  },
  {
    name: 'area',
    words: ['alameda'],
    tools: [],
    steps: [writing, (ctx) => ctx.reply([rivera.blocks.policy[ctx.language]])],
  },
  {
    name: 'callback',
    words: ['call me', 'callback', 'llámame'],
    tools: ['native.request_callback'],
    steps: [
      writing,
      (ctx) => {
        const decision = ctx.decide(DECISIONS.callback);
        const tonight = ctx.text.toLowerCase().includes('tonight');
        ctx.openHandoff({ reason: CALLBACK_REASON, callbackWindow: tonight ? null : CALLBACK_WINDOW, lead: CALLBACK_LEAD.name });
        return ctx.status('receipt', decision);
      },
      (ctx) => {
        const tonight = ctx.text.toLowerCase().includes('tonight');
        return ctx.reply([callbackCard(tonight ? 'open' : 'window', ctx.language, ctx.owner)]);
      },
    ],
  },
  {
    name: 'talk',
    words: ['talk to', 'hablar'],
    askFor: true,
    tools: [],
    steps: HANDOFF_STEPS,
  },
  {
    name: 'outage',
    words: ['outage'],
    tools: [],
    steps: [writing, () => ({ type: 'error', code: 'kernel_unavailable' })],
  },
  {
    name: 'other',
    words: [],
    tools: [],
    steps: [writing, (ctx) => ctx.reply([helpProse(ctx.language, ctx.owner)])],
  },
];

/** Who a demo code is for: a person on record, with the masked contact the code goes to. */
export interface VerifyPerson {
  personId: string;
  name: string;
  maskedContact: string;
}

/** Claude's checked words with the invoice: no digits, amounts or dates. */
const invoiceProse: Record<Language, RenderedBlock> = {
  en: proseBlock("Thanks, Dana. Here's your invoice."),
  es: proseBlock('Gracias, Dana. Aquí tienes tu factura.'),
};

/**
 * Claude's turn once the visitor confirmed it's them, which the API wakes it for: the invoice they
 * asked for, released to them as its verified owner. No visitor message starts it, so it begins as
 * the API's turns do, with Claude writing.
 */
export const AFTER_VERIFY: readonly Step[] = [
  writing,
  (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.releaseInvoice)),
  (ctx) => ctx.reply([invoiceProse[ctx.language], blocks.document_link[ctx.language]]),
];

/** Claude's turn once the visitor confirmed it's them (`AFTER_VERIFY`), as the session may run it (`stepsWithTools`). */
export function afterVerify(allTools: boolean): readonly Step[] {
  return stepsWithTools([DECISIONS.releaseInvoice.tool], AFTER_VERIFY, allTools);
}

/**
 * The seeded hold's turn, as the design system's fixtures have it (`rivera.conversations.visitor`):
 * the 15% quote is held, and Claude's draft named the discount in its own words, so the reply was
 * stopped and the visitor got the handoff card. A fresh copy keeps that stopped reply, which
 * Safety shows; a discount asked in a live chat gets the discount row's reply.
 */
export const SEEDED_HOLD_STEPS: readonly Step[] = [
  (ctx) => ctx.status('held', ctx.decide(heldDiscount(ctx.text, ctx.person))),
  writing,
  (ctx) => ctx.reply([handoff(ctx)], { blocked: true }),
];

/**
 * Whether `lower` has `word` (or a phrase of words) as words of their own, with no letter or digit
 * either side: "off" is in "15% off", never in "offer".
 */
function hasWord(lower: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(lower);
}

/** The script's rule named `name`. */
function ruleNamed(name: RuleName): ScriptRule {
  const rule = SCRIPT.find((r) => r.name === name);
  if (!rule) throw new Error(`the script has no ${name} rule`);
  return rule;
}

/**
 * Whom a visitor asks for on a Desk whose owner is `owner`, as lowercase words: the owner's first
 * name, or a person, in either language, when they gave none.
 */
function askWords(owner: DeskOwner): string[] {
  return owner.name === null ? [A_PERSON.en, A_PERSON.es] : [firstName(owner.name).toLowerCase()];
}

/**
 * The first rule with one of its words, whole, in the lowercased text, else the last rule; on a
 * Desk whose owner is `owner` (Turner's unless given), asking for them is one of the talk rule's
 * words. A discount asked at 0% is a question about the list price (the price rule), and one over
 * 100% is no discount anyone can give (the last rule's plain answer).
 */
export function matchRule(text: string, owner: DeskOwner = RIVERA_OWNER): ScriptRule {
  const lower = text.toLowerCase();
  const wordsOf = (r: ScriptRule) => (r.askFor ? [...r.words, ...askWords(owner)] : r.words);
  const rule = SCRIPT.find((r) => r.command ? r.words.includes(lower.trim()) : wordsOf(r).some((word) => hasWord(lower, word))) ?? SCRIPT[SCRIPT.length - 1];
  if (!rule) throw new Error('the script has no rules');
  if (rule.name !== 'discount') return rule;
  const asked = askedDiscountBp(text);
  if (asked === 0) return ruleNamed('price');
  return asked > WHOLE_PRICE_BP ? ruleNamed('other') : rule;
}

/**
 * The tools a visitor's or agent's session keeps while its Desk's Answering switch is off, besides
 * replying (master plan, "Model-visible tools"): taking a lead and filing a callback. The owner's
 * preview keeps every tool.
 */
export const TOOLS_WHILE_NOT_ANSWERING: ReadonlySet<ToolName> = new Set<ToolName>(['native.capture_lead', 'native.request_callback']);

/**
 * A turn that calls `tools`, as the session may run it: as written when the session has every tool
 * (`allTools`: its Desk is answering, or it is the owner's preview) or needs only the ones it keeps
 * while the Desk isn't; otherwise Claude hands the visitor to Mike, as the "talk" rule does, and
 * nothing is decided.
 */
export function stepsWithTools(tools: readonly ToolName[], steps: readonly Step[], allTools: boolean): readonly Step[] {
  return allTools || tools.every((tool) => TOOLS_WHILE_NOT_ANSWERING.has(tool)) ? steps : HANDOFF_STEPS;
}

/** The turn the visitor's words start on a Desk whose owner is `owner`: their rule's steps, as the session may run them. */
export function scriptedTurn(text: string, allTools: boolean, owner: DeskOwner): readonly Step[] {
  const rule = matchRule(text, owner);
  return stepsWithTools(rule.tools, rule.steps, allTools);
}

// ---------------------------------------------------------------------------------------------
// After the owner answers a held request

/** The answers that run the held action. */
export function allows(answer: ApprovalAnswer): boolean {
  return answer === 'allow_once' || answer === 'allow_person';
}

/** The owner annotation never enters a queued visitor turn, even when it is null. */
export function visitorSafe(decision: Decision): Decision {
  const { owner_plain: _ownerPlain, ...visitor } = decision;
  return visitor;
}

/**
 * What the visitor's chat gets once the owner has answered: the signed approved receipt when
 * allowed, then the resolved outcome, then Claude's follow-up (the quote, refund or handoff).
 * The receipts report what the answer already did, so a take-over doesn't fence them; the follow-up
 * is Claude's, so it does.
 */
export function afterAnswer(answer: ApprovalAnswer, decision: Decision, approved: Decision | null): Step[] {
  decision = visitorSafe(decision);
  // As in the API's resume_after_answer, only an earlier approval for this decision can precede it.
  if (approved !== null && (approved.decision_id !== decision.decision_id
    || approved.state !== 'approved' || approved.ledger_seq >= decision.ledger_seq)) approved = null;
  if (approved !== null) approved = visitorSafe(approved);
  const resolved = unfenced((ctx) => ctx.status('resolved', decision));
  if (decision.state === 'refused_at_execution') return [resolved];
  if (!allows(answer)) return [resolved, writing, (ctx) => ctx.reply([handoff(ctx)])];
  const statuses = [...(approved === null ? [] : [unfenced((ctx) => ctx.status('receipt', approved))]), resolved];
  if (decision.action?.tool === 'payments.create_refund') {
    return [...statuses, writing, (ctx) => ctx.reply([blocks.prose.details[ctx.language], blocks.refund_issued[ctx.language]])];
  }
  // The quote at the discount Mike allowed, the one the visitor asked for.
  const listCents = decision.action?.list_cents ?? DECISIONS.heldQuote.listCents;
  const discountBp = decision.action?.discount_bp ?? DEFAULT_DISCOUNT_BP;
  const quote = { listCents, discountBp, amountCents: decision.action?.amount_cents ?? discountedCents(listCents, discountBp) };
  return [...statuses, writing, (ctx) => ctx.reply([blocks.prose.quoteIntro[ctx.language], discountedQuote(ctx.language, quote)])];
}

/**
 * The rule card an answer drafts, as the kernel's approvals do: "allow for this person" an auto
 * card for that person with the action's amount and discount as limits, "deny always" a never card
 * for the tool, scoped to the person when the session is verified. Other answers draft nothing.
 */
export function cardDiffFor(
  answer: ApprovalAnswer,
  decision: Decision,
  person: { personId: string; name: string } | null,
): RuleCard[] | null {
  const tool = decision.action?.tool;
  if (tool === undefined) return null;
  const base = { person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, is_default: false };
  if (answer === 'allow_person' && person) {
    return [
      {
        ...base,
        card_id: `person-${person.personId}-${tool}`,
        applies_to: tool,
        mode: 'auto',
        who: 'person',
        person_id: person.personId,
        max_amount_cents: decision.action?.amount_cents ?? null,
        max_discount_bp: decision.action?.discount_bp ?? 0,
        reason: `Allowed for ${person.name} after you approved a request like this.`,
      },
    ];
  }
  if (answer === 'deny_always') {
    const scope = person ? person.personId : 'anyone';
    return [
      {
        ...base,
        card_id: `never-${scope}-${tool}`,
        applies_to: tool,
        mode: 'never',
        who: person ? 'person' : 'anyone',
        person_id: person ? person.personId : null,
        reason: 'You said never for this.',
      },
    ];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The owner's rule chat: Ask Claude, beside the Rules page

/** What Claude answers the owner, and the cards it drafts, merged into the active rules by `card_id`. */
export interface RuleChatReply {
  answer: string;
  /** Empty when the owner asked a question rather than a change: nothing is drafted. */
  add: RuleCard[];
}

/** A card with every optional field at its default, as the kernel drafts one. */
function draftCard(fields: Pick<RuleCard, 'card_id' | 'applies_to' | 'mode' | 'who' | 'reason'> & Partial<RuleCard>): RuleCard {
  return { person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, is_default: false, ...fields };
}

/** Monday to Friday, all day. */
const WEEKDAYS_ALL_DAY = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '00:00:00', end: '00:00:00' } satisfies RuleCard['hours'];

/** Whether `card` applies on a Saturday or a Sunday: with no hours, it applies every day. */
function coversAWeekend(card: RuleCard): boolean {
  const hours = card.hours ?? null;
  return hours === null || hours.days.some((day) => day === 'sat' || day === 'sun');
}

/** A request held for the owner, as Claude on Rules reads it: its tool, the kernel's line on it, and the reason of the rule that held it. */
export interface HeldForChat {
  tool: string;
  reasonPlain: string;
  heldBy: string | null;
  /** It moves more money than the payment limit, which no rule goes past, so no rule could let it through. */
  aboveLimit: boolean;
}

/** Why a hold no rule of the owner's decided waits, in the kernel's words for the default ask (`DEFAULT_REASON`, `kernel_service/compiler.py`). */
const DEFAULT_ASK_REASON = 'Not covered by a rule yet, so it asks you.';

/**
 * What the owner calls each tool's requests, so Claude knows which hold a question names: the API's
 * words (`TOOL_LABELS` in `backend/desk/api/rules.py`), but "identity check" for a verification,
 * as the owner app and Rules' question about a hold name it.
 */
export const TOOL_LABELS: Readonly<Partial<Record<string, string>>> = {
  'native.quote': 'quote',
  'native.find_slots': 'open times',
  'native.book': 'booking',
  'native.release_document': 'document',
  'native.payment_link': 'payment link',
  'native.charge_mandate': 'agent payment',
  'native.capture_lead': 'contact details',
  'native.request_callback': 'callback',
  'native.start_verification': 'identity check',
  'payments.list_charges': 'payment history',
  'payments.create_refund': 'refund',
};

/**
 * How Turner's Claude answers the owner on Rules, in place of the API's model turn: the Rules
 * page's suggestions draft their change ("Stop quoting on weekends" moves the quote rules for
 * anyone to weekdays, so weekend quotes ask; "Quote water heater installs up to $600" adds a
 * quote rule up to that amount); "Why was this refund held?" is answered about the newest held
 * request of the tool it names, with the rule that held it, and an offer to draft one unless it is
 * above the payment limit; another question is answered with no draft, and anything else says what
 * Claude can draft. `active` is the Desk's active rules, and `held` its held requests, newest first.
 */
export function ruleChatReply(text: string, active: readonly RuleCard[], held: readonly HeldForChat[] = []): RuleChatReply {
  const lower = text.toLowerCase();
  if (lower.includes('weekend') && lower.includes('quot')) {
    const quotes = active.filter((card) => card.applies_to === 'native.quote' && card.who === 'anyone' && card.mode === 'auto' && card.is_default !== true);
    const quote = quotes[0];
    const weekdays = draftCard({
      card_id: 'card-weekday-quotes',
      applies_to: 'native.quote',
      mode: 'auto',
      who: 'anyone',
      ...quote,
      hours: WEEKDAYS_ALL_DAY,
      reason: 'Quotes from your price list on weekdays. Weekend quotes wait for your answer.',
    });
    // Every other one that still quotes on its own at weekends, such as a water heater rule added
    // since, moves to weekdays too, so the change isn't "No rules change" while one does.
    const others = quotes.slice(1).filter(coversAWeekend).map((card) => ({ ...card, hours: WEEKDAYS_ALL_DAY, reason: `${card.reason.replace(/\.$/, '')}, on weekdays.` }));
    return {
      answer: "Here's that change: quotes stay automatic on weekdays, and on weekends they wait for your answer. Nothing changes until you confirm it.",
      add: [weekdays, ...others],
    };
  }
  if (lower.includes('water heater')) {
    return {
      answer: "Here's a rule for that: I quote water heater installs on my own up to $600, and anything above that asks you first.",
      add: [
        draftCard({
          card_id: 'card-water-heater-quotes',
          applies_to: 'native.quote',
          mode: 'auto',
          who: 'anyone',
          max_amount_cents: 60_000,
          reason: 'Water heater installs quoted up to $600.',
        }),
      ],
    };
  }
  const asked = hasWord(lower, 'why') || hasWord(lower, 'held') ? held.find((h) => hasWord(lower, TOOL_LABELS[h.tool] ?? h.tool)) : undefined;
  if (asked !== undefined) {
    const why = asked.heldBy === null ? DEFAULT_ASK_REASON : `It was held by your rule: ${asked.heldBy}`;
    // Above the payment limit no rule lets it through, so drafting one is no answer.
    const offer = asked.aboveLimit ? '' : " If you'd like requests like this to go through on their own, ask me to draft that rule.";
    return { answer: `${asked.reasonPlain} ${why}${offer}`, add: [] };
  }
  if (lower.trim().endsWith('?')) {
    return {
      answer: 'I can explain what a rule does, or draft a change to one. Ask about a tool by name, such as quotes, bookings or refunds.',
      add: [],
    };
  }
  return {
    answer: 'I can draft one rule change at a time, such as "Stop quoting on weekends". Tell me which tool and what should happen, and I\'ll show you the change before anything applies.',
    add: [],
  };
}
