/**
 * The route table against Plan 02's HTTP contract. PLAN_02 is the plan's route table copied by
 * hand, so a path or method that drifts on either side fails here, not in a browser.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { MoneyCapIn } from './openapi.gen.ts';
import { ROUTES, apiPath, type RouteBody, type RouteKey, type RouteQuery } from './routes.ts';
import type { AnyToolName, SetupPublicLine, SetupPublicLineIn, SetupPublicLines, SetupPublicLinesConfirmIn, SetupQuestion } from './views.ts';
import { ROUTE_MODELS } from './routes.typecheck.ts';
import type { RequestOptions } from './http.ts';

const PLAN_02: Record<RouteKey, string> = {
  // Copy and Desks
  copies: 'POST /api/owner/copies',
  startOver: 'POST /api/owner/start_over',
  me: 'GET /api/owner/me',
  desks: 'GET /api/owner/desks',
  setAnswering: 'PUT /api/owner/desks/{desk_id}/answering',
  setBusiness: 'PUT /api/owner/desks/{desk_id}/business',
  deleteDesk: 'DELETE /api/owner/desks/{desk_id}',
  openPreview: 'POST /api/owner/desks/{desk_id}/preview_session',
  // Today
  today: 'GET /api/owner/desks/{desk_id}/today',
  briefing: 'GET /api/owner/desks/{desk_id}/briefing',
  needsYou: 'GET /api/owner/desks/{desk_id}/needs_you',
  reports: 'GET /api/owner/desks/{desk_id}/reports',
  answer: 'POST /api/owner/approvals/{decision_id}/answer',
  handoffDone: 'POST /api/owner/handoffs/{handoff_id}/done',
  // Conversations
  conversations: 'GET /api/owner/desks/{desk_id}/conversations',
  conversation: 'GET /api/owner/conversations/{session_id}',
  takeover: 'POST /api/owner/conversations/{session_id}/takeover',
  handback: 'POST /api/owner/conversations/{session_id}/handback',
  resume: 'POST /api/owner/conversations/{session_id}/resume',
  ownerMessage: 'POST /api/owner/conversations/{session_id}/messages',
  ownerTyping: 'POST /api/owner/conversations/{session_id}/typing',
  decision: 'GET /api/owner/decisions/{decision_id}',
  // Safety
  safety: 'GET /api/owner/desks/{desk_id}/safety',
  ledger: 'GET /api/owner/desks/{desk_id}/ledger',
  ownerInbox: 'GET /api/owner/demo_inbox',
  health: 'GET /api/health',
  // Rules, tools, knowledge, people
  rules: 'GET /api/owner/desks/{desk_id}/rules',
  ruleDraft: 'GET /api/owner/desks/{desk_id}/rules/drafts/{version}',
  suggestions: 'GET /api/owner/desks/{desk_id}/suggestions',
  simulateToolChange: 'POST /api/owner/desks/{desk_id}/tools/simulate_change',
  addKnowledge: 'POST /api/owner/desks/{desk_id}/knowledge',
  knowledge: 'GET /api/owner/desks/{desk_id}/knowledge',
  people: 'GET /api/owner/desks/{desk_id}/people',
  // Proving
  ruleChat: 'POST /api/owner/policy/{desk_id}/chat',
  draftRules: 'POST /api/owner/policy/{desk_id}/draft',
  draftPreset: 'POST /api/owner/policy/{desk_id}/preset',
  draftSuggestion: 'POST /api/owner/policy/{desk_id}/suggestions/{tool}',
  draftMoneyCap: 'POST /api/owner/policy/{desk_id}/money_cap',
  confirmRules: 'POST /api/owner/policy/{desk_id}/confirm',
  confirmTool: 'POST /api/owner/policy/{desk_id}/tools/confirm',
  setupRules: 'POST /api/owner/policy/setup/{id}/rules',
  setupSituations: 'POST /api/owner/policy/setup/{id}/situations',
  setupSafetyCheck: 'POST /api/owner/policy/setup/{id}/safety_check',
  setupConfirm: 'POST /api/owner/policy/setup/{id}/confirm',
  goLive: 'POST /api/owner/policy/setup/{id}/go_live',
  // Setup
  startSetup: 'POST /api/owner/setup',
  setup: 'GET /api/owner/setup/{id}',
  setupConsent: 'POST /api/owner/setup/{id}/consent',
  setupAnswer: 'POST /api/owner/setup/{id}/answer',
  setupProposal: 'POST /api/owner/setup/{id}/proposals/{proposal_id}',
  setupSuggestions: 'POST /api/owner/setup/{id}/suggestions',
  setupReopen: 'POST /api/owner/setup/{id}/reopen',
  setupEvents: 'GET /api/owner/setup/{id}/events',
  setupTools: 'GET /api/owner/setup/{id}/tools',
  setupConnect: 'POST /api/owner/setup/{id}/tools/connect',
  setupPublicLines: 'GET /api/owner/setup/{id}/public_lines',
  setupPublicLine: 'PUT /api/owner/setup/{id}/public_lines',
  setupPublicLinesConfirm: 'POST /api/owner/setup/{id}/public_lines/confirm',
  removePublicLine: 'DELETE /api/owner/setup/{id}/public_lines/{key}',
  removePublicPrice: 'DELETE /api/owner/setup/{id}/public_lines/prices/{item_id}',
  // Public
  publicDesk: 'GET /api/public/{slug}',
  openSession: 'POST /api/public/desks/{slug}/sessions',
  visitorSession: 'GET /api/public/desks/{slug}/session',
  sendMessage: 'POST /api/public/desks/{slug}/messages',
  visitorTyping: 'POST /api/public/desks/{slug}/typing',
  events: 'GET /api/public/desks/{slug}/events',
  cancelRequest: 'POST /api/public/desks/{slug}/decisions/{decision_id}/cancel',
  verifyCheck: 'POST /api/public/desks/{slug}/verify/check',
  visitorInbox: 'GET /api/public/desks/{slug}/demo_inbox',
  agentCard: 'GET /api/public/desks/{slug}/agent_card',
  agentKey: 'POST /api/public/desks/{slug}/agents/key',
  agentTasks: 'GET /api/public/desks/{slug}/agent_tasks',
  sendAgent: 'POST /api/public/desks/{slug}/send_agent',
  agentRun: 'GET /api/public/desks/{slug}/send_agent/{run_id}',
  // Tokens
  paymentLink: 'GET /api/pay/{token}',
  completePayment: 'POST /api/pay/{token}/complete',
  cancelPayment: 'POST /api/pay/{token}/cancel',
};

/** The model turns: the routes that wait on Claude rather than on the kernel. */
const MODEL_ROUTES = ['startSetup', 'setupConsent', 'setupAnswer', 'setupProposal', 'setupSuggestions', 'setupReopen'];

const entries = Object.entries(ROUTES) as [RouteKey, (typeof ROUTES)[RouteKey]][];

describe('ROUTES', () => {
  it('every_route_is_under_api', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, route] of entries) expect(route.path, key).toMatch(/^\/api\//);
  });

  it('owner_routes_are_under_api_owner', () => {
    for (const [key, route] of entries) {
      expect(route.owner, key).toBe(route.path.startsWith('/api/owner/'));
      expect('proving' in route && route.proving === true, key).toBe(route.path.startsWith('/api/owner/policy/'));
      if (!route.owner) {
        expect(
          route.path.startsWith('/api/public/') || route.path.startsWith('/api/pay/') || route.path === '/api/health',
          key,
        ).toBe(true);
      }
    }
  });

  it('every_route_matches_plan_02', () => {
    expect(Object.keys(ROUTES).sort()).toEqual(Object.keys(PLAN_02).sort());
    for (const [key, route] of entries) expect(`${route.method} ${route.path}`, key).toBe(PLAN_02[key]);
    const model = entries.filter(([, route]) => 'model' in route && route.model === true).map(([key]) => key);
    expect(model.sort()).toEqual([...MODEL_ROUTES].sort());
    // Bodies the web types by hand ahead of the API, checked by `npm run typecheck`: confirmTool's
    // batch body, a whole connector in one action and one tool a list of one (plan 02b Task 7).
    expectTypeOf<RouteBody<'confirmTool'>>().toEqualTypeOf<{ tools: { tool: AnyToolName; definition_sha256: string }[]; enable: boolean }>();
    // A setup answer names the question it answers, so one sent twice can't answer the next (plan 02b Task 6): a
    // topic, or the test-client offer at the plan's end.
    expectTypeOf<RouteBody<'setupAnswer'>>().toEqualTypeOf<{ text: string } & ({ question: SetupQuestion; card?: never } | { question: null; card: string })>();
    // draftMoneyCap's body, the payment limit a draft changes to, is the API's own model, from its
    // document (`MoneyCapIn`, openapi.gen.ts), not typed by hand.
    expectTypeOf<RouteBody<'draftMoneyCap'>>().toEqualTypeOf<MoneyCapIn>();
    expectTypeOf<RouteBody<'draftMoneyCap'>>().toEqualTypeOf<{ auto_money_cap_cents: number }>();
  });

  it('params_are_encoded', () => {
    expect(apiPath('publicDesk', { slug: 'a/b' })).toBe('/api/public/a%2Fb');
    expect(apiPath('ledger', { desk_id: 'd 1' }, { verify: true })).toBe('/api/owner/desks/d%201/ledger?verify=true');
    expect(apiPath('conversation', { session_id: 's1' }, { after: undefined })).toBe('/api/owner/conversations/s1');
    expect(() => apiPath('publicDesk', {} as { slug: string })).toThrow();
  });
});


it('names the setup public-line responses as the API document does', () => {
  for (const key of ['setupPublicLines', 'setupPublicLine', 'setupPublicLinesConfirm'] as const) {
    expect(ROUTE_MODELS[key]).toBe('SetupPublicLines');
  }
  expectTypeOf<RouteBody<'setupPublicLine'>>().toEqualTypeOf<SetupPublicLineIn>();
  expectTypeOf<RouteBody<'setupPublicLinesConfirm'>>().toEqualTypeOf<SetupPublicLinesConfirmIn>();
  expectTypeOf<SetupPublicLines['lines'][number]>().toEqualTypeOf<SetupPublicLine>();
});

it('requires displayed price values in per-item removal requests', () => {
  expectTypeOf<RouteQuery<'removePublicPrice'>>().toEqualTypeOf<{ title: string; unit_cents: number }>();
  expectTypeOf<RequestOptions<'removePublicPrice'>>().toExtend<{ query: { title: string; unit_cents: number } }>();
});
