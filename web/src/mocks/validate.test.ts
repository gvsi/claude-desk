/**
 * The mock API answers in the contracts' shapes: every row of the script is run, the holds are
 * answered both ways, and every contract payload the mock produced is checked against
 * `backend/desk/contracts.schema.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionState } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type {
  ApprovalAnswerOut,
  HealthOut,
  NeedsYouItem,
  OwnerTranscript,
  RulesDraft,
  RulesView,
  SetupState,
  SetupTools,
  ToolConfirmedOut,
  VisitorSession,
  VisitorTranscript,
} from '../api/views.ts';
import { EVENT_GAP_MS, SCRIPT, type RuleName } from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore, type MockRequestInit } from './store.ts';
import { PENDING_FIELDS, validateContract } from './validate.ts';
import schema from '../../../backend/desk/contracts.schema.json';

/** Text for every row of the script, in English and Spanish where the row reads Spanish. */
const SAMPLES: Record<RuleName, string[]> = {
  'cards-only': ['cards-only', 'solo-tarjetas'],
  'cards-kept-handoff': ['cards-kept-handoff', 'tarjetas-con-traspaso'],
  discount: ['Can I get 50% off if I pay cash?', '¿Me hacen un descuento?'],
  invoice: ['Can you send my invoice?', 'Necesito mi factura'],
  deposit: ['How do I pay the deposit?', 'Quiero pagar'],
  booked: ['Book the first one', 'Quiero reservar la primera'],
  book: ['Can I book Tuesday?', 'Quiero reservar'],
  price: ['How much is drain clearing?', '¿Cuánto cuesta?'],
  area: ['Do you work in Alameda?', '¿Trabajan en Alameda?'],
  callback: ['Can you call me back?', 'Please call me tonight', 'Llámame'],
  talk: ["I'd like to talk to Mike Turner.", 'Quiero hablar con Mike'],
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
  it('pending_fields_wait_for_the_contracts', () => {
    // A field typed by hand ahead of the contracts is checked against its own shape until the
    // contracts have it, and then its entry goes.
    const defs = schema.$defs as Record<string, { properties?: Record<string, unknown> }>;
    for (const [model, fields] of Object.entries(PENDING_FIELDS)) {
      for (const field of Object.keys(fields)) expect(Object.keys(defs[model]?.properties ?? {}), `${model}.${field} is in the contracts now`).not.toContain(field);
    }
    const version = mockStore.world.desks[0]?.policy;
    expect(version?.auto_money_cap_cents).toBe(50_000);
    expect(validateContract('PolicyVersion', version)).toEqual([]);
    expect(validateContract('PolicyVersion', { ...version, auto_money_cap_cents: -1 })).not.toEqual([]);
    expect(validateContract('PolicyVersion', { ...version, auto_money_cap_cents: 1_000_001 })).not.toEqual([]);
    expect(validateContract('PolicyVersion', { ...version, auto_money_cap_cents: '500' })).not.toEqual([]);

    // Why a tool waits for review (kernel payments, plan 01c Task 4), or null when it doesn't.
    const tool = mockStore.world.desks[0]?.tools[0];
    for (const reason of ['new', 'changed', 'delisted', null]) expect(validateContract('ToolProfile', { ...tool, review_reason: reason }), String(reason)).toEqual([]);
    expect(validateContract('ToolProfile', { ...tool, review_reason: 'renamed' })).not.toEqual([]);
  });

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
    checks.push(['DemoAgentIssued', await body('agentKey', { params: { slug } })]);
    for (const text of Object.values(SAMPLES).flat()) {
      await body('sendMessage', { params: { slug }, body: { text } });
      await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 6);
    }

    // On the mock checkout the visitor pays one deposit link, whose payment_confirmed card joins the
    // stream, and cancels another.
    const [paid, dropped] = [...mockStore.world.links.keys()];
    if (paid === undefined || dropped === undefined) throw new Error('the deposit samples issue two links');
    checks.push(['PaymentLinkView', await body('paymentLink', { params: { token: paid } })]);
    checks.push(['PaymentLinkStateResult', await body('completePayment', { params: { token: paid } })]);
    checks.push(['PaymentLinkView', await body('paymentLink', { params: { token: paid } })]);
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
    // What the owner tells a Desk: the stored item the kernel answers with.
    const item = { item_id: 'note-1', source: 'setup', title: 'A note', text: 'A note for the Desk.', label: { readers: ['owner'] } };
    checks.push(['KnowledgeItem', await body('addKnowledge', { params: { desk_id: RIVERA.deskId }, body: { item } })]);

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

    // Rules: the active version, a draft's cards and check, its confirm, and a connector turned off and back on.
    const owner = { params: { desk_id: RIVERA.deskId } };
    const rules = (await body('rules', owner)) as RulesView;
    checks.push(['PolicyVersion', rules.active]);
    const drafted = (await body('draftRules', { ...owner, body: { add: [{ ...rules.active.cards[0], mode: 'ask' }] } })) as RulesDraft;
    checks.push(['ProofReport', drafted.proof], ...drafted.cards.map((card): [string, unknown] => ['RuleCard', card]));
    checks.push(['PolicyVersion', await body('confirmRules', { ...owner, body: { version: drafted.version } })]);
    const stripe = rules.tools.filter((row) => row.source === 'mcp').map((row) => ({ tool: row.tool, definition_sha256: row.definition_sha256 }));
    checks.push(['ToolConfirmed', await body('confirmTool', { ...owner, body: { tools: stripe, enable: false } })]);
    const turnedOn = (await body('confirmTool', { ...owner, body: { tools: stripe, enable: true } })) as ToolConfirmedOut;
    expect(turnedOn.draft).not.toBeNull();
    checks.push(['ToolConfirmed', turnedOn]);

    // Every model the plan names was produced, and the script's events reach every event type it uses.
    const models = new Set(checks.map(([model]) => model));
    for (const model of ['SseEvent', 'Decision', 'SessionState', 'LedgerPage', 'Health', 'PublicDesk', 'RuleCard', 'PolicyVersion', 'ProofReport', 'ToolConfirmed']) {
      expect(models, model).toContain(model);
    }
    const types = new Set(checks.filter(([model]) => model === 'SseEvent').map(([, ev]) => (ev as { type: string }).type));
    expect([...types].sort()).toEqual(['demo_inbox', 'error', 'held', 'message', 'receipt', 'resolved', 'turn_end', 'writing']);

    const errors = checks.flatMap(([model, value]) => validateContract(model, value));
    expect(errors).toEqual([]);
  });

  it('confirming_a_tool_already_on_answers_in_the_contracts_shape', async () => {
    // A seeded tool that is already on, confirmed at its own hash, changes nothing and drafts
    // nothing, and its profile still says why it waits for review: it doesn't.
    const owner = { params: { desk_id: RIVERA.deskId } };
    const rules = (await body('rules', owner)) as RulesView;
    for (const name of ['payments.list_charges', 'native.quote']) {
      const row = rules.tools.find((tool) => tool.tool === name);
      expect(row?.status, name).toBe('enabled');
      const confirmed = (await body('confirmTool', { ...owner, body: { tools: [{ tool: name, definition_sha256: row?.definition_sha256 }], enable: true } })) as ToolConfirmedOut;
      expect(confirmed.draft, name).toBeNull();
      expect(confirmed.profiles, name).toMatchObject([{ tool: name, status: 'enabled', review_reason: null }]);
      expect(validateContract('ToolConfirmed', confirmed), name).toEqual([]);
    }
  });

  it('setup_desk_tools_say_why_they_wait_for_review', async () => {
    // A new Desk's Documents and Payments tools, and the mock payments server's once connected,
    // wait for review as a connect never confirmed ("new"); the rest are on and wait for nothing.
    const start = { description: 'Turner Plumbing, a plumber in Oakland.', timezone: 'America/Los_Angeles', idempotency_key: 'key-1' };
    const started = (await body('startSetup', { body: start })) as SetupState;
    const id = started.interview_id;
    await body('setupConnect', { params: { id }, body: { server: 'mock_payments' } });
    const { tools } = (await body('setupTools', { params: { id } })) as SetupTools;
    const waiting = ['native.release_document', 'native.payment_link', 'native.charge_mandate', 'payments.list_charges', 'payments.create_refund'];
    for (const row of tools) {
      expect(row.review_reason, row.tool).toBe(waiting.includes(row.tool) ? 'new' : null);
      expect(row.status, row.tool).toBe(waiting.includes(row.tool) ? 'needs_review' : 'enabled');
    }
    expect(tools.map((row) => row.tool)).toEqual(expect.arrayContaining(waiting));

    // Each tool record is a profile the contract takes, and a tool already on confirms in its shape.
    const desk = mockStore.world.desk(started.desk_id);
    for (const tool of desk?.tools ?? []) expect(validateContract('ToolProfile', tool), tool.tool).toEqual([]);
    const quote = tools.find((row) => row.tool === 'native.quote');
    const confirmed = await body('confirmTool', {
      params: { desk_id: started.desk_id },
      body: { tools: [{ tool: 'native.quote', definition_sha256: quote?.definition_sha256 }], enable: true },
    });
    expect(validateContract('ToolConfirmed', confirmed)).toEqual([]);
  });
});
