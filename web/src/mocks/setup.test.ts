/**
 * The mock's setup interview, driven the way its handlers drive it: the business's name it reads
 * from the owner's description, the way a reader would, and the slug and first question that follow;
 * and the unfinished setup the owner's Desks name until the Desk goes live.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { PublicDesk } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type { BusinessOut, CopyOut, RulesDraft, SetupState, Today } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { holdNextDecision, holdNextConsent, holdNextAnswer, MEMORY_LABEL, QUESTIONS_DONE, SETUP_QUESTIONS, setupPublicDesk } from './setup.ts';
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

/** Advance through the real fixture to a pending job/app or the optional money turn. */
async function cpaAt(kind: string): Promise<SetupState> {
  let state = await startState();
  state = await setupState('setupConsent', state.interview_id, { allow: true });
  state = await setupState('setupAnswer', state.interview_id, { question: state.question, text: 'Both, about evenly' });
  while (state.pending_card) {
    const card = state.messages.at(-1)!.card!;
    if ((card.job?.job ?? card.connector?.app) === kind) return state;
    state = await setupState('setupProposal', state.interview_id, { accept: card.job?.job !== 'payment' }, card.proposal_id);
  }
  return state;
}

describe('setup consultant run and decisions', () => {
  it('keeps_an_unsupported_connector_answer_pending_with_a_neutral_reply', async () => {
    let state = await cpaAt('google_calendar');
    const pending = state.pending_card;
    const card = structuredClone(state.messages.at(-1)!.card!);
    state = await setupState('setupAnswer', state.interview_id, { question: null, card: pending, text: 'We actually use Outlook…' });
    expect(state.pending_card).toBe(pending);
    expect(state.messages.find(({ card }) => card?.proposal_id === pending)?.card).toEqual(card);
    expect(state.messages.at(-1)).toMatchObject({ role: 'claude', text: 'Got it. You can connect it now or leave it for later.', card: null });
  });

  it('introduces_the_status_card_without_repeating_its_line', async () => {
    const state = await cpaAt('status');
    const card = state.messages.at(-1)!.card!;
    expect(state.messages.at(-2)).toMatchObject({ role: 'claude', text: 'Clients also ask where their return stands.', card: null });
    expect(state.messages.at(-2)?.text).not.toBe(card.job?.how);
  });

  it('does_not_assume_agreement_in_the_cpa_opening', async () => {
    let state = await startState();
    state = await setupState('setupConsent', state.interview_id, { allow: true });
    expect(state.messages.find(({ text }) => text.startsWith('Here’s what I’d have your Desk do:'))?.text).toBe('Here’s what I’d have your Desk do: book those free consults, ask new clients a few questions first, and send a retainer link once you’ve priced the work. Questions like “where’s my return?” can come to you for now.');
  });

  it('names_the_cpa_booking_free_intro_call', async () => {
    const state = await cpaAt('schedule');
    expect(state.messages.at(-1)?.card?.job?.config).toEqual({ block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 });
  });

  it('connects_google_calendar_in_chat_without_adding_unsupported_tools', async () => {
    let state = await startState();
    const id = state.interview_id;
    state = await setupState('setupConsent', id, { allow: true });
    state = await setupState('setupAnswer', id, { question: state.question, text: 'Both, about evenly' });
    const calendar = state.messages.at(-1)!.card!;
    expect(calendar).toMatchObject({ kind: 'connector', state: 'proposed', connector: { app: 'google_calendar', connectable: true } });
    expect(state.pending_card).toBe(calendar.proposal_id);
    const tools = structuredClone(mockStore.world.desk(state.desk_id)!.tools);
    state = await setupState('setupProposal', id, { accept: true }, calendar.proposal_id);
    expect(state.messages.find(({ card }) => card?.proposal_id === calendar.proposal_id)?.card?.state).toBe('accepted');
    expect(state.messages.at(-1)!.card?.job?.job).toBe('schedule');
    expect(state.messages.at(-2)).toMatchObject({ role: 'claude', text: 'Connected. Now the intro call.', card: null });
    expect(mockStore.world.desk(state.desk_id)!.tools).toEqual(tools);
    state = await setupState('setupSuggestions', id, {});
    expect(state.messages.flatMap(({ card }) => card?.connector ? [card.connector.connectable] : [])).toEqual([true, true]);
    expect(state.messages.filter(({ role }) => role === 'claude').map(({ text }) => text).join('\n')).not.toMatch(/once it’s available|once it’s in this demo/i);
    expect((await setupState('setup', id)).messages.find(({ card }) => card?.proposal_id === calendar.proposal_id)?.card?.state).toBe('accepted');
  });

  it('reproposes_a_typed_change_with_a_new_id_and_preserves_the_changed_card_on_finish', async () => {
    let state = await cpaAt('schedule');
    const id = state.interview_id;
    const old = structuredClone(state.messages.at(-1)!.card!);
    state = await setupState('setupAnswer', id, { question: null, card: old.proposal_id, text: 'Make it 15 minutes, and check with me before booking.' });
    const updated = state.messages.at(-1)!.card!;
    expect(updated.proposal_id).not.toBe(old.proposal_id);
    expect(updated).toMatchObject({ state: 'proposed', superseded_by: null, job: { title: 'Request a free intro call', autonomy: 'ask', config: { minutes: 15 } } });
    expect(state.pending_card).toBe(updated.proposal_id);
    const changed = state.messages.find(({ card }) => card?.proposal_id === old.proposal_id)!.card!;
    expect(changed).toEqual({ ...old, state: 'changed', superseded_by: updated.proposal_id });
    state = await setupState('setupAnswer', id, { question: null, card: updated.proposal_id, text: 'How would that work?' });
    expect(state.pending_card).toBe(updated.proposal_id);
    expect(state.messages.find(({ card }) => card?.proposal_id === updated.proposal_id)?.card?.state).toBe('proposed');
    state = await setupState('setupSuggestions', id, {});
    expect(state.messages.find(({ card }) => card?.proposal_id === old.proposal_id)?.card).toEqual(changed);
    expect(state.messages.find(({ card }) => card?.proposal_id === updated.proposal_id)?.card?.state).toBe('accepted');
    expect(state.messages.filter(({ role }) => role === 'claude').every(({ text }) => !/\bDone\b/i.test(text))).toBe(true);
    expect(await mockStore.dispatch('setupRules', { params: { id } })).toMatchObject({ status: 200, body: { auto_money_cap_cents: 0 } });
  });

  it('a_read_without_cards_never_names_a_hidden_pending_card', async () => {
    const state = await cpaAt('schedule');
    const response = await mockStore.dispatch('setup', { params: { id: state.interview_id } });
    expect(response).toMatchObject({ status: 200, body: { pending_card: null } });
    if ('network' in response) throw new Error('read failed');
    expect((response.body as SetupState).messages.some(({ card }) => card)).toBe(false);
  });

  it('keeps_questions_done_only_when_no_closing_plan_is_written', async () => {
    let state = await startState('Rivera Plumbing. We fix leaks.');
    state = await setupState('setupConsent', state.interview_id, { allow: false });
    for (const { key: question } of SETUP_QUESTIONS) state = await setupState('setupAnswer', state.interview_id, { question, text: 'Yes' });
    expect(state.messages.at(-1)?.text).toBe(QUESTIONS_DONE);
    expect(state.messages.filter(({ text }) => text === QUESTIONS_DONE)).toHaveLength(1);
    let consultant = await cpaAt('money');
    consultant = await setupState('setupAnswer', consultant.interview_id, { question: consultant.question, text: 'Ask me before every payment' });
    expect(consultant.messages.at(-1)?.text).toContain('Here’s how your Desk will work.');
    expect(consultant.messages.some(({ text }) => text === QUESTIONS_DONE)).toBe(false);
  });

  it('suggestions_preserve_a_scripted_runs_answered_money_limit', async () => {
    let state = await startState('Rivera Plumbing. We fix leaks.');
    state = await setupState('setupConsent', state.interview_id, { allow: false });
    for (const { key: question } of SETUP_QUESTIONS.slice(0, -1)) state = await setupState('setupAnswer', state.interview_id, { question, text: question === 'money_limit' ? 'Up to $500' : 'Yes' });
    state = await setupState('setupSuggestions', state.interview_id, {});
    expect(state.messages.at(-1)?.text).toContain('Your plan for Rivera Plumbing:');
    expect(state.messages.some(({ text }) => text === QUESTIONS_DONE)).toBe(false);
    expect(await mockStore.dispatch('setupRules', { params: { id: state.interview_id } })).toMatchObject({ status: 200, body: { auto_money_cap_cents: 50000 } });
  });

  it('connects_accepted_stripe_in_chat_and_both_finish_paths_keep_its_tools_needing_review', async () => {
    for (const ending of ['answer', 'suggestions']) for (const accept of [true, false]) {
      let state = await cpaAt('stripe');
      const id = state.interview_id;
      state = await setupState('setupProposal', id, { accept }, state.pending_card!);
      const tools = () => mockStore.world.desk(state.desk_id)!.tools.filter(({ tool }) => tool.startsWith('payments.'));
      expect(tools().map(({ status }) => status)).toEqual(accept ? ['needs_review', 'needs_review'] : []);
      if (ending === 'suggestions') state = await setupState('setupSuggestions', id, {});
      else {
        while (state.pending_card) state = await setupState('setupAnswer', id, { question: null, card: state.pending_card, text: 'Not now' });
        state = await setupState('setupAnswer', id, { question: state.question, text: 'Ask me before every payment' });
      }
      expect(state.step).toBe('tools');
      expect(tools().map(({ tool, status, review_reason }) => [tool, status, review_reason])).toEqual(accept ? [['payments.list_charges', 'needs_review', 'new'], ['payments.create_refund', 'needs_review', 'new']] : []);
      if (accept) { await mockStore.dispatch('setupConnect', { params: { id }, body: { server: 'mock_payments' } }); expect(tools()).toHaveLength(2); }
    }
  });

  it('keeps_old_clients_on_words_and_always_serves_message_defaults', async () => {
    for (const cards of [undefined, '0', 'true', '1']) {
      let state = await startState();
      const id = state.interview_id;
      const query: Record<string, string> = cards === undefined ? {} : { cards };
      const consent = await mockStore.dispatch('setupConsent', { params: { id }, query, body: { allow: false } });
      if ('network' in consent) throw new Error('consent failed');
      state = consent.body as SetupState;
      expect(state.pending_card).toBeNull();
      const answered = await mockStore.dispatch('setupAnswer', { params: { id }, query, body: { question: state.question, text: 'Both, about evenly' } });
      if ('network' in answered) throw new Error('answer failed');
      state = answered.body as SetupState;
      expect(state.messages.filter(({ card }) => card)).toHaveLength(cards === '1' ? 1 : 0);
      if (cards !== '1') expect(state.pending_card).toBeNull();
      for (const message of state.messages) { expect(message).toHaveProperty('choices'); expect(message).toHaveProperty('card'); }
      const finished = await mockStore.dispatch('setupSuggestions', { params: { id }, query, body: {} });
      expect(finished).toMatchObject({ status: 200, body: { step: 'tools', pending_card: null } });
      if ('network' in finished) throw new Error('finish failed');
      expect((finished.body as SetupState).messages.filter(({ card }) => card)).toHaveLength(cards === '1' ? 6 : 0);
    }
  });

  it('the_closing_plan_never_offers_a_declined_unpriced_payment', async () => {
    let state = await cpaAt('intake');
    state = await setupState('setupSuggestions', state.interview_id, {});
    expect(state.messages.at(-1)?.text).not.toMatch(/retainer|payment link/i);
    expect(state.messages.at(-1)?.text).toContain('Here’s how your Desk will work.');
  });

  it('a_typed_payment_amount_prices_only_that_job_and_never_grants_money_permission', async () => {
    let state = await cpaAt('payment');
    const payment = state.pending_card!;
    state = await setupState('setupAnswer', state.interview_id, { question: null, card: payment, text: '$750.00' });
    expect(state.messages.find(({ card }) => card?.proposal_id === payment)?.card).toMatchObject({ state: 'changed', superseded_by: state.pending_card, job: { config: { amount_cents: null } } });
    expect(state.messages.at(-1)?.card).toMatchObject({ state: 'proposed', job: { config: { amount_cents: 75000 } } });
    await setupState('setupSuggestions', state.interview_id, {});
    const response = await mockStore.dispatch('setupRules', { params: { id: state.interview_id } });
    expect(response).toMatchObject({ status: 200, body: { auto_money_cap_cents: 0 } });
    if ('network' in response) throw new Error('draft failed');
    expect((response.body as RulesDraft).cards.filter(({ applies_to }) => ['effect:charge', 'effect:pay_out', 'native.payment_link', 'native.charge_mandate'].includes(applies_to)).every(({ mode }) => mode === 'ask')).toBe(true);
  });

  it.each(['accepted', 'declined', 'changed'] as const)('refuses_decisions_on_%s_history_without_changing_anything', async (decision) => {
    let state = await cpaAt('schedule');
    const id = state.interview_id;
    const proposal_id = state.pending_card!;
    state = decision === 'changed'
      ? await setupState('setupAnswer', id, { question: null, card: proposal_id, text: 'Make it 15 minutes.' })
      : await setupState('setupProposal', id, { accept: decision === 'accepted' }, proposal_id);
    expect(state.messages.find(({ card }) => card?.proposal_id === proposal_id)?.card?.state).toBe(decision);
    const before = structuredClone(state);
    const tools = structuredClone(mockStore.world.desk(state.desk_id)!.tools);
    expect(await mockStore.dispatch('setupProposal', { params: { id, proposal_id }, query: { cards: '1' }, body: { accept: decision !== 'accepted' } })).toMatchObject({ status: 409 });
    expect(await setupState('setup', id)).toEqual(before);
    expect(mockStore.world.desk(state.desk_id)!.tools).toEqual(tools);
  });

  it('refuses_zero_payment_decisions_with_amount_required_and_changes_nothing', async () => {
    let state = await cpaAt('payment');
    expect(await mockStore.dispatch('setupProposal', { params: { id: state.interview_id, proposal_id: state.pending_card! }, body: { accept: true, amount_cents: 0 } })).toMatchObject({ status: 422, body: { error: 'amount_required' } });
    expect(await setupState('setup', state.interview_id)).toEqual(state);
    state = await setupState('setupAnswer', state.interview_id, { question: null, card: state.pending_card, text: '$0' });
    const pending = state.pending_card!;
    expect(await mockStore.dispatch('setupProposal', { params: { id: state.interview_id, proposal_id: pending }, body: { accept: true } })).toMatchObject({ status: 422, body: { error: 'amount_required' } });
    expect(await setupState('setup', state.interview_id)).toEqual(state);
    state = await setupState('setupSuggestions', state.interview_id, {});
    expect(state.messages.find(({ card }) => card?.proposal_id === pending)?.card?.state).toBe('declined');
  });

  it('preserves_atomic_validation_and_payment_amount_requirements', async () => {
    let state = await cpaAt('payment');
    const id = state.interview_id;
    const proposal_id = state.pending_card!;
    const params = { id, proposal_id };
    for (const body of [null, [], {}, { accept: 'yes' }, { accept: true, unknown: 1 }, { accept: false, title: 'Changed' }, { accept: false, amount_cents: 0 }, { accept: false, autonomy: 'auto' }, { accept: true, autonomy: 'sometimes' }, ...['', ' ', 'x'.repeat(61), null, 42].map((title) => ({ accept: true, title })), ...[-1, 1000001, 0.5, null, '100'].map((amount_cents) => ({ accept: true, amount_cents }))]) {
      expect(await mockStore.dispatch('setupProposal', { params, body }), JSON.stringify(body)).toMatchObject({ status: 422 });
      expect(await setupState('setup', id)).toEqual(state);
    }
    expect(await mockStore.dispatch('setupProposal', { params, body: { accept: true } })).toMatchObject({ status: 422, body: { error: 'amount_required' } });
    for (const amount_cents of [1, 1000000]) {
      const fresh = await cpaAt('payment');
      const accepted = await setupState('setupProposal', fresh.interview_id, { accept: true, title: 'Updated retainer', autonomy: 'ask', amount_cents }, fresh.pending_card!);
      expect(accepted.messages.find(({ card }) => card?.proposal_id === fresh.pending_card)?.card).toMatchObject({ state: 'accepted', job: { title: 'Updated retainer', autonomy: 'ask', config: { amount_cents } } });
    }
    const connectorState = await cpaAt('stripe');
    for (const body of [{ accept: true, title: 'Renamed' }, { accept: true, amount_cents: 0 }, { accept: true, autonomy: 'auto' }]) {
      expect(await mockStore.dispatch('setupProposal', { params: { id: connectorState.interview_id, proposal_id: connectorState.pending_card! }, body })).toMatchObject({ status: 422 });
    }
    const scheduleState = await cpaAt('schedule');
    expect(await mockStore.dispatch('setupProposal', { params: { id: scheduleState.interview_id, proposal_id: scheduleState.pending_card! }, body: { accept: true, amount_cents: 0 } })).toMatchObject({ status: 422 });
    expect(await mockStore.dispatch('setupProposal', { params: { id, proposal_id: 'missing' }, body: { accept: true } })).toMatchObject({ status: 404 });
    await setupState('setupSuggestions', id, {});
    expect(await mockStore.dispatch('setupProposal', { params, body: { accept: true } })).toMatchObject({ status: 409 });
    expect(await mockStore.dispatch('setupSuggestions', { params: { id }, body: {} })).toMatchObject({ status: 409 });
    mockStore.reset('rivera', { signedIn: false });
    expect(await mockStore.dispatch('setupProposal', { params, body: { accept: true } })).toMatchObject({ status: 401 });
  });

  it('only_sets_money_from_the_opted_in_isolated_turn_and_never_from_unrelated_numbers', async () => {
    for (const [text, cap] of [['Always ask me first', 0], ['Up to $100', 10000], ['Up to $250', 25000], ['Up to $500', 50000], ['I file 2026 returns', 0], ['-500', 0], ['$10,001', 0], ['$250.50', 25050]] as const) {
      let state = await cpaAt('money');
      expect(state.messages.at(-1)?.choices.every(({ recommended }) => !recommended)).toBe(true);
      state = await setupState('setupAnswer', state.interview_id, { question: state.question, text: 'Set an amount now' });
      expect(state.messages.at(-1)?.text).toBe("What's the most I should take or pay out without asking you?");
      expect(state.messages.at(-1)?.choices.map(({ text }) => text)).toEqual(['Always ask me first', 'Up to $100', 'Up to $250', 'Up to $500']);
      state = await setupState('setupAnswer', state.interview_id, { question: state.question, text });
      expect(state.step).toBe('tools');
      const response = await mockStore.dispatch('setupRules', { params: { id: state.interview_id } });
      expect(response, text).toMatchObject({ status: 200, body: { auto_money_cap_cents: cap } });
    }
    let state = await cpaAt('money');
    state = await setupState('setupAnswer', state.interview_id, { question: state.question, text: 'Ask me before every payment' });
    expect(state.messages.some(({ text }) => text === "What's the most I should take or pay out without asking you?")).toBe(false);
    expect(await mockStore.dispatch('setupRules', { params: { id: state.interview_id } })).toMatchObject({ status: 200, body: { auto_money_cap_cents: 0 } });
  });

  it('holds_decisions_and_card_answers_as_202_busy_and_does_not_apply_concurrent_turns', async () => {
    for (const action of ['decision', 'answer'] as const) {
      let state = await cpaAt('schedule');
      const id = state.interview_id;
      const proposal_id = state.pending_card!;
      const release = action === 'decision' ? holdNextDecision(mockStore.world, id) : holdNextAnswer(mockStore.world, id);
      const response = await mockStore.dispatch(action === 'decision' ? 'setupProposal' : 'setupAnswer', {
        params: { id, proposal_id }, query: { cards: '1' }, body: action === 'decision' ? { accept: true } : { question: null, card: proposal_id, text: 'Yes' },
      });
      expect(response).toMatchObject({ status: 202, body: { busy: true, pending_card: proposal_id } });
      if (action === 'answer' && !('network' in response)) expect((response.body as SetupState).messages.at(-1)).toMatchObject({ role: 'owner', text: 'Yes' });
      for (const [key, target, body] of [
        ['setupProposal', proposal_id, { accept: false }],
        ['setupProposal', 'unknown', { accept: true }],
        ['setupSuggestions', undefined, {}],
        ['setupAnswer', undefined, { question: null, card: proposal_id, text: 'No' }],
      ] as const) {
        expect(await mockStore.dispatch(key, { params: { id, ...(target ? { proposal_id: target } : {}) }, query: { cards: '1' }, body })).toEqual(response);
      }
      release();
      state = await setupState('setup', id);
      expect(state.busy).toBe(false);
      expect(state.pending_card).not.toBe(proposal_id);
      expect(state.messages.find(({ card }) => card?.proposal_id === proposal_id)?.card?.state).toBe('accepted');
    }
  });

  it('typed_card_answers_name_exactly_one_target_and_never_accept_an_unpriced_payment', async () => {
    let state = await cpaAt('schedule');
    const id = state.interview_id;
    const pending = state.pending_card;
    for (const body of [{ question: null, text: 'Yes' }, { question: 'what_you_do', card: pending, text: 'Yes' }, { question: null, card: 'p-unknown', text: 'Yes' }]) {
      const response = await mockStore.dispatch('setupAnswer', { params: { id }, body });
      expect(response).toMatchObject({ status: expect.any(Number) });
      expect('status' in response && response.status >= 400).toBe(true);
      expect(await setupState('setup', id)).toEqual(state);
    }
    state = await setupState('setupAnswer', id, { question: null, card: pending, text: 'Yes, please' });
    expect(state.messages.find(({ card }) => card?.proposal_id === pending)?.card?.state).toBe('accepted');
    state = await setupState('setupAnswer', id, { question: null, card: state.pending_card, text: 'Not now' });
    state = await setupState('setupAnswer', id, { question: null, card: state.pending_card, text: 'Yes, please' });
    const payment = state.pending_card;
    state = await setupState('setupAnswer', id, { question: null, card: payment, text: 'Yes, please' });
    expect(state.messages.find(({ card }) => card?.proposal_id === payment)?.card?.state).toBe('declined');
    expect(state.messages.filter(({ role }) => role === 'owner').at(-1)?.text).toBe('Yes, please');
  });

  it('suggestions_record_the_owner_and_finish_all_leftovers_with_safe_unpriced_payments', async () => {
    let state = await cpaAt('intake');
    const before = structuredClone(state);
    state = await setupState('setupSuggestions', state.interview_id, {});
    expect(state).toMatchObject({ step: 'tools', question: null, pending_card: null });
    const extra = state.messages.slice(before.messages.length);
    expect(extra[0]).toMatchObject({ role: 'owner', text: 'Use your suggestions' });
    expect(extra[1]).toMatchObject({ role: 'claude', text: 'Here’s the rest, as I’d set it up.' });
    expect(state.messages.flatMap(({ card }) => card ? [card.state] : [])).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'declined', 'accepted']);
    expect(state.messages.at(-1)?.text).toContain('Here’s how your Desk will work.');
    expect(state.messages.some(({ text }) => text === QUESTIONS_DONE)).toBe(false);
    expect(await mockStore.dispatch('setupRules', { params: { id: state.interview_id } })).toMatchObject({ status: 200, body: { auto_money_cap_cents: 0 } });
  });

  it('asks_one_thing_per_turn_and_keeps_stable_cards_and_earlier_decisions', async () => {
    let state = await startState();
    state = await setupState('setupConsent', state.interview_id, { allow: true });
    expect(state.messages.some(({ card }) => card)).toBe(false);
    expect(state).toMatchObject({ pending_card: null, question: 'what_you_do' });
    state = await setupState('setupAnswer', state.interview_id, { question: state.question, text: 'Both, about evenly' });
    const calendar = state.messages.find(({ card }) => card?.connector?.app === 'google_calendar')!.card!;
    expect(calendar.connector?.connectable).toBe(true);
    const ids = [];
    for (const kind of ['google_calendar', 'schedule', 'intake', 'stripe', 'payment', 'status']) {
      const pending = state.messages.at(-1)!.card!;
      expect(pending.job?.job ?? pending.connector?.app).toBe(kind);
      expect(pending.proposal_id).toMatch(/^p-[0-9a-f]{12}$/);
      expect(state).toMatchObject({ pending_card: pending.proposal_id, question: null });
      expect(state.messages.at(-1)!.choices).toEqual([]);
      ids.push(pending.proposal_id);
      const owners = state.messages.filter(({ role }) => role === 'owner').length;
      state = await setupState('setupProposal', state.interview_id, { accept: kind !== 'payment' }, pending.proposal_id);
      expect(state.messages.filter(({ role }) => role === 'owner')).toHaveLength(owners);
      expect(state.messages.find(({ card }) => card?.proposal_id === pending.proposal_id)?.card?.state).toBe(kind === 'payment' ? 'declined' : 'accepted');
    }
    expect(new Set(ids).size).toBe(6);
    expect(state.messages.at(-1)?.choices.map(({ text }) => text)).toEqual(['Ask me before every payment', 'Set an amount now']);
    expect(await setupState('setup', state.interview_id)).toEqual(state);
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
