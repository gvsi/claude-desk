/**
 * The mock API answers in the contracts' shapes: every row of the script is run, the holds are
 * answered both ways, and every contract payload the mock produced is checked against
 * `backend/desk/contracts.schema.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionState } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type { ApprovalAnswerOut, HealthOut, NeedsYouItem, OwnerTranscript, VisitorSession, VisitorTranscript } from '../api/views.ts';
import { EVENT_GAP_MS, SCRIPT, type RuleName } from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore, type MockRequestInit } from './store.ts';
import { validateContract } from './validate.ts';

/** Text for every row of the script, in English and Spanish where the row reads Spanish. */
const SAMPLES: Record<RuleName, string[]> = {
  discount: ['Can I get 50% off if I pay cash?', '¿Me hacen un descuento?'],
  invoice: ['Can you send my invoice?', 'Necesito mi factura'],
  deposit: ['How do I pay the deposit?', 'Quiero pagar'],
  booked: ['Book the first one', 'Quiero reservar la primera'],
  book: ['Can I book Tuesday?', 'Quiero reservar'],
  price: ['How much is drain clearing?', '¿Cuánto cuesta?'],
  callback: ['Can you call me back?', 'Please call me tonight', 'Llámame'],
  talk: ["I'd like to talk to Maria Rivera.", 'Quiero hablar con Maria'],
  outage: ['outage'],
  other: ['Hello there', 'Hola'],
};

async function body(key: RouteKey, init: MockRequestInit = {}): Promise<unknown> {
  const answer = await mockStore.dispatch(key, init);
  if ('network' in answer || answer.status >= 300) throw new Error(`${key} answered ${JSON.stringify(answer)}`);
  return answer.body;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockStore.reset('rivera_two_desks');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mock payloads', () => {
  it('mock_payloads_match_contracts', async () => {
    // The check can fail: a missing field, a field the contract doesn't have, an unknown model.
    expect(validateContract('EvWriting', { type: 'writing' })).toEqual([]);
    expect(validateContract('EvMessage', { type: 'message' })).not.toEqual([]);
    // A field with a default is still missing: the API's models always send every field.
    expect(validateContract('ProofCheck', { name: 'never_errors', ok: true })).toEqual([
      "ProofCheck/ must have required property 'counterexample_plain'",
      "ProofCheck/ must have required property 'counterexample_raw'",
    ]);
    expect(validateContract('EvWriting', { type: 'writing', text: 'hi' })).not.toEqual([]);
    expect(validateContract('Decision', { ...mockStore.world.decisions.values().next().value?.decision, expires_at: 'soon' })).not.toEqual([]);
    expect(validateContract('NoSuchModel', {})).not.toEqual([]);
    expect(Object.keys(SAMPLES).sort()).toEqual(SCRIPT.map((rule) => rule.name).sort());

    const checks: [model: string, value: unknown][] = [];
    const slug = RIVERA.slug;
    const opened = (await body('openSession', { params: { slug } })) as VisitorSession;
    checks.push(['SessionState', opened.state]);
    for (const text of Object.values(SAMPLES).flat()) {
      await body('sendMessage', { params: { slug }, body: { text } });
      await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 6);
    }

    // On the mock checkout the visitor pays one deposit link, whose payment_confirmed card joins the
    // stream, and cancels another.
    const [paid, dropped] = [...mockStore.world.links.keys()];
    if (paid === undefined || dropped === undefined) throw new Error('the deposit samples issue two links');
    checks.push(['PaymentLinkStateResult', await body('completePayment', { params: { token: paid } })]);
    checks.push(['PaymentLinkStateResult', await body('cancelPayment', { params: { token: dropped } })]);

    // The visitor cancels one of their holds; its resolved receipt joins the stream.
    const held = (await body('needsYou', { params: { desk_id: RIVERA.deskId } })) as NeedsYouItem[];
    const own = held.find((item) => item.decision?.session_id === opened.state.session_id)?.decision;
    if (!own) throw new Error("the discount samples hold this browser's requests");
    await body('cancelRequest', { params: { slug, decision_id: own.decision_id } });

    // Answer each other hold with the answers it offers: the limit holds once each way, and
    // verified Dana's refund (an ask card's hold) allowed for her and denied for good, which draft
    // rule cards.
    const refund = mockStore.world.addHeldRefund();
    const twin = mockStore.world.addHeldRefund();
    const decisions = [...held.flatMap((item) => (item.decision && item.decision !== own ? [item.decision] : [])), refund, twin];
    expect(decisions.length).toBeGreaterThanOrEqual(4);
    const oneTime = ['allow_once', 'deny_once'] as const;
    const forDana = ['allow_person', 'deny_always'] as const;
    for (const [i, decision] of decisions.entries()) {
      const offered = decision.answers ?? [];
      const answer = offered.includes('deny_always') ? forDana[i % forDana.length] : oneTime[i % oneTime.length];
      expect(offered, decision.decision_id).toContain(answer);
      const out = (await body('answer', { params: { decision_id: decision.decision_id }, body: { answer } })) as ApprovalAnswerOut;
      checks.push(['Decision', out.decision], ...(out.card_diff ?? []).map((card): [string, unknown] => ['RuleCard', card]));
    }
    await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 20);
    expect(checks.some(([model]) => model === 'RuleCard')).toBe(true);

    const visitor = (await body('visitorSession', { params: { slug } })) as VisitorTranscript;
    checks.push(['SessionState', visitor.state]);
    const states: SessionState[] = [];
    for (const session of mockStore.world.sessions.values()) {
      const owner = (await body('conversation', { params: { session_id: session.state.session_id } })) as OwnerTranscript;
      states.push(owner.state);
      for (const item of owner.items) if (item.event) checks.push([`Ev${item.event.type[0]?.toUpperCase()}${item.event.type.slice(1)}`, item.event]);
      for (const { ev } of session.events) checks.push(['SseEvent', ev]);
    }
    checks.push(...states.map((state): [string, unknown] => ['SessionState', state]));
    for (const { decision } of mockStore.world.decisions.values()) checks.push(['Decision', decision]);
    for (const { entry } of mockStore.world.inbox) checks.push(['DemoInboxEntry', entry]);
    for (const { view } of mockStore.world.links.values()) checks.push(['PaymentLinkView', view]);

    for (const desk of mockStore.world.desks) {
      const deskId = desk.summary.desk_id;
      checks.push(['LedgerPage', await body('ledger', { params: { desk_id: deskId }, query: { verify: 'true' } })]);
      checks.push(['PolicyVersion', desk.policy], ...desk.policy.cards.map((card): [string, unknown] => ['RuleCard', card]));
      checks.push(['DeskUpdated', await body('setAnswering', { params: { desk_id: deskId }, body: { on: false } })]);
      for (const lang of ['en', 'es']) {
        checks.push(['PublicDesk', await body('publicDesk', { params: { slug: desk.summary.slug }, query: { lang } })]);
      }
    }
    checks.push(['Health', ((await body('health')) as HealthOut).kernel]);

    // Every model the plan names was produced, and the script's events reach every event type it uses.
    const models = new Set(checks.map(([model]) => model));
    for (const model of ['SseEvent', 'Decision', 'SessionState', 'LedgerPage', 'Health', 'PublicDesk', 'RuleCard', 'PolicyVersion']) {
      expect(models, model).toContain(model);
    }
    const types = new Set(checks.filter(([model]) => model === 'SseEvent').map(([, ev]) => (ev as { type: string }).type));
    expect([...types].sort()).toEqual(['demo_inbox', 'error', 'held', 'message', 'receipt', 'resolved', 'turn_end', 'writing']);

    const errors = checks.flatMap(([model, value]) => validateContract(model, value));
    expect(errors).toEqual([]);
  });
});
