/**
 * `factsInProse`, the vision boards' mirror of the kernel's reply check on prose: it holds every
 * entry of the kernel's two lexicons and its lookalike table and nothing else, it reads text each way
 * the kernel reads it, it reports what the kernel reports on every sentence of `factInProse.kernel.ts`,
 * and every signed line of Claude's words on the vision pages passes it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LEXICON, factsInProse, toJavaScript, type FactHit, type LexiconEntry } from './factInProse.ts';
import { KERNEL_CASES } from './factInProse.kernel.ts';
import { LOOKALIKES } from './lookalikes.ts';
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

/**
 * The kernel's lookalike table, read as `labels._load_lookalikes` reads it: one `<code point>\t<letter
 * or digit>` per line, what follows a `#` on it aside, `#` comment lines and blank lines aside. A
 * malformed line or a second line for a character throws, as it stops the kernel from starting.
 */
function kernelLookalikes(): string[] {
  const seen = new Set<string>();
  return readFileSync(path.join(LEXICON_DIR, 'lookalikes.txt'), 'utf8')
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (line.trim() === '' || line.startsWith('#')) return [];
      const tab = line.indexOf('\t');
      const code = tab === -1 ? line : line.slice(0, tab);
      const looksLike = (line.slice(tab + 1).split('#')[0] ?? '').trim();
      if (tab === -1 || !/^[0-9A-F]{4,6}$/.test(code) || parseInt(code, 16) < 0x80 || !/^[A-Za-z0-9]$/.test(looksLike)) {
        throw new Error(`lookalikes.txt:${index + 1} is not a <code point>\\t<letter or digit> line`);
      }
      if (seen.has(code)) throw new Error(`lookalikes.txt:${index + 1} lists ${code} a second time`);
      seen.add(code);
      return [`${code}\t${looksLike}`];
    });
}

const mirroredLookalike = ([code, looksLike]: readonly [number, string]) => `${code.toString(16).toUpperCase().padStart(4, '0')}\t${looksLike}`;

/** The rules `factsInProse` reports for `text`, without and with a booking card beside it. */
const rules = (text: string, bookingCard = false) => factsInProse(text, { bookingCard }).map((hit) => hit.rule);

/** Hits as `[rule, span]` pairs in one order, so two scans' verdicts compare whatever order each reports. */
const pairs = (hits: readonly (readonly [string, string])[]) =>
  hits.map(([rule, span]) => `${rule}\t${span}`).sort();
const ourPairs = (hits: readonly FactHit[]) => pairs(hits.map((hit) => [hit.rule, hit.span] as const));

describe('fact_in_prose', () => {
  it('mirrors_the_kernel_lexicons', () => {
    const kernel = [...kernelEntries('en'), ...kernelEntries('es')];
    const ours = LEXICON.map(mirrored);
    expect(kernel.length).toBeGreaterThan(50);
    // Every kernel entry is mirrored, and nothing is mirrored that the kernel doesn't have.
    expect(kernel.filter((entry) => !ours.includes(entry))).toEqual([]);
    expect(ours.filter((entry) => !kernel.includes(entry))).toEqual([]);
  });

  it('mirrors_the_kernel_lookalikes', () => {
    const kernel = kernelLookalikes();
    const ours = LOOKALIKES.map(mirroredLookalike);
    expect(kernel.length).toBeGreaterThan(400);
    // Every kernel entry is mirrored, once, and nothing is mirrored that the kernel doesn't have.
    expect(new Set(ours).size).toBe(ours.length);
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

  it('reads_a_capital_i_as_l', () => {
    // Issue 142's first example: a capital I drawn for each l.
    expect(rules('It costs tweIve doIIars.')).toEqual(['lex.en.number', 'lex.en.money']);
  });

  it('reads_a_spaced_acute_as_an_apostrophe_and_as_a_space', () => {
    // Issue 142's second example. NFKC writes "´" as a space and a combining acute, which the kernel
    // reads both as "’" ("You´re", "o´clock") and as the space it is drawn on ("no´charge").
    expect(rules('You´re all set.')).toEqual(['lex.en.booking']);
    expect(factsInProse('It opens at five o´clock.')).toContainEqual({ rule: 'lex.en.date', span: 'o \u0301clock' });
    expect(rules('It comes at no´charge.')).toEqual(['lex.en.promise']);
  });

  it('reads_lookalike_letters_as_latin', () => {
    // A Cyrillic small ie (U+0435) in a lexicon word, read as the Latin e it looks like.
    expect(factsInProse('See you on Tu\u0435sday.')).toContainEqual({ rule: 'lex.en.date', span: 'Tu\u0435sday' });
  });

  it('ends_a_span_after_a_whole_character', () => {
    // A lookalike outside the Basic Multilingual Plane is two UTF-16 units: the span holds both.
    const astral = String.fromCodePoint(0x118c1);
    expect(factsInProse(`It costs a few buck${astral}.`)).toContainEqual({ rule: 'lex.en.money', span: `buck${astral}` });
  });

  it('reads_a_bare_stroke_as_i', () => {
    // Greek capitals spelling NINE: the iota is a bare stroke, which the kernel reads as l and as I.
    expect(factsInProse('It takes \u039d\u0399\u039d\u0395 visits.')).toEqual([{ rule: 'lex.en.number', span: '\u039d\u0399\u039d\u0395' }]);
  });

  it('reads_digit_lookalikes_and_letters_shaped_like_0_or_1', () => {
    // A Cyrillic Ze (U+0417) drawn as a 3 is a numeral, and the Cyrillic O (U+041E) next to a digit is part of its number.
    expect(factsInProse('The gate code is \u0417.')).toEqual([{ rule: 'digit', span: '\u0417' }]);
    expect(factsInProse('The gate code is 2\u041e\u041e.')).toEqual([{ rule: 'digit', span: '2\u041e\u041e' }]);
    // A word made only of letters shaped like 0 or 1 is a number unless it is plain ASCII.
    expect(factsInProse('Room \u0406\u041e\u041e is upstairs.')).toEqual([{ rule: 'digit', span: '\u0406\u041e\u041e' }]);
    for (const text of ['I can check. OK?', 'Mike says lO is fine.']) expect(factsInProse(text), text).toEqual([]);
  });

  it('drops_ignorables_and_draws_hangul_fillers_as_spaces', () => {
    // A combining grapheme joiner and a variation selector, which no font draws, inside a word.
    expect(factsInProse('See you on Tues\u034fday.')).toEqual([{ rule: 'lex.en.date', span: 'Tuesday' }]);
    expect(factsInProse('Come by tomor\ufe0frow.')).toEqual([{ rule: 'lex.en.date', span: 'tomorrow' }]);
    // A Hangul filler, drawn as a blank, between two words.
    expect(factsInProse('Your\u3164appointment is confirmed.')).toEqual([{ rule: 'lex.en.booking', span: 'Your appointment is confirmed' }]);
  });

  it('flags_words_mixing_scripts', () => {
    // A Cyrillic i (U+0456) in a Latin word, with or without a lexicon word under it. A word in one
    // other script alone, such as the Greek NINE above, mixes nothing.
    expect(factsInProse('Ask M\u0456ke about it.')).toEqual([{ rule: 'mixed_script', span: 'M\u0456ke' }]);
    expect(factsInProse('See you on Tu\u0435sday.')).toContainEqual({ rule: 'mixed_script', span: 'Tu\u0435sday' });
    // Turned capital F, turned small f and the reversed Roman numeral one hundred belong to the Latin
    // script, but their names don't start with "LATIN ", which is how the kernel tells a Latin letter:
    // to it, these words mix scripts.
    for (const [text, word] of [['It’s \u2132ree.', '\u2132ree'], ['Ask a\u214e about it.', 'a\u214e'], ['Ask \u2183a about it.', '\u2183a']] as const) {
      expect(factsInProse(text), text).toEqual([{ rule: 'mixed_script', span: word }]);
    }
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

  it('agrees_with_the_kernel_on_every_case', () => {
    // The kernel's own verdicts (`factInProse.kernel.ts`): the same hits, rule for rule and span for span.
    expect(KERNEL_CASES.length).toBeGreaterThan(60);
    const disagreements = KERNEL_CASES.flatMap(({ text, bookingCard = false, callbackCard = false, hits }) => {
      const kernel = pairs(hits);
      const ours = ourPairs(factsInProse(text, { bookingCard, callbackCard }));
      return JSON.stringify(ours) === JSON.stringify(kernel) ? [] : [{ text, bookingCard, callbackCard, kernel, ours }];
    });
    expect(disagreements).toEqual([]);
  });
});
