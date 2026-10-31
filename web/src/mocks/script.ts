/**
 * The scripted Desk: how Rivera Plumbing's Claude answers in the mock API. A visitor's message
 * picks the first rule with one of its words, as a word of its own, in the lowercased text (so
 * "offer" never reads as "off"), and that rule's steps run
 * 150 ms apart. Each turn starts as the API's turns do, with Claude writing before anything it
 * does, and ends with `turn_end`; a session's turns run one at a time, as under the API's turn
 * lock (served.ts `Server.runTurn`). Cards, prose and status lines are the design
 * system's Rivera fixtures and the kernel's visitor templates, in the turn's language. Nothing here
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
  type RenderedBlock,
  type RuleCard,
  type SseEvent,
  type StatusEvent,
  type ToolName,
} from '../api/contracts.ts';
import { RIVERA_MONEY_CAP_CENTS, cardBlock, proseBlock, rivera } from '../ds/fixtures/index.ts';
import { executedLine, type ExecutedTool } from '../ds/fixtures/receipts.ts';

export type Language = 'en' | 'es';

/** How far apart a turn's events arrive. */
export const EVENT_GAP_MS = 150;

const SPANISH_MARKERS = ['¿', 'cuánto', 'descuento', 'reservar', 'hablar', 'factura', 'pagar', 'llámame', 'hola'] as const;

/** A turn is in Spanish when the visitor's text has one of the markers, else in English. */
export function turnLanguage(text: string): Language {
  const lower = text.toLowerCase();
  return SPANISH_MARKERS.some((marker) => lower.includes(marker)) ? 'es' : 'en';
}

// ---------------------------------------------------------------------------------------------
// Visitor-facing text: the kernel's templates and the fixture cards, by language

/**
 * The kernel's visitor status lines for Maria Rivera's Desk, as the Rivera fixtures write them (a
 * store test holds each one to the fixtures). An executed action has no line here: it carries its
 * tool's own line, the design system's `executedLine`.
 */
export const VISITOR_PLAIN = {
  en: {
    allowed: "Checked against Maria Rivera's rules",
    held: 'Waiting for Maria Rivera to approve',
    refused: 'Not something I can do here',
    approved: 'Maria Rivera approved this',
    denied: 'Maria Rivera decided not to go ahead',
    expired: 'This request timed out',
    cancelled: 'Cancelled',
    failed: "That didn't go through",
    unknown: 'Still confirming this',
    refused_at_execution: "The rules changed, so this didn't go ahead",
    reply_checked: "Reply checked against Maria Rivera's rules",
    reply_handed_off: 'Passed to Maria Rivera to answer',
    owner_said: 'Written by Maria Rivera',
  },
  es: {
    allowed: 'Revisado con las reglas de Maria Rivera',
    held: 'Esperando la aprobación de Maria Rivera',
    refused: 'No es algo que pueda hacer aquí',
    approved: 'Maria Rivera lo aprobó',
    denied: 'Maria Rivera decidió no seguir adelante',
    expired: 'Esta solicitud venció',
    cancelled: 'Cancelado',
    failed: 'No se pudo completar',
    unknown: 'Todavía lo estamos confirmando',
    refused_at_execution: 'Las reglas cambiaron, así que no se hizo',
    reply_checked: 'Respuesta revisada con las reglas de Maria Rivera',
    reply_handed_off: 'Pasado a Maria Rivera para responder',
    owner_said: 'Escrito por Maria Rivera',
  },
} as const satisfies Record<
  Language,
  Record<Exclude<DecisionState, 'executed'> | 'reply_checked' | 'reply_handed_off' | 'owner_said', string>
>;

/**
 * Tools that only read for Claude and so have no executed line of their own. Every other tool has
 * one in the design system's fixtures: the record is exhaustive, so a new tool without a line
 * fails the typecheck here.
 */
const NO_EXECUTED_LINE = {
  'native.fetch_website': true,
  'native.read_memory': true,
} as const satisfies Record<Exclude<ToolName, ExecutedTool>, true>;

function hasExecutedLine(tool: ToolName): tool is ExecutedTool {
  return !Object.hasOwn(NO_EXECUTED_LINE, tool);
}

const OWNER = rivera.business.ownerName;

/**
 * The visitor's line for a decision in `state`: an executed one names what its tool did, in the
 * signed per-tool words the design system's fixtures carry, never a bare "Done".
 */
export function statusLine(language: Language, state: DecisionState, tool: ToolName | null): string {
  if (state !== 'executed') return VISITOR_PLAIN[language][state];
  if (tool === null || !hasExecutedLine(tool)) throw new Error(`the mock has no executed line for ${tool ?? 'a decision with no tool'}`);
  return executedLine(tool, language, OWNER);
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
 * The quote card for a drain clearing at a discount Maria allowed, as the kernel renders its quote
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

/** The callback card's title, rendered from the handoff fact as Plan 01b does. */
const callbackCards: Record<'window' | 'open', Record<Language, CardBlock>> = {
  window: {
    en: cardBlock('callback_confirmed', {
      fact_id: 'handoff:callback',
      title: 'Maria Rivera will call you back on Monday, between 8:00 am and 9:00 am',
    }),
    es: cardBlock('callback_confirmed', {
      fact_id: 'handoff:callback',
      title: 'Maria Rivera te llamará el lunes, entre las 8:00 y las 9:00',
    }),
  },
  open: {
    en: cardBlock('callback_confirmed', { fact_id: 'handoff:callback', title: 'Maria Rivera will call you back' }),
    es: cardBlock('callback_confirmed', { fact_id: 'handoff:callback', title: 'Maria Rivera te llamará' }),
  },
};

/**
 * Booking the first time offered: Claude's checked words carry no price or date and promise
 * nothing the card doesn't back, and the kernel's card says what was booked. The Spanish card is
 * the design system fixture's.
 */
const bookedProse: Record<Language, RenderedBlock> = {
  en: proseBlock("You're all set. Here's your visit."),
  es: proseBlock('Ya está todo listo. Aquí tienes tu visita.'),
};

const bookedCard: Record<Language, CardBlock> = {
  en: cardBlock('booking_confirmed', {
    fact_id: 'booking:B-77',
    title: 'Tuesday, November 3',
    lines: ['Arriving 2:00 pm to 4:00 pm', 'With Maria Rivera'],
  }),
  es: blocks.booking_confirmed.es,
};

/**
 * Claude's checked words when nothing more specific fits, as the signed board answers a question
 * only Maria can: no digits, amounts, dates or promises, and the way to reach her.
 */
const helpProse: Record<Language, RenderedBlock> = {
  en: proseBlock('Maria can tell you once she sees it. You can ask for her here anytime.'),
  es: proseBlock('Maria te lo puede decir cuando lo vea. Puedes pedir hablar con ella aquí cuando quieras.'),
};

/**
 * Claude's checked words after a request is held for Maria, as the signed board writes them: she
 * decides, and her answer comes back into this chat. No amount, discount or date, and no promise
 * of what she'll say.
 */
export const HELD_PROSE: Record<Language, string> = {
  en: "That's for Maria to decide, so I've asked her. Her answer will show up here.",
  es: 'Eso lo decide Maria, así que ya le pregunté. Su respuesta aparecerá aquí.',
};

/**
 * The kernel's `link_cancelled` line, rendered from the owner's name (master plan, "Payment links";
 * kernel plan 01c), which only the kernel issues.
 */
export const LINK_CANCELLED: Record<Language, string> = {
  en: `This payment link was cancelled because ${OWNER}'s rules changed. Ask again if you still want to pay.`,
  es: `Este enlace de pago se canceló porque cambiaron las reglas de ${OWNER}. Pide uno nuevo si todavía quieres pagar.`,
};

/**
 * The `link_cancelled` card as the kernel renders it. The template joins the generated contracts
 * with kernel plan 01c; until then it is named here by hand, and the public chat shows it as the
 * design system's `LinkCancelledCard`, from its `title`.
 */
export function linkCancelledBlock(language: Language): RenderedBlock {
  const text = LINK_CANCELLED[language];
  const template = 'link_cancelled' as unknown as ClauseTemplate;
  return { kind: 'card', template, text, fact_id: null, title: text, lines: [], href: null, options: [] };
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
 * plan 01b), rendered from the business's name and the code in the chat's language.
 */
function codeBody(language: Language, code: string): string {
  const business = rivera.business.name;
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
  reasonPlain: string;
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
    tool: refundFixture.action.tool,
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
    reasonPlain: 'A visitor booked Tuesday, November 3 at 2:00 pm, inside your weekday hours.',
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
 * drain clearing's price at it, and Maria's line, in the fixtures' words, naming the verified
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
  /** Records a decision with its ledger entries. */
  decide(spec: DecisionSpec): Decision;
  /** The signed status event for a decision as it now stands. */
  status(type: StatusEvent['type'], decision: Decision): StatusEvent;
  /** A checked reply with its ledger entry; `blocked` when Claude's draft failed the check and the visitor gets the handoff. */
  reply(blocks: RenderedBlock[], opts?: { blocked?: boolean }): EvMessage;
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

export type RuleName = 'discount' | 'invoice' | 'deposit' | 'booked' | 'book' | 'price' | 'callback' | 'talk' | 'outage' | 'other';

export interface ScriptRule {
  name: RuleName;
  /** Lowercase words or phrases, any one of which, found whole, picks the rule. Empty for the last rule, which takes anything. */
  words: readonly string[];
  /** The tools its turn calls, besides replying: whether the session has them decides whether it runs (`scriptedTurn`). */
  tools: readonly ToolName[];
  steps: readonly Step[];
}

/** The deposit link's title, as its card shows it: "Service call deposit, $20.00". */
const DEPOSIT_TITLE: Record<Language, string> = {
  en: blocks.payment_link.en.title ?? '',
  es: blocks.payment_link.es.title ?? '',
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

/** Claude hands the visitor to Maria: the kernel's handoff card, as asking for her gets. */
const HANDOFF_STEPS: readonly Step[] = [writing, (ctx) => ctx.reply([blocks.handoff[ctx.language]])];

export const SCRIPT: readonly ScriptRule[] = [
  {
    name: 'discount',
    words: ['off', 'discount', 'descuento'],
    tools: ['native.quote'],
    steps: [
      writing,
      // The percent the visitor asked for, held past the quote card's limit for Maria.
      (ctx) => ctx.status('held', ctx.decide(heldDiscount(ctx.text, ctx.person))),
      // Claude's checked words say Maria decides; the held receipt under them says what waits.
      (ctx) => ctx.reply([proseBlock(HELD_PROSE[ctx.language])]),
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
          body: codeBody(ctx.language, DEMO_CODE),
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
      (ctx) => ctx.reply([{ ...blocks.payment_link[ctx.language], href: `/pay/${ctx.latestLink()}` }]),
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
      (ctx) => ctx.reply([bookedProse[ctx.language], bookedCard[ctx.language]]),
    ],
  },
  {
    name: 'book',
    words: ['book', 'tuesday', 'reservar'],
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
        return ctx.reply([callbackCards[tonight ? 'open' : 'window'][ctx.language]]);
      },
    ],
  },
  {
    name: 'talk',
    words: ['maria', 'talk to', 'hablar'],
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
    steps: [writing, (ctx) => ctx.reply([helpProse[ctx.language]])],
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
 * Safety and the briefing show; a discount asked in a live chat gets the discount row's reply.
 */
export const SEEDED_HOLD_STEPS: readonly Step[] = [
  (ctx) => ctx.status('held', ctx.decide(heldDiscount(ctx.text, ctx.person))),
  writing,
  (ctx) => ctx.reply([blocks.handoff[ctx.language]], { blocked: true }),
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
 * The first rule with one of its words, whole, in the lowercased text, else the last rule. A
 * discount asked at 0% is a question about the list price (the price rule), and one over 100% is
 * no discount anyone can give (the last rule's plain answer).
 */
export function matchRule(text: string): ScriptRule {
  const lower = text.toLowerCase();
  const rule = SCRIPT.find((r) => r.words.some((word) => hasWord(lower, word))) ?? SCRIPT[SCRIPT.length - 1];
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
 * while the Desk isn't; otherwise Claude hands the visitor to Maria, as the "talk" rule does, and
 * nothing is decided.
 */
export function stepsWithTools(tools: readonly ToolName[], steps: readonly Step[], allTools: boolean): readonly Step[] {
  return allTools || tools.every((tool) => TOOLS_WHILE_NOT_ANSWERING.has(tool)) ? steps : HANDOFF_STEPS;
}

/** The turn the visitor's words start: their rule's steps, as the session may run them. */
export function scriptedTurn(text: string, allTools: boolean): readonly Step[] {
  const rule = matchRule(text);
  return stepsWithTools(rule.tools, rule.steps, allTools);
}

// ---------------------------------------------------------------------------------------------
// After the owner answers a held request

/** The answers that run the held action. */
export function allows(answer: ApprovalAnswer): boolean {
  return answer === 'allow_once' || answer === 'allow_person';
}

/**
 * What the visitor's chat gets once the owner has answered: the resolved receipt, then Claude's
 * follow-up, which reports what ran (the discounted quote, or the refund) or hands off to Maria.
 * The receipt reports what the answer already did, so a take-over doesn't fence it; the follow-up
 * is Claude's, so it does.
 */
export function afterAnswer(answer: ApprovalAnswer, decision: Decision): Step[] {
  const resolved = unfenced((ctx) => ctx.status('resolved', decision));
  if (!allows(answer)) return [resolved, writing, (ctx) => ctx.reply([blocks.handoff[ctx.language]])];
  if (decision.action?.tool === 'payments.create_refund') {
    return [resolved, writing, (ctx) => ctx.reply([blocks.prose.details[ctx.language], blocks.refund_issued[ctx.language]])];
  }
  // The quote at the discount Maria allowed, the one the visitor asked for.
  const listCents = decision.action?.list_cents ?? DECISIONS.heldQuote.listCents;
  const discountBp = decision.action?.discount_bp ?? DEFAULT_DISCOUNT_BP;
  const quote = { listCents, discountBp, amountCents: decision.action?.amount_cents ?? discountedCents(listCents, discountBp) };
  return [resolved, writing, (ctx) => ctx.reply([blocks.prose.quoteIntro[ctx.language], discountedQuote(ctx.language, quote)])];
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

/**
 * How Rivera's Claude answers the owner on Rules, in place of the API's model turn: the Rules
 * page's suggestions draft their change ("Stop quoting on weekends" moves the quote rule for
 * anyone to weekdays, so weekend quotes ask; "Quote water heater installs up to $600" adds a
 * quote rule up to that amount), a question is answered with no draft, and anything else says
 * what Claude can draft. `active` is the Desk's active rules.
 */
export function ruleChatReply(text: string, active: readonly RuleCard[]): RuleChatReply {
  const lower = text.toLowerCase();
  if (lower.includes('weekend') && lower.includes('quot')) {
    const quote = active.find((card) => card.applies_to === 'native.quote' && card.who === 'anyone' && card.mode === 'auto' && card.is_default !== true);
    const weekdays = draftCard({
      card_id: 'card-weekday-quotes',
      applies_to: 'native.quote',
      mode: 'auto',
      who: 'anyone',
      ...quote,
      hours: WEEKDAYS_ALL_DAY,
      reason: 'Quotes from your price list on weekdays. Weekend quotes wait for your answer.',
    });
    return {
      answer: "Here's that change: quotes stay automatic on weekdays, and on weekends they wait for your answer. Nothing changes until you confirm it.",
      add: [weekdays],
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
  if (lower.includes('refund') && (lower.includes('why') || lower.includes('held'))) {
    return {
      answer:
        "Dana's refund waited for you because refunds ask you first: your rule says refunds to a customer wait for your answer. If you'd like small refunds to go through on their own, ask me to draft that rule.",
      add: [],
    };
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
