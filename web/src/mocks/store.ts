/**
 * The mock API: one demo copy of Rivera Plumbing in memory, this browser's cookies, and the levers
 * a test pulls. `dispatch` answers a route the way Plan 02's API does, from and into that state, so
 * an answer on Today changes what the visitor's chat streams. MSW's handlers (handlers.ts) are only
 * its transport, and unit tests call it directly. The mock ships in no build: it runs in modes
 * `mock` and `test` only.
 *
 * Cookies are modelled, not set: the owner is signed in or not, and each Desk slug may name one
 * visitor session, as the API's HttpOnly cookies would. Nothing here is a credential.
 */
import type {
  ApprovalAnswer,
  Decision,
  DecisionState,
  DemoInboxEntry,
  EvDemoInbox,
  EvMessage,
  LedgerEntry,
  LedgerEvent,
  LedgerPage,
  PaymentLinkView,
  PolicyVersion,
  PublicDesk,
  RenderedBlock,
  SessionState,
  SseEvent,
  StatusEvent,
} from '../api/contracts.ts';
import { ROUTES, apiPath, type RouteKey, type RouteParams } from '../api/routes.ts';
import type {
  ApprovalAnswerOut,
  Attempt,
  BusinessOut,
  ConversationSummary,
  CopyOut,
  DeskSummary,
  Handoff,
  HealthOut,
  NeedsYouItem,
  NeedsYouSession,
  OwnerTranscript,
  Reports,
  Today,
  TranscriptItem,
  TranscriptKind,
  VisitorSession,
  VisitorTranscript,
} from '../api/views.ts';
import { placeholderHex, rivera } from '../ds/fixtures/index.ts';
import { BUSINESS, activePolicy, copyIds, seedWorld, type CopyIds, type MockSeed } from './seed.ts';
import {
  EVENT_GAP_MS,
  VISITOR_PLAIN,
  afterAnswer,
  allows,
  cardDiffFor,
  matchRule,
  turnEnd,
  turnLanguage,
  type DecisionSpec,
  type Language,
  type Step,
  type TurnContext,
} from './script.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Today's "live" conversations: activity in the last five minutes. */
const LIVE_MS = 5 * MINUTE;
/** Plan 02's limit on a visitor's message. */
const MESSAGE_MAX = 2000;

/** RFC 3339 UTC with microseconds, the form the kernel signs. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '000Z');
}

// Placeholders for hashes and signatures: nothing in the web app verifies one.
const sign = (label: string) => placeholderHex(`signature:${label}`, 64);
const sha256 = (label: string) => placeholderHex(`sha256:${label}`, 32);
const LEDGER_KEY = { key_id: rivera.ledger.verified.key_id, public_key_hex: rivera.ledger.verified.public_key_hex };

/** What a blocked reply's attempt says to the owner. */
const BLOCKED_REPLY_REASON =
  "Claude's reply put a price in its own words instead of a checked card, so it wasn't shown. The visitor was told you'll answer.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------
// The copy

type Listener = (seq: number, ev: SseEvent) => void;

interface SessionRecord {
  state: SessionState;
  deskId: string;
  ownerPreview: boolean;
  /** The verified person on record, once the visitor confirmed it's them; null until then. */
  person: { personId: string; name: string } | null;
  /** The verified person's name, else a lead's once the visitor gave one, else null. Untrusted. */
  displayName: string | null;
  /** The last turn's language; a follow-up after an answer uses it. */
  language: Language;
  lastActivity: number;
  lastVisitorText: string | null;
  /** The owner's view: the visitor's view leaves out whispers. */
  items: TranscriptItem[];
  /** Every event the session's stream has carried, `seq` from 1 with no gaps. */
  events: { seq: number; ev: SseEvent }[];
  listeners: Set<Listener>;
}

interface DeskRecord {
  summary: DeskSummary;
  policy: PolicyVersion;
  ledger: LedgerEntry[];
}

interface DecisionRecord {
  decision: Decision;
  deskId: string;
  createdAt: number;
  fromTheVisitor: string | null;
}

interface HandoffRecord {
  handoff: Handoff;
  deskId: string;
  createdAt: number;
  fromTheVisitor: string | null;
}

interface InboxRecord {
  entry: DemoInboxEntry;
  deskId: string;
  /** The visitor session the entry belongs to; null for the owner's alerts. */
  sessionId: string | null;
}

interface LinkRecord {
  view: PaymentLinkView;
  deskId: string;
  sessionId: string;
}

/** One seeded turn: what the visitor wrote, an optional owner whisper, and Claude's steps. */
export interface ReplayTurn {
  text: string;
  whisper?: string | undefined;
  steps: readonly Step[];
}

/** One demo copy: its business, Desks, chats, decisions and ledger, and how they change. */
export class MockWorld {
  readonly ids: CopyIds;
  readonly desks: DeskRecord[] = [];
  readonly sessions = new Map<string, SessionRecord>();
  readonly decisions = new Map<string, DecisionRecord>();
  readonly handoffs = new Map<string, HandoffRecord>();
  readonly inbox: InboxRecord[] = [];
  readonly links = new Map<string, LinkRecord>();
  private counter = 0;
  private itemN = 0;
  private fixedNow: number | null = null;

  constructor(
    readonly seed: MockSeed,
    readonly copyNo: number,
  ) {
    this.ids = copyIds(copyNo);
  }

  now(): number {
    return this.fixedNow ?? Date.now();
  }

  /** Runs `fn` as if it were `ms` o'clock: how the seed writes history. */
  at<T>(ms: number, fn: () => T): T {
    const before = this.fixedNow;
    this.fixedNow = ms;
    try {
      return fn();
    } finally {
      this.fixedNow = before;
    }
  }

  /** A new id, unique in this copy. */
  id(prefix: string): string {
    this.counter += 1;
    return this.copyNo === 1 ? `${prefix}-${this.counter}` : `${prefix}-${this.copyNo.toString(36)}-${this.counter}`;
  }

  /** A fixed seed id, made unique to this copy. */
  scoped(id: string): string {
    return this.copyNo === 1 ? id : `${id}-${this.copyNo.toString(36)}`;
  }

  desk(deskId: string | undefined): DeskRecord | undefined {
    return this.desks.find((d) => d.summary.desk_id === deskId);
  }

  deskBySlug(slug: string | undefined): DeskRecord | undefined {
    return this.desks.find((d) => d.summary.slug === slug);
  }

  private deskOf(session: SessionRecord): DeskRecord {
    const desk = this.desk(session.deskId);
    if (!desk) throw new Error(`session ${session.state.session_id} has no Desk`);
    return desk;
  }

  sessionsOf(deskId: string): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.deskId === deskId);
  }

  addDesk(fields: Pick<DeskSummary, 'desk_id' | 'slug' | 'name' | 'hours'>): DeskRecord {
    const desk: DeskRecord = {
      summary: { ...fields, business_name: BUSINESS.name, answering: true },
      policy: activePolicy(fields.desk_id),
      ledger: [],
    };
    this.desks.push(desk);
    return desk;
  }

  addSession(desk: DeskRecord, opts: { sessionId?: string; ownerPreview?: boolean } = {}): SessionRecord {
    const sessionId = opts.sessionId ?? this.id('ses-web');
    const session: SessionRecord = {
      state: { session_id: sessionId, kind: 'visitor', verified: false, assurance: 'none', mode: 'ai', generation: 1 },
      deskId: desk.summary.desk_id,
      ownerPreview: opts.ownerPreview ?? false,
      person: null,
      displayName: null,
      language: 'en',
      lastActivity: this.now(),
      lastVisitorText: null,
      items: [],
      events: [],
      listeners: new Set(),
    };
    this.sessions.set(sessionId, session);
    this.appendLedger(desk, {
      kind: 'session',
      origin: 'kernel',
      session_id: sessionId,
      ref_id: null,
      summary: { kind: session.ownerPreview ? 'preview' : 'visitor' },
    });
    return session;
  }

  appendLedger(desk: DeskRecord, event: LedgerEvent): LedgerEntry {
    const seq = desk.ledger.length + 1;
    const { copyId } = this.ids;
    const label = `ledger:${copyId}:${desk.summary.desk_id}:${seq}`;
    const entry: LedgerEntry = {
      copy_id: copyId,
      desk_id: desk.summary.desk_id,
      seq,
      prev_hash: desk.ledger.at(-1)?.hash ?? '0'.repeat(64),
      created_at: isoTime(this.now()),
      event,
      hash: sha256(label),
      signature: sign(label),
      key_id: LEDGER_KEY.key_id,
    };
    desk.ledger.push(entry);
    return entry;
  }

  private addItem(session: SessionRecord, kind: TranscriptKind, text: string | null, event: TranscriptItem['event']): void {
    this.itemN += 1;
    session.items.push({ n: this.itemN, kind, created_at: isoTime(this.now()), text, event });
  }

  visitorText(session: SessionRecord, text: string): void {
    this.addItem(session, 'visitor_text', text, null);
    session.lastVisitorText = text;
    session.language = turnLanguage(text);
    session.lastActivity = this.now();
  }

  whisper(session: SessionRecord, text: string): void {
    this.addItem(session, 'whisper', text, null);
    this.appendLedger(this.deskOf(session), {
      kind: 'whisper',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: null,
      summary: { characters: text.length },
    });
  }

  /** Adds `ev` to the session's stream with the next seq, keeps what the transcript keeps, and tells listeners. */
  emit(session: SessionRecord, ev: SseEvent): number {
    const seq = session.events.length + 1;
    session.events.push({ seq, ev });
    session.lastActivity = this.now();
    if (ev.type === 'message') this.addItem(session, 'delivered', null, ev);
    else if (ev.type === 'receipt' || ev.type === 'held' || ev.type === 'resolved') this.addItem(session, 'status', null, ev);
    for (const listener of [...session.listeners]) {
      try {
        listener(seq, ev);
      } catch {
        session.listeners.delete(listener);
      }
    }
    return seq;
  }

  decide(session: SessionRecord, spec: DecisionSpec, language: Language): Decision {
    const desk = this.deskOf(session);
    const decisionId = this.id('dec');
    const sessionId = session.state.session_id;
    const hold = spec.outcome === 'hold';
    const decided = this.appendLedger(desk, {
      kind: 'decide',
      origin: 'kernel',
      session_id: sessionId,
      ref_id: decisionId,
      summary: { tool: spec.tool, outcome: spec.outcome, card_ids: [...spec.cardIds] },
    });
    let state: DecisionState = hold ? 'held' : spec.outcome === 'refuse' ? 'refused' : 'allowed';
    let ledgerSeq = decided.seq;
    if (spec.outcome === 'allow' && spec.executed) {
      const ran = this.appendLedger(desk, {
        kind: 'execute',
        origin: 'kernel',
        session_id: sessionId,
        ref_id: decisionId,
        summary: { tool: spec.tool, state: 'succeeded' },
      });
      state = 'executed';
      ledgerSeq = ran.seq;
    }
    const inbox = hold ? [this.ownerAlert(desk, spec.reasonPlain)] : [];
    const decision: Decision = {
      decision_id: decisionId,
      session_id: sessionId,
      call_id: this.id('call'),
      action: {
        action_id: this.id('act'),
        copy_id: this.ids.copyId,
        desk_id: desk.summary.desk_id,
        session_id: sessionId,
        generation: session.state.generation,
        tool: spec.tool,
        effects: [...spec.effects],
        args_sha256: sha256(`args:${decisionId}`),
        profile_sha256: sha256(`profile:${spec.tool}`),
        resource: spec.resource ? { ...spec.resource } : { kind: 'desk', id: desk.summary.desk_id, owner_person_id: null },
        list_cents: spec.listCents ?? null,
        discount_bp: spec.discountBp ?? null,
        amount_cents: spec.amountCents ?? null,
        recipient: null,
        starts_at: null,
      },
      outcome: spec.outcome,
      state,
      policy_version: desk.policy.version,
      policy_ids: spec.cardIds.map((cardId) => (hold ? `H.${cardId}.hold` : `A.${cardId}`)),
      card_ids: [...spec.cardIds],
      review: null,
      reason_plain: spec.reasonPlain,
      visitor_plain: VISITOR_PLAIN[language][state],
      answers: hold ? [...(spec.answers ?? [])] : [],
      expires_at: isoTime(this.now() + DAY),
      inbox,
      ledger_seq: ledgerSeq,
      signature: sign(`${decisionId}:${state}`),
    };
    this.decisions.set(decisionId, {
      decision,
      deskId: desk.summary.desk_id,
      createdAt: this.now(),
      fromTheVisitor: session.lastVisitorText,
    });
    return decision;
  }

  /** The owner's Demo inbox alert for a hold; the decision carries its notice. */
  private ownerAlert(desk: DeskRecord, reason: string) {
    const entry: DemoInboxEntry = {
      entry_id: this.id('inbox'),
      to: 'owner',
      kind: 'alert',
      body: reason,
      created_at: isoTime(this.now()),
    };
    this.inbox.push({ entry, deskId: desk.summary.desk_id, sessionId: null });
    return { entry_id: entry.entry_id, to: 'owner', preview: 'A request needs your answer' };
  }

  /** The owner's answer, as the kernel records it: the approval, and the run when it allows. */
  answer(record: DecisionRecord, answer: ApprovalAnswer): Decision {
    const desk = this.desk(record.deskId);
    const session = this.sessions.get(record.decision.session_id);
    if (!desk || !session) throw new Error(`decision ${record.decision.decision_id} has no Desk or session`);
    const { decision_id: decisionId, session_id: sessionId } = record.decision;
    const approval = this.appendLedger(desk, {
      kind: 'approval',
      origin: 'kernel',
      session_id: sessionId,
      ref_id: decisionId,
      summary: { answer },
    });
    let state: DecisionState = 'denied';
    let ledgerSeq = approval.seq;
    if (allows(answer)) {
      const ran = this.appendLedger(desk, {
        kind: 'execute',
        origin: 'kernel',
        session_id: sessionId,
        ref_id: decisionId,
        summary: { tool: record.decision.action?.tool ?? null, state: 'succeeded' },
      });
      state = 'executed';
      ledgerSeq = ran.seq;
    }
    record.decision = {
      ...record.decision,
      state,
      visitor_plain: VISITOR_PLAIN[session.language][state],
      inbox: [],
      ledger_seq: ledgerSeq,
      signature: sign(`${decisionId}:${state}`),
    };
    return record.decision;
  }

  reply(session: SessionRecord, blocks: RenderedBlock[], language: Language, opts: { blocked?: boolean } = {}): EvMessage {
    const blocked = opts.blocked ?? false;
    const messageId = this.id('msg');
    const checked = this.appendLedger(this.deskOf(session), {
      kind: 'reply',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: messageId,
      summary: { author: 'claude', ok: !blocked, language, violations: blocked ? ['number_in_prose'] : [] },
    });
    return {
      type: 'message',
      message_id: messageId,
      generation: session.state.generation,
      author: 'claude',
      language,
      handoff: blocked,
      blocks: blocks.map((block) => ({ ...block, lines: [...(block.lines ?? [])], options: [...(block.options ?? [])] })),
      visitor_plain: VISITOR_PLAIN[language][blocked ? 'reply_handed_off' : 'reply_checked'],
      ledger_seq: checked.seq,
      signature: sign(messageId),
    };
  }

  /** The step context for one turn of `session`, in `language`. */
  context(session: SessionRecord, language: Language, text: string): TurnContext {
    return {
      language,
      text,
      decide: (spec) => this.decide(session, spec, language),
      status: (type, decision) => statusEvent(type, decision),
      reply: (blocks, opts) => this.reply(session, blocks, language, opts),
      inbox: (fields) => this.addVisitorInbox(session, fields),
      openHandoff: (fields) => this.openHandoff(session, fields),
      issueLink: (token, fields) => {
        this.links.set(token, {
          view: { title: fields.title, amount_cents: fields.amountCents, state: 'issued', language },
          deskId: session.deskId,
          sessionId: session.state.session_id,
        });
      },
    };
  }

  private addVisitorInbox(session: SessionRecord, fields: { to: string; body: string; preview: string }): EvDemoInbox {
    const entry: DemoInboxEntry = {
      entry_id: this.id('inbox'),
      to: fields.to,
      kind: 'verification_code',
      body: fields.body,
      created_at: isoTime(this.now()),
    };
    this.inbox.push({ entry, deskId: session.deskId, sessionId: session.state.session_id });
    return { type: 'demo_inbox', entry_id: entry.entry_id, to: entry.to, preview: fields.preview };
  }

  private openHandoff(session: SessionRecord, fields: { reason: string; callbackWindow: string | null; lead: string }): void {
    const handoffId = this.id('handoff');
    this.handoffs.set(handoffId, {
      handoff: {
        handoff_id: handoffId,
        session_id: session.state.session_id,
        reason: fields.reason,
        callback_window: fields.callbackWindow,
        status: 'open',
      },
      deskId: session.deskId,
      createdAt: this.now(),
      fromTheVisitor: session.lastVisitorText,
    });
    session.displayName ??= fields.lead;
  }

  /** Writes seeded turns into history from `from`, each step `EVENT_GAP_MS` apart and turns `gap` apart. */
  replay(session: SessionRecord, from: number, turns: ReplayTurn[], gap = MINUTE): void {
    let t = from;
    for (const turn of turns) {
      this.at(t, () => this.visitorText(session, turn.text));
      const { whisper } = turn;
      if (whisper !== undefined) {
        t += 20_000;
        this.at(t, () => this.whisper(session, whisper));
      }
      const language = turnLanguage(turn.text);
      for (const step of [...turn.steps, turnEnd]) {
        t += EVENT_GAP_MS;
        this.at(t, () => this.emit(session, step(this.context(session, language, turn.text))));
      }
      t += gap;
    }
  }
}

function statusEvent(type: StatusEvent['type'], decision: Decision): StatusEvent {
  return {
    type,
    decision_id: decision.decision_id,
    state: decision.state,
    visitor_plain: decision.visitor_plain,
    ledger_seq: decision.ledger_seq,
    signature: decision.signature,
  } as StatusEvent;
}

// ---------------------------------------------------------------------------------------------
// Read models

function deskSummaries(world: MockWorld): DeskSummary[] {
  return world.desks.map((desk) => ({ ...desk.summary, hours: desk.summary.hours.map((h) => ({ ...h })) }));
}

function copyOut(world: MockWorld): CopyOut {
  return { copy_id: world.ids.copyId, desks: deskSummaries(world) };
}

function businessOut(world: MockWorld): BusinessOut {
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

function conversationSummary(world: MockWorld, session: SessionRecord): ConversationSummary {
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

function needsYou(world: MockWorld, desk: DeskRecord): NeedsYouItem[] {
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

function today(world: MockWorld, desk: DeskRecord): Today {
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

function reports(world: MockWorld, desk: DeskRecord): Reports {
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

function attempts(world: MockWorld, desk: DeskRecord): Attempt[] {
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

function ledgerPage(desk: DeskRecord): LedgerPage {
  return {
    entries: desk.ledger,
    head: desk.ledger.at(-1)?.hash ?? '0'.repeat(64),
    chain_ok: true,
    first_bad_seq: null,
    ...LEDGER_KEY,
  };
}

const VISITOR_KINDS: ReadonlySet<TranscriptKind> = new Set(['visitor_text', 'delivered', 'status']);

function visitorTranscript(session: SessionRecord): VisitorTranscript {
  return {
    state: session.state,
    items: session.items.filter((item) => VISITOR_KINDS.has(item.kind)),
    last_seq: session.events.length,
  };
}

function ownerTranscript(session: SessionRecord, after: number): OwnerTranscript {
  return {
    state: session.state,
    items: session.items.filter((item) => item.n > after).map((item) => ({ ...item, owner_translation: null, triage: null })),
  };
}

function publicDesk(desk: DeskRecord, language: Language): PublicDesk {
  return { ...rivera.publicDesk[language], desk_name: desk.summary.name, brand: { ...BUSINESS.brand } };
}

const HEALTH: HealthOut = {
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

// ---------------------------------------------------------------------------------------------
// Routes

/** A request as a route sees it: path params, query, the parsed JSON body. */
interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** A body was sent but wasn't JSON. */
  malformed: boolean;
}

interface Served {
  status: number;
  body?: unknown;
}

const answerWith = (status: number, body?: unknown): Served => ({ status, body });
const failWith = (status: number, error: string, extra: Record<string, unknown> = {}): Served => ({
  status,
  body: { error, ...extra },
});
const NO_OWNER = failWith(401, 'no_owner_session');
const NO_SESSION = failWith(401, 'no_session');
const NOT_FOUND = failWith(404, 'not_found');
const INVALID = failWith(422, 'invalid');

const ANSWERS: ReadonlySet<string> = new Set<ApprovalAnswer>(['allow_once', 'deny_once', 'allow_person', 'deny_always']);

type Scheduled = { step: Step; language: Language; text: string };

/** The API's side: the copy, this browser's cookies, and the turns in progress. */
class Server {
  world: MockWorld;
  copyNo = 1;
  signedIn: boolean;
  /** Desk slug → the session its visitor cookie names. */
  readonly cookies = new Map<string, string>();
  private readonly turns = new Map<string, { queue: Scheduled[]; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    readonly seed: MockSeed,
    signedIn: boolean,
  ) {
    this.signedIn = signedIn;
    this.world = this.freshWorld();
  }

  private freshWorld(): MockWorld {
    const world = new MockWorld(this.seed, this.copyNo);
    seedWorld(world);
    return world;
  }

  /** A new copy of the same seed, with new ids; the old copy's chats and turns are left behind. */
  startOver(): void {
    this.stopTurns();
    this.copyNo += 1;
    this.world = this.freshWorld();
    this.cookies.clear();
  }

  stopTurns(): void {
    for (const turn of this.turns.values()) if (turn.timer !== null) clearTimeout(turn.timer);
    this.turns.clear();
  }

  /** The session this browser's cookie names for `slug`, or why there is none. */
  visitor(slug: string | undefined): { desk: DeskRecord; session: SessionRecord } | Served {
    const desk = this.world.deskBySlug(slug);
    if (!desk) return NOT_FOUND;
    const sessionId = slug === undefined ? undefined : this.cookies.get(slug);
    const session = sessionId === undefined ? undefined : this.world.sessions.get(sessionId);
    if (!session || session.deskId !== desk.summary.desk_id) return NO_SESSION;
    return { desk, session };
  }

  /** The owner's Desk named in the path, or why the owner can't have it. */
  ownerDesk(deskId: string | undefined): DeskRecord | Served {
    if (!this.signedIn) return NO_OWNER;
    return this.world.desk(deskId) ?? NOT_FOUND;
  }

  /** Queues `steps` after whatever the session's turn is doing, one event every `EVENT_GAP_MS`, then `turn_end`. */
  runTurn(session: SessionRecord, steps: readonly Step[], language: Language, text: string): void {
    const sessionId = session.state.session_id;
    let turn = this.turns.get(sessionId);
    if (!turn) {
      turn = { queue: [], timer: null };
      this.turns.set(sessionId, turn);
    }
    for (const step of [...steps, turnEnd]) turn.queue.push({ step, language, text });
    if (turn.timer === null) this.tick(sessionId);
  }

  private tick(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const world = this.world;
    turn.timer = setTimeout(() => {
      turn.timer = null;
      const session = world.sessions.get(sessionId);
      const next = turn.queue.shift();
      if (world !== this.world || !session || !next) return;
      world.emit(session, next.step(world.context(session, next.language, next.text)));
      if (turn.queue.length > 0) this.tick(sessionId);
    }, EVENT_GAP_MS);
  }
}

const isServed = (value: Served | object): value is Served => 'status' in value;

type RouteImpl = (server: Server, req: Req) => Served;

/** Every route the mock answers. The rest fall through to the catch-all, which records them. */
const SERVED = {
  copies(sv, req) {
    const passcode = isRecord(req.body) ? req.body.passcode : undefined;
    if (req.malformed || typeof passcode !== 'string' || passcode === '') return INVALID;
    if (passcode === 'wrong') return failWith(401, 'wrong_passcode');
    sv.signedIn = true;
    return answerWith(201, copyOut(sv.world));
  },
  startOver(sv) {
    if (!sv.signedIn) return NO_OWNER;
    sv.startOver();
    return answerWith(200, copyOut(sv.world));
  },
  me(sv) {
    return sv.signedIn ? answerWith(200, copyOut(sv.world)) : NO_OWNER;
  },
  desks(sv) {
    return sv.signedIn ? answerWith(200, [businessOut(sv.world)]) : NO_OWNER;
  },
  setAnswering(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    if (isServed(desk)) return desk;
    const on = isRecord(req.body) ? req.body.on : undefined;
    if (typeof on !== 'boolean') return INVALID;
    desk.summary.answering = on;
    return answerWith(200, { desk_id: desk.summary.desk_id, updated_at: isoTime(sv.world.now()) });
  },
  openPreview(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    if (isServed(desk)) return desk;
    const slug = desk.summary.slug;
    const current = sv.visitor(slug);
    if (!isServed(current) && current.session.ownerPreview) {
      return answerWith(200, { state: current.session.state, resumed: true } satisfies VisitorSession);
    }
    const session = sv.world.addSession(desk, { ownerPreview: true });
    sv.cookies.set(slug, session.state.session_id);
    return answerWith(200, { state: session.state, resumed: false } satisfies VisitorSession);
  },
  today(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isServed(desk) ? desk : answerWith(200, today(sv.world, desk));
  },
  needsYou(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isServed(desk) ? desk : answerWith(200, needsYou(sv.world, desk));
  },
  reports(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isServed(desk) ? desk : answerWith(200, reports(sv.world, desk));
  },
  answer(sv, req) {
    if (!sv.signedIn) return NO_OWNER;
    const record = sv.world.decisions.get(req.params.decision_id ?? '');
    if (!record) return NOT_FOUND;
    const answer = isRecord(req.body) ? req.body.answer : undefined;
    if (typeof answer !== 'string' || !ANSWERS.has(answer)) return failWith(422, 'kernel', { code: 'invalid' });
    if (record.decision.state !== 'held') return failWith(409, 'already_resolved', { decision: record.decision });
    const given = answer as ApprovalAnswer;
    if (!(record.decision.answers ?? []).includes(given)) return failWith(422, 'kernel', { code: 'invalid' });
    const session = sv.world.sessions.get(record.decision.session_id);
    const decision = sv.world.answer(record, given);
    if (session) sv.runTurn(session, afterAnswer(given, decision), session.language, '');
    const out: ApprovalAnswerOut = {
      decision,
      execution_state: allows(given) ? 'succeeded' : null,
      card_diff: cardDiffFor(given, decision, session?.person ?? null),
    };
    return answerWith(200, out);
  },
  conversations(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    if (isServed(desk)) return desk;
    const sessions = sv.world.sessionsOf(desk.summary.desk_id).sort((a, b) => b.lastActivity - a.lastActivity);
    return answerWith(200, sessions.map((s) => conversationSummary(sv.world, s)));
  },
  conversation(sv, req) {
    if (!sv.signedIn) return NO_OWNER;
    const session = sv.world.sessions.get(req.params.session_id ?? '');
    if (!session) return NOT_FOUND;
    const after = Number(req.query.get('after') ?? '0');
    return answerWith(200, ownerTranscript(session, Number.isSafeInteger(after) ? after : 0));
  },
  safety(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isServed(desk) ? desk : answerWith(200, attempts(sv.world, desk));
  },
  ledger(sv, req) {
    const desk = sv.ownerDesk(req.params.desk_id);
    return isServed(desk) ? desk : answerWith(200, ledgerPage(desk));
  },
  health() {
    return answerWith(200, HEALTH);
  },
  publicDesk(sv, req) {
    const desk = sv.world.deskBySlug(req.params.slug);
    if (!desk) return NOT_FOUND;
    return answerWith(200, publicDesk(desk, req.query.get('lang') === 'es' ? 'es' : 'en'));
  },
  openSession(sv, req) {
    const slug = req.params.slug ?? '';
    const desk = sv.world.deskBySlug(slug);
    if (!desk) return NOT_FOUND;
    const current = sv.visitor(slug);
    if (!isServed(current)) return answerWith(200, { state: current.session.state, resumed: true } satisfies VisitorSession);
    const session = sv.world.addSession(desk);
    sv.cookies.set(slug, session.state.session_id);
    return answerWith(200, { state: session.state, resumed: false } satisfies VisitorSession);
  },
  visitorSession(sv, req) {
    const visitor = sv.visitor(req.params.slug);
    return isServed(visitor) ? visitor : answerWith(200, visitorTranscript(visitor.session));
  },
  sendMessage(sv, req) {
    const visitor = sv.visitor(req.params.slug);
    if (isServed(visitor)) return visitor;
    const text = isRecord(req.body) ? req.body.text : undefined;
    if (req.malformed || typeof text !== 'string' || text.length < 1 || text.length > MESSAGE_MAX) return INVALID;
    const { session } = visitor;
    sv.world.visitorText(session, text);
    if (session.state.mode === 'ai') sv.runTurn(session, matchRule(text).steps, session.language, text);
    return answerWith(202, { message_id: sv.world.id('vmsg') });
  },
  events(sv, req) {
    // A 200 opens the stream (handlers.ts); `listen` replays and follows it.
    const visitor = sv.visitor(req.params.slug);
    return isServed(visitor) ? visitor : answerWith(200);
  },
} satisfies { [K in RouteKey]?: RouteImpl };

export type ServedKey = keyof typeof SERVED;

/** The routes the mock answers, in the route table's order. */
export const SERVED_KEYS = (Object.keys(ROUTES) as RouteKey[]).filter((key): key is ServedKey => key in SERVED);

// ---------------------------------------------------------------------------------------------
// The store a test drives

export interface MockRequestInit {
  params?: Record<string, string>;
  query?: Record<string, string> | URLSearchParams;
  body?: unknown;
  /** The body wasn't JSON. */
  malformed?: boolean;
  /** The path as sent, with its query; worked out from the route when absent. */
  path?: string;
}

/** What a route answered: a status and JSON body, or a connection dropped with no answer. */
export type MockAnswer = { status: number; body?: unknown } | { network: true };

export interface MockRequest {
  key: RouteKey;
  body: unknown;
  /** The path as sent, with its query. */
  path: string;
}

/** A fault a test plants on a route. */
export interface Injection {
  route: RouteKey;
  /** The answer's status, or `network` for a connection dropped with no answer. */
  status: number | 'network';
  /** How many requests it answers (default 1). */
  times?: number;
  /** The answer's body; a plain `{error}` for the status when absent. */
  body?: unknown;
  /** Waits this long before answering. */
  delayMs?: number;
  /** Lets the route apply its change first, then answers with the fault: a write whose answer was lost. */
  afterCommit?: boolean;
}

export interface ResetOptions {
  /** Whether this browser holds the copy's owner cookie (default true; the dev server starts signed out). */
  signedIn?: boolean;
}

/** The `{error}` body a planted status answers with when it names none. */
function faultBody(status: number, key: RouteKey): unknown {
  if (status < 400) return undefined;
  if (status === 401) return { error: ROUTES[key].owner ? 'no_owner_session' : 'no_session' };
  if (status === 404) return { error: 'not_found' };
  if (status === 409) return { error: 'conflict' };
  if (status === 429) return { error: 'rate_limited', retry_after: 5 };
  if (status === 503) return { error: 'kernel', code: 'kernel_unavailable' };
  if (status >= 500) return { error: 'internal' };
  return { error: 'invalid' };
}

function toQuery(query: MockRequestInit['query']): URLSearchParams {
  return query instanceof URLSearchParams ? query : new URLSearchParams(query ?? {});
}

/** The path a request would have had, for the request log when the caller gave none. */
function pathFor(key: RouteKey, params: Record<string, string>, query: URLSearchParams): string {
  try {
    const path = apiPath(key, params as RouteParams<typeof key>);
    const qs = query.toString();
    return qs === '' ? path : `${path}?${qs}`;
  } catch {
    return ROUTES[key].path;
  }
}

/** Where a visitor's stream resumes: past `?after=` or the browser's `Last-Event-ID`, whichever is later. */
export function streamAfter(query: URLSearchParams, lastEventId: string | null): number {
  const read = (value: string | null) => (value !== null && /^\d+$/.test(value) ? Number(value) : 0);
  return Math.max(read(query.get('after')), read(lastEventId));
}

/** Round-trips through JSON, as the wire would: no answer shares an object with the store. */
const wire = (body: unknown): unknown => (body === undefined ? undefined : JSON.parse(JSON.stringify(body)));

export class MockStore {
  private server = new Server('rivera', true);
  private injections: (Injection & { left: number })[] = [];
  private readonly log: MockRequest[] = [];
  private readonly unhandledPaths: string[] = [];

  /** The copy as it stands, for tests that check what a route changed. */
  get world(): MockWorld {
    return this.server.world;
  }

  /** Every request a route answered (or a fault answered for it), in order. */
  get requests(): readonly MockRequest[] {
    return this.log;
  }

  /** Paths under `/api/` that no mocked route answers, in order. */
  get unhandled(): readonly string[] {
    return this.unhandledPaths;
  }

  /** A fresh copy of `seed`: no visitor cookies, no faults, nothing recorded, no turn in flight. */
  reset(seed: MockSeed, opts: ResetOptions = {}): void {
    this.server.stopTurns();
    this.server = new Server(seed, opts.signedIn ?? true);
    this.injections = [];
    this.log.length = 0;
    this.unhandledPaths.length = 0;
  }

  inject(injection: Injection): void {
    this.injections.push({ ...injection, left: injection.times ?? 1 });
  }

  recordUnhandled(path: string): void {
    this.unhandledPaths.push(path);
  }

  /** Removes one recorded unhandled request to `path`; throws if there is none. */
  takeUnhandled(path: string): void {
    const index = this.unhandledPaths.indexOf(path);
    if (index === -1) {
      throw new Error(`expected an unhandled request to ${path}; recorded: ${JSON.stringify(this.unhandledPaths)}`);
    }
    this.unhandledPaths.splice(index, 1);
  }

  private takeInjection(key: RouteKey): Injection | null {
    const injection = this.injections.find((i) => i.route === key && i.left > 0);
    if (!injection) return null;
    injection.left -= 1;
    return injection;
  }

  /** Answers `key` as the API would: a planted fault first, else the route, from and into the copy. */
  async dispatch(key: RouteKey, init: MockRequestInit = {}): Promise<MockAnswer> {
    const params = init.params ?? {};
    const query = toQuery(init.query);
    this.log.push({ key, body: init.body, path: init.path ?? pathFor(key, params, query) });
    const injection = this.takeInjection(key);
    if (injection?.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, injection.delayMs));
    const impl: RouteImpl | undefined = (SERVED as { [K in RouteKey]?: RouteImpl })[key];
    let served: Served;
    if (injection !== null && injection.afterCommit !== true) {
      served = { status: 0 };
    } else if (impl) {
      served = impl(this.server, { params, query, body: init.body, malformed: init.malformed ?? false });
    } else {
      this.recordUnhandled(ROUTES[key].path);
      served = failWith(501, 'not_mocked');
    }
    if (injection !== null) {
      if (injection.status === 'network') return { network: true };
      return { status: injection.status, body: wire(injection.body ?? faultBody(injection.status, key)) };
    }
    return { status: served.status, body: wire(served.body) };
  }

  /**
   * Follows the stream of the session this browser's cookie names for `slug`: every event after
   * `after` at once, then each new one as it happens. Returns the function that stops it.
   */
  listen(slug: string, after: number, send: (seq: number, ev: SseEvent) => void): () => void {
    const visitor = this.server.visitor(slug);
    if (isServed(visitor)) return () => {};
    const { session } = visitor;
    for (const { seq, ev } of session.events) if (seq > after) send(seq, ev);
    session.listeners.add(send);
    return () => {
      session.listeners.delete(send);
    };
  }
}

/** The one mock API, shared by the handlers, the screen tests and the dev server. */
export const mockStore = new MockStore();
