/**
 * The mock API's read models: what the owner's and the visitor's reads answer, built from the
 * copy as it stands (world.ts) in the shapes of Plan 02's read models (`api/views.ts`) and the
 * shared contracts.
 */
import type { DecisionState, LedgerPage, PublicDesk } from '../api/contracts.ts';
import type {
  Attempt,
  BusinessOut,
  ConversationSummary,
  CopyOut,
  DeskSummary,
  HealthOut,
  NeedsYouItem,
  NeedsYouSession,
  OwnerTranscript,
  Reports,
  Today,
  TranscriptKind,
  VisitorTranscript,
} from '../api/views.ts';
import { rivera } from '../ds/fixtures/index.ts';
import type { Language } from './script.ts';
import { BUSINESS } from './seed.ts';
import {
  LEDGER_KEY,
  MINUTE,
  isoTime,
  type DecisionRecord,
  type DeskRecord,
  type MockWorld,
  type SessionRecord,
} from './world.ts';

/** Today's "live" conversations: activity in the last five minutes. */
const LIVE_MS = 5 * MINUTE;

/** What a blocked reply's attempt says to the owner. */
const BLOCKED_REPLY_REASON =
  "Claude's reply put a price in its own words instead of a checked card, so it wasn't shown. The visitor was told you'll answer.";

function deskSummaries(world: MockWorld): DeskSummary[] {
  return world.desks.map((desk) => ({ ...desk.summary, hours: desk.summary.hours.map((h) => ({ ...h })) }));
}

export function copyOut(world: MockWorld): CopyOut {
  return { copy_id: world.ids.copyId, desks: deskSummaries(world) };
}

export function businessOut(world: MockWorld): BusinessOut {
  return {
    business_id: world.ids.businessId,
    name: BUSINESS.name,
    owner_display_name: BUSINESS.owner_display_name,
    timezone: BUSINESS.timezone,
    desks: deskSummaries(world),
  };
}

function decisionsOf(world: MockWorld, deskId: string): DecisionRecord[] {
  return [...world.decisions.values()].filter((d) => d.deskId === deskId);
}

export function conversationSummary(world: MockWorld, session: SessionRecord): ConversationSummary {
  const counts: Partial<Record<DecisionState, number>> = {};
  for (const { decision } of world.decisions.values()) {
    if (decision.session_id === session.state.session_id) counts[decision.state] = (counts[decision.state] ?? 0) + 1;
  }
  return {
    session_id: session.state.session_id,
    kind: session.state.kind,
    display_name: session.displayName,
    verified: session.state.verified,
    mode: session.state.mode,
    last_activity: isoTime(session.lastActivity),
    outcome_counts: counts,
    owner_preview: session.ownerPreview,
  };
}

function needsYouSession(session: SessionRecord | undefined, sessionId: string): NeedsYouSession {
  return {
    session_id: sessionId,
    kind: session?.state.kind ?? 'visitor',
    display_name: session?.displayName ?? null,
    verified: session?.state.verified ?? false,
    assurance: session?.state.assurance ?? 'none',
  };
}

export function needsYou(world: MockWorld, desk: DeskRecord): NeedsYouItem[] {
  const deskId = desk.summary.desk_id;
  const held = decisionsOf(world, deskId)
    .filter((d) => d.decision.state === 'held')
    .map((d) => ({
      at: d.createdAt,
      item: {
        decision: d.decision,
        held_by: desk.policy.cards.find((card) => card.card_id === d.decision.card_ids[0])?.reason ?? null,
        held_at: isoTime(d.createdAt),
        session: needsYouSession(world.sessions.get(d.decision.session_id), d.decision.session_id),
        from_the_visitor: d.fromTheVisitor,
      } satisfies NeedsYouItem,
    }));
  const callbacks = [...world.handoffs.values()]
    .filter((h) => h.deskId === deskId && h.handoff.status === 'open')
    .map((h) => ({
      at: h.createdAt,
      item: {
        handoff: h.handoff,
        session: needsYouSession(world.sessions.get(h.handoff.session_id), h.handoff.session_id),
        from_the_visitor: h.fromTheVisitor,
      } satisfies NeedsYouItem,
    }));
  return [...held, ...callbacks].sort((a, b) => a.at - b.at).map(({ item }) => item);
}

/** A reply the check stopped: its ledger entry says it wasn't ok. */
const blockedReplies = (desk: DeskRecord) => desk.ledger.filter((e) => e.event.kind === 'reply' && e.event.summary.ok === false);

export function today(world: MockWorld, desk: DeskRecord): Today {
  const now = world.now();
  const sessions = world.sessionsOf(desk.summary.desk_id);
  const customers = sessions.filter((s) => !s.ownerPreview);
  const decisions = decisionsOf(world, desk.summary.desk_id).map((d) => d.decision);
  return {
    greeting_name: BUSINESS.owner_display_name.split(' ')[0] ?? BUSINESS.owner_display_name,
    needs_you_count: needsYou(world, desk).length,
    live: sessions
      .filter((s) => now - s.lastActivity <= LIVE_MS)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((s) => conversationSummary(world, s)),
    // Counted over the copy's life: the mock keeps no "last read".
    briefing: {
      since: null,
      conversations: customers.length,
      bookings: decisions.filter((d) => d.action?.tool === 'native.book' && d.state === 'executed').length,
      leads: customers.filter((s) => s.displayName !== null).length,
      held: decisions.filter((d) => d.outcome === 'hold').length,
      blocked: decisions.filter((d) => d.outcome === 'refuse').length + blockedReplies(desk).length,
      paid_cents: paidCents(world, desk.summary.desk_id),
    },
  };
}

function paidCents(world: MockWorld, deskId: string): number {
  return [...world.links.values()].filter((l) => l.deskId === deskId && l.view.state === 'paid').reduce((sum, l) => sum + l.view.amount_cents, 0);
}

export function reports(world: MockWorld, desk: DeskRecord): Reports {
  const deskId = desk.summary.desk_id;
  const customers = world.sessionsOf(deskId).filter((s) => !s.ownerPreview);
  const neededYou = new Set([
    ...decisionsOf(world, deskId).filter((d) => d.decision.outcome === 'hold').map((d) => d.decision.session_id),
    ...[...world.handoffs.values()].filter((h) => h.deskId === deskId).map((h) => h.handoff.session_id),
  ]);
  return {
    bookings: decisionsOf(world, deskId).filter((d) => d.decision.action?.tool === 'native.book' && d.decision.state === 'executed').length,
    paid_cents: paidCents(world, deskId),
    handled_by_claude: customers.filter((s) => !neededYou.has(s.state.session_id)).length,
    needed_you: customers.filter((s) => neededYou.has(s.state.session_id)).length,
  };
}

export function attempts(world: MockWorld, desk: DeskRecord): Attempt[] {
  const stopped: Attempt[] = decisionsOf(world, desk.summary.desk_id)
    .filter((d) => d.decision.outcome !== 'allow')
    .map((d) => ({
      ref_id: d.decision.decision_id,
      kind: d.decision.outcome === 'hold' ? 'held' : 'refused',
      reason_plain: d.decision.reason_plain,
      card_ids: [...d.decision.card_ids],
      origin: 'kernel',
      created_at: isoTime(d.createdAt),
      triage: null,
      ledger_seq: d.decision.ledger_seq,
    }));
  const replies: Attempt[] = blockedReplies(desk).map((entry) => ({
    ref_id: entry.event.ref_id ?? '',
    kind: 'reply_blocked',
    reason_plain: BLOCKED_REPLY_REASON,
    card_ids: [],
    origin: entry.event.origin,
    created_at: entry.created_at,
    triage: null,
    ledger_seq: entry.seq,
  }));
  return [...stopped, ...replies].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function ledgerPage(desk: DeskRecord): LedgerPage {
  return {
    entries: desk.ledger,
    head: desk.ledger.at(-1)?.hash ?? '0'.repeat(64),
    chain_ok: true,
    first_bad_seq: null,
    ...LEDGER_KEY,
  };
}

const VISITOR_KINDS: ReadonlySet<TranscriptKind> = new Set(['visitor_text', 'delivered', 'status']);

export function visitorTranscript(session: SessionRecord): VisitorTranscript {
  return {
    state: session.state,
    items: session.items.filter((item) => VISITOR_KINDS.has(item.kind)),
    last_seq: session.events.length,
  };
}

export function ownerTranscript(session: SessionRecord, after: number): OwnerTranscript {
  return {
    state: session.state,
    items: session.items.filter((item) => item.n > after).map((item) => ({ ...item, owner_translation: null, triage: null })),
  };
}

export function publicDesk(desk: DeskRecord, language: Language): PublicDesk {
  return { ...rivera.publicDesk[language], desk_name: desk.summary.name, brand: { ...BUSINESS.brand } };
}

export const HEALTH: HealthOut = {
  ok: true,
  kernel: {
    version: 'mock',
    proof_mode: 'symcc',
    dev_signing_key: true,
    public_key_hex: LEDGER_KEY.public_key_hex,
    key_id: LEDGER_KEY.key_id,
    unproved_seeds: [],
  },
};
