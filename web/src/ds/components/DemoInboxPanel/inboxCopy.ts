/**
 * The Demo inbox panel's own words, in the two languages a visitor reads. They are fixed at build
 * time; what an entry says is the kernel's, shown as it arrives.
 */
import type { InboxKind } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';

export interface InboxCopy {
  title: string;
  /** What the panel is, under its title. */
  subtitle: string;
  /** What the owner's panel is, under its title. */
  ownerSubtitle: string;
  /** Before the masked contact or `owner` an entry went to. */
  to: string;
  /** Each kind of entry, above its body. */
  kinds: Readonly<Record<InboxKind, string>>;
  /** While an entry's body is fetched. */
  opening: string;
  /** When fetching an entry's body failed. */
  openFailed: string;
  /** The button that fetches it again. */
  retry: string;
  /** When there is nothing to show. */
  empty: string;
  /** The sheet's button that closes it. */
  close: string;
  /** How many entries wait in the sheet, read with its button's name. */
  entries: (count: number) => string;
}

export const INBOX_COPY = {
  en: {
    title: 'Demo inbox',
    subtitle: 'Stands in for a phone or email inbox. Nothing is really sent.',
    ownerSubtitle: 'What Claude would have sent you by text or email. Nothing is really sent.',
    to: 'To',
    kinds: { verification_code: 'Verification code', alert: 'Alert', head_checkpoint: 'Ledger checkpoint' },
    opening: 'Opening',
    openFailed: 'Couldn’t open this entry.',
    retry: 'Try again',
    empty: 'Nothing here yet. Codes and alerts you’d get by text or email show up here.',
    close: 'Close',
    entries: (count) => (count === 1 ? '1 entry' : `${count} entries`),
  },
  es: {
    title: 'Bandeja de demostración',
    subtitle: 'Hace de bandeja de teléfono o correo. No se envía nada de verdad.',
    ownerSubtitle: 'Lo que Claude te habría enviado por mensaje o correo. No se envía nada de verdad.',
    to: 'Para',
    kinds: { verification_code: 'Código de verificación', alert: 'Aviso', head_checkpoint: 'Punto de control del registro' },
    opening: 'Abriendo',
    openFailed: 'No se pudo abrir esta entrada.',
    retry: 'Intentar de nuevo',
    empty: 'Aún no hay nada. Aquí aparecen los códigos y avisos que recibirías por mensaje o correo.',
    close: 'Cerrar',
    entries: (count) => (count === 1 ? '1 entrada' : `${count} entradas`),
  },
} as const satisfies Record<CopyLanguage, InboxCopy>;
