/**
 * The mock's setup interview, driven the way its handlers drive it: the business's name it reads
 * from the owner's description, the way a reader would, and the slug and first question that follow;
 * the unfinished setup the owner's Desks name until the Desk goes live; the situations it tries,
 * titled for the business; and the Desk it makes, which speaks for its own owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicDesk, RenderedBlock, SseEvent } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type { BusinessOut, CopyOut, DemoAgentRun, RulesDraft, SetupState, SetupTools, SituationResult, Today } from '../api/views.ts';
import { cardBlock, rivera } from '../ds/fixtures/index.ts';
import { PUBLIC_COPY } from '../public/copy.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { AGENT_TURN_GAP_MS } from './agents.ts';
import { businessToolRows, seedBusinessTools } from './businessTools.ts';
import { EVENT_GAP_MS } from './script.ts';
import { RIVERA } from './seed.ts';
import {
  holdNextDecision, holdNextConsent, holdNextAnswer, MEMORY_LABEL, QUESTIONS_DONE, SETUP_QUESTIONS, setupPublicDesk, setupTaskSet,
  thanksTo, TEST_CLIENT_ADDED, TEST_CLIENT_NO, TEST_CLIENT_OFFER, TEST_CLIENT_YES,
} from './setup.ts';
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

  it('appends_accepted_jobs_in_order_without_replacing_a_taken_tool_name', async () => {
    let state = await cpaAt('schedule');
    const desk = mockStore.world.desk(state.desk_id)!;
    seedBusinessTools(desk, businessToolRows([state.messages.at(-1)!.card!.job!]));
    const toolsBefore = structuredClone(desk.tools);
    state = await setupState('setupSuggestions', state.interview_id, {});
    const response = await mockStore.dispatch('setupTools', { params: { id: state.interview_id } });
    if ('network' in response || response.status !== 200) throw new Error('setup tools must answer 200');
    expect((response.body as SetupTools).tools.filter(({ source }) => source === 'business').map(({ tool, business, status }) => [tool, business?.title, status])).toEqual([
      ['desk.book-a-free-intro-call', 'Book a free intro call', 'needs_review'],
      ['desk.book-a-free-intro-call-2', 'Book a free intro call', 'needs_review'],
      ['desk.ask-new-clients-three-questions', 'Ask new clients three questions', 'needs_review'],
    ]);
    expect(desk.tools.slice(0, toolsBefore.length)).toEqual(toolsBefore);
  });

  it('both_finish_paths_leave_a_non_consultant_desks_tools_unchanged', async () => {
    for (const ending of ['answer', 'suggestions']) {
      let state = await startState('Rivera Plumbing. We fix leaks.');
      const id = state.interview_id;
      state = await setupState('setupConsent', id, { allow: false });
      const desk = mockStore.world.desk(state.desk_id)!;
      const toolsBefore = structuredClone(desk.tools);
      const policyBefore = structuredClone(desk.policy);
      if (ending === 'suggestions') state = await setupState('setupSuggestions', id, {});
      else for (const { key: question } of SETUP_QUESTIONS) state = await setupState('setupAnswer', id, { question, text: 'Yes' });
      expect(state.step, ending).toBe('tools');
      const response = await mockStore.dispatch('setupTools', { params: { id } });
      if ('network' in response || response.status !== 200) throw new Error('setup tools must answer 200');
      expect((response.body as SetupTools).tools.filter(({ source }) => source === 'business'), ending).toEqual([]);
      expect(desk.tools, ending).toEqual(toolsBefore);
      expect(desk.policy, ending).toEqual(policyBefore);
    }
  });

  it('use_your_suggestions_serves_the_accepted_booking_and_keeps_the_intake_declined', async () => {
    let state = await cpaAt('intake');
    const id = state.interview_id;
    state = await setupState('setupProposal', id, { accept: false }, state.pending_card!);
    state = await setupState('setupSuggestions', id, {});
    expect(state.step).toBe('tools');
    expect(state.messages.some(({ role, text }) => role === 'owner' && text === 'Use your suggestions')).toBe(true);
    expect(state.messages.find(({ card }) => card?.job?.job === 'intake')?.card?.state).toBe('declined');
    const response = await mockStore.dispatch('setupTools', { params: { id } });
    if ('network' in response || response.status !== 200) throw new Error('setup tools must answer 200');
    expect((response.body as SetupTools).tools.filter(({ source }) => source === 'business')).toEqual([
      expect.objectContaining({
        tool: 'desk.book-a-free-intro-call', status: 'needs_review', review_reason: 'new',
        business: {
          title: 'Book a free intro call', description: 'New clients pick a time within your opening hours and book a 20-minute call.',
          config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 },
        },
      }),
    ]);
  });

  it('finishing_the_last_answer_serves_only_the_accepted_booking_as_a_business_tool', async () => {
    let state = await cpaAt('schedule');
    const id = state.interview_id;
    const booking = state.messages.at(-1)!.card!.job!;
    const desk = mockStore.world.desk(state.desk_id)!;
    const toolsBefore = structuredClone(desk.tools);
    const policyBefore = structuredClone(desk.policy);
    while (state.pending_card) {
      const card = state.messages.at(-1)!.card!;
      state = await setupState('setupProposal', id, { accept: card.job?.job === 'schedule' }, card.proposal_id);
    }
    state = await setupState('setupAnswer', id, { question: state.question, text: 'Ask me before every payment' });
    expect(state.step).toBe('tools');
    const response = await mockStore.dispatch('setupTools', { params: { id } });
    if ('network' in response || response.status !== 200) throw new Error('setup tools must answer 200');
    const rows = (response.body as SetupTools).tools.filter(({ source }) => source === 'business');
    expect(rows).toEqual([expect.objectContaining({
      tool: 'desk.book-a-free-intro-call', source: 'business', status: 'needs_review', review_reason: 'new',
      business: { title: 'Book a free intro call', description: booking.how, config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 } },
      definition_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pending_definition_text: null, pending_sha256: null, cards: [],
    })]);
    expect(desk.tools.slice(0, toolsBefore.length)).toEqual(toolsBefore);
    expect(desk.tools).toHaveLength(toolsBefore.length + 1);
    expect(desk.policy).toEqual(policyBefore);
  });

  it('names_the_cpa_booking_free_intro_call', async () => {
    const state = await cpaAt('schedule');
    expect(state.messages.at(-1)?.card?.job?.config).toEqual({ block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 });
  });

  it.each(['google_calendar', 'stripe'] as const)('keeps_an_accepted_%s_disconnected_when_its_simulated_connect_fails_once', async (app) => {
    let state = await cpaAt(app);
    const id = state.interview_id;
    const proposal_id = state.pending_card!;
    const tools = structuredClone(mockStore.world.desk(state.desk_id)!.tools);
    const release = holdNextDecision(mockStore.world, id);
    expect(await mockStore.dispatch('setupProposal', { params: { id, proposal_id }, query: { cards: '1' }, body: { accept: true } })).toMatchObject({ status: 202, body: { busy: true } });
    release('connection_failed');
    state = await setupState('setup', id);
    expect(state.messages.find(({ card }) => card?.proposal_id === proposal_id)?.card).toMatchObject({ state: 'accepted', connector: { connected: false } });
    expect(mockStore.world.desk(state.desk_id)!.tools).toEqual(tools);
    expect(state.messages.at(-2)?.text).not.toMatch(/^Connected\./);
    // A failure affects just one simulated attempt; reaching Tools can complete it later.
    state = await setupState('setupSuggestions', id, {});
    expect(state.messages.find(({ card }) => card?.proposal_id === proposal_id)?.card?.connector?.connected).toBe(true);
  });

  it('connects_google_calendar_in_chat_without_adding_unsupported_tools', async () => {
    let state = await startState();
    const id = state.interview_id;
    state = await setupState('setupConsent', id, { allow: true });
    state = await setupState('setupAnswer', id, { question: state.question, text: 'Both, about evenly' });
    const calendar = state.messages.at(-1)!.card!;
    expect(calendar).toMatchObject({ kind: 'connector', state: 'proposed', connector: { app: 'google_calendar', connectable: true, connected: false } });
    expect(state.pending_card).toBe(calendar.proposal_id);
    const tools = structuredClone(mockStore.world.desk(state.desk_id)!.tools);
    state = await setupState('setupProposal', id, { accept: true }, calendar.proposal_id);
    expect(state.messages.find(({ card }) => card?.proposal_id === calendar.proposal_id)?.card?.state).toBe('accepted');
    expect(state.messages.find(({ card }) => card?.proposal_id === calendar.proposal_id)?.card?.connector?.connected).toBe(true);
    expect(state.messages.at(-1)!.card?.job?.job).toBe('schedule');
    expect(state.messages.at(-2)).toMatchObject({ role: 'claude', text: 'Connected. Now the intro call.', card: null });
    expect(mockStore.world.desk(state.desk_id)!.tools).toEqual(tools);
    state = await setupState('setupSuggestions', id, {});
    expect(state.messages.flatMap(({ card }) => card?.connector ? [card.connector.connectable] : [])).toEqual([true, true]);
    expect(state.messages.flatMap(({ card }) => card?.connector ? [card.connector.connected] : [])).toEqual([true, true]);
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

describe('the test-client offer, as the API asks it', () => {
  const LAKEVIEW = 'Lakeview Accounts. I’m Lee. We help local businesses.';
  const CONTACT = 'Email me at lee@example.com. After hours, take a message.';
  const OFFER = {
    role: 'claude', text: TEST_CLIENT_OFFER, card: null,
    choices: [{ text: TEST_CLIENT_YES, recommended: true }, { text: TEST_CLIENT_NO, recommended: false }],
  };

  /** A scripted run to its end, typing `contact` on the contact question; or, with `suggestions`, using the suggestions once it's typed. */
  async function finished(contact: string, suggestions = false): Promise<SetupState> {
    let state = await startState(LAKEVIEW);
    const id = state.interview_id;
    state = await setupState('setupConsent', id, { allow: false });
    for (const { key: question } of SETUP_QUESTIONS.slice(0, -1)) state = await setupState('setupAnswer', id, { question, text: 'Yes' });
    if (!suggestions) return setupState('setupAnswer', id, { question: 'contact_and_after_hours', text: contact });
    // An answer that leaves the contact question open keeps it waiting, as a follow-up does.
    state = await setupState('setupAnswer', id, { question: 'contact_and_after_hours', text: `Not sure yet. ${contact}` });
    expect(state.question).toBe('contact_and_after_hours');
    return setupState('setupSuggestions', id, {});
  }

  it('asks_once_after_the_closing_plan_when_the_owner_typed_their_contact', async () => {
    const state = await finished(CONTACT);
    expect([state.step, state.question]).toEqual(['questions', 'test_client']);
    expect(state.messages.slice(-2)).toEqual([{ role: 'claude', text: QUESTIONS_DONE, choices: [], card: null }, OFFER]);
    // With no contact of the owner's own, as the API reads it: none typed, hours only, another person's or a rejected one.
    for (const contact of [
      'Yes', 'The same as on my website.', 'We are open 8.00-17.00', 'Ana: ana@example.test',
      'Call my assistant Ana at (510) 555-0142 or email ana@example.test.', 'Do not use old@example.test or 510-555-0142.',
      'Ana’s email is ana@example.test',
    ]) {
      const without = await finished(contact);
      expect([without.step, without.question, without.messages.at(-1)?.text], contact).toEqual(['tools', null, QUESTIONS_DONE]);
    }
    for (const contact of ['Ana handles bookings. My own email is lee@example.com.', 'Ana: ana@example.test, Lee: lee@example.com']) {
      expect((await finished(contact)).question, contact).toBe('test_client');
    }
  });

  it('a_yes_says_done_and_not_now_says_nothing_and_both_move_to_tools', async () => {
    for (const [text, said] of [[TEST_CLIENT_YES, [TEST_CLIENT_ADDED]], [TEST_CLIENT_NO, []], ['Sure, go ahead', [TEST_CLIENT_ADDED]], ["don't add me", []]] as const) {
      const offered = await finished(CONTACT);
      const state = await setupState('setupAnswer', offered.interview_id, { question: 'test_client', text });
      expect([state.step, state.question], text).toEqual(['tools', null]);
      expect(state.messages.slice(-1 - said.length), text).toEqual([
        { role: 'owner', text, choices: [], card: null }, ...said.map((line) => ({ role: 'claude', text: line, choices: [], card: null })),
      ]);
      expect(await mockStore.dispatch('setupAnswer', { params: { id: offered.interview_id }, body: { question: 'test_client', text } }), text).toMatchObject({ status: 409 });
    }
  });

  it('an_answer_that_is_neither_yes_nor_no_gets_the_same_offer_again', async () => {
    // A question or a conditional yes is no yes, whatever words it holds.
    for (const text of ['What does that mean?', 'What does add me as a test client mean?', 'What happens if I say yes?', "If it's free, yes"]) {
      const offered = await finished(CONTACT);
      const state = await setupState('setupAnswer', offered.interview_id, { question: 'test_client', text });
      expect([state.step, state.question], text).toEqual(['questions', 'test_client']);
      expect(state.messages.slice(-2), text).toEqual([{ role: 'owner', text, choices: [], card: null }, OFFER]);
    }
  });

  it('use_your_suggestions_reaches_the_same_offer_and_using_them_again_moves_on', async () => {
    const state = await finished(CONTACT, true);
    expect([state.step, state.question]).toEqual(['questions', 'test_client']);
    expect(state.messages.at(-2)?.text).toContain('Your plan for Lakeview Accounts:');
    expect(state.messages.at(-1)).toEqual(OFFER);
    const moved = await setupState('setupSuggestions', state.interview_id, {});
    expect([moved.step, moved.question]).toEqual(['tools', null]);
    expect(moved.messages.slice(-2)).toEqual([OFFER, { role: 'owner', text: 'Use your suggestions', choices: [], card: null }]);
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

  it('a_name_that_ends_in_a_stop_is_thanked_with_one', () => {
    // The description's reading never gives such a name, but the thanks mustn't add a second stop.
    expect(thanksTo('Bob Smith Jr.')).toBe('Thanks, Bob Smith Jr.');
    expect(thanksTo('Maria')).toBe('Thanks, Maria.');
    expect(thanksTo(null)).toBe('Thanks.');
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
        // The raw description states free and a duration, so it stays private before public lines are seeded.
        ['Chen & Co.', 'Linda', 'chen-co-setup1', null],
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

describe("the real situations, in the business's own words", () => {
  /**
   * The situations setup tries on `description`'s draft and the draft itself, every question answered
   * and $500 the money limit: the scripted questions, or the CPA run's proposals (its unpriced
   * retainer declined) and its money turn, opted into.
   */
  async function triedOn(description: string): Promise<{ rows: SituationResult[]; draft: RulesDraft }> {
    let state = await startState(description);
    const id = state.interview_id;
    state = await setupState('setupConsent', id, { allow: false });
    for (let turn = 0; state.step === 'questions'; turn += 1) {
      if (turn > 20) throw new Error('setup must reach its tools');
      const card = state.messages.find((message) => message.card !== null && message.card.proposal_id === state.pending_card)?.card;
      if (card) {
        state = await setupState('setupProposal', id, { accept: card.job?.job !== 'payment' }, card.proposal_id);
        continue;
      }
      const offered = state.messages.at(-1)?.choices.map(({ text }) => text) ?? [];
      const text = state.question === 'money_limit' ? (offered.includes('Set an amount now') ? 'Set an amount now' : 'Up to $500') : (offered[0] ?? 'Yes, that works.');
      state = await setupState('setupAnswer', id, { question: state.question, text });
    }
    const drafted = await mockStore.dispatch('setupRules', { params: { id } });
    if ('network' in drafted || drafted.status !== 200) throw new Error('setup must draft its rules');
    const draft = drafted.body as RulesDraft;
    expect(draft.auto_money_cap_cents, description).toBe(50000);
    const tried = await mockStore.dispatch('setupSituations', { params: { id } });
    if ('network' in tried || tried.status !== 200) throw new Error('setup must try its situations');
    return { rows: tried.body as SituationResult[], draft };
  }

  /** Where the two bookings the bookings rule (card-2) decides sit: a Tuesday afternoon, and the Saturday morning. */
  const WEEKDAY = 0;
  const SATURDAY = 4;
  /** Where the verified customer's own document sits. */
  const DOCUMENT = 3;
  /**
   * Everything a situation tries and what the kernel said, but its words. Two more fields follow
   * each business's own days and are left out here, then checked on their own: the reason the
   * bookings rule gives on the two bookings, and who the Saturday booking is (a salon open on
   * Saturdays has no "after hours" there).
   */
  const probed = (rows: readonly SituationResult[]) =>
    rows.map(({ situation, result, matches }, at) => {
      const booking = at === WEEKDAY || at === SATURDAY;
      return {
        who: at === SATURDAY ? null : situation.who,
        probe: situation.probe,
        expected: situation.expected,
        result: booking ? { ...result, reason_plain: null } : result,
        matches,
      };
    });
  /** Each situation's who, plan and result, as the owner reads them. */
  const outcomes = (rows: readonly SituationResult[]) =>
    rows.map(({ situation, result, matches }) => [situation.who, situation.expected, result.outcome, result.reason_plain, result.card_ids, result.depends_on_review, matches]);
  /** Rivera Plumbing's situations, as they always were. */
  const RIVERA_OUTCOMES = [
    ['public', 'allow', 'allow', 'Books weekday visits in your hours.', ['card-2'], false, true],
    ['public', 'hold', 'hold', 'Discounts ask you first.', [], false, true],
    ['agent', 'allow_if_reviewed', 'hold', 'Within its signed limit, checked by the reviewer.', ['card-7'], true, true],
    ['verified', 'allow', 'allow', 'Sends customers their own documents.', ['card-4'], false, true],
    ['after_hours', 'hold', 'allow', 'Books weekday visits in your hours.', ['card-2'], false, false],
    ['public', 'refuse', 'refuse', 'Private data only to its verified owner.', [], false, true],
  ];
  const cardOf = (draft: RulesDraft, id: string) => draft.cards.find((card) => card.card_id === id);
  /** The draft's cards without the business's own words: the agent payment's reason, and the bookings rule's days and reason. */
  const withoutBusinessWords = (draft: RulesDraft) =>
    draft.cards.map((card) => {
      if (card.card_id === 'card-7') return { ...card, reason: null };
      if (card.card_id === 'card-2') return { ...card, reason: null, hours: card.hours ? { ...card.hours, days: null } : null };
      return card;
    });

  /** Words that belong to a plumber's work: none of them in another business's situations. */
  const PLUMBING = /\b(?:drains?|plumb\w*|leaks?|water heaters?|service calls?|visits?)\b/i;
  const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
  /**
   * The starters, in `START_EXAMPLES`' order: their situations; the reason of the rule that lets
   * agents pay; the days the bookings rule books on its own and its reason; and who the Saturday
   * booking is.
   */
  const STARTERS: readonly { business: string; titles: readonly string[]; reason: string; days: readonly string[]; bookings: string; saturday: string }[] = [
    {
      business: 'Juniper Hair Studio',
      titles: [
        'A visitor wants a cut on Tuesday afternoon',
        'A visitor asks for 10% off a cut and color',
        'An agent pays the color appointment deposit',
        'A client asks for their last receipt',
        'A visitor wants balayage on Saturday morning',
        "Someone asks for another client's phone number",
      ],
      reason: 'Agents pay the color appointment deposit within their signed limit, checked by the reviewer.',
      // Open Tuesday to Saturday, so a Saturday visitor isn't after hours.
      days: ['tue', 'wed', 'thu', 'fri', 'sat'],
      bookings: 'Books appointments Tuesday to Saturday in your hours.',
      saturday: 'public',
    },
    {
      // Rivera Plumbing's are the situations as they always were.
      business: 'Rivera Plumbing',
      titles: [
        'A visitor wants a drain cleared on Tuesday afternoon',
        'A visitor asks for 10% off if they pay cash',
        'An agent pays the service call deposit',
        'A customer asks for their last invoice',
        'A visitor wants a Saturday morning visit for a slow drain',
        "Someone asks for another customer's address",
      ],
      reason: 'Agents pay the service call deposit within their signed limit, checked by the reviewer.',
      days: WEEKDAYS,
      bookings: 'Books weekday visits in your hours.',
      saturday: 'after_hours',
    },
    {
      business: 'Maple Street Rentals',
      titles: [
        'A visitor wants a viewing on Tuesday afternoon',
        "A visitor asks for 10% off the first month's rent",
        'An agent pays the application fee',
        'A tenant asks for a copy of their lease',
        'A visitor wants a Saturday morning viewing',
        'Someone asks which apartment another tenant lives in',
      ],
      reason: 'Agents pay the application fee within their signed limit, checked by the reviewer.',
      days: WEEKDAYS,
      bookings: 'Books weekday viewings in your hours.',
      saturday: 'after_hours',
    },
    {
      business: 'Chen & Co.',
      titles: [
        'A visitor wants a free consult on Tuesday afternoon',
        'A visitor asks for 10% off their tax return',
        'An agent pays the retainer',
        "A client asks for last year's return",
        'A visitor wants a free consult on Saturday morning',
        "Someone asks for another client's tax return",
      ],
      reason: 'Agents pay the retainer within their signed limit, checked by the reviewer.',
      days: WEEKDAYS,
      bookings: 'Books weekday consults in your hours.',
      saturday: 'after_hours',
    },
  ];

  /**
   * The business's own bookings: the bookings rule books its days in the same hours with its own
   * reason, which both bookings give; the Saturday booking is `saturday` and still not what the
   * answers planned ("Saturday bookings ask you first."); and the agent payment's rule names
   * `reason`.
   */
  function expectOwnBookings(rows: readonly SituationResult[], draft: RulesDraft, own: { days: readonly string[]; bookings: string; saturday: string; reason: string }, label: string): void {
    expect(cardOf(draft, 'card-2'), label).toMatchObject({ applies_to: 'native.book', mode: 'auto', hours: { days: own.days, start: '08:00:00', end: '18:00:00' }, reason: own.bookings });
    expect([rows[WEEKDAY]?.result.reason_plain, rows[SATURDAY]?.result.reason_plain], label).toEqual([own.bookings, own.bookings]);
    expect([rows[SATURDAY]?.situation.who, rows[SATURDAY]?.matches], label).toEqual([own.saturday, false]);
    expect(cardOf(draft, 'card-3'), label).toMatchObject({ applies_to: 'native.book', mode: 'ask', hours: { days: ['sat'] }, reason: 'Saturday bookings ask you first.' });
    expect(cardOf(draft, 'card-7')?.reason, label).toBe(own.reason);
  }

  it('each_starter_gets_its_own_words_with_riveras_probes_and_results', async () => {
    const rivera = await triedOn(START_EXAMPLES.en.examples[1]?.description ?? '');
    for (const language of ['en', 'es'] as const) {
      for (const [at, { chip, description }] of START_EXAMPLES[language].examples.entries()) {
        const starter = STARTERS[at];
        if (!starter) throw new Error(`no starter at ${at}`);
        const { rows, draft } = await triedOn(description);
        const titles = rows.map(({ situation }) => situation.title);
        expect(titles, `${chip}: ${starter.business}`).toEqual(starter.titles);
        if (starter.business === 'Rivera Plumbing') expect(outcomes(rows), chip).toEqual(RIVERA_OUTCOMES);
        else for (const title of titles) expect(title, chip).not.toMatch(PLUMBING);
        // The English CPA run drafts its other cards from its own answers, which never ask about
        // documents: its document row follows its own documents rule
        // (`chens_answered_run_changes_only_where_its_draft_asks`), so it isn't compared here.
        const consultant = language === 'en' && starter.business === 'Chen & Co.';
        const sameAsRivera = (r: readonly SituationResult[]) => probed(r).filter((_, row) => !consultant || row !== DOCUMENT);
        // Only the words, and the bookings that follow the business's own days, change: what each
        // situation tries, plans and gets is otherwise Rivera's.
        expect(sameAsRivera(rows), chip).toEqual(sameAsRivera(rivera.rows));
        expectOwnBookings(rows, draft, starter, chip);
        // Nothing else about the cards changes. Only the two rules with the business's words are
        // compared for the English CPA run.
        const compared = (d: RulesDraft) => withoutBusinessWords(d).filter((card) => !consultant || card.card_id === 'card-2' || card.card_id === 'card-7');
        expect(compared(draft), chip).toEqual(compared(rivera.draft));
      }
    }
  });

  it('a_business_no_starter_describes_gets_words_that_fit_any_business', async () => {
    const rivera = await triedOn(START_EXAMPLES.en.examples[1]?.description ?? '');
    for (const description of [
      "I'm Lena, and Lena's Bike Repair fixes bikes in Berkeley, Monday to Saturday.",
      'Soy Ana. Tengo la Panadería Ana en Oakland: pan de masa madre y pasteles por encargo.',
      // A word that only starts like "hair" names no salon.
      'Lake Dental is a dental practice treating cavities, chipped teeth and hairline cracks.',
    ]) {
      const { rows, draft } = await triedOn(description);
      const titles = rows.map(({ situation }) => situation.title);
      expect(titles, description).toEqual([
        'A visitor wants to book a time on Tuesday afternoon',
        'A visitor asks for 10% off if they pay cash',
        'An agent pays the deposit',
        'A customer asks for their last invoice',
        'A visitor wants to book a time on Saturday morning',
        "Someone asks for another customer's address",
      ]);
      for (const title of titles) expect(title, description).not.toMatch(PLUMBING);
      expect(probed(rows), description).toEqual(probed(rivera.rows));
      expectOwnBookings(rows, draft, {
        days: WEEKDAYS,
        bookings: 'Books weekday times in your hours.',
        saturday: 'after_hours',
        reason: 'Agents pay the deposit within their signed limit, checked by the reviewer.',
      }, description);
      expect(withoutBusinessWords(draft), description).toEqual(withoutBusinessWords(rivera.draft));
    }
  });

  /**
   * The situations setup tries on `description`'s draft and the draft itself, after "Use your
   * suggestions" with the first question unanswered: every limit left unanswered asks first.
   */
  async function triedOnSuggestions(description: string): Promise<{ rows: SituationResult[]; draft: RulesDraft }> {
    const id = (await startState(description)).interview_id;
    expect((await setupState('setupConsent', id, { allow: false })).question, description).toBe('what_you_do');
    await setupState('setupSuggestions', id, {});
    const drafted = await mockStore.dispatch('setupRules', { params: { id } });
    if ('network' in drafted || drafted.status !== 200) throw new Error('setup must draft its rules');
    const tried = await mockStore.dispatch('setupSituations', { params: { id } });
    if ('network' in tried || tried.status !== 200) throw new Error('setup must try its situations');
    return { rows: tried.body as SituationResult[], draft: drafted.body as RulesDraft };
  }

  /** A situation's plan and result as the owner reads them, and whether it is what was planned. */
  const read = (row: SituationResult | undefined) => [row?.situation.expected, row?.result.outcome, row?.result.reason_plain, row?.result.card_ids, row?.matches];
  /** Where the rows the answers didn't plan for sit. */
  const flagged = (rows: readonly SituationResult[]) => rows.flatMap((row, at) => (row.matches ? [] : [at]));
  /** Juniper Hair Studio, Rivera Plumbing, and a business no starter describes. */
  const SUGGESTED = [
    START_EXAMPLES.en.examples[0]?.description ?? '',
    START_EXAMPLES.en.examples[1]?.description ?? '',
    "I'm Lena, and Lena's Bike Repair fixes bikes in Berkeley, Monday to Saturday.",
  ];

  it('a_booking_asks_when_the_suggestions_left_bookings_asking', async () => {
    // The Rules step showed "Bookings ask you first": the weekday booking asks, as planned.
    for (const description of SUGGESTED) {
      const { rows, draft } = await triedOnSuggestions(description);
      expect(cardOf(draft, 'card-2'), description).toMatchObject({ applies_to: 'native.book', mode: 'ask', reason: 'Bookings ask you first.' });
      expect(read(rows[WEEKDAY]), description).toEqual(['hold', 'hold', 'Bookings ask you first.', ['card-2'], true]);
    }
  });

  it('a_customers_own_document_asks_when_the_suggestions_left_documents_asking', async () => {
    // Juniper's Rules step showed "Documents ask you first": the client's receipt asks, as planned.
    const { rows, draft } = await triedOnSuggestions(SUGGESTED[0] ?? '');
    expect(cardOf(draft, 'card-4'), 'Juniper').toMatchObject({ applies_to: 'native.release_document', mode: 'ask', reason: 'Documents ask you first.' });
    expect(rows[DOCUMENT]?.situation.title).toBe('A client asks for their last receipt');
    expect(read(rows[DOCUMENT]), 'Juniper').toEqual(['hold', 'hold', 'Documents ask you first.', ['card-4'], true]);
  });

  it('nothing_is_flagged_when_the_suggestions_left_bookings_asking', async () => {
    // The Saturday booking is planned to ask first, as the answers' Saturday rule says. Where the
    // bookings rule books it on its own, that isn't what was planned (`expectOwnBookings`); where
    // the suggestions left bookings asking first too, it is, and no row is flagged.
    for (const description of SUGGESTED) {
      const { rows } = await triedOnSuggestions(description);
      expect(flagged(rows), description).toEqual([]);
      expect(read(rows[SATURDAY]), description).toEqual(['hold', 'hold', 'Bookings ask you first.', ['card-2'], true]);
    }
  });

  it('the_suggestions_draft_names_each_rule_once', async () => {
    // The Saturday rule already asks first, so it keeps its own reason when the suggestions leave
    // bookings asking first too, and the Rules step lists every reason once.
    for (const description of SUGGESTED) {
      const { draft } = await triedOnSuggestions(description);
      expect(cardOf(draft, 'card-3'), description).toMatchObject({ applies_to: 'native.book', mode: 'ask', reason: 'Saturday bookings ask you first.' });
      const reasons = draft.cards.map((card) => card.reason);
      expect(reasons.filter((reason, at) => reasons.indexOf(reason) !== at), description).toEqual([]);
    }
  });

  it('chens_answered_run_changes_only_where_its_draft_asks', async () => {
    // The CPA run never asks about documents, so its draft's documents rule asks first, as its
    // Rules step shows: the client's return asks, as planned. Every other row is as it was.
    const { rows, draft } = await triedOn(START_EXAMPLES.en.examples[3]?.description ?? '');
    expect(cardOf(draft, 'card-4')).toMatchObject({ applies_to: 'native.release_document', mode: 'ask', reason: 'Documents ask you first.' });
    const bookings = 'Books weekday consults in your hours.';
    expect(outcomes(rows)).toEqual([
      ['public', 'allow', 'allow', bookings, ['card-2'], false, true],
      ['public', 'hold', 'hold', 'Discounts ask you first.', [], false, true],
      ['agent', 'allow_if_reviewed', 'hold', 'Within its signed limit, checked by the reviewer.', ['card-7'], true, true],
      ['verified', 'hold', 'hold', 'Documents ask you first.', ['card-4'], false, true],
      ['after_hours', 'hold', 'allow', bookings, ['card-2'], false, false],
      ['public', 'refuse', 'refuse', 'Private data only to its verified owner.', [], false, true],
    ]);
  });
});

describe("the built-in agent's task words on a Desk setup made", () => {
  it('each_starter_gets_its_business_type_and_the_seed_none', async () => {
    // As setup's start reads a type in the description: the salon is "other", the plumber a trade,
    // the rentals a landlord and the CPA firm an office, in either language. The seeded Desk, which
    // setup didn't make, has none (its set is Rivera's).
    const expected = ['other', 'trade', 'landlord', 'office'];
    for (const language of ['en', 'es'] as const) {
      mockStore.reset('rivera');
      const types = [];
      for (const { description } of START_EXAMPLES[language].examples) {
        const desk = await started(description);
        const made = mockStore.world.desks.find((d) => d.summary.slug === desk.slug);
        types.push(made === undefined ? undefined : setupTaskSet(mockStore.world, made.summary.desk_id));
      }
      expect(types, language).toEqual(expected);
      expect(setupTaskSet(mockStore.world, mockStore.world.desks[0]?.summary.desk_id ?? '')).toBeNull();
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

describe('a Desk setup made, speaking for its own owner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A Desk the mock's setup made from `description` and took live, the owner taking Claude's suggestions: its slug. */
  async function liveDesk(description: string): Promise<string> {
    const { interview_id: id, slug } = await startState(description);
    const steps: [RouteKey, unknown][] = [
      ['setupConsent', { allow: false }],
      ['setupSuggestions', {}],
      ...(['setupRules', 'setupSituations', 'setupSafetyCheck', 'setupConfirm', 'goLive'] as const).map((key): [RouteKey, unknown] => [key, undefined]),
    ];
    for (const [key, body] of steps) {
      const answer = await mockStore.dispatch(key, { params: { id }, body });
      if ('network' in answer || answer.status !== 200) throw new Error(`the mock answers ${key}`);
    }
    return slug;
  }

  /** The events this browser's chat with the Desk on `slug` gets while `act` runs and its turn plays out. */
  async function eventsWhile(slug: string, act: () => Promise<unknown>): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    const stop = mockStore.listen(slug, 0, (_seq, ev) => events.push(ev));
    const before = events.length;
    await act();
    await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
    stop();
    return events.slice(before);
  }

  /** The events of the Desk's turn answering `text`, sent in this browser's chat with the Desk on `slug`. */
  async function turnOn(slug: string, text: string): Promise<SseEvent[]> {
    const opened = await mockStore.dispatch('openSession', { params: { slug } });
    if ('network' in opened || opened.status !== 200) throw new Error('the mock opens a chat');
    return eventsWhile(slug, async () => {
      const sent = await mockStore.dispatch('sendMessage', { params: { slug }, body: { text } });
      if ('network' in sent || sent.status !== 202) throw new Error('the mock takes the message');
    });
  }

  /** The blocks of the Desk's replies to `text`, sent in this browser's chat with the Desk on `slug`. */
  async function repliesTo(slug: string, text: string): Promise<RenderedBlock[]> {
    return (await turnOn(slug, text)).flatMap((ev) => (ev.type === 'message' ? ev.blocks : []));
  }

  /** The visitor's status lines in a turn, in order: each decision's, then each reply's. */
  function linesOf(events: readonly SseEvent[]): string[] {
    return events.flatMap((ev) => ('visitor_plain' in ev ? [ev.visitor_plain] : []));
  }

  /** Claude's own words in a turn's replies. */
  function proseOf(events: readonly SseEvent[]): (string | null)[] {
    return events.flatMap((ev) => (ev.type === 'message' ? ev.blocks.filter((b) => b.kind === 'prose').map((b) => b.text) : []));
  }

  it('the_callback_and_booking_cards_name_that_owner', async () => {
    // The kernel's cards, of the same kinds, facts and shapes, name the Desk's own owner.
    const slug = await liveDesk(CPA);
    const callback = (title: string) => cardBlock('callback_confirmed', { fact_id: 'handoff:callback', title });
    expect(await repliesTo(slug, 'Can you call me back?')).toEqual([callback('Linda will call you back on Monday, between 8:00 am and 9:00 am')]);
    expect(await repliesTo(slug, 'Please call me tonight')).toEqual([callback('Linda will call you back')]);
    expect(await repliesTo(slug, 'Llámame, por favor')).toEqual([callback('Linda te llamará el lunes, entre las 8:00 y las 9:00')]);

    expect((await repliesTo(slug, 'Book the first one')).at(-1)).toEqual(
      cardBlock('booking_confirmed', { fact_id: 'booking:B-77', title: 'Tuesday, November 3', lines: ['Arriving 2:00 pm to 4:00 pm', 'With Linda'] }),
    );
    expect((await repliesTo(slug, '¿Me reservas la primera?')).at(-1)).toEqual(
      cardBlock('booking_confirmed', { fact_id: 'booking:B-77', title: 'martes 3 de noviembre', lines: ['Llegada de 14:00 a 16:00', 'Con Linda'] }),
    );
    // Rivera's Desk books with the fixtures' own card.
    expect((await repliesTo(RIVERA.slug, 'Book the first one')).at(-1)).toEqual(rivera.blocks.booking_confirmed.en);
    expect((await repliesTo(RIVERA.slug, '¿Me reservas la primera?')).at(-1)).toEqual(rivera.blocks.booking_confirmed.es);
  });

  /** The Desk's card for the newest payment link once a change to the rules cancels it, as the visitor's chat gets it. */
  async function linkCancelledOn(slug: string): Promise<SseEvent[]> {
    const newest = [...mockStore.world.links].at(-1);
    if (newest === undefined) throw new Error('the Desk issued a payment link');
    const [token, link] = newest;
    return eventsWhile(slug, async () => mockStore.world.cancelLink(token, link, 'rules_changed'));
  }

  it('the_owner_in_the_chat_and_a_cancelled_link_name_that_owner', async () => {
    // A deposit link Linda's rules cancelled says so in the kernel's words, and her own words in
    // the chat she took over are marked as hers.
    const slug = await liveDesk(CPA);
    await turnOn(slug, 'Can I pay the deposit?');
    const cancelled = await linkCancelledOn(slug);
    expect(linesOf(cancelled)).toEqual(["Reply checked against Linda's rules"]);
    expect(cancelled.flatMap((ev) => (ev.type === 'message' ? ev.blocks.map((b) => b.lines?.at(-1)) : []))).toEqual([
      "This payment link was cancelled because Linda's rules changed. Ask again if you still want to pay.",
    ]);

    const chat = mockStore.visitorSession(slug);
    if (!chat) throw new Error('the visitor has a chat');
    const { session_id, generation } = chat.state;
    const said = await eventsWhile(slug, async () => {
      await mockStore.dispatch('takeover', { params: { session_id }, body: { generation } });
      await mockStore.dispatch('ownerMessage', { params: { session_id }, body: { text: 'Hi, it is Linda.', kind: 'say' } });
    });
    expect(linesOf(said)).toEqual(['Written by Linda']);
  });

  it('a_name_that_ends_in_a_stop_gets_one', async () => {
    // Setup names an owner by one word, but a Desk's display name can end in a stop: a sentence
    // that ends on it never gets a second.
    const slug = await liveDesk(CPA);
    const desk = mockStore.world.deskBySlug(slug);
    if (!desk) throw new Error('setup made the Desk');
    desk.ownerName = 'Bob Smith Jr.';
    expect(await repliesTo(slug, PUBLIC_COPY.en.askForOwner('Bob Smith Jr.'))).toEqual([
      cardBlock('handoff', { fact_id: null, title: 'Let me check with Bob Smith Jr.', lines: ['Bob Smith Jr. will reply here.'] }),
    ]);
    expect(await repliesTo(slug, PUBLIC_COPY.es.askForOwner('Bob Smith Jr.'))).toEqual([
      cardBlock('handoff', { fact_id: null, title: 'Déjame consultarlo con Bob Smith Jr.', lines: ['Bob Smith Jr. te responderá aquí.'] }),
    ]);
    await turnOn(slug, '¿Puedo pagar el depósito?');
    const cancelled = await linkCancelledOn(slug);
    expect(cancelled.flatMap((ev) => (ev.type === 'message' ? ev.blocks.map((b) => b.lines?.at(-1)) : []))).toEqual([
      'Este enlace de pago se canceló porque cambiaron las reglas de Bob Smith Jr. Pídelo de nuevo si todavía quieres pagar.',
    ]);
  });

  it('what_only_the_owner_can_answer_names_that_owner', async () => {
    // Claude's plain answer when nothing more specific fits: Linda can tell, and the visitor can ask
    // for her by name, as the page's "Ask for Linda" does.
    const slug = await liveDesk(CPA);
    expect(proseOf(await turnOn(slug, 'Should we file jointly this year?'))).toEqual([
      'Linda can tell you after taking a look. You can ask for Linda here anytime.',
    ]);
    expect(proseOf(await turnOn(slug, 'Hola'))).toEqual(['Linda te lo puede decir cuando lo vea. Puedes pedir hablar con Linda aquí cuando quieras.']);
  });

  it('rivera_keeps_her_signed_held_line', async () => {
    // Rivera's Desk keeps the signed boards' words, in either language.
    const asked = await turnOn(RIVERA.slug, 'Can I get 10% off?');
    expect(linesOf(asked)).toEqual(['Waiting for Maria Rivera to approve', "Reply checked against Maria Rivera's rules"]);
    expect(proseOf(asked)).toEqual(["That's for Maria to decide, so I've asked her. Her answer will show up here."]);
    const pedido = await turnOn(RIVERA.slug, '¿Me hacen un descuento?');
    expect(linesOf(pedido)).toEqual(['Esperando la aprobación de Maria Rivera', 'Respuesta revisada con las reglas de Maria Rivera']);
    expect(proseOf(pedido)).toEqual(['Eso lo decide Maria, así que ya le pregunté. Su respuesta aparecerá aquí.']);
  });

  it('a_held_request_waits_for_that_owner_by_name', async () => {
    // A discount past the quote card's limit waits for Linda. Claude says so naming her, with no
    // pronoun the Desk can't know, and her answer comes back naming her too.
    const slug = await liveDesk(CPA);
    const asked = await turnOn(slug, 'Can I get 10% off?');
    expect(linesOf(asked)).toEqual(['Waiting for Linda to approve', "Reply checked against Linda's rules"]);
    expect(proseOf(asked)).toEqual(["That's for Linda to decide, so I've asked. The answer will show up here."]);
    const pedido = await turnOn(slug, '¿Me hacen un descuento?');
    expect(linesOf(pedido)).toEqual(['Esperando la aprobación de Linda', 'Respuesta revisada con las reglas de Linda']);
    expect(proseOf(pedido)).toEqual(['Eso lo decide Linda, así que ya le pregunté. Su respuesta aparecerá aquí.']);

    const held = asked.find((ev) => ev.type === 'held');
    if (held?.type !== 'held') throw new Error('the discount was held');
    const answered = await eventsWhile(slug, () => mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } }));
    expect(linesOf(answered)).toEqual(['Linda lo aprobó', 'Cotizado con la lista de precios de Linda', 'Respuesta revisada con las reglas de Linda']);
    const retenido = pedido.find((ev) => ev.type === 'held');
    if (retenido?.type !== 'held') throw new Error('the discount was held');
    const denied = await eventsWhile(slug, () => mockStore.dispatch('answer', { params: { decision_id: retenido.decision_id }, body: { answer: 'deny_once' } }));
    expect(linesOf(denied)).toEqual(['Linda decidió no seguir adelante', 'Pasado a Linda para responder']);
  });

  it('the_status_lines_name_that_owner', async () => {
    // As the kernel renders them from the Desk's owner_display_name: on Linda's Desk a quote's
    // receipt and its reply's check name her, in either language.
    const slug = await liveDesk(CPA);
    expect(linesOf(await turnOn(slug, 'How much is it?'))).toEqual(["Quoted from Linda's price list", "Reply checked against Linda's rules"]);
    expect(linesOf(await turnOn(slug, '¿Cuánto cuesta?'))).toEqual(['Cotizado con la lista de precios de Linda', 'Respuesta revisada con las reglas de Linda']);
  });

  it('asking_for_the_owner_hands_off_to_that_owner_by_name', async () => {
    // What the public page's "Ask for Linda" sends, in either language, as the kernel's handoff card
    // answers it on her Desk.
    const slug = await liveDesk(CPA);
    expect(await repliesTo(slug, PUBLIC_COPY.en.askForOwner('Linda'))).toEqual([
      cardBlock('handoff', { fact_id: null, title: 'Let me check with Linda.', lines: ['Linda will reply here.'] }),
    ]);
    expect(await repliesTo(slug, PUBLIC_COPY.es.askForOwner('Linda'))).toEqual([
      cardBlock('handoff', { fact_id: null, title: 'Déjame consultarlo con Linda.', lines: ['Linda te responderá aquí.'] }),
    ]);
    // Rivera's Desk still hands off to Maria Rivera, in the fixtures' own words.
    expect(await repliesTo(RIVERA.slug, PUBLIC_COPY.en.askForOwner('Maria Rivera'))).toEqual([rivera.blocks.handoff.en]);
    expect(await repliesTo(RIVERA.slug, PUBLIC_COPY.es.askForOwner('Maria Rivera'))).toEqual([rivera.blocks.handoff.es]);
  });

  it('asking_for_the_owner_by_first_name_reaches_the_handoff', async () => {
    // A visitor's own words, not only the page's button: Linda's first name reaches her on her
    // Desk, and Maria's reaches Maria only on Rivera's.
    const slug = await liveDesk(CPA);
    const toLinda = { en: cardBlock('handoff', { fact_id: null, title: 'Let me check with Linda.', lines: ['Linda will reply here.'] }) };
    const asked = await turnOn(slug, 'Can I speak with Linda?');
    expect(asked.flatMap((ev) => (ev.type === 'message' ? ev.blocks : []))).toEqual([toLinda.en]);
    expect(linesOf(asked)).toEqual(['Passed to Linda to answer']);
    expect(await repliesTo(slug, '¿Está LINDA?')).toEqual([
      cardBlock('handoff', { fact_id: null, title: 'Déjame consultarlo con Linda.', lines: ['Linda te responderá aquí.'] }),
    ]);
    expect(await repliesTo(slug, 'Can I speak with Maria?')).not.toContainEqual(toLinda.en);
    expect(await repliesTo(RIVERA.slug, 'Can I speak with Maria?')).toEqual([rivera.blocks.handoff.en]);
  });

  it('the_verification_code_names_that_business', async () => {
    // The code the kernel sends to the contact on record names the Desk's own business, as its
    // public page does, in the chat's language; Rivera's reads as before.
    const codesFor = async (slug: string, text: string) => {
      await turnOn(slug, text);
      const sessionId = mockStore.visitorSession(slug)?.state.session_id;
      return mockStore.world.inbox.filter((record) => record.sessionId === sessionId).map((record) => record.entry.body).at(-1);
    };
    const slug = await liveDesk(CPA);
    expect(await codesFor(slug, 'Can you send my invoice?')).toBe(
      "Your Chen & Co. code is 482913. It expires in ten minutes. If you didn't ask for it, ignore this message.",
    );
    expect(await codesFor(slug, 'Necesito mi factura')).toBe('Tu código de Chen & Co. es 482913. Vence en diez minutos. Si no lo pediste, ignora este mensaje.');
    expect(await codesFor(RIVERA.slug, 'Can you send my invoice?')).toBe(
      "Your Rivera Plumbing code is 482913. It expires in ten minutes. If you didn't ask for it, ignore this message.",
    );
    expect(await codesFor(RIVERA.slug, 'Necesito mi factura')).toBe(
      'Tu código de Rivera Plumbing es 482913. Vence en diez minutos. Si no lo pediste, ignora este mensaje.',
    );
  });

  it('the_kept_cards_handoff_names_that_owner', async () => {
    // The demo command whose checked card is kept with Claude's drafted handoff: the handoff is the
    // Desk's own, and Rivera's Desk still gets the fixtures' card.
    const slug = await liveDesk(CPA);
    expect((await repliesTo(slug, 'cards-kept-handoff')).at(-1)).toEqual(
      cardBlock('handoff', { fact_id: null, title: 'Let me check with Linda.', lines: ['Linda will reply here.'] }),
    );
    expect((await repliesTo(slug, 'tarjetas-con-traspaso')).at(-1)).toEqual(
      cardBlock('handoff', { fact_id: null, title: 'Déjame consultarlo con Linda.', lines: ['Linda te responderá aquí.'] }),
    );
    expect(await repliesTo(RIVERA.slug, 'cards-kept-handoff')).toEqual([rivera.blocks.quote.en, rivera.blocks.handoff.en]);
    expect(await repliesTo(RIVERA.slug, 'tarjetas-con-traspaso')).toEqual([rivera.blocks.quote.es, rivera.blocks.handoff.es]);
  });

  it('with_no_owner_name_the_lines_name_the_business_owner', async () => {
    // Setup's fallback, "Owner", is no one's name, and the page never shows it. The lines that would
    // name the owner say "the business owner" instead, the words the page's "Ask for a person" uses,
    // and a visitor can ask for a person in their own words.
    const fenster = await liveDesk('Fenster & Fenster. Bespoke windows and doors in Oakland.');
    const toTheOwner = {
      en: cardBlock('handoff', { fact_id: null, title: 'Let me check with the business owner.', lines: ['The business owner will reply here.'] }),
      es: cardBlock('handoff', { fact_id: null, title: 'Déjame consultarlo con el dueño del negocio.', lines: ['El dueño del negocio te responderá aquí.'] }),
    };
    expect(await repliesTo(fenster, PUBLIC_COPY.en.askForOwner(null))).toEqual([toTheOwner.en]);
    expect(await repliesTo(fenster, PUBLIC_COPY.es.askForOwner(null))).toEqual([toTheOwner.es]);
    expect(await repliesTo(fenster, 'Can I speak with a person?')).toEqual([toTheOwner.en]);
    expect(await repliesTo(fenster, '¿Puedo ver a una persona?')).toEqual([toTheOwner.es]);

    expect(linesOf(await turnOn(fenster, 'How much is it?'))).toEqual(["Quoted from the business owner's price list", "Reply checked against the business owner's rules"]);
    expect(linesOf(await turnOn(fenster, '¿Cuánto cuesta?'))).toEqual([
      'Cotizado con la lista de precios del dueño del negocio',
      'Respuesta revisada con las reglas del dueño del negocio',
    ]);
    expect(proseOf(await turnOn(fenster, 'Should we go with oak or walnut?'))).toEqual([
      'The business owner can tell you after taking a look. You can ask for a person here anytime.',
    ]);
    expect(proseOf(await turnOn(fenster, 'Hola'))).toEqual([
      'El dueño del negocio te lo puede decir cuando lo vea. Puedes pedir hablar con una persona aquí cuando quieras.',
    ]);
    expect(await repliesTo(fenster, 'Call me tonight')).toEqual([
      cardBlock('callback_confirmed', { fact_id: 'handoff:callback', title: 'The business owner will call you back' }),
    ]);

    const asked = await turnOn(fenster, 'Can I get 10% off?');
    expect(linesOf(asked)).toEqual(['Waiting for the business owner to approve', "Reply checked against the business owner's rules"]);
    expect(proseOf(asked)).toEqual(["That's for the business owner to decide, so I've asked. The answer will show up here."]);
    const held = asked.find((ev) => ev.type === 'held');
    if (held?.type !== 'held') throw new Error('the discount was held');
    const answered = await eventsWhile(fenster, () => mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } }));
    expect(linesOf(answered)[0]).toBe('The business owner approved this');
  });

  it('an_agent_at_a_desk_not_yet_live_is_handed_to_its_owner', async () => {
    // Until the Desk goes live its Answering is off, so the built-in agent's booking gets the
    // handoff, to the Desk's own owner.
    const { slug } = await startState(CPA);
    const opened = await mockStore.dispatch('openSession', { params: { slug } });
    if ('network' in opened || opened.status !== 200) throw new Error('the mock opens a chat');
    const sent = await mockStore.dispatch('sendAgent', { params: { slug }, body: { task: 'book_visit', idempotency_key: 'agent-at-linda' } });
    if ('network' in sent || sent.status !== 202) throw new Error('the mock sends the agent');
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 6);
    const read = await mockStore.dispatch('agentRun', { params: { slug, run_id: (sent.body as { run_id: string }).run_id } });
    if ('network' in read || read.status !== 200) throw new Error('the mock reads the run');
    const run = read.body as DemoAgentRun;
    expect(run.state).toBe('done');
    expect(run.turns.filter((turn) => turn.author === 'desk').map((turn) => turn.blocks)).toEqual([
      [cardBlock('handoff', { fact_id: null, title: 'Let me check with Linda.', lines: ['Linda will reply here.'] })],
    ]);
  });
});
