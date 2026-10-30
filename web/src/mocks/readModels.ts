/**
 * The mock API's read models: what the owner's and the visitor's reads answer, built from the
 * copy as it stands (world.ts) in the shapes of Plan 02's read models (`api/views.ts`) and the
 * shared contracts.
 */
import type { Decision, DecisionState, LedgerEntry, LedgerPage, PublicDesk } from '../api/contracts.ts';
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
  NeedsYouItem,
  NeedsYouSession,
  OwnerTranscript,
  PaymentLinkOut,
  Reports,
  ThisWeek,
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
  type LinkRecord,
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
        handoff: null,
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
        decision: null,
        held_by: null,
        held_at: null,
        session: needsYouSession(world.sessions.get(h.handoff.session_id), h.handoff.session_id),
        from_the_visitor: h.fromTheVisitor,
      } satisfies NeedsYouItem,
    }));
  return [...held, ...callbacks].sort((a, b) => a.at - b.at).map(({ item }) => item);
}

/**
 * One of Claude's replies the check stopped, as Safety and Today count them: its `reply` entry
 * wasn't ok for a reason other than a paused chat. An owner's stopped say isn't an attempt.
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
  leads: (Happened & { leadId: string; displayName: string; note: string })[];
  /** Refusals at decide time, and Claude's replies the check stopped. */
  stopped: (Happened & { refId: string; line: string | null })[];
  holds: Happened[];
  callbacks: Happened[];
  /** The owner answering a hold, taking over, whispering, resuming, or writing in the chat. */
  steppedIn: Happened[];
  /** Replies Claude delivered that weren't a handoff. */
  replies: Happened[];
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
        .map((d) => ({ sessionId: d.decision.session_id, at: d.createdAt, refId: d.decision.decision_id, line: d.decision.reason_plain })),
      ...stoppedReplies(desk).map((e) => ({ sessionId: sessionOf(e), at: Date.parse(e.created_at), refId: String(e.seq), line: null })),
    ],
    holds: decisions.filter((d) => d.decision.outcome === 'hold').map((d) => ({ sessionId: d.decision.session_id, at: d.createdAt })),
    callbacks: executed('native.request_callback').map((d) => ({ sessionId: d.decision.session_id, at: reachedAt(d.decision) })),
    steppedIn: [
      ...[...approvals, ...ownerActs].map((e) => ({ sessionId: sessionOf(e), at: Date.parse(e.created_at) })),
      ...delivered.filter((d) => author(d) === 'owner'),
    ],
    replies: delivered.filter(
      (d) => author(d) === 'claude' && !(d.item.event?.type === 'message' && d.item.event.blocks.some((b) => b.template === 'handoff')),
    ),
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

const KIND_ORDER: readonly BriefingKind[] = ['blocked', 'booking', 'lead', 'answer'];

function briefingItems(a: Activity): BriefingItem[] {
  const { since, now } = a.window;
  const end = now + 1;
  const nameOf = (sessionId: string) => a.world.sessions.get(sessionId)?.displayName ?? null;
  const item = (kind: BriefingKind, h: Happened, refId: string, line: string | null): BriefingItem => ({
    kind,
    at: isoTime(h.at),
    session_id: h.sessionId === '' ? null : h.sessionId,
    display_name: h.sessionId === '' ? null : nameOf(h.sessionId),
    ref_id: refId,
    line,
  });
  // An answer: Claude replied in the window, to a conversation with nothing else in it.
  const busy = new Set(
    [a.bookings, a.leads, a.holds, a.stopped, a.callbacks].flatMap((all) => within(all, since, end).map((h) => h.sessionId)),
  );
  const newestReply = new Map<string, Happened>();
  for (const reply of within(a.replies, since, end)) {
    if (busy.has(reply.sessionId)) continue;
    const seen = newestReply.get(reply.sessionId);
    if (!seen || reply.at > seen.at) newestReply.set(reply.sessionId, reply);
  }
  const items = [
    ...within(a.stopped, since, end).map((s) => item('blocked', s, s.refId, s.line)),
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
    blocked: within(a.stopped, since, end).length,
    total: items.length,
    newest: { blocked: first('blocked'), booking: first('booking'), lead_or_answer: leadOrAnswer },
  };
}

function thisWeekOf(a: Activity): ThisWeek {
  const { days, weekFrom, now } = a.window;
  const end = now + 1;
  const conversations = conversationsIn(a, weekFrom, end);
  const steppedIn = new Set(within(a.steppedIn, weekFrom, end).map((h) => h.sessionId).filter((id) => conversations.has(id)));
  const bookings = within(a.bookings, weekFrom, end);
  return {
    timezone: BUSINESS.timezone,
    start: days[0]?.date ?? '',
    end: days.at(-1)?.date ?? '',
    bookings: bookings.length,
    booked_cents: bookings.reduce((sum, b) => sum + b.cents, 0),
    conversations: conversations.size,
    handled: conversations.size - steppedIn.size,
    stepped_in: steppedIn.size,
    stopped: within(a.stopped, weekFrom, end).length,
    days: days.map(({ date, from, to }) => ({
      date,
      conversations: conversationsIn(a, from, Math.min(to, end)).size,
      bookings: within(a.bookings, from, Math.min(to, end)).length,
      stopped: within(a.stopped, from, Math.min(to, end)).length,
    })),
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

/**
 * Safety's attempts, newest first: decisions refused at decide time and Claude's replies the check
 * stopped, the same filter as Today's "stopped" (the API core's `_stopped_attempts`). A hold is the
 * owner's to answer, not an attempt that was stopped, so it isn't listed.
 */
export function attempts(world: MockWorld, desk: DeskRecord): Attempt[] {
  const stopped: Attempt[] = decisionsOf(world, desk.summary.desk_id)
    .filter((d) => d.decision.outcome === 'refuse')
    .map((d) => ({
      ref_id: d.decision.decision_id,
      kind: 'refused',
      reason_plain: d.decision.reason_plain,
      card_ids: [...d.decision.card_ids],
      origin: 'kernel',
      created_at: isoTime(d.createdAt),
      triage: null,
      ledger_seq: d.decision.ledger_seq,
    }));
  const replies: Attempt[] = stoppedReplies(desk).map((entry) => ({
    ref_id: String(entry.seq),
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

/** The owner's view of a chat: every item after `after`, whispers included, and whether the visitor is typing at `now`. */
export function ownerTranscript(session: SessionRecord, after: number, now: number): OwnerTranscript {
  const typing = session.typingUntil;
  return {
    state: session.state,
    items: session.items.filter((item) => item.n > after).map((item) => ({ ...item, owner_translation: item.owner_translation ?? null, triage: item.triage ?? null })),
    typing_until: typing !== null && typing > now ? isoTime(typing) : null,
  };
}

export function publicDesk(desk: DeskRecord, language: Language): PublicDesk {
  return {
    ...rivera.publicDesk[language],
    desk_name: desk.summary.name,
    brand: { ...BUSINESS.brand },
    open_status: desk.openStatus?.[language] ?? null,
  };
}

/**
 * The mock checkout's view of a link: the kernel's `PaymentLinkView` and the fields kernel plan 01c
 * adds (`views.ts` `PaymentLinkOut`). The customer's name shows only while the link is open.
 */
export function paymentLinkOut(link: LinkRecord): PaymentLinkOut {
  return {
    ...link.view,
    cancel_reason: link.cancelReason,
    business_name: BUSINESS.name,
    customer_name: link.view.state === 'issued' ? link.customerName : null,
  };
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
