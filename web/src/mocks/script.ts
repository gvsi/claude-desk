/**
 * The scripted Desk: how Rivera Plumbing's Claude answers in the mock API. A visitor's message
 * picks the first rule with one of its words in the lowercased text, and that rule's steps run
 * 150 ms apart, each turn ending with `turn_end`. Cards, prose and status lines are the design
 * system's Rivera fixtures and the kernel's visitor templates, in the turn's language. Nothing here
 * is a model; it stands in for the API's turn runner so screens can be built and tested.
 */
import type {
  ApprovalAnswer,
  CardBlock,
  Decision,
  DecisionState,
  EvDemoInbox,
  EvMessage,
  Effect,
  NormalizedAction,
  Outcome,
  RenderedBlock,
  RuleCard,
  SseEvent,
  StatusEvent,
  ToolName,
} from '../api/contracts.ts';
import { RIVERA_MONEY_CAP_CENTS, cardBlock, proseBlock, rivera } from '../ds/fixtures/index.ts';

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
 * The kernel's visitor status lines for Maria Rivera's Desk, as the Rivera fixtures write them. An
 * executed action has no line here: it carries its tool's own line (`EXECUTED_LINES`).
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
  },
} as const satisfies Record<Language, Record<Exclude<DecisionState, 'executed'> | 'reply_checked' | 'reply_handed_off', string>>;

/**
 * The signed line an executed action shows a visitor, per tool: what ran and whose records it
 * used, never a bare "Done". `{owner}` is the owner's display name. These are the kernel's lines,
 * which the visitor's page shows verbatim.
 */
export const EXECUTED_LINES = {
  'native.quote': { en: "Quoted from {owner}'s price list", es: 'Cotizado con la lista de precios de {owner}' },
  'native.find_slots': { en: "Times read from {owner}'s calendar", es: 'Horarios tomados del calendario de {owner}' },
  'native.book': { en: "Booked on {owner}'s calendar", es: 'Reservado en el calendario de {owner}' },
  'native.capture_lead': { en: 'Details saved for {owner}', es: 'Datos guardados para {owner}' },
  'native.request_callback': { en: 'Callback request saved for {owner}', es: 'Solicitud de llamada guardada para {owner}' },
  'native.start_verification': { en: 'Verification started', es: 'Verificación iniciada' },
  'native.release_document': { en: "Document shared from {owner}'s records", es: 'Documento compartido desde los registros de {owner}' },
  'native.payment_link': { en: 'Payment link made for this quote', es: 'Enlace de pago creado para esta cotización' },
  // Only a visiting agent pays from a signed limit, so "your" is the agent.
  'native.charge_mandate': { en: 'Charged within the limit of your mandate', es: 'Cobrado dentro del límite de tu mandato' },
  'payments.list_charges': { en: "Charges read from {owner}'s payments", es: 'Cargos tomados de los pagos de {owner}' },
  'payments.create_refund': { en: 'Refunded to the original payment', es: 'Reembolsado al pago original' },
} as const satisfies Partial<Record<ToolName, Record<Language, string>>>;

const OWNER = rivera.business.ownerName;

/** The visitor's line for a decision in `state`: an executed one names what its tool did. */
export function statusLine(language: Language, state: DecisionState, tool: ToolName | null): string {
  if (state !== 'executed') return VISITOR_PLAIN[language][state];
  const lines: Partial<Record<ToolName, Record<Language, string>>> = EXECUTED_LINES;
  const line = tool === null ? undefined : lines[tool];
  if (line === undefined) throw new Error(`the mock has no executed line for ${tool ?? 'a decision with no tool'}`);
  return line[language].replaceAll('{owner}', OWNER);
}

const { blocks } = rivera;

/** The held quote after Maria allows it: 15% off the $180.00 list price. */
const discountedQuote: Record<Language, CardBlock> = {
  en: cardBlock('quote', {
    fact_id: 'quote:Q-1043',
    title: '$153.00',
    lines: ['Drain clearing', 'Includes 15% off $180.00', 'Good until Tuesday, November 3, 2:00 pm'],
  }),
  es: cardBlock('quote', {
    fact_id: 'quote:Q-1043',
    title: '$153.00',
    lines: ['Drain clearing', 'Incluye 15 % de descuento sobre $180.00', 'Válido hasta martes 3 de noviembre, 14:00'],
  }),
};

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
 * Booking the first time offered: Claude's checked words carry no price or date, and the kernel's
 * card says what was booked. The Spanish card is the design system fixture's.
 */
const bookedProse: Record<Language, RenderedBlock> = {
  en: proseBlock("Maria will text you when she's on her way."),
  es: proseBlock('Maria te enviará un mensaje cuando vaya de camino.'),
};

const bookedCard: Record<Language, CardBlock> = {
  en: cardBlock('booking_confirmed', {
    fact_id: 'booking:B-77',
    title: 'Tuesday, November 3',
    lines: ['Arriving 2:00 pm to 4:00 pm', 'With Maria Rivera'],
  }),
  es: blocks.booking_confirmed.es,
};

/** Claude's checked words when nothing more specific fits: no digits, amounts, dates or promises. */
const helpProse: Record<Language, RenderedBlock> = {
  en: proseBlock('I can help with prices, open times, bookings and invoices for Rivera Plumbing. What do you need?'),
  es: proseBlock('Puedo ayudarte con precios, horarios, reservas y facturas de Rivera Plumbing. ¿Qué necesitas?'),
};

const inboxPreview: Record<Language, string> = {
  en: 'New verification code',
  es: 'Nuevo código de verificación',
};

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
  /** The seeded hold: a visitor not on record wants the drain clearing at 15% off, past the quote card's limit. */
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
  callback: {
    tool: 'native.request_callback',
    effects: ['send_message'],
    outcome: 'allow',
    executed: true,
    cardIds: [],
    reasonPlain: 'A visitor asked you to call them back.',
  },
} as const satisfies Record<string, DecisionSpec>;

/** The effects that move money: a request with one is a money request. */
const MONEY_EFFECTS: ReadonlySet<Effect> = new Set<Effect>(['charge', 'pay_out']);

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
  /** Records a decision with its ledger entries. */
  decide(spec: DecisionSpec): Decision;
  /** The signed status event for a decision as it now stands. */
  status(type: StatusEvent['type'], decision: Decision): StatusEvent;
  /** A checked reply with its ledger entry; `blocked` when Claude's draft failed the check and the visitor gets the handoff. */
  reply(blocks: RenderedBlock[], opts?: { blocked?: boolean }): EvMessage;
  /** A Demo inbox entry for this session, and the notice the visitor sees (no code in it). */
  inbox(fields: { to: string; body: string; preview: string }): EvDemoInbox;
  /** An open callback request in Needs you; the visitor becomes a lead under `lead`. */
  openHandoff(fields: { reason: string; callbackWindow: string | null; lead: string }): void;
  /** A payment link for this session, `issued`. */
  issueLink(token: string, fields: { title: string; amountCents: number }): void;
}

/** One event of a turn, made when its time comes. */
export type Step = (ctx: TurnContext) => SseEvent;

/** Claude is writing: the visitor sees the indicator until the next message or the turn's end. */
export const writing: Step = () => ({ type: 'writing' });

/** Ends every turn: the visitor's "Claude is writing" clears even when nothing was shown. */
export const turnEnd: Step = () => ({ type: 'turn_end' });

export type RuleName = 'discount' | 'invoice' | 'deposit' | 'booked' | 'book' | 'price' | 'callback' | 'talk' | 'outage' | 'other';

export interface ScriptRule {
  name: RuleName;
  /** Lowercase words, any one of which picks the rule. Empty for the last rule, which takes anything. */
  words: readonly string[];
  steps: readonly Step[];
}

/** The verification code the invoice rule sends to the Demo inbox. */
export const DEMO_CODE = '482913';

/** The payment link the deposit rule issues, the one the fixtures' card points at. */
export const PAYMENT_TOKEN = 'k7Hq2vX9';

/** The callback request the script records, as the visitor typed it. */
export const CALLBACK_REASON = 'Dana Wells · (503) 555-0142 · Leaking water heater';

export const SCRIPT: readonly ScriptRule[] = [
  {
    name: 'discount',
    words: ['off', 'discount', 'descuento'],
    steps: [
      (ctx) => ctx.status('held', ctx.decide(DECISIONS.heldQuote)),
      writing,
      // Claude's draft named the discount in its own words, so the visitor gets the handoff card.
      (ctx) => ctx.reply([blocks.handoff[ctx.language]], { blocked: true }),
    ],
  },
  {
    name: 'invoice',
    words: ['invoice', 'return', 'factura'],
    steps: [
      writing,
      (ctx) => ctx.reply([blocks.verify_prompt[ctx.language]]),
      (ctx) =>
        ctx.inbox({
          to: rivera.people.dana.maskedContact,
          body: `Your Rivera Plumbing verification code is ${DEMO_CODE}.`,
          preview: inboxPreview[ctx.language],
        }),
    ],
  },
  {
    name: 'deposit',
    words: ['deposit', 'pay', 'pagar'],
    steps: [
      (ctx) => {
        const decision = ctx.decide(DECISIONS.paymentLink);
        ctx.issueLink(PAYMENT_TOKEN, { title: 'Service call deposit', amountCents: 2000 });
        return ctx.status('receipt', decision);
      },
      writing,
      (ctx) => ctx.reply([blocks.payment_link[ctx.language]]),
    ],
  },
  {
    // Picks a time already offered, so it comes before "book", which lists them.
    name: 'booked',
    words: ['first one', 'la primera'],
    steps: [
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.book)),
      writing,
      (ctx) => ctx.reply([bookedProse[ctx.language], bookedCard[ctx.language]]),
    ],
  },
  {
    name: 'book',
    words: ['book', 'tuesday', 'reservar'],
    steps: [
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.slots)),
      writing,
      (ctx) => ctx.reply([blocks.booking_options[ctx.language]]),
    ],
  },
  {
    name: 'price',
    words: ['price', 'cost', 'how much', 'cuánto', 'precio'],
    steps: [
      (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.quote)),
      writing,
      (ctx) => ctx.reply([blocks.prose.quoteIntro[ctx.language], blocks.quote[ctx.language]]),
    ],
  },
  {
    name: 'callback',
    words: ['call me', 'callback', 'llámame'],
    steps: [
      (ctx) => {
        const decision = ctx.decide(DECISIONS.callback);
        const tonight = ctx.text.toLowerCase().includes('tonight');
        ctx.openHandoff({ reason: CALLBACK_REASON, callbackWindow: tonight ? null : CALLBACK_WINDOW, lead: 'Dana Wells' });
        return ctx.status('receipt', decision);
      },
      writing,
      (ctx) => {
        const tonight = ctx.text.toLowerCase().includes('tonight');
        return ctx.reply([callbackCards[tonight ? 'open' : 'window'][ctx.language]]);
      },
    ],
  },
  {
    name: 'talk',
    words: ['maria', 'talk to', 'hablar'],
    steps: [writing, (ctx) => ctx.reply([blocks.handoff[ctx.language]])],
  },
  {
    name: 'outage',
    words: ['outage'],
    steps: [writing, () => ({ type: 'error', code: 'kernel_unavailable' })],
  },
  {
    name: 'other',
    words: [],
    steps: [writing, (ctx) => ctx.reply([helpProse[ctx.language]])],
  },
];

/** The first rule with one of its words in the lowercased text, else the last rule. */
export function matchRule(text: string): ScriptRule {
  const lower = text.toLowerCase();
  const rule = SCRIPT.find((r) => r.words.some((word) => lower.includes(word))) ?? SCRIPT[SCRIPT.length - 1];
  if (!rule) throw new Error('the script has no rules');
  return rule;
}

export function ruleNamed(name: RuleName): ScriptRule {
  const rule = SCRIPT.find((r) => r.name === name);
  if (!rule) throw new Error(`the script has no rule named ${name}`);
  return rule;
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
 */
export function afterAnswer(answer: ApprovalAnswer, decision: Decision): Step[] {
  const resolved: Step = (ctx) => ctx.status('resolved', decision);
  if (!allows(answer)) return [resolved, writing, (ctx) => ctx.reply([blocks.handoff[ctx.language]])];
  if (decision.action?.tool === 'payments.create_refund') {
    return [resolved, writing, (ctx) => ctx.reply([blocks.prose.details[ctx.language], blocks.refund_issued[ctx.language]])];
  }
  return [resolved, writing, (ctx) => ctx.reply([blocks.prose.quoteIntro[ctx.language], discountedQuote[ctx.language]])];
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
