/**
 * The scripted Desk: how Rivera Plumbing's Claude answers in the mock API. A visitor's message
 * picks the first rule with one of its words, as a word of its own, in the lowercased text (so
 * "offer" never reads as "off"), and that rule's steps run
 * 150 ms apart, each turn ending with `turn_end`. Cards, prose and status lines are the design
 * system's Rivera fixtures and the kernel's visitor templates, in the turn's language. Nothing here
 * is a model; it stands in for the API's turn runner so screens can be built and tested.
 */
import type {
  ApprovalAnswer,
  CardBlock,
  ClauseTemplate,
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
 * with kernel plan 01c; until then it is named here by hand, and this build's reply card shows it
 * as a plain card with the kernel's words, as it shows any template it doesn't know.
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
  steps: readonly Step[];
}

/** The verification code the invoice rule sends to the Demo inbox. */
export const DEMO_CODE = '482913';

/**
 * The first payment link's token in the screen tests' copy, the one the fixtures' card points at.
 * Every later link, and every link on the dev server, gets a random token of its own (store.ts).
 */
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
      // Claude's checked words say Maria decides; the held receipt under them says what waits.
      (ctx) => ctx.reply([proseBlock(HELD_PROSE[ctx.language])]),
    ],
  },
  {
    name: 'invoice',
    words: ['invoice', 'return', 'factura'],
    steps: [
      writing,
      (ctx) => ctx.reply([blocks.verify_prompt[ctx.language]]),
      (ctx) =>
        ctx.startVerification({
          person: rivera.people.dana,
          code: DEMO_CODE,
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
        ctx.issueLink({ title: 'Service call deposit', amountCents: 2000 });
        return ctx.status('receipt', decision);
      },
      writing,
      // The card points at the link this turn issued, by its own token.
      (ctx) => ctx.reply([{ ...blocks.payment_link[ctx.language], href: `/pay/${ctx.latestLink()}` }]),
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
 * asked for, released to them as its verified owner.
 */
export const AFTER_VERIFY: readonly Step[] = [
  (ctx) => ctx.status('receipt', ctx.decide(DECISIONS.releaseInvoice)),
  writing,
  (ctx) => ctx.reply([invoiceProse[ctx.language], blocks.document_link[ctx.language]]),
];

/**
 * The seeded hold's turn, as the design system's fixtures have it (`rivera.conversations.visitor`):
 * the 15% quote is held, and Claude's draft named the discount in its own words, so the reply was
 * stopped and the visitor got the handoff card. A fresh copy keeps that stopped reply, which
 * Safety and the briefing show; a discount asked in a live chat gets the discount row's reply.
 */
export const SEEDED_HOLD_STEPS: readonly Step[] = [
  (ctx) => ctx.status('held', ctx.decide(DECISIONS.heldQuote)),
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

/** The first rule with one of its words, whole, in the lowercased text, else the last rule. */
export function matchRule(text: string): ScriptRule {
  const lower = text.toLowerCase();
  const rule = SCRIPT.find((r) => r.words.some((word) => hasWord(lower, word))) ?? SCRIPT[SCRIPT.length - 1];
  if (!rule) throw new Error('the script has no rules');
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
 * The receipt reports what the answer already did, so a take-over doesn't fence it; the follow-up
 * is Claude's, so it does.
 */
export function afterAnswer(answer: ApprovalAnswer, decision: Decision): Step[] {
  const resolved = unfenced((ctx) => ctx.status('resolved', decision));
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
