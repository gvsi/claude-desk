/**
 * Static error copy, fixed at build time: what a visitor reads when a turn ends with an `EvError`,
 * and what the owner reads when a request comes back with a `KernelError`. Every code has a line in
 * English and Spanish, no line shows a code, and a code this build doesn't know reads as
 * "something went wrong", never as nothing.
 */
import type { EvError, EvErrorCode, KernelErrorCode } from '../../../api/contracts.ts';

/** The two languages a visitor reads. */
export type CopyLanguage = 'en' | 'es';

/** One line of copy in both languages. */
export type CopyPair = Readonly<Record<CopyLanguage, string>>;

/** The kernel or the service behind it failed: the visitor's and the owner's fallback line. */
export const UNREACHABLE_COPY = {
  en: 'Something went wrong on our side. Try again in a moment.',
  es: 'Algo falló de nuestro lado. Inténtalo de nuevo en un momento.',
} as const satisfies CopyPair;

/** The visitor's chat session is gone; shown with `NEW_CHAT_LABEL`, which opens a new one. */
export const CHAT_ENDED_COPY = {
  en: 'This chat ended. Start a new one to keep going.',
  es: 'Este chat terminó. Empieza uno nuevo para seguir.',
} as const satisfies CopyPair;

/** The button beside `CHAT_ENDED_COPY`. */
export const NEW_CHAT_LABEL = {
  en: 'Start a new chat',
  es: 'Empezar un chat nuevo',
} as const satisfies CopyPair;

/** The visitor sent too many messages too fast. */
export const RATE_LIMITED_COPY = {
  en: "You're sending messages quickly. Wait a moment, then try again.",
  es: 'Estás enviando mensajes muy rápido. Espera un momento y vuelve a intentarlo.',
} as const satisfies CopyPair;

const EV_ERROR_COPY = {
  session: CHAT_ENDED_COPY,
  rate_limited: RATE_LIMITED_COPY,
  kernel_unavailable: UNREACHABLE_COPY,
  internal: UNREACHABLE_COPY,
} as const satisfies Record<EvErrorCode, CopyPair>;

const GONE = {
  en: "This isn't available anymore. Reload to see where things stand.",
  es: 'Esto ya no está disponible. Recarga para ver cómo está.',
} as const satisfies CopyPair;

const CHANGED = {
  en: 'This changed while you were looking. Reload to see where it stands.',
  es: 'Esto cambió mientras mirabas. Recarga para ver cómo está.',
} as const satisfies CopyPair;

/**
 * The owner's line after a conflict when the screen has already read the item again and shows it as
 * it stands now. It pairs with the reload line `errorCopy` gives for `conflict`, `stale_generation`,
 * `mode_owner` and `mode_paused`, which a screen that can't refresh in place shows instead.
 */
export const CHANGED_REFRESHED = {
  en: "This changed while you were looking. Here's where it stands now.",
  es: 'Esto cambió mientras mirabas. Así está ahora.',
} as const satisfies CopyPair;

const KERNEL_ERROR_COPY = {
  auth: {
    en: 'Your session ended. Open the demo again to keep going.',
    es: 'Tu sesión terminó. Abre la demo otra vez para seguir.',
  },
  not_found: GONE,
  closed: GONE,
  conflict: CHANGED,
  stale_generation: CHANGED,
  mode_owner: CHANGED,
  mode_paused: CHANGED,
  invalid: {
    en: "That didn't go through. Check it and try again.",
    es: 'No se pudo completar. Revísalo e inténtalo de nuevo.',
  },
  rate_limited: {
    en: "That's a lot of requests at once. Wait a moment, then try again.",
    es: 'Son muchas solicitudes a la vez. Espera un momento y vuelve a intentarlo.',
  },
  seed_unproved: {
    en: "Rules can't be checked right now. Try again in a moment.",
    es: 'Ahora no se pueden comprobar las reglas. Inténtalo de nuevo en un momento.',
  },
  internal: UNREACHABLE_COPY,
  // Only agent turns can be replayed; an owner should never see it, so it reads as unreachable.
  replayed: UNREACHABLE_COPY,
} as const satisfies Record<KernelErrorCode, CopyPair>;

/**
 * The pair for `code` in `table`, or `UNREACHABLE_COPY` for a code the table doesn't list (an
 * unlisted code at runtime, or a name such as "constructor" that only an object's prototype has).
 */
function pairFor(table: Readonly<Record<string, CopyPair>>, code: unknown): CopyPair {
  return typeof code === 'string' && Object.hasOwn(table, code) ? (table[code] ?? UNREACHABLE_COPY) : UNREACHABLE_COPY;
}

/** The line in `language`, falling back to English for a language this build doesn't have. */
function lineIn(pair: CopyPair, language: unknown): string {
  return language === 'es' ? pair.es : pair.en;
}

/**
 * What the visitor reads when a turn ends with `ev`: `session` ends the chat (pair it with
 * `NEW_CHAT_LABEL`), `rate_limited` asks them to slow down, and anything else, an unlisted code
 * included, is `UNREACHABLE_COPY`. A turn that ends silently has no copy; that is the SSE layer's.
 */
export function evErrorCopy(ev: Pick<EvError, 'code'>, language: CopyLanguage): string {
  return lineIn(pairFor(EV_ERROR_COPY, ev.code), language);
}

/**
 * What the owner reads when a request comes back with `KernelError.code`: one plain line per code,
 * never empty and never the code itself, so no owner request fails silently.
 */
export function errorCopy(code: KernelErrorCode, language: CopyLanguage = 'en'): string {
  return lineIn(pairFor(KERNEL_ERROR_COPY, code), language);
}
