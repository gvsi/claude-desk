// The line an executed receipt shows a visitor, per tool, in both languages: what ran and whose
// records it used, rather than a bare "Done". `{owner}` is the owner's display name.

import type { Bilingual } from './index';

const EXECUTED_LINES = {
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
} as const satisfies Record<string, Bilingual<string>>;

/** A tool whose executed receipt has its own line. */
export type ExecutedTool = keyof typeof EXECUTED_LINES;

/** The executed receipt's line for `tool` in `language`, with the owner's display name in it. */
export function executedLine(tool: ExecutedTool, language: 'en' | 'es', owner: string): string {
  return EXECUTED_LINES[tool][language].replaceAll('{owner}', owner);
}
