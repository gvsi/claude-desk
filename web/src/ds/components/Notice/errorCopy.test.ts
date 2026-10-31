import { describe, expect, it } from 'vitest';

import { EV_ERROR_CODES, KERNEL_ERROR_CODES, type EvError, type KernelErrorCode } from '../../../api/contracts';
import { rivera } from '../../fixtures';
import * as ds from '../../index.ts';
import { assertCleanCopy } from '../../test/copy.ts';
import {
  AGENT_START_LOST_COPY,
  AGENT_START_RETRY_COPY,
  CHANGED_REFRESHED,
  CHAT_ENDED_COPY,
  DEMO_BUDGET_COPY,
  NEW_CHAT_LABEL,
  RATE_LIMITED_COPY,
  RELOAD_PAGE_LABEL,
  SETUP_START_LOST_COPY,
  SETUP_START_RETRY_COPY,
  SETUP_START_SLOW_COPY,
  SETUP_START_SPENT_COPY,
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

  it('changed_refreshed_says_where_it_stands_now', () => {
    // The screen has already read the item again after a conflict, so the line says so instead of
    // asking for a reload; it opens like the reload line, so the two read as a pair.
    expect(CHANGED_REFRESHED).toEqual({
      en: "This changed while you were looking. Here's where it stands now.",
      es: 'Esto cambió mientras mirabas. Así está ahora.',
    });
    for (const language of LANGUAGES) {
      const reload = errorCopy('conflict', language);
      expect(CHANGED_REFRESHED[language].split('. ')[0]).toBe(reload.split('. ')[0]);
      expect(CHANGED_REFRESHED[language]).not.toMatch(/reload|recarga/i);
    }
  });

  it('agent_page_copy_word_for_word', () => {
    // Starting an agent whose answer was lost: it may be running, so sending it again may run it twice.
    expect(AGENT_START_LOST_COPY).toEqual({
      en: 'The agent may have started, but we lost the answer. If you reload and send it again, it may run twice.',
      es: 'Puede que el agente haya empezado, pero perdimos la respuesta. Si recargas y lo envías de nuevo, puede ejecutarse dos veces.',
    });
    expect(RELOAD_PAGE_LABEL).toEqual({ en: 'Reload the page', es: 'Recargar la página' });
    expect(DEMO_BUDGET_COPY).toEqual({
      en: 'The demo has used its budget for now. Try again later.',
      es: 'La demo agotó su presupuesto por ahora. Inténtalo más tarde.',
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
      ...[UNREACHABLE_COPY, CHAT_ENDED_COPY, NEW_CHAT_LABEL, RATE_LIMITED_COPY, CHANGED_REFRESHED, AGENT_START_LOST_COPY, RELOAD_PAGE_LABEL, DEMO_BUDGET_COPY].flatMap((pair) => [
        pair.en,
        pair.es,
      ]),
    ];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => shownCodes(line).length > 0)).toEqual([]);
    // The plain-word exception covers one sentence of one line, the owner's auth line in English,
    // so it can't quietly spread to another line.
    expect(lines.filter((line) => PLAIN_PHRASES.some((phrase) => line.includes(phrase)))).toEqual([errorCopy('auth', 'en')]);
  });

  it('start_retry_copy_word_for_word', () => {
    // The answer to starting an agent or setup was lost, and trying again is safe: if it started,
    // the retry finds it. Starting setup can also be slow, or fail with nothing started.
    expect(AGENT_START_RETRY_COPY).toEqual({
      en: "We lost the answer, so we don't know yet whether the agent started. Try again: if it did, you'll see it.",
      es: 'Perdimos la respuesta, así que aún no sabemos si el agente empezó. Inténtalo de nuevo: si empezó, lo verás.',
    });
    expect(SETUP_START_RETRY_COPY).toBe("We lost the answer, so we don't know yet whether setup started. Try again: if it did, you'll go straight to it.");
    expect(SETUP_START_SLOW_COPY).toBe('Setup is taking longer than usual to start. Try again in a moment.');
    expect(SETUP_START_SPENT_COPY).toBe("Setup didn't start. If a draft Desk shows in your Desks, open it from there. Otherwise, start again.");

    // Exported from the design system's index, beside the lines they replace.
    expect(ds.AGENT_START_RETRY_COPY).toBe(AGENT_START_RETRY_COPY);
    expect(ds.SETUP_START_RETRY_COPY).toBe(SETUP_START_RETRY_COPY);
    expect(ds.SETUP_START_SLOW_COPY).toBe(SETUP_START_SLOW_COPY);
    expect(ds.SETUP_START_SPENT_COPY).toBe(SETUP_START_SPENT_COPY);

    // No line shows a code, and each passes the copy check as shown.
    const lines = [AGENT_START_RETRY_COPY.en, AGENT_START_RETRY_COPY.es, SETUP_START_RETRY_COPY, SETUP_START_SLOW_COPY, SETUP_START_SPENT_COPY];
    expect(lines.filter((line) => shownCodes(line).length > 0)).toEqual([]);
    for (const line of lines) {
      const shown = document.createElement('p');
      shown.textContent = line;
      document.body.append(shown);
      expect(() => assertCleanCopy(shown), line).not.toThrow();
      shown.remove();
    }
  });

  it('setup_start_lost_copy_word_for_word', () => {
    // Starting setup whose answer was lost: the setup interview may already exist, so starting it
    // again may leave two drafts. An owner line, in English only, as owner screens are.
    expect(SETUP_START_LOST_COPY).toBe('Setup may have started, but we lost the answer. If you reload and start again, you may get two drafts.');
    expect(shownCodes(SETUP_START_LOST_COPY)).toEqual([]);
  });
});
