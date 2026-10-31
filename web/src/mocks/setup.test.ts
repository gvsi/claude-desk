/**
 * The mock's setup interview, driven the way its handlers drive it: the business's name it reads
 * from the owner's description, the way a reader would, and the slug and first question that follow;
 * and the unfinished setup the owner's Desks name until the Desk goes live.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { PublicDesk } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type { BusinessOut, CopyOut, SetupState, Today } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { holdNextConsent, holdNextAnswer, MEMORY_LABEL, QUESTIONS_DONE, SETUP_QUESTIONS, setupPublicDesk } from './setup.ts';
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

it('async_consent_repeats_202_then_lands_on_a_read_without_a_second_turn', async () => {
  const started = await mockStore.dispatch('startSetup', { body: { description: 'Rivera Plumbing.', timezone: 'UTC', idempotency_key: 'async-consent' } });
  if ('network' in started) throw new Error('start failed');
  const state = started.body as SetupState;
  expect(state.busy).toBe(false);
  const finish = holdNextConsent(mockStore.world, state.interview_id);
  const params = { id: state.interview_id };
  const pending = await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  expect(pending).toMatchObject({ status: 202, body: { consent: true, question: null, busy: true } });
  const again = await mockStore.dispatch('setupConsent', { params, body: { allow: false } });
  expect(again).toEqual(pending);
  finish('landed');
  const landed = await mockStore.dispatch('setup', { params });
  expect(landed).toMatchObject({ status: 200, body: { consent: true, question: 'what_you_do', busy: false } });
  if ('network' in landed) throw new Error('read failed');
  expect((landed.body as SetupState).messages.filter((m) => m.role === 'owner')).toHaveLength(1);
  expect(await mockStore.dispatch('setupConsent', { params, body: { allow: true } })).toMatchObject({ status: 409 });
});

it('failed_async_consent_restores_the_consent_question_and_can_be_answered_again', async () => {
  const started = await mockStore.dispatch('startSetup', { body: { description: 'Rivera Plumbing.', timezone: 'UTC', idempotency_key: 'failed-consent' } });
  if ('network' in started) throw new Error('start failed');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  const finish = holdNextConsent(mockStore.world, state.interview_id);
  await mockStore.dispatch('setupConsent', { params, body: { allow: false } });
  finish('failed');
  expect(await mockStore.dispatch('setup', { params })).toMatchObject({
    status: 200, body: { busy: false, consent: null, question: null, messages: state.messages },
  });
  expect(await mockStore.dispatch('setupConsent', { params, body: { allow: false } })).toMatchObject({
    status: 200, body: { busy: false, consent: false, question: 'what_you_do' },
  });
});

const CPA = "I'm Linda Chen. Chen & Co. is a two-person CPA firm in San Jose doing tax returns and bookkeeping for individuals and small businesses. New clients start with a free 20-minute consult, and we price each engagement after it.";

async function startState(description = CPA): Promise<SetupState> {
  const answer = await mockStore.dispatch('startSetup', { body: { description, timezone: 'America/Los_Angeles', idempotency_key: `consultant-${++starts}` } });
  if ('network' in answer || answer.status !== 201) throw new Error('setup must start');
  return answer.body as SetupState;
}

async function setupState(key: RouteKey, id: string, body?: unknown, proposal_id?: string): Promise<SetupState> {
  const answer = await mockStore.dispatch(key, { params: { id, ...(proposal_id === undefined ? {} : { proposal_id }) }, query: { cards: '1' }, body });
  if ('network' in answer || answer.status !== 200) throw new Error(`${key} must answer 200`);
  return answer.body as SetupState;
}

describe('setup consultant run and decisions', () => {
  it('serves_cards_only_with_exact_opt_in_on_all_five_setup_state_routes', async () => {
    for (const key of ['setup', 'setupConsent', 'setupAnswer', 'setupProposal', 'setupSuggestions'] as const) {
      for (const cards of [undefined, '0', 'true', '1']) {
        let state = await startState();
        const id = state.interview_id;
        if (key !== 'setupConsent') state = await setupState('setupConsent', id, { allow: true });
        const proposal_id = state.messages.find((message) => message.card?.job?.job === 'schedule')?.card?.proposal_id ?? '';
        const body = key === 'setupConsent' ? { allow: true }
          : key === 'setupAnswer' ? { question: state.question, text: 'Individuals only' }
          : key === 'setupProposal' ? { accept: true } : key === 'setupSuggestions' ? {} : undefined;
        const answer = await mockStore.dispatch(key, { params: { id, proposal_id }, query: cards === undefined ? {} : { cards }, body });
        expect(answer).toMatchObject({ status: 200 });
        if ('network' in answer || answer.status !== 200) throw new Error('setup must answer');
        const full = await setupState('setup', id);
        expect(full.messages.filter((message) => message.card)).toHaveLength(6);
        expect(answer.body).toEqual({ ...full, messages: full.messages.filter((message) => cards === '1' || message.card === null) });
      }
    }
  });

  it('keeps_ambiguous_or_invalid_cpa_money_answers_at_zero', async () => {
    for (const text of ['I file 2026 returns', '-500', '$10,001', 'Always ask me first', 'Up to $500', '$250.50']) {
      let state = await startState();
      state = await setupState('setupConsent', state.interview_id, { allow: false });
      while (state.question !== 'money_limit') state = await setupState('setupAnswer', state.interview_id, { question: state.question, text: 'Yes' });
      state = await setupState('setupAnswer', state.interview_id, { question: 'money_limit', text });
      const expected = text === 'Up to $500' ? 50_000 : text === '$250.50' ? 25_050 : 0;
      expect(await mockStore.dispatch('setupRules', { params: { id: state.interview_id } }), text).toMatchObject({ status: 200, body: { auto_money_cap_cents: expected } });
    }
  });

  it('suggestions_also_close_a_scripted_run_and_preserve_an_answered_money_limit', async () => {
    let state = await startState('Rivera Plumbing. We fix leaks.');
    state = await setupState('setupConsent', state.interview_id, { allow: false });
    for (const { key: question } of SETUP_QUESTIONS.slice(0, -1)) state = await setupState('setupAnswer', state.interview_id, { question, text: question === 'money_limit' ? 'Up to $500' : 'Yes' });
    state = await setupState('setupSuggestions', state.interview_id, {});
    expect(state.messages.at(-1)?.text).toBe(QUESTIONS_DONE);
    expect(state.messages.at(-2)).toMatchObject({ role: 'claude' });
    expect(state.messages.at(-2)?.text).toMatch(/plan/i);
    expect(await mockStore.dispatch('setupRules', { params: { id: state.interview_id } })).toMatchObject({ status: 200, body: { auto_money_cap_cents: 50_000 } });
  });

  it('refuses_new_actions_before_consent_during_a_turn_and_after_questions', async () => {
    let state = await startState();
    const id = state.interview_id;
    expect(await mockStore.dispatch('setupSuggestions', { params: { id }, body: {} })).toMatchObject({ status: 409 });
    state = await setupState('setupConsent', id, { allow: true });
    const proposal_id = state.messages.find((message) => message.card)!.card!.proposal_id;
    expect(await mockStore.dispatch('setupProposal', { params: { id, proposal_id: 'p-ffffffffffff' }, body: { accept: true } })).toMatchObject({ status: 404 });
    for (const body of [null, [], { text: 'yes' }]) expect(await mockStore.dispatch('setupSuggestions', { params: { id }, body })).toMatchObject({ status: 422 });
    for (const key of ['setupProposal', 'setupSuggestions'] as const) {
      expect(await mockStore.dispatch(key, { params: { id, proposal_id }, body: key === 'setupProposal' ? { accept: true } : {}, malformed: true })).toMatchObject({ status: 422 });
      expect(await mockStore.dispatch(key, { params: { id: 'missing', proposal_id }, body: {} })).toMatchObject({ status: 404 });
    }
    const release = holdNextAnswer(mockStore.world, id);
    await setupState('setupAnswer', id, { question: state.question, text: 'Individuals only' });
    expect(await mockStore.dispatch('setupSuggestions', { params: { id }, body: {} })).toMatchObject({ status: 409 });
    expect(await mockStore.dispatch('setupProposal', { params: { id, proposal_id }, body: { accept: true } })).toMatchObject({ status: 409 });
    release();
    await setupState('setupSuggestions', id, {});
    expect(await mockStore.dispatch('setupProposal', { params: { id, proposal_id }, body: { accept: true } })).toMatchObject({ status: 409 });
    expect(await mockStore.dispatch('setupSuggestions', { params: { id }, body: {} })).toMatchObject({ status: 409 });
    mockStore.reset('rivera', { signedIn: false });
    for (const key of ['setupProposal', 'setupSuggestions'] as const) expect(await mockStore.dispatch(key, { params: { id, proposal_id }, body: {} })).toMatchObject({ status: 401 });
  });

  it('connects_only_accepted_stripe_at_either_transition_to_tools_needing_review', async () => {
    for (const ending of ['answer', 'suggestions'] as const) {
      for (const decision of ['accepted', 'declined', 'proposed'] as const) {
        let state = await startState();
        state = await setupState('setupConsent', state.interview_id, { allow: true });
        const stripe = state.messages.find((message) => message.card?.connector?.app === 'stripe')!.card!;
        const calendar = state.messages.find((message) => message.card?.connector?.app === 'google_calendar')!.card!;
        await setupState('setupProposal', state.interview_id, { accept: true }, calendar.proposal_id);
        if (decision !== 'proposed') await setupState('setupProposal', state.interview_id, { accept: decision === 'accepted' }, stripe.proposal_id);
        const tools = () => mockStore.world.desk(state.desk_id)!.tools.filter((tool) => tool.tool.startsWith('payments.'));
        expect(tools()).toEqual([]);
        if (ending === 'suggestions') state = await setupState('setupSuggestions', state.interview_id, {});
        else while (state.question !== null) state = await setupState('setupAnswer', state.interview_id, { question: state.question, text: state.messages.at(-1)!.choices[0]!.text });
        expect(state.step).toBe('tools');
        expect(tools().map((tool) => [tool.tool, tool.status, tool.review_reason])).toEqual(decision === 'accepted' ? [
          ['payments.list_charges', 'needs_review', 'new'], ['payments.create_refund', 'needs_review', 'new'],
        ] : []);
        expect(mockStore.world.desk(state.desk_id)!.policy.auto_money_cap_cents).toBe(0);
        if (decision === 'accepted') {
          await mockStore.dispatch('setupConnect', { params: { id: state.interview_id }, body: { server: 'mock_payments' } });
          expect(tools()).toHaveLength(2);
        }
      }
    }
  });

  it('suggestions_finish_remaining_topics_with_facts_unchanged_and_unanswered_limits_asking', async () => {
    let state = await startState();
    state = await setupState('setupConsent', state.interview_id, { allow: false });
    state = await setupState('setupAnswer', state.interview_id, { question: state.question, text: 'Individuals only' });
    const before = structuredClone(state);
    const about = mockStore.world.desks.find((desk) => desk.summary.desk_id === state.desk_id)!;
    const publicBefore = setupPublicDesk(mockStore.world, about, 'en');
    state = await setupState('setupSuggestions', state.interview_id, {});
    expect(state.step).toBe('tools');
    expect(state.question).toBeNull();
    expect(state.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(state.messages).toHaveLength(before.messages.length + 2);
    expect(state.messages.at(-2)?.text).toMatch(/Your plan:/);
    expect(state.messages.at(-1)?.text).toBe(QUESTIONS_DONE);
    expect(setupPublicDesk(mockStore.world, about, 'en')).toEqual(publicBefore);
    const draft = await mockStore.dispatch('setupRules', { params: { id: state.interview_id } });
    expect(draft).toMatchObject({ status: 200, body: { auto_money_cap_cents: 0 } });
    if ('network' in draft || draft.status !== 200) throw new Error('setupRules must answer');
    const cards = (draft.body as import('../api/views.ts').RulesDraft).cards;
    expect(cards.filter((card) => ['native.quote', 'native.release_document', 'effect:charge', 'effect:pay_out'].includes(card.applies_to)).every((card) => card.mode === 'ask')).toBe(true);
  });

  it('rejects_invalid_proposal_changes_atomically', async () => {
    const start = await startState();
    const state = await setupState('setupConsent', start.interview_id, { allow: true });
    const cards = state.messages.flatMap((message) => message.card ? [message.card] : []);
    const payment = cards.find((card) => card.job?.job === 'payment')!;
    const bodies: unknown[] = [
      {}, null, [], { accept: 'yes' }, { accept: true, unknown: 1 },
      { accept: false, title: 'Changed' }, { accept: false, amount_cents: 0 },
      ...['', '  ', 'x'.repeat(61), null, 42].map((title) => ({ accept: true, title })),
      ...[-1, 1_000_001, 0.5, null, '100'].map((amount_cents) => ({ accept: true, amount_cents })),
    ];
    for (const body of bodies) {
      expect(await mockStore.dispatch('setupProposal', { params: { id: state.interview_id, proposal_id: payment.proposal_id }, body }), JSON.stringify(body)).toMatchObject({ status: 422 });
      expect(await setupState('setup', state.interview_id)).toEqual(state);
    }
    for (const card of cards.filter((card) => card !== payment)) {
      expect(await mockStore.dispatch('setupProposal', { params: { id: state.interview_id, proposal_id: card.proposal_id }, body: { accept: true, amount_cents: 0 } })).toMatchObject({ status: 422 });
    }
    const connector = cards.find((card) => card.kind === 'connector')!;
    expect(await mockStore.dispatch('setupProposal', { params: { id: state.interview_id, proposal_id: connector.proposal_id }, body: { accept: true, title: 'Renamed' } })).toMatchObject({ status: 422 });
    for (const amount_cents of [0, 1_000_000]) {
      const changed = await setupState('setupProposal', state.interview_id, { accept: true, title: '😀'.repeat(60), amount_cents }, payment.proposal_id);
      expect(changed.messages.find((message) => message.card?.proposal_id === payment.proposal_id)?.card?.job?.config).toMatchObject({ amount_cents });
    }
  });

  it('accepts_changes_and_replaces_an_earlier_proposal_decision', async () => {
    const start = await startState();
    let state = await setupState('setupConsent', start.interview_id, { allow: true });
    const retainer = state.messages.find((message) => message.card?.job?.job === 'payment')!.card!;
    state = await setupState('setupProposal', state.interview_id, { accept: true, title: 'Updated retainer', amount_cents: 75_000 }, retainer.proposal_id);
    expect(state.messages.find((message) => message.card?.proposal_id === retainer.proposal_id)?.card).toMatchObject({
      state: 'accepted', job: { title: 'Updated retainer', config: { amount_cents: 75_000 } },
    });
    state = await setupState('setupProposal', state.interview_id, { accept: false }, retainer.proposal_id);
    expect(state.messages.find((message) => message.card?.proposal_id === retainer.proposal_id)?.card?.state).toBe('declined');
    state = await setupState('setupProposal', state.interview_id, { accept: true }, retainer.proposal_id);
    expect(state.messages.find((message) => message.card?.proposal_id === retainer.proposal_id)?.card?.state).toBe('accepted');
    const calendar = state.messages.find((message) => message.card?.connector?.app === 'google_calendar')!.card!;
    state = await setupState('setupProposal', state.interview_id, { accept: true }, calendar.proposal_id);
    expect(state.messages.find((message) => message.card?.proposal_id === calendar.proposal_id)?.card?.state).toBe('accepted');
    expect((await setupState('setup', state.interview_id)).messages).toEqual(state.messages);
  });

  it('leads_cpa_topics_skips_quote_and_discount_limits_and_closes_before_tools', async () => {
    let state = await startState();
    state = await setupState('setupConsent', state.interview_id, { allow: false });
    expect(state.messages.some((message) => message.role === 'tool_label')).toBe(false);
    const topics = [];
    while (state.question !== null) {
      topics.push(state.question);
      expect(topics.length).toBeLessThanOrEqual(5);
      const choices = state.messages.at(-1)!.choices;
      expect(choices.length).toBeGreaterThanOrEqual(2);
      expect(choices.length).toBeLessThanOrEqual(4);
      expect(choices.filter((choice) => choice.recommended)).toHaveLength(1);
      expect(choices[0]?.recommended).toBe(true);
      expect(choices.every((choice) => [...choice.text].length <= 80)).toBe(true);
      const text = state.question === 'money_limit' ? 'Up to $250' : choices[0]!.text;
      if (state.question === 'money_limit') expect(choices.map((choice) => choice.text)).toEqual(['Always ask me first', 'Up to $250', 'Up to $500']);
      state = await setupState('setupAnswer', state.interview_id, { question: state.question, text });
      expect(state.messages.filter((message) => message.role === 'owner').at(-1)?.text).toBe(text);
    }
    expect(topics).toEqual(['what_you_do', 'contact_and_after_hours', 'hours_and_area', 'documents_and_payments', 'money_limit']);
    expect(state.step).toBe('tools');
    expect(state.messages.at(-1)?.text).toBe(QUESTIONS_DONE);
    expect(state.messages.at(-2)?.text).toMatch(/plan.*consult.*intake.*retainer/i);
    expect(state.messages.at(-2)?.text).toContain('“');
    const draft = await mockStore.dispatch('setupRules', { params: { id: state.interview_id } });
    expect(draft).toMatchObject({ status: 200, body: { auto_money_cap_cents: 25_000 } });
  });

  it('opens_the_cpa_run_with_understanding_six_stable_cards_and_a_fact_question', async () => {
    let state = await startState();
    expect(state.messages.every((message) => message.card === null)).toBe(true);
    state = await setupState('setupConsent', state.interview_id, { allow: true });
    const read = state.messages.findIndex((message) => message.text === MEMORY_LABEL);
    const opening = state.messages.slice(read + 1);
    expect(opening).toHaveLength(8);
    expect(opening[0]?.text).toMatch(/tax returns.*bookkeeping.*individuals.*small businesses/i);
    expect(opening[0]?.text).toMatch(/clients.*(?:ask|reach out)/i);
    const cards = opening.slice(1, -1).map((message) => message.card!);
    expect(cards.map((card) => card.job?.job ?? card.connector?.app)).toEqual(['schedule', 'intake', 'payment', 'status', 'google_calendar', 'stripe']);
    expect(cards.map((card) => [card.state, card.kind])).toEqual([
      ['proposed', 'job'], ['proposed', 'job'], ['proposed', 'job'], ['proposed', 'job'], ['proposed', 'connector'], ['proposed', 'connector'],
    ]);
    expect(cards[0]?.job).toMatchObject({ title: 'Book a free intro consult', config: { block: 'typed_booking', appointment_type: 'Free intro consult', minutes: 20 }, can_do_today: true });
    expect(cards[1]?.job).toMatchObject({ title: 'New client intake', config: { block: 'intake', questions: ['Is this a personal or business return?', 'Which tax years do you need help with?', 'Have you heard from the IRS or the state?'] }, can_do_today: true });
    expect(cards[2]?.job).toMatchObject({ title: 'Collect a retainer', config: { block: 'purpose_payment', purpose: 'Engagement retainer', amount_cents: 50_000 }, can_do_today: true });
    expect(cards[3]?.job).toMatchObject({ title: "Where's my return?", config: null, can_do_today: false });
    expect(cards[4]?.connector).toMatchObject({ app: 'google_calendar', connectable: false });
    expect(cards[5]?.connector).toMatchObject({ app: 'stripe', connectable: true });
    for (const card of cards) {
      expect(card.proposal_id).toMatch(/^p-[0-9a-f]{12}$/);
      expect(card.job === null).toBe(card.kind === 'connector');
      expect(card.connector === null).toBe(card.kind === 'job');
      expect([...(card.job?.why ?? card.connector!.why)].length).toBeLessThanOrEqual(200);
      if (card.job) {
        expect([...card.job.title].length).toBeLessThanOrEqual(60);
        expect([...card.job.how].length).toBeLessThanOrEqual(300);
      }
    }
    expect(new Set(cards.map((card) => card.proposal_id)).size).toBe(6);
    for (const message of opening.slice(1, -1)) expect(message).toMatchObject({ role: 'claude', text: '', choices: [] });
    expect(state.question).toBe('what_you_do');
    expect(opening.at(-1)?.choices).toHaveLength(3);
    expect(opening.at(-1)?.choices[0]?.recommended).toBe(true);
    const reread = await setupState('setup', state.interview_id);
    expect(reread).toEqual(state);
    for (const message of state.messages) {
      expect(message).toHaveProperty('choices');
      expect(message).toHaveProperty('card');
    }
  });

  it('serves_defaults_on_every_scripted_message_without_changing_the_run', async () => {
    let state = await startState('Rivera Plumbing. We fix leaks.');
    expect(state.messages[0]).toMatchObject({ choices: [], card: null });
    state = await setupState('setupConsent', state.interview_id, { allow: true });
    expect(state.messages.at(-1)?.text).toBe(SETUP_QUESTIONS[0]?.text);
    for (const question of SETUP_QUESTIONS) {
      expect(state.question).toBe(question.key);
      state = await setupState('setupAnswer', state.interview_id, { question: question.key, text: 'Yes' });
    }
    expect(state.step).toBe('tools');
    expect(state.messages.at(-1)?.text).toBe(QUESTIONS_DONE);
    for (const message of state.messages) expect(message).toMatchObject({ choices: [], card: null });
  });
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

  it('with_no_name_given_the_owner_is_setups_fallback', async () => {
    // As the API's setup names the owner (`owner_name`): the name they gave, else "Owner", never
    // the business's name. The same name on the Desk's public page, in the owner's Desks and in
    // Today's greeting.
    const ownerNames = async (description: string) => {
      const answer = await mockStore.dispatch('startSetup', { body: { description, timezone: 'America/Los_Angeles', idempotency_key: `start-${++starts}` } });
      if ('network' in answer || answer.status !== 201) throw new Error('the mock starts a setup');
      const { desk_id: deskId, slug } = answer.body as SetupState;
      const read = async <T,>(key: RouteKey, init: Parameters<typeof mockStore.dispatch>[1]): Promise<T> => {
        const got = await mockStore.dispatch(key, init);
        if ('network' in got || got.status !== 200) throw new Error(`the mock answers ${key}`);
        return got.body as T;
      };
      const desk = await read<PublicDesk>('publicDesk', { params: { slug }, query: { lang: 'en' } });
      const businesses = await read<BusinessOut[]>('desks', {});
      const today = await read<Today>('today', { params: { desk_id: deskId } });
      return {
        publicPage: desk.owner_display_name,
        business: businesses.find((business) => business.desks.some((d) => d.desk_id === deskId))?.owner_display_name,
        greeting: today.greeting_name,
      };
    };
    expect(await ownerNames('Fenster & Fenster. Bespoke windows and doors in Oakland.')).toEqual({ publicPage: 'Owner', business: 'Owner', greeting: 'Owner' });
    expect(await ownerNames("I'm Ana. I run Ana's Bakery in Oakland.")).toEqual({ publicPage: 'Ana', business: 'Ana', greeting: 'Ana' });
  });

  it('the_owner_in_a_setup_desks_chat_is_its_own', async () => {
    // The stream names whoever takes a chat over and types in it as the Desk's business names its
    // owner: setup's fallback when no name was given, never the seeded Rivera's.
    const joinedAs = async (description: string) => {
      const answer = await mockStore.dispatch('startSetup', { body: { description, timezone: 'America/Los_Angeles', idempotency_key: `start-${++starts}` } });
      if ('network' in answer || answer.status !== 201) throw new Error('the mock starts a setup');
      const desk = mockStore.world.desk((answer.body as SetupState).desk_id);
      if (!desk) throw new Error('setup made a Desk');
      const chat = mockStore.world.addSession(desk);
      mockStore.world.takeOver(chat);
      mockStore.world.ownerTyping(chat);
      return chat.events.flatMap(({ ev }) => (ev.type === 'owner_joined' || ev.type === 'owner_typing' ? [`${ev.type} ${ev.name}`] : []));
    };
    expect(await joinedAs('Fenster & Fenster. Bespoke windows and doors in Oakland.')).toEqual(['owner_joined Owner', 'owner_typing Owner']);
    expect(await joinedAs("I'm Ana. I run Ana's Bakery in Oakland.")).toEqual(['owner_joined Ana', 'owner_typing Ana']);
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
    // business's name from its description, the owner greeted by the first name they give, a
    // slug from the business's name, and the work as the line on its public page.
    const expected = {
      en: [
        ['Juniper Hair Studio', 'Priya', 'juniper-hair-studio-setup1', 'Most clients book ahead; we take a deposit for color appointments and charge for late cancellations. We’re open Tuesday to Saturday.'],
        ['Rivera Plumbing', 'Maria', 'rivera-plumbing-setup1', null],
        ['Maple Street Rentals', 'Sam', 'maple-street-rentals-setup1', 'People ask about open units and viewings, tenants report maintenance problems, and I collect application fees and deposits.'],
        ['Chen & Co.', 'Linda', 'chen-co-setup1', 'New clients start with a free 20-minute consult, and we price each engagement after it.'],
      ],
      es: [
        ['Juniper Hair Studio', 'Priya', 'juniper-hair-studio-setup1', 'Casi todos los clientes reservan con anticipación; pedimos un depósito para las citas de color y cobramos las cancelaciones tardías. Abrimos de martes a sábado.'],
        ['Rivera Plumbing', 'Maria', 'rivera-plumbing-setup1', null],
        ['Maple Street Rentals', 'Sam', 'maple-street-rentals-setup1', 'La gente pregunta por unidades disponibles y visitas, los inquilinos reportan problemas de mantenimiento, y yo cobro las cuotas de solicitud y los depósitos.'],
        ['Chen & Co.', 'Linda', 'chen-co-setup1', 'Los clientes nuevos empiezan con una consulta gratis de 20 minutos, y cotizamos cada trabajo después de ella.'],
      ],
    } as const;
    for (const language of ['en', 'es'] as const) {
      // Each language starts its own copy: the translated starters share the same business names.
      mockStore.reset('rivera');
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

  it('a_new_copy_lists_its_desks_with_no_setup', async () => {
    // A new copy (`copies`) and a copy started over (`start_over`) list the seeded Desk, made without
    // setup, so it names none, as the API sends it: null, never left out.
    for (const [key, body] of [
      ['copies', { passcode: 'demo' }],
      ['startOver', undefined],
    ] as const) {
      const answer = await mockStore.dispatch(key, { body });
      if ('network' in answer || answer.status >= 300) throw new Error(`the mock answers ${key}`);
      const desks = (answer.body as CopyOut).desks;
      expect(desks.length, key).toBeGreaterThan(0);
      for (const desk of desks) expect(desk, key).toHaveProperty('setup', null);
    }
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
