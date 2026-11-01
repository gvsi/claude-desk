/**
 * The mock API's world: one demo copy of Turner Plumbing in memory (its Desks, chats, decisions,
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
  KnowledgeItem,
  LedgerEntry,
  LedgerEvent,
  OpenStatus,
  PaymentLinkView,
  RenderedBlock,
  ReplyVerdict,
  RuleCard,
  OwnerMessageResult,
  SessionState,
  SseEvent,
  StatusEvent,
  ToolProfile,
} from '../api/contracts.ts';
import type {
  DeskSummary,
  Handoff,
  PolicyVersionOut,
  RulesDraft,
  Suggestion,
  ToolConfirmEntry,
  ToolConfirmedOut,
  ToolReviewReason,
  ToolRow,
  TranscriptItem,
  TranscriptKind,
} from '../api/views.ts';
import { cardBlock, placeholderHex, rivera } from '../ds/fixtures/index.ts';
import { rulesForTool } from '../ds/components/ToolRulesCard/toolRules.ts';
import { OWNER_NAME_FALLBACK } from '../public/brand.ts';
import { DOCUMENT_HREF, type DocumentLink } from './documents.ts';
import { BUSINESS, activePolicy, copyIds, riveraTools, type CopyIds, type MockSeed } from './seed.ts';
import {
  DECISIONS,
  EVENT_GAP_MS,
  allows,
  answersFor,
  linkCancelledBlock,
  statusLine,
  turnEnd,
  turnLanguage,
  visitorLine,
  writing,
  type DecisionSpec,
  type DeskOwner,
  type Language,
  type Step,
  type TurnContext,
} from './script.ts';

export const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Tokens `prefix1`, `prefix2`…, for a copy made without a store to name its links. */
function counted(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** RFC 3339 UTC with microseconds, the form the kernel signs. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '000Z');
}

// Placeholders for hashes and signatures: nothing in the web app verifies one.
const sign = (label: string) => placeholderHex(`signature:${label}`, 64);
const sha256 = (label: string) => placeholderHex(`sha256:${label}`, 32);
export const LEDGER_KEY = { key_id: rivera.ledger.verified.key_id, public_key_hex: rivera.ledger.verified.public_key_hex };

/** The reason the kernel gives a handoff the handoff card opened: its own words, never the visitor's or Claude's. */
export const CARD_REASON = 'The Desk handed this to you.';

/** What closed a card handoff, as the kernel's `closed_by` names it: the owner taking the chat over or writing in it, or the visitor booking a time. */
type CardHandoffCloser = 'takeover' | 'owner_message' | 'booking';

type Listener = (seq: number, ev: SseEvent) => void;

/** How long a typing signal shows, and how often one counts (plan 02b Task 1). */
export const TYPING_SHOWS_MS = 5_000;
export const TYPING_EVERY_MS = 2_000;

export interface SessionRecord {
  state: SessionState;
  /**
   * The visitor's chat has ended for good (a seeded scenario: its document waits for the owner
   * after the chat closed). The visitor's routes no longer find it; the owner's history still does.
   */
  ended: boolean;
  deskId: string;
  ownerPreview: boolean;
  /** The verified person on record, once the visitor confirmed it's them; null until then. */
  person: { personId: string; name: string } | null;
  /** The verified person's name, else a lead's once the visitor gave one, else null. Untrusted. */
  displayName: string | null;
  /** The last turn's language; a follow-up after an answer uses it. */
  language: Language;
  lastActivity: number;
  /** The owner's view: the visitor's view leaves out whispers. */
  items: TranscriptItem[];
  /** Every event the session's stream has carried, `seq` from 1 with no gaps. */
  events: { seq: number; ev: SseEvent }[];
  listeners: Set<Listener>;
  /** Until when the visitor is typing, as the owner's view shows it; null when they haven't been. */
  typingUntil: number | null;
  /** When the visitor's last typing signal that counted came. */
  visitorTypedAt: number | null;
  /** When the owner's last typing event went to the visitor. */
  ownerTypedAt: number | null;
}

/**
 * A tool as the kernel's tool row has it, with why it waits for review (`review_reason`, null unless
 * it does), which the contract types don't have yet. Every record carries the reason, so the profile
 * a tool confirm answers with always has it.
 */
export type ToolRecord = Omit<ToolProfile, 'tool' | 'source'> & Pick<ToolRow, 'tool' | 'source' | 'business'> & { review_reason: ToolReviewReason | null };

export interface DeskRecord {
  /** Stored business brand; absent or empty reads as the default teal palette. */
  brand?: Record<string, string>;
  /** The Desk as the copy lists it, but its setup, which is its interview's (`withSetupDesks`). */
  summary: Omit<DeskSummary, 'setup'>;
  /** The active rules version, with its money cap. */
  policy: PolicyVersionOut;
  ledger: LedgerEntry[];
  /** The kernel's open status for the Desk's public page, by language; null when it makes no claim. */
  openStatus: Record<Language, OpenStatus> | null;
  /** Rule drafts made from the active rules, by version; none is active until the owner confirms it. */
  drafts: Map<number, DraftRecord>;
  /** The highest rules version made for the Desk: versions are never reused. */
  lastVersion: number;
  /** The Desk's tools, as the kernel's tool rows have them. */
  tools: ToolRecord[];
  /** Rules the owner's answers suggest, newest first; none until a test adds one. */
  suggestions: Suggestion[];
  /**
   * Who the stream names as the owner who takes a chat over and types in it: a Desk setup made
   * names its own owner; the seeded Desks leave it out and name Turner's (`BUSINESS`).
   */
  ownerName?: string;
}

/**
 * Rules a test adds to a Desk's active version (`MockWorld.addActiveRules`), as if confirmed
 * earlier: Dana Whitfield's own booking rule, which a preset removes like any other, and the demo
 * agent's rule on every tool that charges money, which outranks each payment tool's own.
 */
export const EXTRA_RULES = {
  danaBooking: rivera.personalBookingCard,
  agentCharges: rivera.sharedChargeCard,
} as const satisfies Record<string, RuleCard>;

/** A rules draft as the kernel keeps one until the owner confirms it. */
export interface DraftRecord {
  /** What `ruleDraft` answers. */
  draft: RulesDraft;
  /** The version it was drafted from: once another is active, confirming it is refused. */
  parent: number;
  /** The tools a tool confirm's draft turns on, each at the hash the owner confirmed. */
  enables: ToolConfirmEntry[];
}

/** Why the kernel refuses a tool confirm: a tool the Desk doesn't have, or a hash or a change it won't take. */
export type ToolConfirmRefusal = 'not_found' | 'conflict';

/**
 * The hash a tool's connector lists now, which an enable must name, at the tool confirm and again
 * at the draft's confirm (the master plan's `/tools/confirm` and `/policy/confirm`): a changed
 * definition's pending hash while it waits for review, else the pinned one.
 */
function listedHash(tool: Pick<ToolProfile, 'pending_sha256' | 'definition_sha256'>): string | null {
  return tool.pending_sha256 != null && tool.pending_sha256 !== '' ? tool.pending_sha256 : (tool.definition_sha256 ?? null);
}

/**
 * The policy a card compiles to for a decision that went `outcome`, as the kernel names it: an
 * auto card's allow, its hold twin, or a never card's forbid.
 */
function policyOf(cardId: string, outcome: Decision['outcome']): string {
  if (outcome === 'hold') return `H.${cardId}.hold`;
  return outcome === 'refuse' ? `F.never.${cardId}` : `A.${cardId}`;
}

/** A card with every optional field at its default, so two cards compare by what they enforce. */
export function canonicalCard(card: RuleCard): string {
  const full: Record<string, unknown> = {
    person_id: null,
    agent_key_id: null,
    max_amount_cents: null,
    max_discount_bp: 0,
    hours: null,
    review: false,
    is_default: false,
    ...card,
  };
  return JSON.stringify(Object.keys(full).sort().map((key) => [key, full[key]]));
}

export interface DecisionRecord {
  decision: Decision;
  /** The signed approval snapshot, kept separately from the execution outcome. */
  approved?: Decision | null;
  deskId: string;
  createdAt: number;
}

/** An open or done handoff. What its visitor wrote is read from its chat on every read, as the API does. */
export interface HandoffRecord {
  handoff: Handoff;
  deskId: string;
  createdAt: number;
}

/** A lead, as the kernel keeps one: someone who left their name and how to reach them. */
export interface LeadRecord {
  leadId: string;
  deskId: string;
  sessionId: string;
  /** As the visitor typed it. Untrusted. */
  displayName: string;
  /** What they want and how to reach them, as typed, or null when they left no note. Untrusted. */
  note: string | null;
  createdAt: number;
  /** Replayed from the recorded history into this copy; a test adds such a lead. */
  replayed?: boolean;
}

export interface InboxRecord {
  entry: DemoInboxEntry;
  deskId: string;
  /** The visitor session the entry belongs to; null for the owner's alerts. */
  sessionId: string | null;
}

export interface LinkRecord {
  /**
   * The kernel's `PaymentLinkView`, exactly as the contracts have it: `cancel_reason` is
   * `rules_changed` once a change to the business's rules cancelled the link, and `customer_name`
   * the kernel's name for a link issued to a verified person ("Dana W."), only while it is open.
   */
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
  /**
   * What the owner told each Desk, by Desk and `item_id`, as the kernel stored it: when it was first
   * added, and whether the kernel forces it owner-only, which withholds its title and text when listed.
   */
  readonly knowledge = new Map<string, { deskId: string; item: KnowledgeItem; createdAt: number | null; forced: boolean }>();
  /**
   * Whether the kernel keeps an item to the owner whatever readers it's posted with, as it does one
   * holding a customer's private data (kernel verification fixes, plan 01b Task 6c). It never does
   * unless a test says so.
   */
  keepsKnowledgeOwnerOnly: (item: KnowledgeItem) => boolean = () => false;
  readonly inbox: InboxRecord[] = [];
  readonly links = new Map<string, LinkRecord>();
  /** The document links this copy's document cards handed out, by token (documents.ts), opened or not. */
  readonly documentLinks = new Map<string, DocumentLink>();
  /**
   * The Desks deleted from this copy, by id. Their chats, decisions and callback requests stay in
   * the copy, closed: the routes that name one answer 409 `closed` (served.ts), as the kernel does.
   */
  readonly deletedDesks = new Map<string, DeskRecord>();
  /** Each session's open demo code, by session id: the code and who it confirms. Spent once it works. */
  readonly challenges = new Map<string, { code: string; person: { personId: string; name: string } }>();
  private counter = 0;
  private itemN = 0;
  private fixedNow: number | null = null;
  /** Above 0 while `replay` writes history. */
  private replaying = 0;

  constructor(
    readonly seed: MockSeed,
    readonly copyNo: number,
    /** A new payment link's token, from the store that holds the copy. */
    private readonly linkToken: () => string,
    /** A new document link's token, from the store that holds the copy; a copy made without one counts its own. */
    private readonly documentToken: () => string = counted('doc'),
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

  /** The owner's display name on the session's Desk: its own, or Turner's on a seeded Desk. */
  ownerNameOf(session: SessionRecord): string {
    return ownerNameOfDesk(this.deskOf(session));
  }

  /** Whom the visitor's lines on the session's Desk name, its handoff card's among them (`deskOwner`). */
  ownerOf(session: SessionRecord): DeskOwner {
    return deskOwner(this.deskOf(session));
  }

  sessionsOf(deskId: string): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.deskId === deskId);
  }

  addDesk(fields: Pick<DeskSummary, 'desk_id' | 'slug' | 'name' | 'hours'> & Pick<DeskRecord, 'openStatus'>): DeskRecord {
    const { openStatus, ...summary } = fields;
    const policy = activePolicy(fields.desk_id);
    const desk: DeskRecord = {
      brand: { ...BUSINESS.brand },
      summary: { ...summary, business_name: BUSINESS.name, answering: true },
      policy,
      ledger: [],
      openStatus,
      drafts: new Map(),
      lastVersion: policy.version,
      tools: riveraTools(),
      suggestions: [],
    };
    this.desks.push(desk);
    return desk;
  }

  /**
   * Takes `desk` out of the copy, as deleting a Desk does: its public link and its owner pages
   * answer not found from now on, and so do its chats, which reach it by its slug. Its id is kept
   * in `deletedDesks`, so what names one of its chats is refused as closed. Its open payment links
   * are cancelled first, as the kernel cancels them in the delete, so none can be paid after it.
   */
  deleteDesk(desk: DeskRecord): void {
    for (const [token, link] of this.links) {
      if (link.deskId === desk.summary.desk_id && link.view.state === 'issued') this.cancelLink(token, link, 'desk_deleted');
    }
    const index = this.desks.indexOf(desk);
    if (index !== -1) this.desks.splice(index, 1);
    this.deletedDesks.set(desk.summary.desk_id, desk);
  }

  /** A new chat on `desk`: a visitor's, the owner's preview, or with `agent` a signed visiting agent's, by the name it gave. */
  addSession(desk: DeskRecord, opts: { sessionId?: string; ownerPreview?: boolean; agent?: string } = {}): SessionRecord {
    const sessionId = opts.sessionId ?? this.id('ses-web');
    const kind = opts.agent === undefined ? 'visitor' : 'agent';
    const session: SessionRecord = {
      state: { session_id: sessionId, kind, verified: false, assurance: 'none', mode: 'ai', generation: 1 },
      ended: false,
      deskId: desk.summary.desk_id,
      ownerPreview: opts.ownerPreview ?? false,
      person: null,
      displayName: opts.agent ?? null,
      language: 'en',
      lastActivity: this.now(),
      items: [],
      events: [],
      listeners: new Set(),
      typingUntil: null,
      visitorTypedAt: null,
      ownerTypedAt: null,
    };
    this.sessions.set(sessionId, session);
    this.appendLedger(desk, {
      kind: 'session',
      origin: 'kernel',
      session_id: sessionId,
      ref_id: null,
      summary: { kind: session.ownerPreview ? 'preview' : kind },
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

  /** The visitor's message: it takes the place of their typing, and their next keystroke counts at once. */
  visitorText(session: SessionRecord, text: string): void {
    this.addItem(session, 'visitor_text', text, null);
    session.language = turnLanguage(text);
    session.lastActivity = this.now();
    session.typingUntil = null;
    session.visitorTypedAt = null;
  }

  /**
   * A visiting agent's signed request: its words join the owner's view of the chat. The built-in
   * agent's run also quotes them to the page that sent it, on its agent turn (`AgentTurn.text`).
   */
  agentText(session: SessionRecord, text: string): void {
    this.addItem(session, 'agent_text', text, null);
    session.lastActivity = this.now();
  }

  /** The owner's whisper: only Claude sees it, so it joins the owner's view and the record, never the visitor's stream. */
  whisper(session: SessionRecord, text: string): OwnerMessageResult {
    const messageId = this.id('whisper');
    this.addItem(session, 'whisper', text, null);
    const entry = this.appendLedger(this.deskOf(session), {
      kind: 'whisper',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: messageId,
      summary: { characters: text.length },
    });
    return { message_id: messageId, verdict: null, ledger_seq: entry.seq };
  }

  /**
   * The owner's own words in the chat she took over, as the kernel delivers a say: checked, then
   * one `owner_said` card with her words verbatim, author `owner`, at the session's generation now.
   */
  say(session: SessionRecord, text: string): OwnerMessageResult {
    const messageId = this.id('msg');
    const { language } = session;
    const desk = this.deskOf(session);
    const checked = this.appendLedger(desk, {
      kind: 'reply',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: messageId,
      summary: { author: 'owner', ok: true, language, violations: [] },
    });
    this.closeCardHandoffs(session, 'owner_message');
    const blocks = [cardBlock('owner_said', { fact_id: `owner:${messageId}`, title: text })];
    const signature = sign(messageId);
    const visitorPlain = visitorLine(language, 'owner_said', deskOwner(desk));
    this.emit(session, {
      type: 'message',
      message_id: messageId,
      generation: session.state.generation,
      author: 'owner',
      language,
      handoff: false,
      blocks,
      visitor_plain: visitorPlain,
      ledger_seq: checked.seq,
      signature,
    });
    return {
      message_id: messageId,
      verdict: {
        ok: true,
        language,
        blocks,
        violations: [],
        message_id: messageId,
        generation: session.state.generation,
        visitor_plain: visitorPlain,
        ledger_seq: checked.seq,
        signature,
      },
      ledger_seq: checked.seq,
    };
  }

  /** The visitor is typing: the owner's view shows it for five seconds. A signal within 2 s of the last that counted changes nothing. */
  visitorTyping(session: SessionRecord): void {
    const now = this.now();
    if (session.visitorTypedAt !== null && now - session.visitorTypedAt < TYPING_EVERY_MS) return;
    session.visitorTypedAt = now;
    session.typingUntil = now + TYPING_SHOWS_MS;
  }

  /** The owner is typing in the chat she took over: the visitor's stream is told, at most once every 2 s. */
  ownerTyping(session: SessionRecord): void {
    const now = this.now();
    if (session.ownerTypedAt !== null && now - session.ownerTypedAt < TYPING_EVERY_MS) return;
    session.ownerTypedAt = now;
    this.emit(session, { type: 'owner_typing', name: this.ownerNameOf(session), until: isoTime(now + TYPING_SHOWS_MS) });
  }

  /**
   * Adds `ev` to the session's stream with the next seq, keeps what the transcript keeps, and tells
   * listeners. The transcript keeps a delivered message, a status, and where the owner joined and
   * left (an item of the event's own kind holding it), as the API does.
   */
  emit(session: SessionRecord, ev: SseEvent): number {
    const seq = session.events.length + 1;
    session.events.push({ seq, ev });
    session.lastActivity = this.now();
    if (ev.type === 'message') this.addItem(session, 'delivered', null, ev);
    else if (ev.type === 'receipt' || ev.type === 'held' || ev.type === 'resolved') this.addItem(session, 'status', null, ev);
    else if (ev.type === 'owner_joined' || ev.type === 'owner_left') this.addItem(session, ev.type, null, ev);
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
    // In the order they were always drawn: the owner's alert for a hold, then the call and the action.
    const inbox = hold ? [this.ownerAlert(desk, decisionId, spec.reasonPlain)] : [];
    const callId = this.id('call');
    const actionId = this.id('act');
    if (spec.outcome === 'allow' && spec.executed) {
      this.runSideEffects(session, spec.tool);
      const ran = this.appendLedger(desk, {
        kind: 'execute',
        origin: 'kernel',
        session_id: sessionId,
        ref_id: decisionId,
        summary: { decision_id: decisionId, action_id: actionId, state: 'executed' },
      });
      state = 'executed';
      ledgerSeq = ran.seq;
    }
    const decision: Decision = {
      decision_id: decisionId,
      session_id: sessionId,
      call_id: callId,
      action: {
        action_id: actionId,
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
      policy_ids: spec.policyIds ? [...spec.policyIds] : spec.cardIds.map((cardId) => policyOf(cardId, spec.outcome)),
      card_ids: [...spec.cardIds],
      review: null,
      reason_plain: spec.reasonPlain,
      owner_plain: null,
      visitor_plain: statusLine(language, state === 'refused' && spec.visitorStatus !== undefined ? spec.visitorStatus : state, spec.tool, deskOwner(desk)),
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
   * Checks a demo code as the kernel's `/verify/check` does: the session's open code confirms its
   * person, once. A wrong code, or one already used, verifies nothing.
   */
  checkCode(session: SessionRecord, code: string): boolean {
    const challenge = this.challenges.get(session.state.session_id);
    if (!challenge || challenge.code !== code) return false;
    this.challenges.delete(session.state.session_id);
    this.verify(session, challenge.person);
    return true;
  }

  /**
   * Verified Dana asks for her $180.00 drain clearing payment back, a minute ago, and the refund
   * card holds it for Mike: the design system's `rivera.heldRefund`, in this copy. Tests add it;
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

  /** The owner's Demo inbox alert for a hold, naming the held decision; the decision carries its notice. */
  private ownerAlert(desk: DeskRecord, decisionId: string, reason: string) {
    const entry: DemoInboxEntry = {
      entry_id: this.id('inbox'),
      to: 'owner',
      kind: 'alert',
      body: reason,
      created_at: isoTime(this.now()),
      decision_id: decisionId,
    };
    this.inbox.push({ entry, deskId: desk.summary.desk_id, sessionId: null });
    return { entry_id: entry.entry_id, to: 'owner', preview: 'A request needs your answer' };
  }

  /**
   * The owner's answer, as the kernel records it: the approval, with the summary `approvals.py`
   * writes as it takes an answer (the decision, its action, the answer, and `approved` or `denied`),
   * and the run when it allows. Keep the approval snapshot separate from the run's outcome.
   */
  answer(record: DecisionRecord, answer: ApprovalAnswer): Decision {
    const desk = this.desk(record.deskId);
    const session = this.sessions.get(record.decision.session_id);
    if (!desk || !session) throw new Error(`decision ${record.decision.decision_id} has no Desk or session`);
    const { decision_id: decisionId, session_id: sessionId } = record.decision;
    // Recheck before writing an approval: a refusal is one approval entry, with no execution.
    const action = record.decision.action;
    if (allows(answer) && session.ended && action?.effects.includes('private_data')) {
      return this.refuseAnswer(record, answer, desk, 'session_ended', 'session_closed', 'Not shared: their session ended before your answer');
    }
    const rulesRefuse = action != null && rulesForTool(action, desk.policy.cards).some((card) => card.mode === 'never' && (
      card.who === 'anyone' ||
      (card.who === 'verified' && session.state.verified) ||
      (card.who === 'person' && session.person?.personId === card.person_id) ||
      (card.who === 'record_owner' && session.person != null && session.person.personId === action.resource.owner_person_id)
    ));
    if (allows(answer) && rulesRefuse) {
      return this.refuseAnswer(record, answer, desk, 'rules_changed', 'policy', "Your rules changed before this ran, so it wasn't done.");
    }
    const approval = this.appendLedger(desk, {
      kind: 'approval',
      origin: 'kernel',
      session_id: sessionId,
      ref_id: decisionId,
      summary: {
        decision_id: decisionId,
        action_id: record.decision.action?.action_id ?? null,
        answer,
        state: allows(answer) ? 'approved' : 'denied',
      },
    });
    record.approved = allows(answer) ? {
      ...record.decision,
      state: 'approved',
      visitor_plain: visitorLine(session.language, 'approved', deskOwner(desk)),
      inbox: [],
      ledger_seq: approval.seq,
      signature: sign(`${decisionId}:approved`),
    } : null;
    let state: DecisionState = 'denied';
    let ledgerSeq = approval.seq;
    if (allows(answer)) {
      state = 'executed';
      this.runSideEffects(session, record.decision.action?.tool);
      const ran = this.appendLedger(desk, {
        kind: 'execute',
        origin: 'kernel',
        session_id: sessionId,
        ref_id: decisionId,
        summary: { decision_id: decisionId, action_id: record.decision.action?.action_id ?? null, state },
      });
      ledgerSeq = ran.seq;
    }
    record.decision = {
      ...record.decision,
      state,
      owner_plain: null,
      visitor_plain: statusLine(session.language, state, record.decision.action?.tool ?? null, deskOwner(desk)),
      inbox: [],
      ledger_seq: ledgerSeq,
      signature: sign(`${decisionId}:${state}`),
    };
    return record.decision;
  }

  private refuseAnswer(record: DecisionRecord, answer: ApprovalAnswer, desk: DeskRecord, reason: string, check: string, ownerPlain: string): Decision {
    const decision = record.decision;
    const entry = this.appendLedger(desk, {
      kind: 'approval', origin: 'kernel', session_id: decision.session_id, ref_id: decision.decision_id,
      summary: { decision_id: decision.decision_id, action_id: decision.action?.action_id ?? null,
        answer, state: 'refused_at_execution', reason, check },
    });
    record.decision = { ...decision, state: 'refused_at_execution', owner_plain: ownerPlain,
      visitor_plain: statusLine(this.sessions.get(decision.session_id)?.language ?? 'en', 'refused_at_execution', decision.action?.tool ?? null, deskOwner(desk)),
      inbox: [], ledger_seq: entry.seq, signature: sign(`${decision.decision_id}:refused_at_execution`) };
    return record.decision;
  }

  /**
   * The owner's answer to a held request of a deleted Desk, as the kernel takes it: an allow is
   * re-checked at execution and refused there (`refused_at_execution`), so nothing runs, and a deny
   * is `denied`. The Desk's chat is closed, so it hears nothing. Its retained ledger records the answer.
   */
  answerClosed(record: DecisionRecord, answer: ApprovalAnswer): Decision {
    const desk = this.deletedDesks.get(record.deskId);
    if (!desk) throw new Error('the decision has no deleted Desk');
    if (allows(answer)) return this.refuseAnswer(record, answer, desk, 'rules_changed', 'desk', "This Desk was deleted before this ran, so it wasn't done.");
    const state: DecisionState = allows(answer) ? 'refused_at_execution' : 'denied';
    const language = this.sessions.get(record.decision.session_id)?.language ?? 'en';
    const entry = this.appendLedger(desk, {
      kind: 'approval', origin: 'kernel', session_id: record.decision.session_id, ref_id: record.decision.decision_id,
      summary: { decision_id: record.decision.decision_id, action_id: record.decision.action?.action_id ?? null, answer, state },
    });
    record.decision = {
      ...record.decision,
      state,
      owner_plain: null,
      visitor_plain: statusLine(language, state, record.decision.action?.tool ?? null, deskOwner(desk)),
      inbox: [],
      ledger_seq: entry.seq,
      signature: sign(`${record.decision.decision_id}:${state}`),
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
      visitor_plain: statusLine(session.language, 'cancelled', record.decision.action?.tool ?? null, deskOwner(desk)),
      inbox: [],
      ledger_seq: cancelled.seq,
      signature: sign(`${decisionId}:cancelled`),
    };
    this.emit(session, statusEvent('resolved', record.decision));
    return record.decision;
  }

  /**
   * A reply of Claude's, checked and recorded. Outside the owner's preview, one that shows the
   * handoff card opens the owner's handoff first, as the kernel's check does (`openCardHandoff`),
   * except in history the seed or a test writes: the kernel's seed holds its request without
   * checking a reply.
   */
  reply(session: SessionRecord, blocks: RenderedBlock[], language: Language, opts: { blocked?: boolean; paused?: boolean } = {}): EvMessage {
    const paused = opts.paused ?? false;
    const blocked = paused || (opts.blocked ?? false);
    const handoff = blocks.some((block) => block.template === 'handoff');
    const messageId = this.id('msg');
    if (this.replaying === 0 && handoff && !session.ownerPreview) this.openCardHandoff(session);
    // Each document card hands out a link of its own, in place of the one it was written with,
    // which opens once from now on.
    const shown = blocks.map((block) => {
      if (block.template !== 'document_link' || !DOCUMENT_HREF.test(block.href ?? '')) return block;
      const token = this.documentToken();
      this.documentLinks.set(token, { title: block.title ?? '', opened: false });
      return { ...block, href: `/api/d/${token}` };
    });
    const desk = this.deskOf(session);
    const checked = this.appendLedger(desk, {
      kind: 'reply',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: messageId,
      summary: { author: 'claude', ok: !blocked, language, violations: paused ? ['session_paused'] : blocked ? ['number_in_prose'] : [] },
    });
    return {
      type: 'message',
      message_id: messageId,
      generation: session.state.generation,
      author: 'claude',
      language,
      handoff,
      blocks: shown.map((block) => ({ ...block, lines: [...(block.lines ?? [])], options: [...(block.options ?? [])] })),
      visitor_plain: visitorLine(language, handoff ? 'reply_handed_off' : 'reply_checked', deskOwner(desk)),
      ledger_seq: checked.seq,
      signature: sign(messageId),
    };
  }

  /** The step context for one turn of `session`, in `language`. */
  context(session: SessionRecord, language: Language, text: string): TurnContext {
    // Looked up only when a step names the owner, so making a context still never reads the Desk.
    const owner = () => this.ownerOf(session);
    return {
      language,
      text,
      get person() {
        return session.person;
      },
      get owner() {
        return owner();
      },
      decide: (spec) => this.decide(session, spec, language),
      status: (type, decision) => statusEvent(type, decision),
      reply: (blocks, opts) => this.reply(session, blocks, language, opts),
      startVerification: (fields) => {
        this.challenges.set(session.state.session_id, { code: fields.code, person: { personId: fields.person.personId, name: fields.person.name } });
        return this.addVisitorInbox(session, { to: fields.person.maskedContact, body: fields.body, preview: fields.preview });
      },
      openHandoff: (fields) => this.openHandoff(session, fields),
      issueLink: (fields) => {
        this.issueLink(session, { ...fields, language });
      },
      latestLink: () => {
        const mine = [...this.links].filter(([, link]) => link.sessionId === session.state.session_id);
        const newest = mine.at(-1);
        if (!newest) throw new Error(`session ${session.state.session_id} has no payment link`);
        return newest[0];
      },
    };
  }

  /**
   * A payment link for `session`, `issued`, with a token of its own, which it returns. It names the
   * business, and a link issued to a verified person carries their first name and last initial, as
   * the kernel's does.
   */
  issueLink(session: SessionRecord, fields: { title: string; amountCents: number; language: Language }): string {
    const token = this.linkToken();
    this.links.set(token, {
      view: {
        title: fields.title,
        amount_cents: fields.amountCents,
        state: 'issued',
        language: fields.language,
        business_name: BUSINESS.name,
        customer_name: session.person ? shortName(session.person.name) : null,
        cancel_reason: null,
      },
      deskId: session.deskId,
      sessionId: session.state.session_id,
    });
    return token;
  }

  /**
   * The visitor paid on the mock checkout, as the kernel completes a link: it is paid, the record
   * says so, and the link's chat gets the kernel's `payment_confirmed` card, author `desk`. Only an
   * `issued` link can be paid (the route refuses the rest).
   */
  payLink(token: string, link: LinkRecord): ReplyVerdict {
    const session = this.sessions.get(link.sessionId);
    if (!session) throw new Error(`payment link ${token} has no session`);
    link.view = { ...link.view, state: 'paid', customer_name: null };
    this.appendLedger(this.deskOf(session), {
      kind: 'payment',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: token,
      summary: { state: 'paid', amount_cents: link.view.amount_cents },
    });
    return this.fromTheDesk(session, [rivera.blocks.payment_confirmed[session.language]]);
  }

  /**
   * The link is cancelled: by the visitor on the checkout, which the chat isn't told of; by its
   * Desk's delete, whose chat is closed; or by a change to the business's rules, as the kernel
   * cancels an open link the new rules no longer allow when the owner confirms them. That one says
   * why on the checkout (`cancel_reason`), and its chat gets the kernel's `link_cancelled` card,
   * author `desk`, with the link's amount and title.
   */
  cancelLink(token: string, link: LinkRecord, by: 'visitor' | 'desk_deleted' | 'rules_changed'): void {
    const session = this.sessions.get(link.sessionId);
    if (!session) throw new Error(`payment link ${token} has no session`);
    link.view = { ...link.view, state: 'cancelled', customer_name: null, cancel_reason: by === 'rules_changed' ? 'rules_changed' : null };
    this.appendLedger(this.deskOf(session), {
      kind: 'payment',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: token,
      summary: { state: 'cancelled', by },
    });
    if (by === 'rules_changed' && !session.ended) this.fromTheDesk(session, [linkCancelledBlock(link.view, session.language, `payment_link:${token}`, this.ownerOf(session))]);
  }

  /**
   * A message from the Desk itself (author `desk`), as the kernel issues one: checked and recorded,
   * then sent to the chat at its generation now, in its last language. Returns its verdict.
   */
  private fromTheDesk(session: SessionRecord, blocks: RenderedBlock[]): ReplyVerdict {
    const messageId = this.id('msg');
    const { language } = session;
    const desk = this.deskOf(session);
    const checked = this.appendLedger(desk, {
      kind: 'reply',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: messageId,
      summary: { author: 'desk', ok: true, language, violations: [] },
    });
    const signature = sign(messageId);
    const visitorPlain = visitorLine(language, 'reply_checked', deskOwner(desk));
    this.emit(session, {
      type: 'message',
      message_id: messageId,
      generation: session.state.generation,
      author: 'desk',
      language,
      handoff: false,
      blocks,
      visitor_plain: visitorPlain,
      ledger_seq: checked.seq,
      signature,
    });
    return {
      ok: true,
      language,
      blocks,
      violations: [],
      message_id: messageId,
      generation: session.state.generation,
      visitor_plain: visitorPlain,
      ledger_seq: checked.seq,
      signature,
    };
  }

  private addVisitorInbox(session: SessionRecord, fields: { to: string; body: string; preview: string }): EvDemoInbox {
    const entry: DemoInboxEntry = {
      entry_id: this.id('inbox'),
      to: fields.to,
      kind: 'verification_code',
      body: fields.body,
      created_at: isoTime(this.now()),
      decision_id: null,
    };
    this.inbox.push({ entry, deskId: session.deskId, sessionId: session.state.session_id });
    return { type: 'demo_inbox', entry_id: entry.entry_id, to: entry.to, preview: fields.preview };
  }

  /**
   * A callback request in Needs you, and the lead it makes: the name, and the rest of what they typed
   * as its note. As the kernel's `native.request_callback` does (plan 01b), a chat holds one open
   * handoff: it first closes the chat's open ones, the handoff card's or an earlier call-back's, each
   * as the owner's mark of done does but naming the call-back that replaced it, then opens its own.
   * A handoff's kind never changes, so the owner keeps one item for the conversation, and a stale
   * Done on a closed one is 409.
   */
  private openHandoff(session: SessionRecord, fields: { reason: string; callbackWindow: string | null; lead: string }): void {
    const sessionId = session.state.session_id;
    const handoffId = this.id('handoff');
    for (const record of this.handoffs.values()) {
      if (record.handoff.session_id === sessionId && record.handoff.status === 'open') this.closeHandoff(record, handoffId);
    }
    this.handoffs.set(handoffId, {
      handoff: { handoff_id: handoffId, session_id: sessionId, reason: fields.reason, callback_window: fields.callbackWindow, status: 'open', kind: 'callback' },
      deskId: session.deskId,
      createdAt: this.now(),
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

  /**
   * The owner's handoff for a reply of Claude's that shows the handoff card, as the kernel opens
   * one (plan 01b, `reply_check.open_card_handoff`): none while the chat has an open handoff of
   * either kind; otherwise an open one of kind `card`, with the kernel's own reason, no call-back
   * window and no lead, an alert to the owner saying who is waiting and nothing of what was said,
   * and a `desk_data` entry on the chat.
   */
  private openCardHandoff(session: SessionRecord): void {
    const sessionId = session.state.session_id;
    const open = [...this.handoffs.values()].some((h) => h.handoff.session_id === sessionId && h.handoff.status === 'open');
    if (open) return;
    // None while the chat has a held request waiting for the owner, whose alert and item she already
    // has (the kernel's `awaits_the_owner`, the owner's decision of 2026-10-31).
    const awaitsTheOwner = [...this.decisions.values()].some((d) => d.decision.session_id === sessionId && d.decision.state === 'held');
    if (awaitsTheOwner) return;
    const desk = this.deskOf(session);
    const handoffId = this.id('handoff');
    this.handoffs.set(handoffId, {
      handoff: { handoff_id: handoffId, session_id: sessionId, reason: CARD_REASON, callback_window: null, status: 'open', kind: 'card' },
      deskId: session.deskId,
      createdAt: this.now(),
    });
    const entry: DemoInboxEntry = {
      entry_id: this.id('inbox'),
      to: 'owner',
      kind: 'alert',
      body: `${session.person?.name ?? 'A visitor'} is waiting in a conversation the Desk handed to you.`,
      created_at: isoTime(this.now()),
      decision_id: null,
    };
    this.inbox.push({ entry, deskId: session.deskId, sessionId: null });
    this.appendLedger(desk, {
      kind: 'desk_data',
      origin: 'kernel',
      session_id: sessionId,
      ref_id: null,
      summary: { part: 'handoffs', refs: [handoffId], kind: 'card' },
    });
  }

  /**
   * A handoff closed, a call-back request's or the handoff card's, as the kernel records it: a
   * `desk_data` entry naming it, on no chat and with no `kind`. The owner marking it done gives no
   * more; a call-back closing it adds `replaced_by`, the call-back's own handoff; closing a card
   * handoff because the owner handled the chat or the visitor booked a time adds `closed_by`,
   * naming which.
   */
  closeHandoff(record: HandoffRecord, replacedBy?: string, closedBy?: CardHandoffCloser): void {
    const desk = this.desk(record.deskId);
    if (!desk) throw new Error(`handoff ${record.handoff.handoff_id} has no Desk`);
    record.handoff = { ...record.handoff, status: 'done' };
    this.appendLedger(desk, {
      kind: 'desk_data',
      origin: 'kernel',
      session_id: null,
      ref_id: null,
      summary: {
        part: 'handoffs',
        refs: [record.handoff.handoff_id],
        ...(replacedBy === undefined ? {} : { replaced_by: replacedBy }),
        ...(closedBy === undefined ? {} : { closed_by: closedBy }),
      },
    });
  }

  /**
   * The owner handling the conversation, or the visitor booking a time in it, closes its card
   * handoffs; a promised call-back is still owed.
   */
  private closeCardHandoffs(session: SessionRecord, by: CardHandoffCloser): void {
    for (const record of this.handoffs.values()) {
      if (record.handoff.session_id === session.state.session_id && record.handoff.status === 'open' && record.handoff.kind === 'card') {
        this.closeHandoff(record, undefined, by);
      }
    }
  }

  /**
   * What an action does to its chat as it runs, recorded before its execution entry, as the
   * kernel's adapter does: a booking (`native.book`, the owner's decision of 2026-11-01) closes the
   * chat's card handoffs, since the visitor has what they asked for. The mock runs no typed
   * booking, which closes them the same way in the kernel.
   */
  private runSideEffects(session: SessionRecord, tool: string | undefined): void {
    if (tool === 'native.book') this.closeCardHandoffs(session, 'booking');
  }

  /**
   * The owner takes over the chat, as the kernel records it: the owner's mode at the next
   * generation, so a turn still queued for the old one is fenced off (served.ts `Server.tick`), and
   * the visitor is told.
   */
  takeOver(session: SessionRecord): SessionState {
    const previous = session.state.mode;
    session.state = { ...session.state, mode: 'owner', generation: session.state.generation + 1 };
    this.appendLedger(this.deskOf(session), {
      kind: 'takeover',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: null,
      summary: { from: previous, to: 'owner', generation: session.state.generation },
    });
    this.closeCardHandoffs(session, 'takeover');
    this.emit(session, { type: 'owner_joined', name: this.ownerNameOf(session) });
    return session.state;
  }

  /** The owner hands the chat back to Claude, at the next generation, and the visitor is told. */
  handBack(session: SessionRecord): SessionState {
    const previous = session.state.mode;
    session.state = { ...session.state, mode: 'ai', generation: session.state.generation + 1 };
    this.appendLedger(this.deskOf(session), {
      kind: 'takeover',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: null,
      summary: { from: previous, to: 'ai', generation: session.state.generation },
    });
    this.emit(session, { type: 'owner_left' });
    return session.state;
  }

  /**
   * The breaker pauses the chat after repeated blocked attempts, as the kernel records it: Claude
   * doesn't answer until the owner resumes it or takes over, and each message meanwhile gets the
   * kernel's handoff (`PAUSED_TURN`). Tests add it; no seed has it.
   */
  pause(session: SessionRecord): void {
    session.state = { ...session.state, mode: 'paused' };
    this.appendLedger(this.deskOf(session), {
      kind: 'breaker',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: null,
      summary: { paused: true },
    });
  }

  /** The owner resumes Claude in a paused chat, at the next generation. */
  resume(session: SessionRecord): SessionState {
    session.state = { ...session.state, mode: 'ai', generation: session.state.generation + 1 };
    this.appendLedger(this.deskOf(session), {
      kind: 'breaker',
      origin: 'kernel',
      session_id: session.state.session_id,
      ref_id: null,
      summary: { resumed: true, generation: session.state.generation },
    });
    return session.state;
  }

  /** Adds `cards` to the Desk's active rules, as if the owner had confirmed them earlier. */
  addActiveRules(desk: DeskRecord, cards: readonly RuleCard[]): void {
    desk.policy = { ...desk.policy, cards: [...desk.policy.cards, ...cards.map((card) => ({ ...card }))] };
  }

  /**
   * A draft of the Desk's rules with `add` merged in by `card_id`, as the kernel drafts an
   * approval's card diff: the next version, checked, and stored until the owner confirms it.
   * Default cards are left out of what it shows.
   */
  draft(desk: DeskRecord, add: readonly RuleCard[]): RulesDraft {
    const cards = desk.policy.cards.filter((card) => !card.is_default).map((card) => ({ ...card }));
    for (const card of add) {
      const at = cards.findIndex((c) => c.card_id === card.card_id);
      if (at === -1) cards.push({ ...card });
      else cards[at] = { ...card };
    }
    return this.draftCards(desk, cards);
  }

  /**
   * A draft of the Desk's rules as `cards`, at the money cap `cap` (the active version's when left
   * out), turning on `enables`: the next version, its diff with the active rules by `card_id`,
   * checked, and stored until the owner confirms it. Default cards are left out.
   */
  draftCards(desk: DeskRecord, cards: readonly RuleCard[], opts: { cap?: number; enables?: readonly ToolConfirmEntry[] } = {}): RulesDraft {
    const active = desk.policy.cards.filter((card) => !card.is_default);
    const next = cards.filter((card) => !card.is_default).map((card) => ({ ...card }));
    const was = new Map(active.map((card) => [card.card_id, card]));
    const now = new Set(next.map((card) => card.card_id));
    const added = next.filter((card) => !was.has(card.card_id));
    const removed = active.filter((card) => !now.has(card.card_id)).map((card) => ({ ...card }));
    const changed = next.flatMap((card): [RuleCard, RuleCard][] => {
      const old = was.get(card.card_id);
      return old !== undefined && canonicalCard(old) !== canonicalCard(card) ? [[{ ...old }, card]] : [];
    });
    // Each reason once, in card order, as the API's summary lists them (`desk.api.versions.rules_draft`),
    // so rules lowered to the same payment limit share one entry. This is to match the API's data only:
    // the payment limit's review shows a row per changed rule, not the summary, which only a draft
    // with nothing to compare with (setup's) shows.
    const reasons = (mode: RuleCard['mode']) => [...new Set(next.filter((c) => c.mode === mode).map((c) => c.reason))];
    const proof = desk.policy.proof;
    desk.lastVersion += 1;
    const draft: RulesDraft = {
      version: desk.lastVersion,
      cards: next,
      diff: { added, removed, changed },
      auto_money_cap_cents: opts.cap ?? desk.policy.auto_money_cap_cents ?? 0,
      proof: {
        ok: true,
        method: 'symcc',
        cases: null,
        timed_out: false,
        checks: (proof?.checks ?? []).map((check) => ({ ...check })),
      },
      summary: { on_its_own: reasons('auto'), asks_you: reasons('ask'), never: reasons('never') },
    };
    desk.drafts.set(draft.version, { draft, parent: desk.policy.version, enables: [...(opts.enables ?? [])] });
    return draft;
  }

  /** A stored draft as a rules version with `status`, as the kernel keeps its versions. */
  private versionOf(desk: DeskRecord, record: DraftRecord, status: PolicyVersionOut['status']): PolicyVersionOut {
    const { draft } = record;
    const sha = (part: string) => placeholderHex(`sha256:${desk.summary.desk_id}:${draft.version}:${part}`, 32);
    return {
      desk_id: desk.summary.desk_id,
      version: draft.version,
      parent_version: record.parent,
      cards: draft.cards.map((card) => ({ ...card })),
      cedar_sha256: sha('cedar'),
      schema_sha256: sha('schema'),
      baseline_sha256: desk.policy.baseline_sha256,
      profiles_sha256: sha('profiles'),
      invariants_sha256: desk.policy.invariants_sha256,
      review_thresholds_version: desk.policy.review_thresholds_version,
      status,
      proof: { ...draft.proof, checks: draft.proof.checks.map((check) => ({ ...check })) },
      auto_money_cap_cents: draft.auto_money_cap_cents ?? 0,
    };
  }

  /**
   * Activates a draft, as the kernel's confirm does: the draft becomes the active version, its
   * tools turn on at the hashes the owner confirmed, and the record says so. A draft that isn't open
   * is not found, and one made from a version no longer active is stale. One that turns a tool on at
   * a hash its connector no longer lists (its definition changed again since) is a conflict, and
   * nothing changes: the tool waits for the owner's review of the new definition.
   */
  confirmDraft(desk: DeskRecord, version: number): PolicyVersionOut | 'not_found' | 'stale' | 'conflict' {
    const record = desk.drafts.get(version);
    if (record === undefined) return 'not_found';
    if (record.parent !== desk.policy.version) return 'stale';
    const drifted = record.enables.some((entry) => {
      const tool = desk.tools.find((row) => row.tool === entry.tool);
      return tool === undefined || entry.definition_sha256 !== listedHash(tool);
    });
    if (drifted) return 'conflict';
    desk.policy = this.versionOf(desk, record, 'active');
    desk.drafts.delete(version);
    for (const entry of record.enables) {
      desk.tools = desk.tools.map((tool) =>
        tool.tool === entry.tool
          ? { ...tool, status: 'enabled', definition_sha256: entry.definition_sha256, pending_definition_text: null, pending_sha256: null, review_reason: null }
          : tool,
      );
    }
    this.appendLedger(desk, {
      kind: 'policy',
      origin: 'kernel',
      session_id: null,
      ref_id: String(version),
      summary: { version, parent_version: record.parent },
    });
    // A never rule or a deciding ask rule revokes auto-allowed links in the scopes this mock models.
    // The script issues only auto-allowed links: it has no owner-approved link provenance or
    // full kernel rule evaluator (limits, hours, reviewer conditions and other principal scopes).
    const linkRules = rulesForTool({ tool: 'native.payment_link', effects: ['charge'] }, desk.policy.cards);
    // Match rulesForTool's ordering: personal tool, personal effect, group tool, group effect.
    const specificity = (card: RuleCard) => (card.who === 'person' || card.who === 'agent' ? 0 : 2)
      + (card.applies_to.startsWith('effect:') ? 1 : 0);
    for (const [token, link] of this.links) {
      if (link.deskId !== desk.summary.desk_id || link.view.state !== 'issued') continue;
      const session = this.sessions.get(link.sessionId);
      if (!session) continue;
      const applicable = linkRules.filter((card) => (
        card.who === 'anyone' ||
        (card.who === 'verified' && session.state.verified) ||
        (card.who === 'person' && session.person?.personId === card.person_id)
      ));
      const mostSpecific = applicable[0];
      // Never always wins; otherwise only the most specific cards decide, with ask winning ties.
      if (applicable.some((card) => card.mode === 'never') || (mostSpecific && applicable.some(
        (card) => card.mode === 'ask' && specificity(card) === specificity(mostSpecific),
      ))) this.cancelLink(token, link, 'rules_changed');
    }
    return { ...desk.policy, cards: desk.policy.cards.map((card) => ({ ...card })) };
  }

  /**
   * A tool confirm, as the kernel takes its batch: a whole connector in one action. Turning off
   * applies at once with no draft, except that verification can't be turned off. Turning on names
   * each tool's listed hash (a changed one's pending hash, never the old one) and drafts one version
   * for the tools not yet on, at the active rules and cap, which applies only when the owner
   * confirms it. The answer lists the batch's tools as they stand now, in the request's order.
   */
  confirmTools(desk: DeskRecord, entries: readonly ToolConfirmEntry[], enable: boolean): ToolConfirmedOut | ToolConfirmRefusal {
    const tools = entries.map((entry) => desk.tools.find((tool) => tool.tool === entry.tool));
    if (tools.some((tool) => tool === undefined)) return 'not_found';
    const profileOf = (name: string) => desk.tools.find((tool) => tool.tool === name) as ToolProfile;
    const profiles = () => entries.map((entry) => ({ ...profileOf(entry.tool) }));
    if (entries.length === 0) return 'not_found';
    if (!enable) {
      if (entries.some((entry) => entry.tool === 'native.start_verification')) return 'conflict';
      const off = new Set<string>(entries.map((entry) => entry.tool));
      // Off no longer waits for review, so it gives no reason; a changed definition stays to review later.
      desk.tools = desk.tools.map((tool) => (off.has(tool.tool) ? { ...tool, status: 'disabled', review_reason: null } : tool));
      for (const entry of entries) {
        this.appendLedger(desk, { kind: 'tool_pin', origin: 'kernel', session_id: null, ref_id: entry.tool, summary: { tool: entry.tool, enabled: false } });
      }
      return { profiles: profiles(), draft: null };
    }
    const hashed = entries.every((entry, i) => {
      const tool = tools[i];
      return tool !== undefined && entry.definition_sha256 !== '' && entry.definition_sha256 === listedHash(tool);
    });
    if (!hashed) return 'conflict';
    const enables = entries.filter((entry) => {
      const tool = profileOf(entry.tool);
      return !(tool.status === 'enabled' && tool.definition_sha256 === entry.definition_sha256);
    });
    if (enables.length === 0) return { profiles: profiles(), draft: null };
    const draft = this.draftCards(desk, desk.policy.cards, { enables });
    const record = desk.drafts.get(draft.version);
    if (record === undefined) throw new Error(`draft ${draft.version} was not stored`);
    return { profiles: profiles(), draft: this.versionOf(desk, record, 'proved') };
  }

  /** Writes seeded turns into history from `from`, each step `EVENT_GAP_MS` apart and turns `gap` apart. */
  replay(session: SessionRecord, from: number, turns: ReplayTurn[], gap = MINUTE): void {
    this.replaying += 1;
    try {
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
    } finally {
      this.replaying -= 1;
    }
  }
}

/** A person's first name and last initial, as the kernel names them on a payment link: "Dana W.". */
function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words[0] ?? '';
  const last = words.length > 1 ? words.at(-1) : undefined;
  const initial = last === undefined ? '' : (Array.from(last)[0] ?? '');
  return initial === '' ? first : `${first} ${initial}.`;
}

/** The owner's display name on `desk`: its own, or Turner's on a seeded Desk. */
function ownerNameOfDesk(desk: DeskRecord): string {
  return desk.ownerName ?? BUSINESS.owner_display_name;
}

/**
 * Whom the visitor's lines on `desk` name: its owner, by display name, or no one by name when the
 * Desk carries setup's fallback, "Owner", which is no one's name and which the public page never
 * shows (`brandFrom`).
 */
function deskOwner(desk: DeskRecord): DeskOwner {
  const name = ownerNameOfDesk(desk);
  return { name: name === OWNER_NAME_FALLBACK ? null : name, business: desk.summary.business_name };
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
