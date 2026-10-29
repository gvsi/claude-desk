/**
 * The mock API's world: one demo copy of Rivera Plumbing in memory (its Desks, chats, decisions,
 * ledger and Demo inbox) and how a turn changes it. The seed (seed.ts) fills a new copy, the read
 * models (readModels.ts) read it, and the routes (served.ts) answer from and into it.
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
  OpenStatus,
  PaymentLinkView,
  PolicyVersion,
  RenderedBlock,
  RuleCard,
  SessionState,
  SseEvent,
  StatusEvent,
} from '../api/contracts.ts';
import type { DeskSummary, Handoff, RulesDraft, TranscriptItem, TranscriptKind } from '../api/views.ts';
import { placeholderHex, rivera } from '../ds/fixtures/index.ts';
import { BUSINESS, activePolicy, copyIds, type CopyIds, type MockSeed } from './seed.ts';
import {
  DECISIONS,
  EVENT_GAP_MS,
  VISITOR_PLAIN,
  allows,
  answersFor,
  statusLine,
  turnEnd,
  turnLanguage,
  writing,
  type DecisionSpec,
  type Language,
  type Step,
  type TurnContext,
} from './script.ts';

export const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** RFC 3339 UTC with microseconds, the form the kernel signs. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '000Z');
}

// Placeholders for hashes and signatures: nothing in the web app verifies one.
const sign = (label: string) => placeholderHex(`signature:${label}`, 64);
const sha256 = (label: string) => placeholderHex(`sha256:${label}`, 32);
export const LEDGER_KEY = { key_id: rivera.ledger.verified.key_id, public_key_hex: rivera.ledger.verified.public_key_hex };

type Listener = (seq: number, ev: SseEvent) => void;

export interface SessionRecord {
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

export interface DeskRecord {
  summary: DeskSummary;
  policy: PolicyVersion;
  ledger: LedgerEntry[];
  /** The kernel's open status for the Desk's public page, by language; null when it makes no claim. */
  openStatus: Record<Language, OpenStatus> | null;
  /** Rule drafts made from the active rules, by version; none is active until the owner confirms it. */
  drafts: Map<number, RulesDraft>;
}

export interface DecisionRecord {
  decision: Decision;
  deskId: string;
  createdAt: number;
  fromTheVisitor: string | null;
}

export interface HandoffRecord {
  handoff: Handoff;
  deskId: string;
  createdAt: number;
  fromTheVisitor: string | null;
}

/** A lead, as the kernel keeps one: someone who left their name and how to reach them. */
export interface LeadRecord {
  leadId: string;
  deskId: string;
  sessionId: string;
  /** As the visitor typed it. Untrusted. */
  displayName: string;
  /** What they want and how to reach them, as typed. Untrusted. */
  note: string;
  createdAt: number;
}

export interface InboxRecord {
  entry: DemoInboxEntry;
  deskId: string;
  /** The visitor session the entry belongs to; null for the owner's alerts. */
  sessionId: string | null;
}

export interface LinkRecord {
  view: PaymentLinkView;
  deskId: string;
  sessionId: string;
}

/** What verified Dana writes when she asks for her drain clearing payment back. Untrusted, as any visitor's words. */
export const REFUND_REQUEST = "I'd like a refund for the drain clearing I paid for on October 12.";

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
  readonly leads: LeadRecord[] = [];
  readonly inbox: InboxRecord[] = [];
  readonly links = new Map<string, LinkRecord>();
  private counter = 0;
  private itemN = 0;
  private fixedNow: number | null = null;

  constructor(
    readonly seed: MockSeed,
    readonly copyNo: number,
    /** A new payment link's token, from the store that holds the copy. */
    private readonly linkToken: () => string,
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

  addDesk(fields: Pick<DeskSummary, 'desk_id' | 'slug' | 'name' | 'hours'> & Pick<DeskRecord, 'openStatus'>): DeskRecord {
    const { openStatus, ...summary } = fields;
    const desk: DeskRecord = {
      summary: { ...summary, business_name: BUSINESS.name, answering: true },
      policy: activePolicy(fields.desk_id),
      ledger: [],
      openStatus,
      drafts: new Map(),
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
      } catch (error) {
        // Dropped, so the others still hear the stream, and rethrown on its own, so a framing bug
        // or a failed assertion fails where it happened instead of a stream that quietly stops.
        session.listeners.delete(listener);
        queueMicrotask(() => {
          throw error;
        });
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
      visitor_plain: statusLine(language, state, spec.tool),
      answers: hold ? answersFor(spec, session.person !== null) : [],
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

  /** The visitor confirmed it's them with the demo code: the chat is now `person`'s, verified. */
  verify(session: SessionRecord, person: { personId: string; name: string }): void {
    session.state = { ...session.state, verified: true, assurance: 'demo_code' };
    session.person = { personId: person.personId, name: person.name };
    session.displayName = person.name;
    this.appendLedger(this.deskOf(session), {
      kind: 'verify',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: null,
      summary: { ok: true, assurance: 'demo_code' },
    });
  }

  /**
   * Verified Dana asks for her $180.00 drain clearing payment back, a minute ago, and the refund
   * card holds it for Maria: the design system's `rivera.heldRefund`, in this copy. Tests add it;
   * no seed has it. Her verified chat with the Desk is made the first time and kept after.
   */
  addHeldRefund(deskId: string = this.ids.deskId): Decision {
    const desk = this.desk(deskId);
    if (!desk) throw new Error(`the copy has no Desk ${deskId}`);
    const from = this.now() - MINUTE;
    const { dana } = rivera.people;
    let session = this.sessionsOf(deskId).find((s) => s.person?.personId === dana.personId);
    if (!session) {
      const sessionId = deskId === this.ids.deskId ? this.scoped('ses-dana-verified') : undefined;
      const opened = this.at(from, () => this.addSession(desk, { sessionId }));
      this.at(from, () => this.verify(opened, dana));
      session = opened;
    }
    let held: Decision | null = null;
    this.replay(session, from, [
      {
        text: REFUND_REQUEST,
        steps: [
          (ctx) => {
            held = ctx.decide(DECISIONS.heldRefund);
            return ctx.status('held', held);
          },
          writing,
          (ctx) => ctx.reply([rivera.blocks.handoff[ctx.language]]),
        ],
      },
    ]);
    if (held === null) throw new Error("Dana's refund wasn't decided");
    return held;
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
      visitor_plain: statusLine(session.language, state, record.decision.action?.tool ?? null),
      inbox: [],
      ledger_seq: ledgerSeq,
      signature: sign(`${decisionId}:${state}`),
    };
    return record.decision;
  }

  /** The visitor cancels their held request, as the kernel records it: no answer can run it now. */
  cancel(record: DecisionRecord): Decision {
    const desk = this.desk(record.deskId);
    const session = this.sessions.get(record.decision.session_id);
    if (!desk || !session) throw new Error(`decision ${record.decision.decision_id} has no Desk or session`);
    const { decision_id: decisionId, session_id: sessionId } = record.decision;
    const cancelled = this.appendLedger(desk, {
      kind: 'approval',
      origin: 'kernel',
      session_id: sessionId,
      ref_id: decisionId,
      summary: { state: 'cancelled', by: 'visitor' },
    });
    record.decision = {
      ...record.decision,
      state: 'cancelled',
      visitor_plain: statusLine(session.language, 'cancelled', record.decision.action?.tool ?? null),
      inbox: [],
      ledger_seq: cancelled.seq,
      signature: sign(`${decisionId}:cancelled`),
    };
    this.emit(session, statusEvent('resolved', record.decision));
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
      issueLink: (fields) => {
        this.links.set(this.linkToken(), {
          view: { title: fields.title, amount_cents: fields.amountCents, state: 'issued', language },
          deskId: session.deskId,
          sessionId: session.state.session_id,
        });
      },
      latestLink: () => {
        const mine = [...this.links].filter(([, link]) => link.sessionId === session.state.session_id);
        const newest = mine.at(-1);
        if (!newest) throw new Error(`session ${session.state.session_id} has no payment link`);
        return newest[0];
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

  /** A callback request in Needs you, and the lead it makes: the name, and the rest of what they typed as its note. */
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
    const named = `${fields.lead} · `;
    this.leads.push({
      leadId: this.id('lead'),
      deskId: session.deskId,
      sessionId: session.state.session_id,
      displayName: fields.lead,
      note: fields.reason.startsWith(named) ? fields.reason.slice(named.length) : fields.reason,
      createdAt: this.now(),
    });
    session.displayName ??= fields.lead;
  }

  /** The owner closes a callback request, as the kernel records it. */
  closeHandoff(record: HandoffRecord): void {
    const desk = this.desk(record.deskId);
    if (!desk) throw new Error(`handoff ${record.handoff.handoff_id} has no Desk`);
    record.handoff = { ...record.handoff, status: 'done' };
    this.appendLedger(desk, {
      kind: 'desk_data',
      origin: 'kernel',
      session_id: record.handoff.session_id,
      ref_id: record.handoff.handoff_id,
      summary: { handoff: 'done' },
    });
  }

  /**
   * The owner takes over the chat, as the kernel records it: the owner's mode at the next
   * generation, so anything still running for the old one is fenced off, and the visitor is told.
   */
  takeOver(session: SessionRecord): SessionState {
    session.state = { ...session.state, mode: 'owner', generation: session.state.generation + 1 };
    this.appendLedger(this.deskOf(session), {
      kind: 'takeover',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: null,
      summary: { mode: 'owner', generation: session.state.generation },
    });
    this.emit(session, { type: 'owner_joined', name: BUSINESS.owner_display_name });
    return session.state;
  }

  /**
   * A draft of the Desk's rules with `add` merged in by `card_id`, as the kernel drafts an
   * approval's card diff: the next version, checked, and stored until the owner confirms it.
   * Default cards are left out of what it shows.
   */
  draft(desk: DeskRecord, add: readonly RuleCard[]): RulesDraft {
    const before = desk.policy.cards.filter((card) => !card.is_default);
    const cards = before.map((card) => ({ ...card }));
    const added: RuleCard[] = [];
    const changed: [RuleCard, RuleCard][] = [];
    for (const card of add) {
      const at = cards.findIndex((c) => c.card_id === card.card_id);
      const copy = { ...card };
      if (at === -1) {
        cards.push(copy);
        added.push(copy);
      } else {
        const old = cards[at];
        if (old) changed.push([old, copy]);
        cards[at] = copy;
      }
    }
    const reasons = (mode: RuleCard['mode']) => cards.filter((c) => c.mode === mode).map((c) => c.reason);
    const proof = desk.policy.proof;
    const draft: RulesDraft = {
      version: desk.policy.version + desk.drafts.size + 1,
      cards,
      diff: { added, removed: [], changed },
      proof: {
        ok: true,
        method: 'symcc',
        cases: null,
        timed_out: false,
        checks: (proof?.checks ?? []).map((check) => ({ ...check })),
      },
      summary: { on_its_own: reasons('auto'), asks_you: reasons('ask'), never: reasons('never') },
    };
    desk.drafts.set(draft.version, draft);
    return draft;
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
