/**
 * The mock's setup interview, driven the way its handlers drive it: the business's name it reads
 * from the owner's description, the way a reader would, and the slug and first question that follow;
 * and the unfinished setup the owner's Desks name until the Desk goes live.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { RouteKey } from '../api/routes.ts';
import type { BusinessOut, CopyOut, SetupState } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { SETUP_QUESTIONS, setupPublicDesk } from './setup.ts';
import { mockStore } from './store.ts';

interface Started {
  business: string | undefined;
  slug: string;
  /** Claude's first words. */
  first: string | undefined;
  /** The line about the business on its public page, or null when it has none. */
  about: string | null;
}

/** How many starts this file has sent, which gives each its own client key. */
let starts = 0;

/** A new interview from `description`: what the new Desk is called, Claude's first words and the line about it. */
async function started(description: string): Promise<Started> {
  const body = { description, timezone: 'America/Los_Angeles', idempotency_key: `start-${++starts}` };
  const answer = await mockStore.dispatch('startSetup', { body });
  if ('network' in answer || answer.status !== 201) throw new Error('the mock starts a setup');
  const state = answer.body as SetupState;
  const desk = mockStore.world.desks.find((d) => d.summary.desk_id === state.desk_id);
  const charter = desk === undefined ? [] : (setupPublicDesk(mockStore.world, desk, 'en')?.charter ?? []);
  const about = charter.map((block) => ('title' in block ? block.title : null))[0] ?? null;
  return { business: desk?.summary.business_name, slug: state.slug, first: state.messages[0]?.text, about };
}

beforeEach(() => {
  mockStore.reset('rivera');
});

describe("the business's name, from the description", () => {
  it('a_phrase_like_i_run_names_the_business', async () => {
    // The owner introduces themselves first: the business is the one they say they run, not "I'm Ana".
    const ana = await started("I'm Ana. I run Ana's Bakery in Oakland. Sourdough and cakes to order.");
    expect(ana.business).toBe("Ana's Bakery");
    expect(ana.slug).toBe('ana-s-bakery-setup1');
    expect(ana.first).toMatch(/^Thanks, Ana\. .* about Ana's Bakery\?/);

    // "We run" and "I own" name it too, up to a comma, " on " or the sentence's end.
    expect((await started("We run Rivera Plumbing, a two-van crew. I'm Maria.")).business).toBe('Rivera Plumbing');
    expect((await started("I'm Lee and I own Acme Bakery on Main Street.")).business).toBe('Acme Bakery');
    expect((await started('Hello, I am Sam and I own Kernel Plumbing')).business).toBe('Kernel Plumbing');

    // A comma ends the name; with none, the whole name is kept, up to the API's 80 characters.
    const long = await started("I'm Maria. I run Rivera Plumbing, Heating and Emergency Drain Services of the East Bay.");
    expect(long.business).toBe('Rivera Plumbing');
    const longer = await started("I'm Maria. I run Rivera Plumbing Heating and Emergency Drain Services of the East Bay.");
    expect(longer.business).toBe('Rivera Plumbing Heating and Emergency Drain Services of the East Bay');
  });

  it('a_name_keeps_the_apis_80_characters_and_is_cut_only_at_a_whole_word', async () => {
    // Up to 80 characters, as the API keeps a business's name: one over 60 is kept whole, however it's named.
    const bayview = 'Bayview Heating, Plumbing & Drain Services of Greater Oakland';
    expect(bayview.length).toBeGreaterThan(60);
    expect((await started(`${bayview}. I'm Sam, a plumber in Oakland.`)).business).toBe(bayview);
    expect((await started(`I'm Sam. ${bayview} is my business.`)).business).toBe(bayview);
    // Its white space as the API keeps it: one space between words.
    expect((await started("Rivera   Plumbing. I'm Maria.")).business).toBe('Rivera Plumbing');

    // A longer name ends on the last whole word that fits, with no comma, "&", "and" or "or" (or the
    // Spanish "y" or "o") left at its end.
    const cases: [string, string][] = [
      [`${bayview}, Berkeley, Richmond and Walnut Creek`, `${bayview}, Berkeley`],
      [`${bayview}, Berkeley & Richmond Too`, `${bayview}, Berkeley`],
      [`${bayview}, Berkeley and Richmond Too`, `${bayview}, Berkeley`],
      [`${bayview}, Berkeley And Richmond Too`, `${bayview}, Berkeley`],
      ['Panadería Inés y Compañía de Repostería Artesanal de Oakland, Berkeley y Richmond', 'Panadería Inés y Compañía de Repostería Artesanal de Oakland, Berkeley'],
      // Whole words that fill the 80 characters exactly are all kept.
      [`${bayview} and the Inner East Bay Hills`, `${bayview} and the Inner East`],
    ];
    for (const [name, kept] of cases) {
      const business = (await started(`${name}. I'm Sam.`)).business ?? '';
      expect(business, name).toBe(kept);
      expect(business.length, name).toBeLessThanOrEqual(80);
      // The name's start, with no letter or digit of a cut word after it.
      expect(name.startsWith(business), name).toBe(true);
      expect(name.slice(business.length), `${name}: ends on a whole word`).toMatch(/^[^\p{L}\p{N}]/u);
    }
    // Characters are counted as the API counts them, one per code point: with a 🔧, which JavaScript
    // counts as two, a name of exactly 80 is still whole.
    const wrench = `${bayview} 🔧 and the East Bay`;
    expect([[...wrench].length, wrench.length]).toEqual([80, 81]);
    expect((await started(`${wrench}. I'm Sam.`)).business).toBe(wrench);
    // A single word longer than that has no whole word to keep: it names nothing, so a later sentence can.
    expect((await started(`${'Bayview'.repeat(12)}.`)).business).toBe('Your business');
    expect((await started(`${'Bayview'.repeat(12)}. I run Acme Bakery.`)).business).toBe('Acme Bakery');
  });

  it('a_phrase_like_is_my_shop_names_the_business', async () => {
    const ana = await started("Hi, I'm Ana. Ana's Bakery is my shop in Oakland.");
    expect(ana.business).toBe("Ana's Bakery");
    expect(ana.slug).toBe('ana-s-bakery-setup1');
    expect(ana.first).toMatch(/^Thanks, Ana\. .* about Ana's Bakery\?/);
    // Any of the words for a business, mine or ours; a curly apostrophe stays the owner's.
    expect((await started('My name is Maria. Rivera Plumbing is our business.')).business).toBe('Rivera Plumbing');
    expect((await started('I’m Lee. Lee’s Café is my café, on Main Street.')).business).toBe('Lee’s Café');
    // Not every "is my …": a day off names nothing, so the first sentence does.
    expect((await started('Acme Bakery. Sunday is my day off.')).business).toBe('Acme Bakery');
  });

  it('else_the_first_sentence_that_is_not_an_introduction', async () => {
    const rivera = await started("Rivera Plumbing. I'm Maria, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters.");
    expect(rivera.business).toBe('Rivera Plumbing');
    expect(rivera.slug).toBe('rivera-plumbing-setup1');
    expect(rivera.first).toMatch(/^Thanks, Maria\. .* about Rivera Plumbing\?/);
    // "We run a small crew", "Monday to Friday" or "3 vans" is no name, so the first sentence still is.
    expect((await started("Rivera Plumbing. I'm Maria. We run a small crew in Oakland.")).business).toBe('Rivera Plumbing');
    expect((await started('Rivera Plumbing. We run Monday to Friday, and I own 3 vans.')).business).toBe('Rivera Plumbing');

    // The owner's introduction is passed over, however it's put.
    for (const intro of ["I'm Lee.", 'I’m Lee.', 'I am Lee.', 'My name is Lee.', "Hi, I'm Lee.", "Hi! I'm Lee.", 'Hello, my name is Lee.']) {
      expect((await started(`${intro} Acme Bakery. Sourdough and cakes to order.`)).business, intro).toBe('Acme Bakery');
    }
  });

  it('else_your_business_when_the_owner_only_introduces_themselves', async () => {
    const ana = await started("I'm Ana.");
    expect(ana.business).toBe('Your business');
    expect(ana.slug).toBe('your-business-setup1');
    // The owner is still greeted by name.
    expect(ana.first).toMatch(/^Thanks, Ana\. .* about Your business\?/);
    expect((await started("Hi! I'm Ana")).business).toBe('Your business');
  });

  it('a_name_given_first_wins_over_a_later_phrase', async () => {
    // The sentences are read in order: a later "we run" or "we own" doesn't replace a name given first.
    const cases: [string, string][] = [
      ["Rivera Plumbing. I'm Maria. We run QuickBooks for invoicing.", 'Rivera Plumbing'],
      ["Rivera Plumbing. I'm Maria. We run Google Ads in the spring.", 'Rivera Plumbing'],
      ['Rivera Plumbing. We own Ford vans and a Ridgid camera.', 'Rivera Plumbing'],
      ['Rivera Plumbing. We run Mon-Fri, 8 to 6.', 'Rivera Plumbing'],
      ["Acme Bakery. I'm Lee. We run Thanksgiving pie orders every November.", 'Acme Bakery'],
      ["Ana's Bakery is my shop. We run Farmers Market stalls too.", "Ana's Bakery"],
    ];
    for (const [description, business] of cases) expect((await started(description)).business, description).toBe(business);
  });

  it('a_first_person_sentence_is_no_name_but_called_and_my_shop_is_name_it', async () => {
    const cases: [string, string][] = [
      // A sentence about the owner or the work, with no name in it, names nothing.
      ["I'm Ana. I run a small bakery in Oakland. Sourdough and cakes to order.", 'Sourdough and cakes to order'],
      ["I'm Ana. I run a small bakery in Oakland.", 'Your business'],
      ["I'm Ana. We bake sourdough and cakes to order.", 'Your business'],
      // "called X", "named X" and "my shop is X" name it.
      ['I run a bakery called Ana’s Bakery', 'Ana’s Bakery'],
      ["I'm Ana. I run a bakery named Ana's Bakery in Oakland.", "Ana's Bakery"],
      ["I'm Ana. My bakery is called Ana's Bakery.", "Ana's Bakery"],
      ["I'm Ana. My shop is Ana's Bakery.", "Ana's Bakery"],
      ['Our business is Rivera Plumbing.', 'Rivera Plumbing'],
    ];
    for (const [description, business] of cases) expect((await started(description)).business, description).toBe(business);
  });

  it('is_my_shop_takes_the_name_not_the_introduction_or_a_pronoun', async () => {
    const cases: [string, string][] = [
      // An introduction before the name is left out of it.
      ["Hi, I'm Ana and Ana's Bakery is my shop in Oakland.", "Ana's Bakery"],
      ["I'm Inés, and Inés Bakery is my shop.", 'Inés Bakery'],
      // "This", "It" and the like name nothing.
      ["I'm Ana. This is my bakery in Oakland. Sourdough and cakes to order.", 'Sourdough and cakes to order'],
      ["I'm Ana. This is my bakery in Oakland.", 'Your business'],
      ["Hi, I'm Ana! This is our shop. We bake sourdough.", 'Your business'],
      ["I'm Ana. It is my business to bake.", 'Your business'],
      ["Hi, I'm Ana and there is my shop.", 'Your business'],
    ];
    for (const [description, business] of cases) expect((await started(description)).business, description).toBe(business);
  });

  it('a_name_in_a_phrase_ends_where_the_name_does', async () => {
    const cases: [string, string][] = [
      ["I'm Ana. I run Ana's Bakery with my sister.", "Ana's Bakery"],
      ["I'm Ana. I run Ana's Bakery at 5th and Main.", "Ana's Bakery"],
      ["I'm Ana. I run Ana's Bakery near Lake Merritt.", "Ana's Bakery"],
      ['We run Rivera Plumbing out of Oakland since 2009.', 'Rivera Plumbing'],
      ['We run Rivera Plumbing since 2009.', 'Rivera Plumbing'],
      ['We run Rivera Plumbing for homes and small shops.', 'Rivera Plumbing'],
      ['I own Rivera Plumbing from the start of 2009.', 'Rivera Plumbing'],
      ["I run Ana's Bakery and we bake sourdough to order.", "Ana's Bakery"],
      ["I run Ana's Bakery and my sister runs the café.", "Ana's Bakery"],
      ["I'm Ana. My shop is called Ana's Bakery and our café is next door.", "Ana's Bakery"],
      // An "and" that is part of the name stays in it.
      ["I'm Maria and I run Rivera Plumbing and Heating in Oakland.", 'Rivera Plumbing and Heating'],
    ];
    for (const [description, business] of cases) expect((await started(description)).business, description).toBe(business);
  });

  it('a_schedule_names_nothing_but_a_day_in_a_name_is_kept', async () => {
    const cases: [string, string][] = [
      // A day followed by more of the name is the business's name.
      ["I'm Lee. I run Sunday Bakery in Fresno.", 'Sunday Bakery'],
      ["I'm Lee. I own Saturdays Cafe on Main.", 'Saturdays Cafe'],
      ["I'm Lee. We run Mondays Bar.", 'Mondays Bar'],
      ["I'm Lee. Sunday Bakery is my shop.", 'Sunday Bakery'],
      // Days that are only a schedule aren't.
      ["I'm Maria. We run Monday to Friday. Rivera Plumbing is our business.", 'Rivera Plumbing'],
      ["I'm Maria. We run Mon-Fri, 8 to 6. Rivera Plumbing.", 'Rivera Plumbing'],
      ["I'm Lee. We run Sundays.", 'Your business'],
      ["I'm Lee. We run Saturday mornings.", 'Your business'],
      ["I'm Lee. We run Tue–Sat 9 to 5.", 'Your business'],
    ];
    for (const [description, business] of cases) expect((await started(description)).business, description).toBe(business);
  });
});

describe('the owner and the line about the business, from the description', () => {
  it('every_introduction_names_the_owner', async () => {
    const cases: [string, string][] = [
      ['My name is Maria. Rivera Plumbing is our business.', 'Thanks, Maria.'],
      ['I am Sam and I own Kernel Plumbing.', 'Thanks, Sam.'],
      ["Hi, I'm Ana and Ana's Bakery is my shop in Oakland.", 'Thanks, Ana.'],
      ['Rivera Plumbing. We fix leaks and clear drains.', 'Thanks.'],
    ];
    for (const [description, greeting] of cases) {
      expect((await started(description)).first?.slice(0, greeting.length + ' Before'.length), description).toBe(`${greeting} Before`);
    }
  });

  it('the_about_line_leaves_out_the_introduction_and_the_name', async () => {
    const cases: [string, string | null][] = [
      ["Hi, I'm Lee. Acme Bakery. Sourdough and cakes to order.", 'Sourdough and cakes to order.'],
      ["I'm Ana. I run Ana's Bakery in Oakland. Sourdough and cakes to order.", 'Sourdough and cakes to order.'],
      ["We bake sourdough and cakes to order. I'm Ana and I run Ana's Bakery.", 'We bake sourdough and cakes to order.'],
      ['Acme Bakery. My name is Lee. Sourdough and cakes to order.', 'Sourdough and cakes to order.'],
      ["Rivera Plumbing. I'm Maria, a licensed plumber in Oakland. We fix leaks.", 'We fix leaks.'],
      ["Hi! I'm Ana. Ana's Bakery.", null],
    ];
    for (const [description, about] of cases) expect((await started(description)).about, description).toBe(about);
  });
});

describe('a description in Spanish', () => {
  it('spanish_introductions_and_phrases_are_read', async () => {
    const cases: [string, string, string][] = [
      ['Soy Ana. Tengo la Panadería Ana en Oakland. Pan de masa madre.', 'Panadería Ana', 'Thanks, Ana.'],
      ['Me llamo Ana. Panadería Ana es mi negocio.', 'Panadería Ana', 'Thanks, Ana.'],
      ['Hola, soy Ana. Panadería Ana. Pan y pasteles por encargo.', 'Panadería Ana', 'Thanks, Ana.'],
      ['Mi nombre es Inés. Tenemos Óptica Inés con dos tiendas.', 'Óptica Inés', 'Thanks, Inés.'],
      ['Soy Inés y Café Inés es nuestra tienda.', 'Café Inés', 'Thanks, Inés.'],
      ['Hola, soy Ana. Tengo una panadería en Oakland.', 'Your business', 'Thanks, Ana.'],
      // The UI tester's case: the name has accents and a "y" of its own, and the owner is still Inés.
      [
        "I'm Inés, and I run Panadería Inés y Compañía de Repostería Artesanal in Oakland.",
        'Panadería Inés y Compañía de Repostería Artesanal',
        'Thanks, Inés.',
      ],
      // Up to the API's 80 characters, so this one is whole.
      ['Soy Inés. Tengo Panadería Inés y Compañía de Repostería Artesanal de la Bahía de San Francisco.', 'Panadería Inés y Compañía de Repostería Artesanal de la Bahía de San Francisco', 'Thanks, Inés.'],
    ];
    for (const [description, business, greeting] of cases) {
      const { business: named, first } = await started(description);
      expect(named, description).toBe(business);
      expect(first?.slice(0, greeting.length), description).toBe(greeting);
    }
  });
});

describe("setup's examples", () => {
  it('each_example_gives_its_business_owner_slug_and_line', async () => {
    // The start step's examples, in English and in Spanish, read as an owner's own description: the
    // business's name from its first sentence, the owner greeted by the first name they give, a
    // slug from the business's name, and the work as the line on its public page.
    const expected = {
      en: [
        ['Okafor Plumbing', 'Daniel', 'okafor-plumbing-setup1', 'People often send me a photo of the problem before I come out.'],
        [
          "Rosa's Bakery",
          'Rosa',
          'rosa-s-bakery-setup1',
          'Most orders are for birthdays and weddings, and people tell me the size, the flavors and the design they have in mind.',
        ],
        ['Nguyen Tax Services', 'Linh', 'nguyen-tax-services-setup1', 'People send me their documents online or bring them to my office.'],
      ],
      es: [
        ['Plomería Okafor', 'Daniel', 'plomeria-okafor-setup1', 'La gente suele mandarme una foto del problema antes de que vaya.'],
        [
          'Panadería Rosa',
          'Rosa',
          'panaderia-rosa-setup1',
          'Casi todos los pedidos son para cumpleaños y bodas, y la gente me dice el tamaño, los sabores y el diseño que tiene en mente.',
        ],
        ['Impuestos Nguyen', 'Linh', 'impuestos-nguyen-setup1', 'La gente me manda sus documentos por internet o los trae a mi oficina.'],
      ],
    } as const;
    for (const language of ['en', 'es'] as const) {
      const examples = START_EXAMPLES[language].examples;
      expect(examples).toHaveLength(expected[language].length);
      for (const [at, { chip, description }] of examples.entries()) {
        const [business, owner, slug, about] = expected[language][at] ?? [];
        const desk = await started(description);
        expect(desk.business, chip).toBe(business);
        expect(desk.first?.startsWith(`Thanks, ${owner ?? ''}. Before`), chip).toBe(true);
        expect(desk.first, chip).toContain(`about ${business ?? ''}?`);
        expect(desk.slug, chip).toBe(slug);
        expect(desk.about, chip).toBe(about);
      }
    }
  });
});

describe("a Desk's unfinished setup, in the owner's Desks", () => {
  /** Each of the copy's Desks, by id, with the setup interview the owner's Desks name for it. */
  async function setups(): Promise<Map<string, unknown>> {
    const answer = await mockStore.dispatch('desks');
    if ('network' in answer || answer.status !== 200) throw new Error('the mock lists the Desks');
    return new Map((answer.body as BusinessOut[]).flatMap((business) => business.desks.map((desk) => [desk.desk_id, desk.setup])));
  }

  /** Answers a route of the interview, or throws. */
  async function step(key: RouteKey, id: string, body?: unknown): Promise<void> {
    const answer = await mockStore.dispatch(key, { params: { id }, body });
    if ('network' in answer || answer.status !== 200) throw new Error(`the mock answers ${key}`);
  }

  it('a_desk_made_by_setup_names_its_interview_until_it_goes_live', async () => {
    // The seeded Desk was made without setup: it names none.
    const seeded = await setups();
    expect([...seeded.values()]).toEqual([null]);

    const body = { description: "Okafor Plumbing. I'm Daniel.", timezone: 'America/Los_Angeles', idempotency_key: 'start-unfinished' };
    const started = await mockStore.dispatch('startSetup', { body });
    if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
    const { interview_id: id, desk_id: deskId } = started.body as SetupState;
    const setupOf = async () => (await setups()).get(deskId);

    // From the start of setup, at each step it stops at, until it goes live.
    expect(await setupOf()).toEqual({ interview_id: id, step: 'questions' });
    await step('setupConsent', id, { allow: false });
    for (const question of SETUP_QUESTIONS) await step('setupAnswer', id, { question: question.key, text: 'Yes, that works.' });
    expect(await setupOf()).toEqual({ interview_id: id, step: 'tools' });
    await step('setupRules', id);
    expect(await setupOf()).toEqual({ interview_id: id, step: 'rules' });
    await step('setupSituations', id);
    expect(await setupOf()).toEqual({ interview_id: id, step: 'situations' });
    await step('setupSafetyCheck', id);
    expect(await setupOf()).toEqual({ interview_id: id, step: 'safety_check' });
    // Its rules confirmed and Answering still off, setup isn't finished until it goes live.
    await step('setupConfirm', id);
    expect(await setupOf()).toEqual({ interview_id: id, step: 'preview' });
    await step('goLive', id);
    expect(await setupOf()).toBeNull();
    // And the seeded Desk still names none.
    const [seededId] = seeded.keys();
    expect((await setups()).get(seededId ?? '')).toBeNull();
  });

  it('the_copy_names_it_too', async () => {
    // The copy (`me`) lists the same Desks as the switcher does, each naming its unfinished setup.
    const body = { description: "Okafor Plumbing. I'm Daniel.", timezone: 'America/Los_Angeles', idempotency_key: 'start-copy' };
    const started = await mockStore.dispatch('startSetup', { body });
    if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
    const { interview_id: id, desk_id: deskId } = started.body as SetupState;
    const me = await mockStore.dispatch('me');
    if ('network' in me || me.status !== 200) throw new Error('the mock reads the copy');
    const desks = (me.body as CopyOut).desks;
    expect(desks.map((desk) => [desk.desk_id, desk.setup])).toEqual([...(await setups())]);
    expect(desks.find((desk) => desk.desk_id === deskId)?.setup).toEqual({ interview_id: id, step: 'questions' });
  });
});
