import { describe, expect, it } from 'vitest';

import { EV_ERROR_CODES, KERNEL_ERROR_CODES, type EvError, type KernelErrorCode } from '../../../api/contracts';
import { rivera } from '../../fixtures';
import {
  CHAT_ENDED_COPY,
  NEW_CHAT_LABEL,
  RATE_LIMITED_COPY,
  UNREACHABLE_COPY,
  errorCopy,
  evErrorCopy,
  type CopyPair,
} from './errorCopy';

const LANGUAGES = ['en', 'es'] as const;

/** The owner lines, word for word, per `KernelError.code`. */
const CONFLICT: CopyPair = {
  en: 'This changed while you were looking. Reload to see where it stands.',
  es: 'Esto cambió mientras mirabas. Recarga para ver cómo está.',
};
const GONE: CopyPair = {
  en: "This isn't available anymore. Reload to see where things stand.",
  es: 'Esto ya no está disponible. Recarga para ver cómo está.',
};
const OWNER_COPY: Record<KernelErrorCode, CopyPair> = {
  auth: {
    en: 'Your session ended. Open the demo again to keep going.',
    es: 'Tu sesión terminó. Abre la demo otra vez para seguir.',
  },
  not_found: GONE,
  closed: GONE,
  conflict: CONFLICT,
  stale_generation: CONFLICT,
  mode_owner: CONFLICT,
  mode_paused: CONFLICT,
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
  internal: {
    en: 'Something went wrong on our side. Try again in a moment.',
    es: 'Algo falló de nuestro lado. Inténtalo de nuevo en un momento.',
  },
  replayed: {
    en: 'Something went wrong on our side. Try again in a moment.',
    es: 'Algo falló de nuestro lado. Inténtalo de nuevo en un momento.',
  },
};

/** A code the schema doesn't list, as an older or newer server might send. */
const UNLISTED = 'brand_new_code';

function errorEvent(code: string): EvError {
  const event = rivera.events.errors.find((e) => e.type === 'error' && e.code === code);
  if (event === undefined || event.type !== 'error') throw new Error(`no fixture EvError for ${code}`);
  return event;
}

/**
 * "session" is also a plain English word, and the owner's auth line uses it: "Your session ended."
 * That exact sentence is the one place a code's spelling may appear; everywhere else it counts as
 * showing the code.
 */
const PLAIN_PHRASES = ['Your session ended.'];

/** The error codes a string shows, ignoring case. */
function shownCodes(text: string): string[] {
  const scanned = PLAIN_PHRASES.reduce((rest, phrase) => rest.replaceAll(phrase, ''), text).toLowerCase();
  return [...new Set([...KERNEL_ERROR_CODES, ...EV_ERROR_CODES])].filter((code) => scanned.includes(code));
}

describe('static error copy', () => {
  it('every_kernel_error_code_has_owner_copy', () => {
    for (const code of KERNEL_ERROR_CODES) {
      for (const language of LANGUAGES) {
        const line = errorCopy(code, language);
        expect(line.trim(), `${code} in ${language}`).not.toBe('');
        expect(line, `${code} in ${language}`).toBe(OWNER_COPY[code][language]);
      }
    }
    // English unless the screen asks for Spanish.
    expect(errorCopy('invalid')).toBe(OWNER_COPY.invalid.en);
    // The take-over and pause codes read as the conflict line; internal reads as unreachable.
    for (const code of ['stale_generation', 'mode_owner', 'mode_paused'] as const) {
      expect(errorCopy(code)).toBe(errorCopy('conflict'));
      expect(errorCopy(code, 'es')).toBe(errorCopy('conflict', 'es'));
    }
    expect(errorCopy('internal')).toBe(UNREACHABLE_COPY.en);
    expect(errorCopy('internal', 'es')).toBe(UNREACHABLE_COPY.es);
    // A code this build doesn't know still gets a line, never an empty one.
    expect(errorCopy(UNLISTED as KernelErrorCode)).toBe(UNREACHABLE_COPY.en);
    expect(errorCopy(UNLISTED as KernelErrorCode, 'es')).toBe(UNREACHABLE_COPY.es);
  });

  it('ev_error_copy', () => {
    expect(rivera.events.errors.map((e) => (e.type === 'error' ? e.code : e.type)).sort()).toEqual([...EV_ERROR_CODES].sort());
    for (const language of LANGUAGES) {
      expect(evErrorCopy(errorEvent('session'), language)).toBe(CHAT_ENDED_COPY[language]);
      expect(evErrorCopy(errorEvent('rate_limited'), language)).toBe(RATE_LIMITED_COPY[language]);
      expect(evErrorCopy(errorEvent('kernel_unavailable'), language)).toBe(UNREACHABLE_COPY[language]);
      expect(evErrorCopy(errorEvent('internal'), language)).toBe(UNREACHABLE_COPY[language]);
      const unlisted = { type: 'error', code: UNLISTED } as unknown as EvError;
      expect(evErrorCopy(unlisted, language)).toBe(UNREACHABLE_COPY[language]);
    }
    // The copy itself, word for word.
    expect(UNREACHABLE_COPY).toEqual(OWNER_COPY.internal);
    expect(CHAT_ENDED_COPY).toEqual({
      en: 'This chat ended. Start a new one to keep going.',
      es: 'Este chat terminó. Empieza uno nuevo para seguir.',
    });
    expect(NEW_CHAT_LABEL).toEqual({ en: 'Start a new chat', es: 'Empezar un chat nuevo' });
    expect(RATE_LIMITED_COPY).toEqual({
      en: "You're sending messages quickly. Wait a moment, then try again.",
      es: 'Estás enviando mensajes muy rápido. Espera un momento y vuelve a intentarlo.',
    });
  });

  it('error_copy_never_shows_a_code', () => {
    // The matcher finds a code however it is written, so the check below can't pass by matching nothing.
    expect(shownCodes('Error: kernel_unavailable')).toEqual(['kernel_unavailable']);
    expect(shownCodes('Rate_Limited (429)')).toEqual(['rate_limited']);
    expect(shownCodes('Your session expired.')).toEqual(['session']);
    expect(shownCodes('Your session ended. Open the demo again to keep going.')).toEqual([]);

    const lines = [
      ...KERNEL_ERROR_CODES.flatMap((code) => LANGUAGES.map((language) => errorCopy(code, language))),
      ...EV_ERROR_CODES.flatMap((code) => LANGUAGES.map((language) => evErrorCopy(errorEvent(code), language))),
      ...[UNREACHABLE_COPY, CHAT_ENDED_COPY, NEW_CHAT_LABEL, RATE_LIMITED_COPY].flatMap((pair) => [pair.en, pair.es]),
    ];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => shownCodes(line).length > 0)).toEqual([]);
  });
});
