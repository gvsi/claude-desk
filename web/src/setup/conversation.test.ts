import { describe, expect, it } from 'vitest';
import type { ProposalCard, SetupMessage, SetupState } from '../api/views.ts';
import { decisionBody, isCard, liveChoices } from './conversation.ts';

const payment: ProposalCard = {
  proposal_id: 'p-000000000001', kind: 'job', state: 'proposed', superseded_by: null, connector: null,
  job: {
    job: 'payment', title: 'Collect a retainer', why: 'Start the engagement.', how: 'Send a payment link.', can_do_today: true, autonomy: 'ask',
    config: { block: 'purpose_payment', purpose: 'Engagement retainer', amount_cents: 50_000 },
  },
};
const message = (fields: Partial<SetupMessage> = {}): SetupMessage => ({ role: 'claude', text: 'Question?', choices: [], card: null, ...fields });
const state = (messages: SetupMessage[]): SetupState => ({
  interview_id: 'i1', desk_id: 'd1', slug: 'chen', step: 'questions', consent: true, question: 'what_you_do', messages,
});

describe('setup conversation', () => {
  it('requires_an_owner_amount_before_accepting_an_unpriced_payment_job', () => {
    const unpriced: ProposalCard = { ...payment, job: { ...payment.job!, config: { block: 'purpose_payment', purpose: 'Retainer', amount_cents: null } } };
    for (const action of ['accept', 'change'] as const) {
      const result = decisionBody({ action, proposal: unpriced, title: 'Retainer', autonomy: 'ask' });
      expect(result).toMatchObject({ ok: false, field: 'amount_cents', code: 'amount_required', message: expect.any(String) });
      expect(result).not.toHaveProperty('body');
    }
    expect(decisionBody({ action: 'decline', proposal: unpriced })).toEqual({ ok: true, body: { accept: false } });
    for (const amount_cents of [0, 1_000_000]) {
      expect(decisionBody({ action: 'accept', proposal: unpriced, amount_cents })).toEqual({ ok: true, body: { accept: true, amount_cents } });
    }
  });

  it('includes_job_autonomy_only_on_acceptance_and_rejects_connector_autonomy', () => {
    for (const autonomy of ['auto', 'ask'] as const) {
      expect(decisionBody({ action: 'change', proposal: payment, autonomy })).toEqual({ ok: true, body: { accept: true, autonomy } });
      expect(decisionBody({ action: 'decline', proposal: payment, autonomy })).toEqual({ ok: true, body: { accept: false } });
    }
    const connector: ProposalCard = { ...payment, kind: 'connector', job: null, connector: { app: 'stripe', label: 'Stripe', why: 'Payments', connectable: true } };
    expect(decisionBody({ action: 'change', proposal: connector, autonomy: 'auto' })).toMatchObject({ ok: false, field: 'autonomy' });
  });

  it('returns_field_errors_instead_of_bodies_for_invalid_changes', () => {
    for (const title of ['', '   ', 'x'.repeat(61)]) {
      expect(decisionBody({ action: 'change', proposal: payment, title })).toMatchObject({ ok: false, field: 'title' });
    }
    expect(decisionBody({ action: 'change', proposal: payment, title: '😀'.repeat(60) })).toMatchObject({ ok: true });
    for (const amount_cents of [-1, 1_000_001, 0.5, NaN, Infinity]) {
      expect(decisionBody({ action: 'change', proposal: payment, amount_cents })).toMatchObject({ ok: false, field: 'amount_cents' });
    }
    const schedule: ProposalCard = { ...payment, job: { ...payment.job!, config: { block: 'typed_booking', appointment_type: 'Intro', minutes: 20 } } };
    const connector: ProposalCard = { ...payment, kind: 'connector', job: null, connector: { app: 'stripe', label: 'Stripe', why: 'Payments', connectable: true } };
    for (const proposal of [schedule, connector]) {
      expect(decisionBody({ action: 'change', proposal, amount_cents: 100 })).toMatchObject({ ok: false, field: 'amount_cents' });
    }
    expect(decisionBody({ action: 'change', proposal: connector, title: 'Renamed' })).toMatchObject({ ok: false, field: 'title' });
    expect(decisionBody({ action: 'change', proposal: schedule, title: 'Intro' })).toEqual({ ok: true, body: { accept: true, title: 'Intro' } });
  });

  it('builds_declines_accepts_and_trimmed_payment_changes', () => {
    expect(decisionBody({ action: 'decline', proposal: payment, title: 'Ignored', amount_cents: -1 })).toEqual({ ok: true, body: { accept: false } });
    expect(decisionBody({ action: 'accept', proposal: payment })).toEqual({ ok: true, body: { accept: true } });
    for (const amount_cents of [0, 1_000_000]) {
      expect(decisionBody({ action: 'change', proposal: payment, title: '  New retainer  ', amount_cents }))
        .toEqual({ ok: true, body: { accept: true, title: 'New retainer', amount_cents } });
    }
  });

  it('keeps_only_the_latest_choices_live_until_an_owner_answers', () => {
    const choices = [{ text: 'New clients', recommended: true }, { text: 'Existing clients', recommended: false }];
    const messages = [message({ choices }), message({ text: '', card: payment }), message({ role: 'tool_label' }), message()];
    expect(liveChoices(state(messages))).toEqual({ index: 0, choices });
    expect(liveChoices(state([...messages, message({ choices })]))).toEqual({ index: 4, choices });
    expect(liveChoices(state([...messages, message({ role: 'owner' }), message()]))).toBeNull();
    expect(liveChoices(state([message({ text: '', card: payment, choices })]))).toBeNull();
    expect(liveChoices(state([message({ role: 'owner', choices })]))).toBeNull();
    expect(liveChoices({ ...state([]), messages: [{ role: 'claude', text: 'Old API' }] })).toBeNull();
    for (const fields of [{ step: 'tools' as const }, { consent: null }, { question: null }]) {
      expect(liveChoices({ ...state(messages), ...fields })).toBeNull();
    }
    expect(liveChoices({ ...state(messages), consent: false })).toEqual({ index: 0, choices });
  });

  it('identifies_card_messages_and_tolerates_older_messages', () => {
    expect(isCard(message({ text: '', card: payment }))).toBe(true);
    expect(isCard(message({ text: '' }))).toBe(false);
    expect(isCard({ role: 'claude', text: 'Old API' })).toBe(false);
  });
});
