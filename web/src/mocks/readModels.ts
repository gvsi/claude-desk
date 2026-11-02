/**
 * The mock API's read models: what the owner's and the visitor's reads answer, built from the
 * copy as it stands (world.ts) in the shapes of Plan 02's read models (`api/views.ts`) and the
 * shared contracts.
 */
import { effectiveBrand } from './brand.ts';
import type { Decision, DecisionState, HoursWindow, LedgerEntry, LedgerPage, PublicDesk, RuleCard, SseEvent, ToolName } from '../api/contracts.ts';
import type {
  Attempt,
  Briefing,
  BriefingItem,
  BriefingKind,
  BriefingList,
  BusinessOut,
  ConversationSummary,
  CopyOut,
  DeskSummary,
  HealthOut,
  KnowledgeRow,
  NeedsYouItem,
  NeedsYouSession,
  OwnerTranscript,
  PaymentLinkOut,
  PeopleOut,
  RefusalCause,
  Reports,
  RulesPreset,
  RulesView,
  ThisWeek,
  Today,
  ToolRow,
  TranscriptKind,
  Triage,
  VisitorTranscript,
} from '../api/views.ts';
import { rulesForTool } from '../ds/components/ToolRulesCard/toolRules.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { AGENT_CARD_BLOCKS } from './agents.ts';
import { refusalCause } from './causes.ts';
import { VISITOR_PLAIN, type Language } from './script.ts';
import { BUSINESS, PRESETS, presetCards } from './seed.ts';
import {
  LEDGER_KEY,
  MINUTE,
  canonicalCard,
  isoTime,
  type DecisionRecord,
  type DeskRecord,
  type LinkRecord,
  type MockWorld,
  type SessionRecord,
} from './world.ts';

/** Today's "live" conversations: activity in the last five minutes. */
const LIVE_MS = 5 * MINUTE;

/** What a blocked reply's attempt says to the owner. */
const BLOCKED_REPLY_REASON =
  "Claude's reply put a price in its own words instead of a checked card, so it wasn't shown. The visitor was told you'll answer.";

/** The copy's Desks, none with an unfinished setup: setup's own Desks name theirs (`withSetupDesks`). */
function deskSummaries(world: MockWorld): DeskSummary[] {
  return world.desks.map((desk) => ({ ...desk.summary, hours: desk.summary.hours.map((h) => ({ ...h })), setup: null }));
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
    brand: effectiveBrand(world.desks[0]?.brand),
    desks: deskSummaries(world),
  };
}

function decisionsOf(world: MockWorld, deskId: string): DecisionRecord[] {
  return [...world.decisions.values()].filter((d) => d.deskId === deskId);
}

/** The most of one visitor message the owner's glimpse of it carries, "…" included. */
const VISITOR_LINE_MAX = 200;

/**
 * A visitor's message as the owner's one-line glimpse of it (the API's `visitor_line`): whitespace
 * collapsed to single spaces, and cut to 199 characters and "…" past 200, with no space left
 * before the "…". Null when nothing is left.
 */
function visitorLine(text: string | null): string | null {
  const chars = Array.from((text ?? '').split(/\s+/).filter(Boolean).join(' '));
  if (chars.length === 0) return null;
  return chars.length > VISITOR_LINE_MAX ? `${chars.slice(0, VISITOR_LINE_MAX - 1).join('').trimEnd()}…` : chars.join('');
}

/**
 * What the visitor typed last in `session`, as the API's summary carries it (`visitorLine`). Null
 * for an agent's or the owner's chat, the owner's preview, before the visitor writes, and when
 * what they wrote last is all whitespace.
 */
function latestVisitorText(session: SessionRecord): string | null {
  if (session.state.kind !== 'visitor' || session.ownerPreview) return null;
  return visitorLine(session.items.findLast((item) => item.kind === 'visitor_text')?.text ?? null);
}

/** What a visitor, or a visiting agent, wrote in a chat (the API's `VISITOR_TEXT`). */
const SAID: ReadonlySet<TranscriptKind> = new Set(['visitor_text', 'agent_text']);

/**
 * What Needs you quotes from a chat, read as it stands, as the API's `recent_texts` and
 * `visitor_lines` read it: the visitor's (or visiting agent's) previous and last messages, oldest
 * first, each as its glimpse (`visitorLine`), joined with " · ". Just the last when there's one,
 * and null when nothing is left.
 */
function fromTheVisitor(session: SessionRecord | undefined): string | null {
  const said = (session?.items ?? []).filter((item) => SAID.has(item.kind)).slice(-2);
  const lines = said.map((item) => visitorLine(item.text)).filter((line) => line !== null);
  return lines.length > 0 ? lines.join(' · ') : null;
}

/** An agent's newest outcome and the facts behind it, as the API's summary carries them. */
type AgentOutcome = Pick<ConversationSummary, 'latest_outcome' | 'latest_outcome_starts_at' | 'latest_outcome_cents' | 'latest_outcome_cause'>;

const NO_OUTCOME: AgentOutcome = { latest_outcome: null, latest_outcome_starts_at: null, latest_outcome_cents: null, latest_outcome_cause: null };

/**
 * The API's agent-only outcome: matched executed receipts/cards, with later decisive events first,
 * and the kernel's facts behind it, as the API reads them: a booking's start and a charge's amount
 * from its decision's action, a Desk-authored payment confirmation's from the session's newest
 * link paid before it, and a refusal's cause from its `decide` entry.
 */
function latestAgentOutcome(world: MockWorld, session: SessionRecord): AgentOutcome {
  if (session.state.kind !== 'agent') return NO_OUTCOME;
  const records = [...world.decisions.values()].filter((d) => d.decision.session_id === session.state.session_id);
  const decisions = new Map(records.map((d) => [d.decision.decision_id, d.decision]));
  const desk = world.desk(session.deskId);
  const atDecision = (decision: Decision) => Date.parse(desk?.ledger[decision.ledger_seq - 1]?.created_at ?? '') ||
    records.find((r) => r.decision.decision_id === decision.decision_id)?.createdAt || 0;
  type Outcome = ConversationSummary['latest_outcome'];
  const events: { at: number; seq: number; priority: number; n: number; outcome: Outcome; decision?: Decision }[] = [];
  for (const { decision } of records) {
    const { state, action } = decision;
    if (decision.outcome === 'hold' || ['refused', 'refused_at_execution', 'held', 'denied', 'expired', 'cancelled'].includes(state) ||
      (state === 'executed' && ['native.book', 'native.charge_mandate', 'native.request_callback'].includes(action?.tool ?? ''))) {
      events.push({ at: atDecision(decision), seq: decision.ledger_seq, priority: 0, n: 0,
        outcome: state === 'refused' || state === 'refused_at_execution' ? 'turned_down' : null, decision });
    }
  }
  for (const handoff of world.handoffs.values()) {
    if (handoff.handoff.session_id === session.state.session_id) {
      const entry = desk?.ledger.find((e) => e.event.kind === 'desk_data' && e.event.summary.kind !== undefined &&
        Array.isArray(e.event.summary.refs) && e.event.summary.refs.includes(handoff.handoff.handoff_id));
      events.push({ at: handoff.createdAt, seq: entry?.seq ?? 0, priority: 2, n: 0, outcome: null });
    }
  }
  const done: Partial<Record<string, { tool: string; outcome: Outcome }>> = {
    booking_confirmed: { tool: 'native.book', outcome: 'visit_booked' },
    charge_confirmed: { tool: 'native.charge_mandate', outcome: 'deposit_paid' },
  };
  // Turn ends live in the stream rather than the transcript. Tag each event with its last end,
  // just as the API does, so an undelivered turn cannot lend its receipt to a later card.
  const turnEnds = new Map<SseEvent, number>();
  let lastEnd = 0;
  for (const { seq, ev } of session.events) {
    if (ev.type === 'turn_end') lastEnd = seq;
    turnEnds.set(ev, lastEnd);
  }
  let pending: Decision[] = [];
  let previousEnd = 0;
  for (const item of [...session.items].sort((a, b) => a.n - b.n)) {
    const event = item.event;
    if (['visitor_text', 'agent_text', 'whisper'].includes(item.kind)) pending = [];
    if (event && (item.kind === 'status' || item.kind === 'delivered')) {
      const end = turnEnds.get(event) ?? 0;
      if (end !== previousEnd) pending = [];
      previousEnd = end;
    }
    if (item.kind === 'status') {
      const decision = event && 'decision_id' in event ? decisions.get(event.decision_id) : undefined;
      if (event && 'state' in event && event.state === 'executed' && decision?.state === 'executed') pending.push(decision);
      continue;
    }
    if (item.kind !== 'delivered' || event?.type !== 'message') continue;
    const receipts = pending;
    pending = [];
    const cards = event.blocks.filter((b) => b.kind === 'card').map((b) => b.template ?? '');
    if (event.handoff || cards.includes('handoff')) {
      events.push({ at: Date.parse(item.created_at), seq: event.ledger_seq, priority: 2, n: item.n, outcome: null });
      continue;
    }
    for (const card of cards.reverse()) {
      if (card === 'payment_confirmed' && event.author === 'desk') {
        events.push({ at: Date.parse(item.created_at), seq: event.ledger_seq, priority: 1, n: item.n, outcome: 'deposit_paid' });
        break;
      }
      const result = done[card];
      if (!result) continue;
      const decision = receipts.filter((d) => d.action?.tool === result.tool).sort((a, b) => b.ledger_seq - a.ledger_seq)[0];
      if (decision) events.push({ at: atDecision(decision), seq: decision.ledger_seq, priority: 1, n: item.n, outcome: result.outcome, decision });
      break;
    }
  }
  events.sort((a, b) => a.at - b.at || a.seq - b.seq || a.priority - b.priority || a.n - b.n);
  const newest = events.at(-1);
  if (!newest?.outcome) return NO_OUTCOME;
  const { outcome, decision } = newest;
  const found: AgentOutcome = { ...NO_OUTCOME, latest_outcome: outcome };
  if (outcome === 'visit_booked') return { ...found, latest_outcome_starts_at: decision?.action?.starts_at ?? null };
  if (outcome === 'deposit_paid' && decision) return { ...found, latest_outcome_cents: decision.action?.amount_cents ?? null };
  if (outcome === 'deposit_paid') {
    // The mock names a link by its token, as the payment entry's ref_id.
    const paid = (desk?.ledger ?? []).filter((e) => e.seq < newest.seq && e.event.kind === 'payment' && e.event.session_id === session.state.session_id &&
      e.event.summary.state === 'paid' && !e.event.summary.refused).at(-1);
    return { ...found, latest_outcome_cents: world.links.get(paid?.event.ref_id ?? '')?.view.amount_cents ?? null };
  }
  if (outcome === 'turned_down' && decision) {
    const entry = desk?.ledger.find((e) => e.seq === decision.ledger_seq && e.event.kind === 'decide') ?? null;
    return { ...found, latest_outcome_cause: refusalCause(decision, entry, { verified: session.state.verified }) };
  }
  return found;
}

/** Visitor outcomes follow kernel ledger time, never transcript text or shown cards. */
function latestVisitorOutcome(world: MockWorld, session: SessionRecord): ConversationSummary['latest_outcome'] {
  if (session.state.kind !== 'visitor' || session.ownerPreview) return null;
  type Outcome = ConversationSummary['latest_outcome'];
  const done: Partial<Record<string, Outcome>> = {
    'native.quote': 'quoted', 'native.book': 'visit_booked',
    'native.capture_lead': 'lead_captured', 'native.release_document': 'document_sent',
  };
  const ledger = world.desk(session.deskId)?.ledger ?? [];
  const entryTime = (entry: LedgerEntry): number => {
    const replayed = entry.event.summary.replayed;
    if (typeof replayed === 'object' && replayed !== null && 'at' in replayed && typeof replayed.at === 'string') {
      const recorded = Date.parse(replayed.at);
      if (!Number.isNaN(recorded)) return recorded;
    }
    return Date.parse(entry.created_at);
  };
  const events: { at: number; seq: number; outcome: Outcome }[] = [];
  for (const { decision, createdAt } of world.decisions.values()) {
    if (decision.session_id !== session.state.session_id) continue;
    const { state } = decision;
    const outcome = state === 'executed' ? done[decision.action?.tool ?? ''] :
      state === 'refused' || state === 'refused_at_execution' ? 'turned_down' :
      state === 'denied' ? 'owner_declined' : undefined;
    if (outcome !== undefined || ['held', 'expired', 'cancelled'].includes(state)) {
      const entry = ledger.find((e) => e.seq === decision.ledger_seq);
      events.push({ at: entry ? entryTime(entry) : createdAt, seq: decision.ledger_seq, outcome: outcome ?? null });
    }
  }
  const paid = new Set([...world.links].filter(([, link]) =>
    link.sessionId === session.state.session_id && link.view.state === 'paid').map(([token]) => token));
  const callbacks = new Set([...world.handoffs.values()].filter(({ handoff }) =>
    handoff.session_id === session.state.session_id && handoff.kind === 'callback' && handoff.status === 'done')
    .map(({ handoff }) => handoff.handoff_id));
  for (const entry of ledger) {
    const { event } = entry;
    const { summary } = event;
    // The mock identifies its links by ref_id; each paid transition counts once, never a refused retry.
    if (event.kind === 'payment' && summary.state === 'paid' && !summary.refused && paid.delete(event.ref_id ?? '')) {
      events.push({ at: entryTime(entry), seq: entry.seq, outcome: 'deposit_paid' });
    }
    if (event.kind !== 'desk_data' || summary.part !== 'handoffs' || !Array.isArray(summary.refs)) continue;
    if (summary.kind === 'card' || summary.kind === 'callback') {
      if (event.session_id === session.state.session_id) events.push({ at: entryTime(entry), seq: entry.seq, outcome: null });
    } else if (!('replaced_by' in summary) && !('closed_by' in summary)) {
      for (const id of summary.refs) {
        if (typeof id === 'string' && callbacks.delete(id)) events.push({ at: entryTime(entry), seq: entry.seq, outcome: 'called_back' });
      }
    }
  }
  events.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return events.at(-1)?.outcome ?? null;
}

export function conversationSummary(world: MockWorld, session: SessionRecord): ConversationSummary {
  const counts: Partial<Record<DecisionState, number>> = {};
  for (const { decision } of world.decisions.values()) {
    if (decision.session_id === session.state.session_id) counts[decision.state] = (counts[decision.state] ?? 0) + 1;
  }
  return {
    session_id: session.state.session_id,
    kind: session.state.kind,
    display_name: session.displayName ?? session.demoVisitor ?? null,
    verified: session.state.verified,
    mode: session.state.mode,
    last_activity: isoTime(session.lastActivity),
    outcome_counts: counts,
    owner_preview: session.ownerPreview,
    latest_visitor_text: latestVisitorText(session),
    demo_visitor: session.demoVisitor != null,
    demo_visitor_run_id: session.demoVisitorRun ?? null,
    ...(session.state.kind === 'agent' ? latestAgentOutcome(world, session) : { ...NO_OUTCOME, latest_outcome: latestVisitorOutcome(world, session) }),
  };
}

function needsYouSession(session: SessionRecord | undefined, sessionId: string): NeedsYouSession {
  return {
    session_id: sessionId,
    kind: session?.state.kind ?? 'visitor',
    display_name: session?.displayName ?? session?.demoVisitor ?? null,
    verified: session?.state.verified ?? false,
    assurance: session?.state.assurance ?? 'none',
    demo_visitor: session?.demoVisitor != null,
  };
}

/**
 * The kernel's rank of a rule card (`specificity` in `backend/desk/always_on.py`): one for a person
 * or agent above one for a group, then a tool's own above a shared one, and the default ask below
 * every card.
 */
function cardRank(card: RuleCard): number {
  if (card.is_default === true) return -1;
  return (card.who === 'person' || card.who === 'agent' ? 2 : 0) + (card.applies_to.startsWith('effect:') ? 0 : 1);
}

/**
 * The rule card that held a request, as the API's Needs you picks it (`holding_card` in
 * `backend/desk/api/owner_reads.py`): a hold's `card_ids` are every card behind its matching hold
 * permits, sorted by ID, so the default ask for anyone can come first. Of those the Desk has, the
 * most specific (`cardRank`), the ask cards among them when there are any, then the first by ID.
 */
function holdingCard(cards: readonly RuleCard[], cardIds: readonly string[]): RuleCard | null {
  const known = cardIds.flatMap((id) => cards.find((card) => card.card_id === id) ?? []);
  const top = Math.max(...known.map(cardRank));
  const deciding = known.filter((card) => cardRank(card) === top);
  const asks = deciding.filter((card) => card.mode === 'ask');
  return (asks.length > 0 ? asks : deciding).reduce<RuleCard | null>(
    (first, card) => (first === null || card.card_id < first.card_id ? card : first),
    null,
  );
}

/**
 * Every held request and open handoff, oldest first. Each quotes what its visitor wrote most
 * recently, as of this read (`fromTheVisitor`). A handoff also carries its chat's newest triage
 * summary (`newestTriageSummary`); a held request never does, as the API sends it, since a visitor
 * could steer a summary to sway an approval.
 */
export function needsYou(world: MockWorld, desk: DeskRecord): NeedsYouItem[] {
  const deskId = desk.summary.desk_id;
  const held = decisionsOf(world, deskId)
    .filter((d) => d.decision.state === 'held')
    .map((d) => {
      const session = world.sessions.get(d.decision.session_id);
      return {
        at: d.createdAt,
        item: {
          decision: d.decision,
          handoff: null,
          held_by: holdingCard(desk.policy.cards, d.decision.card_ids)?.reason ?? null,
          held_at: isoTime(d.createdAt),
          session: needsYouSession(session, d.decision.session_id),
          from_the_visitor: fromTheVisitor(session),
          claude_summary: null,
        } satisfies NeedsYouItem,
      };
    });
  const callbacks = [...world.handoffs.values()]
    .filter((h) => h.deskId === deskId && h.handoff.status === 'open')
    .map((h) => {
      const session = world.sessions.get(h.handoff.session_id);
      return {
        at: h.createdAt,
        item: {
          handoff: h.handoff,
          decision: null,
          held_by: null,
          held_at: null,
          session: needsYouSession(session, h.handoff.session_id),
          from_the_visitor: fromTheVisitor(session),
          claude_summary: newestTriageSummary(world, desk, h.handoff.session_id),
        } satisfies NeedsYouItem,
      };
    });
  return [...held, ...callbacks].sort((a, b) => a.at - b.at).map(({ item }) => item);
}

/**
 * One of Claude's replies the check stopped, as Safety lists them: its `reply` entry wasn't ok for
 * a reason other than a paused chat. An owner's stopped say isn't an attempt. Nobody tried
 * anything, so the briefing leaves it out and the last 7 days don't count it as stopped.
 */
function stoppedReplies(desk: DeskRecord) {
  return desk.ledger.filter((e) => {
    const { summary } = e.event;
    if (e.event.kind !== 'reply' || summary.ok !== false || summary.author !== 'claude') return false;
    const violations = Array.isArray(summary.violations) ? summary.violations : [];
    return violations.length === 0 || violations.some((v) => v !== 'session_paused');
  });
}

export function today(world: MockWorld, desk: DeskRecord): Today {
  const now = world.now();
  const sessions = world.sessionsOf(desk.summary.desk_id);
  const activity = activityOf(world, desk);
  return {
    greeting_name: BUSINESS.owner_display_name.split(' ')[0] ?? BUSINESS.owner_display_name,
    needs_you_count: needsYou(world, desk).length,
    live: sessions
      .filter((s) => now - s.lastActivity <= LIVE_MS)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((s) => conversationSummary(world, s)),
    briefing: briefingOf(activity),
    this_week: thisWeekOf(activity),
  };
}

/** `GET …/briefing`: every item since last night, newest first. */
export function briefingList(world: MockWorld, desk: DeskRecord): BriefingList {
  const activity = activityOf(world, desk);
  return { since: activity.window.sinceIso, items: briefingItems(activity) };
}

// Today's windows, as the API core computes them (plan 02a, Task 9): times on the business's clock,
// each day's edges taken from its own date, and every term counting the Desk's sessions, the
// owner's own previews included.

const DAY_MS = 24 * 60 * MINUTE;

/** `ms` on the business's clock: its local date and time, and its offset from UTC in minutes. */
function wallClock(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const [year, month, day, hour, minute, second] = [get('year'), get('month'), get('day'), get('hour') % 24, get('minute'), get('second')];
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  const offsetMinutes = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - whole) / MINUTE);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return {
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}:${pad(second)}`,
    offsetMinutes,
  };
}

/** The instant a local date's `hour` o'clock begins on the business's clock. */
function localInstant(date: string, hour: number, timeZone: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour);
  // The offset at a first guess, then at the instant it gives, so a daylight-saving change between them is followed.
  const first = asUtc - wallClock(asUtc, timeZone).offsetMinutes * MINUTE;
  return asUtc - wallClock(first, timeZone).offsetMinutes * MINUTE;
}

/** `date` plus `days`, as a local `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `ms` as the API writes a local time: `2026-10-28T18:00:00-07:00`. */
function localIso(ms: number, timeZone: string): string {
  const { date, time, offsetMinutes } = wallClock(ms, timeZone);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${date}T${time}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

interface Windows {
  now: number;
  /** "Since last night": 18:00 yesterday, local. */
  since: number;
  sinceIso: string;
  /** The seven local dates ending today, oldest first, and when each begins and ends. */
  days: { date: string; from: number; to: number }[];
  /** 00:00 on the first of the seven. */
  weekFrom: number;
}

function windows(now: number): Windows {
  const tz = BUSINESS.timezone;
  const today = wallClock(now, tz).date;
  const since = localInstant(addDays(today, -1), 18, tz);
  const days = [-6, -5, -4, -3, -2, -1, 0].map((offset) => {
    const date = addDays(today, offset);
    return { date, from: localInstant(date, 0, tz), to: localInstant(addDays(date, 1), 0, tz) };
  });
  return { now, since, sinceIso: localIso(since, tz), days, weekFrom: days[0]?.from ?? now };
}

/** Something that happened in a conversation, and when. */
interface Happened {
  sessionId: string;
  at: number;
}

interface Booking extends Happened {
  decision: Decision;
  cents: number;
}

/** What Today's terms are built from, each at the time the API core times it. */
interface Activity {
  world: MockWorld;
  window: Windows;
  /** A visitor's or an agent's own words. */
  texts: Happened[];
  bookings: Booking[];
  leads: (Happened & { leadId: string; displayName: string; note: string | null })[];
  /**
   * Refusals at decide time, and Claude's replies the check stopped, each with its kind as Safety
   * lists it. `cause` is read from its deciding policies and decide entry, as on Safety; a refusal
   * the API can't place and a stopped reply have none.
   */
  stopped: (Happened & { kind: 'refused' | 'reply_blocked'; refId: string; line: string | null; cause: RefusalCause | null })[];
  holds: Happened[];
  callbacks: Happened[];
  /** The owner answering a hold, taking over, whispering, resuming, or writing in the chat. */
  steppedIn: Happened[];
  /** Replies Claude delivered that weren't a handoff. */
  replies: Happened[];
  /** Replies Claude delivered with the handoff clause: the chat is waiting on the owner. */
  handoffs: Happened[];
}

const sessionOf = (e: LedgerEntry) => e.event.session_id ?? '';

function activityOf(world: MockWorld, desk: DeskRecord): Activity {
  const deskId = desk.summary.desk_id;
  const sessions = world.sessionsOf(deskId);
  const decisions = decisionsOf(world, deskId);
  /** When a decision reached its state: the time of its `ledger_seq` entry. */
  const reachedAt = (decision: Decision) => Date.parse(desk.ledger[decision.ledger_seq - 1]?.created_at ?? '') || 0;
  const executed = (tool: string) => decisions.filter((d) => d.decision.action?.tool === tool && d.decision.state === 'executed');

  // A quote backs at most one booking: each booking, in time order, takes the newest quote of its
  // session from at or before it that no earlier booking took.
  const quotes = executed('native.quote').map((d) => ({ id: d.decision.decision_id, sessionId: d.decision.session_id, at: reachedAt(d.decision), cents: d.decision.action?.amount_cents ?? 0 }));
  const taken = new Set<string>();
  const bookings = executed('native.book')
    .map((d) => ({ sessionId: d.decision.session_id, at: reachedAt(d.decision), decision: d.decision, cents: 0 }))
    .sort((a, b) => a.at - b.at)
    .map((booking) => {
      const quote = quotes
        .filter((q) => q.sessionId === booking.sessionId && q.at <= booking.at && !taken.has(q.id))
        .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))[0];
      if (quote) taken.add(quote.id);
      return { ...booking, cents: quote?.cents ?? 0 };
    });

  const approvals = desk.ledger.filter((e) => {
    if (e.event.kind !== 'approval') return false;
    // A visitor's own cancel isn't the owner stepping in.
    return world.decisions.get(e.event.ref_id ?? '')?.decision.state !== 'cancelled';
  });
  const ownerActs = desk.ledger.filter(
    (e) => e.event.kind === 'takeover' || e.event.kind === 'whisper' || (e.event.kind === 'breaker' && e.event.summary.resumed === true),
  );
  const items = sessions.flatMap((s) => s.items.map((item) => ({ sessionId: s.state.session_id, item, at: Date.parse(item.created_at) })));
  const delivered = items.filter(({ item }) => item.kind === 'delivered' && item.event?.type === 'message');
  const author = ({ item }: (typeof items)[number]) => (item.event?.type === 'message' ? item.event.author : null);
  const handsOff = ({ item }: (typeof items)[number]) => item.event?.type === 'message' && item.event.blocks.some((b) => b.template === 'handoff');

  return {
    world,
    window: windows(world.now()),
    texts: items.filter(({ item }) => item.kind === 'visitor_text' || item.kind === 'agent_text'),
    bookings,
    leads: world.leads
      .filter((lead) => lead.deskId === deskId)
      .map((lead) => ({ sessionId: lead.sessionId, at: lead.createdAt, leadId: lead.leadId, displayName: lead.displayName, note: lead.note })),
    stopped: [
      ...decisions
        .filter((d) => d.decision.outcome === 'refuse')
        .map((d) => ({
          sessionId: d.decision.session_id,
          at: d.createdAt,
          kind: 'refused' as const,
          refId: d.decision.decision_id,
          line: d.decision.reason_plain,
          cause: refusalCause(d.decision, desk.ledger.find((e) => e.seq === d.decision.ledger_seq && e.event.kind === 'decide') ?? null, {
            verified: world.sessions.get(d.decision.session_id)?.state.verified ?? false,
          }),
        })),
      ...stoppedReplies(desk).map((e) => ({
        sessionId: sessionOf(e),
        at: Date.parse(e.created_at),
        kind: 'reply_blocked' as const,
        refId: String(e.seq),
        line: null,
        cause: null,
      })),
    ],
    holds: decisions.filter((d) => d.decision.outcome === 'hold').map((d) => ({ sessionId: d.decision.session_id, at: d.createdAt })),
    callbacks: executed('native.request_callback').map((d) => ({ sessionId: d.decision.session_id, at: reachedAt(d.decision) })),
    steppedIn: [
      ...[...approvals, ...ownerActs].map((e) => ({ sessionId: sessionOf(e), at: Date.parse(e.created_at) })),
      ...delivered.filter((d) => author(d) === 'owner'),
    ],
    replies: delivered.filter((d) => author(d) === 'claude' && !handsOff(d)),
    handoffs: delivered.filter((d) => author(d) === 'claude' && handsOff(d)),
  };
}

/** The ones from `from`, included, to `to`, left out. */
function within<T extends Happened>(all: readonly T[], from: number, to: number): T[] {
  return all.filter((h) => h.at >= from && h.at < to);
}

/** The conversations with someone's own words in the span. */
function conversationsIn(a: Activity, from: number, to: number): Set<string> {
  return new Set(within(a.texts, from, to).map((t) => t.sessionId));
}

const KIND_ORDER: readonly BriefingKind[] = ['turned_down', 'booking', 'lead', 'answer'];

/**
 * Every briefing item since last night, newest first, as the API core lists them: each request
 * the kernel refused, booking and lead, and each conversation Claude answered alone. Claude's
 * drafts the reply check stopped stay on Safety: they make no item, and a reply delivered after
 * one is still an answer.
 */
function briefingItems(a: Activity): BriefingItem[] {
  const { since, now } = a.window;
  const end = now + 1;
  const nameOf = (sessionId: string) => {
    const session = a.world.sessions.get(sessionId);
    return session?.displayName ?? session?.demoVisitor ?? null;
  };
  const item = (kind: BriefingKind, h: Happened, refId: string, line: string | null, cause: RefusalCause | null = null): BriefingItem => ({
    kind,
    at: isoTime(h.at),
    session_id: h.sessionId === '' ? null : h.sessionId,
    display_name: h.sessionId === '' ? null : nameOf(h.sessionId),
    ref_id: refId,
    line,
    cause,
    demo_visitor: a.world.sessions.get(h.sessionId)?.demoVisitor != null,
  });
  const refused = a.stopped.filter((s) => s.kind === 'refused');
  // An answer: Claude replied in the window, to a conversation with nothing else in it, and didn't
  // hand it to the owner.
  const busy = new Set(
    [a.bookings, a.leads, a.holds, refused, a.callbacks, a.handoffs].flatMap((all) => within(all, since, end).map((h) => h.sessionId)),
  );
  const newestReply = new Map<string, Happened>();
  for (const reply of within(a.replies, since, end)) {
    if (busy.has(reply.sessionId)) continue;
    const seen = newestReply.get(reply.sessionId);
    if (!seen || reply.at > seen.at) newestReply.set(reply.sessionId, reply);
  }
  const items = [
    ...within(refused, since, end).map((s) => item('turned_down', s, s.refId, s.line, s.cause)),
    ...within(a.bookings, since, end).map((b) => item('booking', b, b.decision.decision_id, b.decision.reason_plain)),
    ...within(a.leads, since, end).map((l) => ({ ...item('lead', l, l.leadId, l.note), display_name: l.displayName })),
    ...[...newestReply.values()].map((r) => item('answer', r, r.sessionId, null)),
  ];
  return items.sort(
    (x, y) =>
      Date.parse(y.at) - Date.parse(x.at) ||
      KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
      (y.ref_id < x.ref_id ? -1 : y.ref_id > x.ref_id ? 1 : 0),
  );
}

function briefingOf(a: Activity): Briefing {
  const { since, now } = a.window;
  const end = now + 1;
  const items = briefingItems(a);
  const first = (kind: BriefingKind) => items.find((i) => i.kind === kind) ?? null;
  const lead = first('lead');
  const answer = first('answer');
  const leadOrAnswer = lead === null ? answer : answer === null || Date.parse(lead.at) >= Date.parse(answer.at) ? lead : answer;
  return {
    since: a.window.sinceIso,
    conversations: conversationsIn(a, since, end).size,
    bookings: within(a.bookings, since, end).length,
    leads: within(a.leads, since, end).length,
    answers: items.filter((i) => i.kind === 'answer').length,
    turned_down: items.filter((i) => i.kind === 'turned_down').length,
    total: items.length,
    newest: { turned_down: first('turned_down'), booking: first('booking'), lead_or_answer: leadOrAnswer },
  };
}

/**
 * One count of a span, from `from` to `end` (left out), as the API's `week_counts` makes it for
 * Today's last 7 days and the reports alike: the conversations with someone's own words in it, how
 * many of them the owner stepped into there, and the bookings made.
 */
function spanCounts(a: Activity, from: number, end: number): { conversations: number; steppedIn: number; bookings: Booking[] } {
  const conversations = conversationsIn(a, from, end);
  const steppedIn = new Set(within(a.steppedIn, from, end).map((h) => h.sessionId).filter((id) => conversations.has(id)));
  return { conversations: conversations.size, steppedIn: steppedIn.size, bookings: within(a.bookings, from, end) };
}

/**
 * The last 7 days, as the API core's `this_week` counts them. `stopped` is the requests the kernel
 * refused, total and by day: a draft of Claude's the reply check stopped is no attempt anyone made,
 * so Safety lists it, but the briefing leaves it out and the week doesn't count it.
 */
function thisWeekOf(a: Activity): ThisWeek {
  const { days, weekFrom, now } = a.window;
  const end = now + 1;
  const { conversations, steppedIn, bookings } = spanCounts(a, weekFrom, end);
  const refused = a.stopped.filter((s) => s.kind === 'refused');
  return {
    timezone: BUSINESS.timezone,
    start: days[0]?.date ?? '',
    end: days.at(-1)?.date ?? '',
    bookings: bookings.length,
    booked_cents: bookings.reduce((sum, b) => sum + b.cents, 0),
    conversations,
    handled: conversations - steppedIn,
    stepped_in: steppedIn,
    stopped: within(refused, weekFrom, end).length,
    days: days.map(({ date, from, to }) => ({
      date,
      conversations: conversationsIn(a, from, Math.min(to, end)).size,
      bookings: within(a.bookings, from, Math.min(to, end)).length,
      stopped: within(refused, from, Math.min(to, end)).length,
    })),
  };
}

/**
 * The money paid through the Desk's payment links from `from` to `end` (left out), by when the
 * record says each was paid. (The API also counts what agents charged within their signed limits;
 * the mock's reports don't yet.)
 */
function paidCents(world: MockWorld, desk: DeskRecord, from: number, end: number): number {
  const paidAt = new Map(
    desk.ledger.filter((e) => e.event.kind === 'payment' && e.event.summary.state === 'paid').map((e) => [e.event.ref_id, Date.parse(e.created_at)]),
  );
  return [...world.links]
    .filter(([token, l]) => {
      const at = paidAt.get(token);
      return l.deskId === desk.summary.desk_id && l.view.state === 'paid' && at !== undefined && at >= from && at < end;
    })
    .reduce((sum, [, l]) => sum + l.view.amount_cents, 0);
}

/** The reports' span when none is asked for, and the longest the API allows, in local dates. */
export const REPORT_DAYS = { default: 30, max: 365 } as const;

/**
 * The reports for the last `days` local dates, today included, from 00:00 on the first of them to
 * now, as the API counts them: the same count as Today's last 7 days (`spanCounts`), so a
 * conversation needed the owner only when she stepped into it there (answered a request in it,
 * took it over, whispered or resumed it). A request held for her, or a chat the handoff card handed
 * to her, stays Claude's until she does.
 */
export function reports(world: MockWorld, desk: DeskRecord, days: number = REPORT_DAYS.default): Reports {
  const a = activityOf(world, desk);
  const { now } = a.window;
  const end = now + 1;
  const from = localInstant(addDays(wallClock(now, BUSINESS.timezone).date, 1 - days), 0, BUSINESS.timezone);
  const { conversations, steppedIn, bookings } = spanCounts(a, from, end);
  return {
    bookings: bookings.length,
    paid_cents: paidCents(world, desk, from, end),
    handled_by_claude: conversations - steppedIn,
    needed_you: steppedIn,
  };
}

/**
 * Safety's attempts, newest first: decisions refused at decide time and Claude's replies the check
 * stopped (the API core's `_stopped_attempts`); the briefing and the last 7 days count only the
 * refused ones. A hold is the owner's to answer, not an attempt
 * that was stopped, so it isn't listed. Each refusal carries its cause, read as the API reads it
 * from its deciding policies and its `decide` entry (`refusalCause`); a stopped draft has none.
 */
export function attempts(world: MockWorld, desk: DeskRecord): Attempt[] {
  const stopped: Attempt[] = refusals(world, desk)
    .map((d) => ({
      ref_id: d.decision.decision_id,
      kind: 'refused',
      reason_plain: d.decision.reason_plain,
      card_ids: [...d.decision.card_ids],
      origin: 'kernel',
      created_at: isoTime(d.createdAt),
      triage: refusalTriage(d),
      ledger_seq: d.decision.ledger_seq,
      cause: refusalCause(d.decision, desk.ledger.find((e) => e.seq === d.decision.ledger_seq && e.event.kind === 'decide') ?? null, {
        verified: world.sessions.get(d.decision.session_id)?.state.verified ?? false,
      }),
    }));
  const replies: Attempt[] = stoppedReplies(desk).map((entry) => ({
    ref_id: String(entry.seq),
    kind: 'reply_blocked',
    reason_plain: BLOCKED_REPLY_REASON,
    card_ids: [],
    origin: entry.event.origin,
    created_at: entry.created_at,
    triage: stoppedReplyTriage(),
    ledger_seq: entry.seq,
    cause: null,
  }));
  return [...stopped, ...replies].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The requests the kernel refused at decide time on `desk`. */
function refusals(world: MockWorld, desk: DeskRecord): DecisionRecord[] {
  return decisionsOf(world, desk.summary.desk_id).filter((d) => d.decision.outcome === 'refuse');
}

/**
 * The AI-written triage of a refused request, as Safety shows it: the scripted agent's over-limit
 * charge, whose receipt identifies it in either language, and none for any other.
 */
function refusalTriage(d: DecisionRecord): Triage | null {
  if (!Object.values(VISITOR_PLAIN).some((words) => words.refused_over_mandate === d.decision.visitor_plain)) return null;
  return { category: 'limits', summary: 'The agent asked to charge more than its signed limit. The Desk refused the charge.' };
}

/** The AI-written triage of a draft of Claude's the reply check stopped, as Safety shows it. */
function stoppedReplyTriage(): Triage {
  return {
    category: 'wording',
    summary: 'The visitor asked for a discount. Claude’s draft stated the discount in its own words, so the Desk stopped the reply.',
  };
}

/**
 * The newest AI-written triage summary of a chat's stopped attempts, the one Safety shows for it,
 * or null when nothing in it was triaged: what Needs you sends on a handoff (the API's
 * `newest_triage`). Here the ledger's order says which is newest. The API keeps the summary
 * written last, and its summaries are written by background jobs that can finish out of order, so
 * with two triaged attempts in one chat the two can pick differently. The mock writes no summary
 * late, so it doesn't model that.
 */
function newestTriageSummary(world: MockWorld, desk: DeskRecord, sessionId: string): string | null {
  const triaged = [
    ...refusals(world, desk)
      .filter((d) => d.decision.session_id === sessionId)
      .map((d) => ({ seq: d.decision.ledger_seq, triage: refusalTriage(d) })),
    ...stoppedReplies(desk)
      .filter((entry) => entry.event.session_id === sessionId)
      .map((entry) => ({ seq: entry.seq, triage: stoppedReplyTriage() })),
  ];
  const newest = triaged.filter((t) => t.triage !== null).sort((a, b) => a.seq - b.seq).at(-1);
  return newest?.triage?.summary ?? null;
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

/** What a visitor's transcript holds: their own words, what was delivered to them, and where the owner joined and left. */
const VISITOR_KINDS: ReadonlySet<TranscriptKind> = new Set(['visitor_text', 'delivered', 'status', 'owner_joined', 'owner_left']);

export function visitorTranscript(session: SessionRecord): VisitorTranscript {
  return {
    state: session.state,
    items: session.items.filter((item) => VISITOR_KINDS.has(item.kind)),
    last_seq: session.events.length,
  };
}

/** The owner's view of a chat: every item after `after`, whispers included, and whether the visitor is typing at `now`. */
export function ownerTranscript(session: SessionRecord, after: number, now: number, world: MockWorld): OwnerTranscript {
  const typing = session.typingUntil;
  return {
    state: session.state,
    items: session.items.filter((item) => item.n > after).map((item) => {
      const event = item.event;
      const status = item.kind === 'status' && event != null && (event.type === 'receipt' || event.type === 'resolved' || event.type === 'held') ? event : null;
      const decision = status == null ? undefined : world.decisions.get(status.decision_id)?.decision;
      const ownerPlain = status?.state === 'refused_at_execution' && decision?.state === status.state &&
        decision.session_id === session.state.session_id && decision.ledger_seq === status.ledger_seq ? decision.owner_plain ?? null : null;
      return { ...item, owner_translation: item.owner_translation ?? null, triage: item.triage ?? null, owner_plain: ownerPlain };
    }),
    typing_until: typing !== null && typing > now ? isoTime(typing) : null,
    demo_visitor: session.demoVisitor != null,
    demo_visitor_run_id: session.demoVisitorRun ?? null,
  };
}

export function publicDesk(desk: DeskRecord, language: Language): PublicDesk {
  return {
    ...rivera.publicDesk[language],
    desk_name: desk.summary.name,
    brand: effectiveBrand(desk.brand),
    agent_card: AGENT_CARD_BLOCKS[language].map((block) => ({ ...block })),
    open_status: desk.openStatus?.[language] ?? null,
  };
}

/** The mock checkout's view of a link: the kernel's `PaymentLinkView`, as the link holds it. */
export function paymentLinkOut(link: LinkRecord): PaymentLinkOut {
  return { ...link.view };
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

/**
 * The preset the owner cards came from: the one whose cards they are, exactly, as a Desk with these
 * opening hours drafts it (`presetCards`), else null. It is provenance only, and Turner's own rules
 * match neither.
 */
function presetOf(cards: readonly RuleCard[], hours: readonly HoursWindow[]): RulesPreset | null {
  const set = (list: readonly RuleCard[]) => list.filter((card) => card.is_default !== true).map(canonicalCard).sort().join('\n');
  const owned = set(cards);
  const match = (Object.keys(PRESETS) as RulesPreset[]).find((preset) => set(presetCards(preset, hours)) === owned);
  return match ?? null;
}

/**
 * The Desk's rules as the owner reads them: the active version with its money cap, every tool row
 * (the kernel's tool columns, without the adapter's own) with the active cards that cover it, in
 * card order, each `shared` when it is on an effect group, and the preset the owner cards came from.
 */
export function rulesView(desk: DeskRecord): RulesView {
  const cards = desk.policy.cards;
  const tools = desk.tools.map((tool): ToolRow => {
    const covering = new Set(rulesForTool({ tool: tool.tool as ToolName, effects: tool.effects }, cards).map((card) => card.card_id));
    return {
      tool: tool.tool as ToolName,
      source: tool.source,
      ...(tool.business === undefined ? {} : { business: structuredClone(tool.business) }),
      effects: [...tool.effects],
      reversible: tool.reversible,
      status: tool.status,
      description_confirmed: tool.description_confirmed,
      definition_sha256: tool.definition_sha256 ?? null,
      pending_definition_text: tool.pending_definition_text ?? null,
      pending_sha256: tool.pending_sha256 ?? null,
      review_reason: tool.review_reason,
      cards: cards
        .filter((card) => covering.has(card.card_id))
        .map((card) => ({ card_id: card.card_id, mode: card.mode, reason: card.reason, shared: card.applies_to.startsWith('effect:') })),
    };
  });
  return { active: { ...desk.policy, cards: cards.map((card) => ({ ...card })) }, tools, preset: presetOf(cards, desk.summary.hours) };
}

/**
 * What the owner told a Desk, oldest first, as the knowledge list returns it: an item the kernel
 * forces owner-only with its title and text withheld.
 */
export function knowledgeList(world: MockWorld, deskId: string): KnowledgeRow[] {
  return [...world.knowledge.values()]
    .filter((stored) => stored.deskId === deskId)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        if (a.createdAt === null) return -1;
        if (b.createdAt === null) return 1;
        return a.createdAt - b.createdAt;
      }
      return a.item.item_id < b.item.item_id ? -1 : a.item.item_id > b.item.item_id ? 1 : 0;
    })
    .map(({ item, createdAt, forced }) => ({
      item_id: item.item_id,
      title: forced ? null : item.title,
      text: forced ? null : item.text,
      readers: [...(item.label.readers ?? ['owner'])],
      source: item.source,
      created_at: createdAt === null ? null : isoTime(createdAt),
    }));
}

/** The business's people on record (Dana and Bob, as the seed has them) and the Desk's leads, oldest first. */
export function peopleOut(world: MockWorld, desk: DeskRecord): PeopleOut {
  const { dana, bob } = rivera.people;
  return {
    people: [dana, bob].map((person) => ({ person_id: person.personId, display_name: person.name, masked_contact: person.maskedContact })),
    leads: world.leads
      .filter((lead) => lead.deskId === desk.summary.desk_id)
      .map((lead) => ({
        lead_id: lead.leadId,
        display_name: lead.displayName,
        note: lead.note,
        created_at: isoTime(lead.createdAt),
        ...(lead.replayed === true ? { replayed: true } : {}),
        demo_visitor: world.sessions.get(lead.sessionId)?.demoVisitor != null,
      })),
  };
}
