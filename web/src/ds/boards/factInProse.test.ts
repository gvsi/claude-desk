/**
 * `factsInProse`, the vision boards' mirror of the kernel's reply check on prose: it holds every
 * entry of the kernel's two lexicons and nothing else, it catches what the kernel catches, and every
 * signed line of Claude's words on the vision pages passes it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LEXICON, factsInProse, toJavaScript, type LexiconEntry } from './factInProse.ts';
import { CITY_TURNS, CLAUDE_ACCOUNT_TURNS, PHONE_REPLY, TEAM_REPLIES } from './vision.tsx';

const LEXICON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../backend/desk/kernel_service/lexicon');

/** The kernel's entries, read as it reads them: one `<category>\t<regex>` per line, `#` comments and blank lines aside. */
function kernelEntries(language: 'en' | 'es'): string[] {
  return readFileSync(path.join(LEXICON_DIR, `${language}.txt`), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => `${language}\t${line}`);
}

const mirrored = (entry: LexiconEntry) => `${entry.language}\t${entry.category}\t${entry.pattern}`;

/** The rules `factsInProse` reports for `text`, without and with a booking card beside it. */
const rules = (text: string, bookingCard = false) => factsInProse(text, { bookingCard }).map((hit) => hit.rule);

describe('fact_in_prose', () => {
  it('mirrors_the_kernel_lexicons', () => {
    const kernel = [...kernelEntries('en'), ...kernelEntries('es')];
    const ours = LEXICON.map(mirrored);
    expect(kernel.length).toBeGreaterThan(50);
    // Every kernel entry is mirrored, and nothing is mirrored that the kernel doesn't have.
    expect(kernel.filter((entry) => !ours.includes(entry))).toEqual([]);
    expect(ours.filter((entry) => !kernel.includes(entry))).toEqual([]);
  });

  it('catches_what_the_kernel_catches', () => {
    const cases: [string, string][] = [
      // The always-on scans: any numeral, any currency sign, a percent sign.
      ['Mike arrives at 2.', 'digit'],
      ['Llega a las ٢.', 'digit'],
      ['That’s $ well spent.', 'currency'],
      ['It’s 50% off.', 'percent_sign'],
      // Each lexicon category, in each language.
      ['It takes two visits.', 'lex.en.number'],
      ['Son dos visitas.', 'lex.es.number'],
      ['It costs a few bucks.', 'lex.en.money'],
      ['Cuesta unos dólares.', 'lex.es.money'],
      ['Ten percent off.', 'lex.en.percent'],
      ['Un por ciento menos.', 'lex.es.percent'],
      ['See you on Tuesday.', 'lex.en.date'],
      ['Come by tomorrow.', 'lex.en.date'],
      ['We close in May.', 'lex.en.date'],
      ['Nos vemos el miércoles.', 'lex.es.date'],
      ['I guarantee it.', 'lex.en.promise'],
      ['That one is free.', 'lex.en.promise'],
      ['Te damos un descuento.', 'lex.es.promise'],
      ['It comes at no extra charge.', 'lex.en.promise'],
      // Any word after "no" but "matter", "one", "way" or "doubt" can start a waiver or sit in one ("set", "standard",
      // "worries"), so a charge, cost or fee after it blocks.
      ['There’s no set cost until Mike sees the leak.', 'lex.en.promise'],
      ['No standard fees will be charged.', 'lex.en.promise'],
      ['No worries about costs; you pay nothing.', 'lex.en.promise'],
      ['There’s no set up fee.', 'lex.en.promise'],
      ['There’s no set up charge.', 'lex.en.promise'],
      ['Sin recargos.', 'lex.es.promise'],
      ['No hay cargo extra.', 'lex.es.promise'],
      ['Your appointment is confirmed.', 'lex.en.booking'],
      ['You’re all set.', 'lex.en.booking'],
      ['Booking confirmed.', 'lex.en.booking'],
      ['Tu cita está confirmada.', 'lex.es.booking'],
      // "sí" (yes) is no condition, so the claim after it stands.
      ['Sí, está confirmada.', 'lex.es.booking'],
    ];
    expect(cases.filter(([text, rule]) => !rules(text).includes(rule)).map(([text, rule]) => `${rule}: ${text}`)).toEqual([]);
  });

  it('passes_what_the_kernel_passes', () => {
    // The modal "may", a booking claim with a condition straight before it, and a booking claim beside its card.
    for (const text of ['You may call Mike.', 'Once your visit is confirmed, Mike texts you.', 'Cuando tu cita está confirmada, te escribimos.']) {
      expect(rules(text), text).toEqual([]);
    }
    expect(rules('Your appointment is confirmed.', true)).toEqual([]);
  });

  it('translates_word_classes_inside_brackets', () => {
    // A kernel line with `\w` inside a class, as in `(?![\w-])`, compiles in JavaScript and keeps its meaning.
    const regex = toJavaScript(String.raw`no[\s-]+(?!(?:matter|one|way|doubt)(?![\w-]))(?:[^\W\d_]+[\s-]+){0,2}(?:charges?|costs?)`);
    expect(regex.test('at no extra cost')).toBe(true);
    // The regex is global, so its search would start after the last match; start each test at 0.
    regex.lastIndex = 0;
    expect(regex.test('no matter the costs')).toBe(false);
  });

  it('folds_as_the_kernel_does', () => {
    // A dash of any kind is "-", an apostrophe of any kind is "’", accents drop, spaces run together.
    expect(rules('Next‐week works.')).toContain('lex.en.date');
    expect(rules('Youʼre   all set.')).toContain('lex.en.booking');
    expect(rules('Mañana.')).toContain('lex.es.date');
  });

  it('passes_every_signed_vision_line', () => {
    // Claude's words on the team Desk, the Claude account and the city office pages, as the owner signed them.
    const signed = [
      ...TEAM_REPLIES,
      CLAUDE_ACCOUNT_TURNS.ask,
      CLAUDE_ACCOUNT_TURNS.matched,
      CLAUDE_ACCOUNT_TURNS.sent,
      CITY_TURNS.verifyFirst,
      CITY_TURNS.stands,
      CITY_TURNS.next,
      CITY_TURNS.times,
      CITY_TURNS.staffDecides,
    ];
    expect(signed.filter((line) => rules(line).length > 0)).toEqual([]);
    // The phone's line claims the booking, so it passes only beside its booking card.
    expect(rules(PHONE_REPLY, true)).toEqual([]);
    expect(rules(PHONE_REPLY)).toEqual(['lex.en.booking']);
  });

  it('keeps_booking_and_callback_receipts_independent', () => {
    for (const text of ['Your appointment and call are booked.', 'Your table and call are confirmed.',
      'Tu cita y tu llamada están confirmadas.', 'Ya están confirmadas tu llamada y tu cita.']) {
      const language = text.startsWith('Your') ? 'en' : 'es';
      for (const bookingCard of [false, true]) {
        for (const callbackCard of [false, true]) {
          const expected = [!bookingCard && `lex.${language}.booking`, !callbackCard && `lex.${language}.callback`].filter(Boolean);
          expect([...new Set(factsInProse(text, { bookingCard, callbackCard }).map((hit) => hit.rule))].sort(), text).toEqual(expected.sort());
        }
      }
    }
    for (const text of ['Your call is confirmed.', 'Your call with Mike is confirmed.', 'Your callback request is confirmed.',
      'Your follow-up-call is confirmed.', 'Tu llamada está confirmada.']) {
      expect(factsInProse(text, { callbackCard: true }), text).toEqual([]);
      expect(factsInProse(text, { bookingCard: true }).map((hit) => hit.rule), text).toEqual([
        text.startsWith('Your') ? 'lex.en.callback' : 'lex.es.callback',
      ]);
    }
    expect(factsInProse("We've booked your appointment—call us for details.", { callbackCard: true }).map((hit) => hit.rule)).toEqual(['lex.en.booking']);
  });

  it('requires_booking_backing_for_phrasal_set_service_calls', () => {
    for (const subject of ['service call', 'service-call', 'emergency service call', 'emergency service-call', 'service call with Mike']) {
      for (const tail of ['up', 'to proceed']) {
        const text = `Your ${subject} is set ${tail}.`;
        for (const bookingCard of [false, true]) {
          for (const callbackCard of [false, true]) {
            expect([...new Set(factsInProse(text, { bookingCard, callbackCard }).map((hit) => hit.rule))], text)
              .toEqual(bookingCard ? [] : ['lex.en.booking']);
          }
        }
      }
    }
    expect(factsInProse('Your account is set up.')).toEqual([]);
    expect(factsInProse('Your workspace is set up.')).toEqual([]);
  });

  it('stops_visitor_history_before_independent_completed_claims', () => {
    for (const history of ['consultation', 'callback']) {
      for (const [noun, category] of [['appointment', 'booking'], ['call', 'callback']]) {
        for (const separator of ['—', '–', '-', ' - ', '\n- ', '\n* ', '\n', '; ', ': ', ', ', '/ ']) {
          const prefix = separator.includes('\n') ? '- ' : '';
          const text = `${prefix}You said you'd booked a ${history}${separator}Booked your ${noun}.`;
          for (const bookingCard of [false, true]) {
            for (const callbackCard of [false, true]) {
              const backed = category === 'booking' ? bookingCard : callbackCard;
              expect([...new Set(factsInProse(text, { bookingCard, callbackCard }).map((hit) => hit.rule))], text)
                .toEqual(backed ? [] : [`lex.en.${category}`]);
            }
          }
        }
      }
    }
  });

  it('preserves_honest_context_and_claim_group_spans', () => {
    const honest = ['Your identity is confirmed.', 'Your IDENTITY is confirmed.', 'Your contact details are confirmed.', 'Your account is set up.',
      'Your custom workspace is set to receive messages.', 'Have you previously booked a consultation with us?',
      "You said you'd booked a consultation with us before.", 'If you have already booked a consultation, I can help with it.',
      'Si te hemos reservado una mesa, puedo buscar la confirmación.', 'Si ya hemos reservado tu mesa, puedo buscar la confirmación.',
      'Once your follow-up-call is confirmed, we can discuss access.'];
    for (const text of honest) {
      expect(factsInProse(text), text).toEqual([]);
      expect(factsInProse(`${text} Your consultation is confirmed.`).map((hit) => hit.rule), text).toContain('lex.en.booking');
    }
    expect(factsInProse('Tu llamada está confirmada. Está confirmada.')).toEqual([
      { rule: 'lex.es.callback', span: 'Tu llamada está confirmada' },
      { rule: 'lex.es.booking', span: 'Está confirmada' },
    ]);
    expect(factsInProse('Your call WITH Mike is confirmed.', { callbackCard: true })).toEqual([]);
    expect(rules('Your appointment with Mike is set up.')).toContain('lex.en.booking');
    const regex = toJavaScript(String.raw`context|(?P<claim>booked)`);
    expect([...('context booked'.matchAll(regex))].map((match) => match.groups?.claim)).toEqual([undefined, 'booked']);
  });
});
