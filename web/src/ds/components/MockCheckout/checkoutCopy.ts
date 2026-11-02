/**
 * The mock checkout's own words, in the two languages a visitor reads. They are fixed at build
 * time and carry no amount, date or promise: the amount is the page's string, put into "Pay" as
 * given, and the title is the link's own. The test card is fixed too, so its values are copy here,
 * never props: the page shows a card, it never asks for one. Only the name can be typed, when the
 * link carries none, and it stays on the page.
 */
import type { PaymentLinkState } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { TEST_PAYMENT } from '../ReplyCard/chrome.ts';

/** The states with no payment left to make: every state but `issued`. */
export type FinalPaymentState = Exclude<PaymentLinkState, 'issued'>;

export interface CheckoutCopy {
  /** The badge at the card's top right, in every state. */
  testMode: string;
  /** The card's last line, in every state: the same note every money card carries. */
  testPayment: string;
  /** Under the amount. */
  worksOnce: string;
  /** The test card's group label. */
  cardInformation: string;
  /** The names a screen reader gives each test card value. */
  cardNumber: string;
  expiry: string;
  securityCode: string;
  /** The name's label, over the customer's name or the field to type one in. */
  nameOnCard: string;
  /** With a lock, under the shown card: why the card needs nothing typed. */
  filledIn: string;
  /** Under the name to type, when the link carries none: any name will do, and it goes nowhere. */
  anyName: string;
  /** The primary button, with the page's amount string. */
  pay: (amount: string) => string;
  /** The secondary button. */
  cancel: string;
  /** After a request to pay or cancel failed. */
  error: string;
  /** Each final state's line, which says where to go next. */
  final: Readonly<Record<FinalPaymentState, string>>;
  /**
   * Lines with a way back to the chat in three parts: the words before the link, the link's
   * words and the words after it. A checkout cancelled for any reason but a rule change uses
   * the paid line's same `back` words.
   */
  returnLine: Readonly<Partial<Record<FinalPaymentState | 'rules_changed', PaidLine>>>;
  /** A cancelled link that a change to the business's rules cancelled. */
  cancelledRulesChanged: string;
}

/** A line with a way back to the chat inside it. */
export interface PaidLine {
  before: string;
  back: string;
  after: string;
}

/** The paid line's parts, by language: the line is these, joined, so the two never differ. */
const PAID = {
  en: { before: 'Paid. ', back: 'Go back to the chat', after: ' to see it there.' },
  es: { before: 'Pagado. ', back: 'Vuelve al chat', after: ' para verlo allí.' },
} as const satisfies Record<CopyLanguage, PaidLine>;

const CANCELLED = {
  en: 'This payment was cancelled. Nothing was charged.',
  es: 'Este pago se canceló. No se cobró nada.',
} as const;

const EXPIRED = {
  en: { before: 'This payment link expired. Ask in ', back: 'the chat', after: ' for a new one.' },
  es: { before: 'Este enlace de pago venció. Pide uno nuevo en ', back: 'el chat', after: '.' },
} as const satisfies Record<CopyLanguage, PaidLine>;

const RULES_CHANGED = {
  en: {
    before: 'This link was cancelled because the business changed its rules. Nothing was charged. Ask in ',
    back: 'the chat',
    after: ' if you still want to pay.',
  },
  es: {
    before: 'Este enlace se canceló porque el negocio cambió sus reglas. No se cobró nada. Pregunta en ',
    back: 'el chat',
    after: ' si todavía quieres pagar.',
  },
} as const satisfies Record<CopyLanguage, PaidLine>;

const joined = ({ before, back, after }: PaidLine) => `${before}${back}${after}`;

/** The test card every checkout shows, filled in and locked. */
export const TEST_CARD = {
  number: '4242 4242 4242 4242',
  expiry: '12 / 34',
  securityCode: '123',
} as const;

export const CHECKOUT_COPY = {
  en: {
    testMode: 'Test mode',
    testPayment: TEST_PAYMENT.en,
    worksOnce: 'This link works once.',
    cardInformation: 'Card information',
    cardNumber: 'Card number',
    expiry: 'Expiry date',
    securityCode: 'Security code',
    nameOnCard: 'Name on card',
    filledIn: 'Test card, filled in for you',
    anyName: 'Any name works. It stays on this page.',
    pay: (amount) => `Pay ${amount}`,
    cancel: 'Cancel payment',
    error: 'That didn’t go through. Reload this page to see where the payment stands.',
    final: {
      paid: joined(PAID.en),
      expired: joined(EXPIRED.en),
      cancelled: CANCELLED.en,
      unknown: 'This payment is still being confirmed. The chat will show the result.',
    },
    returnLine: {
      paid: PAID.en,
      expired: EXPIRED.en,
      cancelled: { before: `${CANCELLED.en} `, back: PAID.en.back, after: '.' },
      rules_changed: RULES_CHANGED.en,
    },
    cancelledRulesChanged: joined(RULES_CHANGED.en),
  },
  es: {
    testMode: 'Modo de prueba',
    testPayment: TEST_PAYMENT.es,
    worksOnce: 'Este enlace funciona una sola vez.',
    cardInformation: 'Datos de la tarjeta',
    cardNumber: 'Número de tarjeta',
    expiry: 'Fecha de vencimiento',
    securityCode: 'Código de seguridad',
    nameOnCard: 'Nombre en la tarjeta',
    filledIn: 'Tarjeta de prueba, ya rellenada',
    anyName: 'Cualquier nombre sirve. Se queda en esta página.',
    pay: (amount) => `Pagar ${amount}`,
    cancel: 'Cancelar pago',
    error: 'No se pudo completar. Recarga esta página para ver el estado del pago.',
    final: {
      paid: joined(PAID.es),
      expired: joined(EXPIRED.es),
      cancelled: CANCELLED.es,
      unknown: 'Este pago aún se está confirmando. El chat mostrará el resultado.',
    },
    returnLine: {
      paid: PAID.es,
      expired: EXPIRED.es,
      cancelled: { before: `${CANCELLED.es} `, back: PAID.es.back, after: '.' },
      rules_changed: RULES_CHANGED.es,
    },
    cancelledRulesChanged: joined(RULES_CHANGED.es),
  },
} as const satisfies Record<CopyLanguage, CheckoutCopy>;
