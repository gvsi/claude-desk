/**
 * A reply card's fixed words, per template and language: the label on its top line, the button on
 * a link card and the note on a card about money moving. They are build-time copy with no amounts,
 * dates or promises; everything else on a card is the kernel's rendered text.
 */
import type { ClauseTemplate } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';

export interface CardChrome {
  /** The card's top line, which says what kind of card it is. `{owner}` is the owner's display name. */
  label: string;
  /** The button on a link card, saying where it goes. */
  action?: string;
  /** A fixed line under the card's details. */
  note?: string;
}

/** The note on every card about money moving, and on the mock checkout. */
export const TEST_PAYMENT = {
  en: 'Test payment, no money moves',
  es: 'Pago de prueba, no se mueve dinero',
} as const;

/**
 * The templates whose card is about money moving: a link to pay, a paid link, an agent's charge and
 * a refund. Each one carries the test-payment note in both languages, and chrome.test.ts fails if
 * one doesn't, or if a card outside this list does. A new money card goes here.
 */
export const MONEY_TEMPLATES: readonly ClauseTemplate[] = ['payment_link', 'payment_confirmed', 'charge_confirmed', 'refund_issued'];

/** Every template has both languages, so a missing template or language is a compile error. */
export const CARD_CHROME: Readonly<Record<ClauseTemplate, Readonly<Record<CopyLanguage, Readonly<CardChrome>>>>> = {
  quote: { en: { label: 'Quote' }, es: { label: 'Presupuesto' } },
  booking_options: { en: { label: 'Open times' }, es: { label: 'Horarios libres' } },
  booking_confirmed: { en: { label: 'Booked' }, es: { label: 'Reservado' } },
  payment_link: {
    en: { label: 'Payment link', action: 'Open payment page', note: TEST_PAYMENT.en },
    es: { label: 'Enlace de pago', action: 'Abrir página de pago', note: TEST_PAYMENT.es },
  },
  document_link: {
    en: { label: 'Document, only for you', action: 'Download' },
    es: { label: 'Documento, solo para ti', action: 'Descargar' },
  },
  hours: { en: { label: 'Hours' }, es: { label: 'Horario' } },
  policy: { en: { label: 'Policy' }, es: { label: 'Política' } },
  contact: { en: { label: 'Contact' }, es: { label: 'Contacto' } },
  handoff: { en: { label: 'Handed to a person' }, es: { label: 'Pasado a una persona' } },
  verify_prompt: { en: { label: "Confirm it's you" }, es: { label: 'Confirma que eres tú' } },
  owner_said: { en: { label: '{owner} said' }, es: { label: '{owner} dijo' } },
  charges: { en: { label: 'Your charges' }, es: { label: 'Tus cargos' } },
  refund_issued: {
    en: { label: 'Refund issued', note: TEST_PAYMENT.en },
    es: { label: 'Reembolso emitido', note: TEST_PAYMENT.es },
  },
  charge_confirmed: {
    en: { label: 'Charge confirmed', note: TEST_PAYMENT.en },
    es: { label: 'Cargo confirmado', note: TEST_PAYMENT.es },
  },
  callback_confirmed: { en: { label: 'Callback set' }, es: { label: 'Llamada programada' } },
  payment_confirmed: {
    en: { label: 'Paid', note: TEST_PAYMENT.en },
    es: { label: 'Pagado', note: TEST_PAYMENT.es },
  },
};

/** The template's chrome in `language`, or null for a template this build doesn't know. */
export function cardChrome(template: string, language: CopyLanguage): Readonly<CardChrome> | null {
  if (!Object.hasOwn(CARD_CHROME, template)) return null;
  const chrome = CARD_CHROME[template as ClauseTemplate];
  return Object.hasOwn(chrome, language) ? chrome[language] : chrome.en;
}

/** A chrome line with the owner's display name in place of `{owner}`. */
export function withOwner(text: string, ownerName: string): string {
  return text.replaceAll('{owner}', ownerName);
}
