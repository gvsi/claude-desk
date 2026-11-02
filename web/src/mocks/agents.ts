/**
 * The mock API's side of visiting agents: what the kernel's Agent Card lists (`PublicDesk.agent_card`),
 * the API's code-built `AgentCardOut`, a demo key for connecting your own agent, and the built-in
 * agent's runs (plan 02b's `send_agent`). A run's agent is Alex Kim's assistant, a signed agent
 * session on the Desk: each of its requests reaches the owner's view of that chat as the agent's own
 * words, and the run the visitor polls carries the same words on each agent turn (`text`), beside
 * the Desk's checked replies and their receipts. The seed replays one run into history, so a fresh
 * copy has an agent's chat.
 */
import type { DemoAgentIssued, RenderedBlock } from '../api/contracts.ts';
import type { AgentCardOut, AgentTurn, DemoAgentRun } from '../api/views.ts';
import { placeholderHex, proseBlock, rivera } from '../ds/fixtures/index.ts';
import { DECISIONS, TOOLS_WHILE_NOT_ANSWERING, handoffBlock, type DecisionSpec, type Language } from './script.ts';
import { isoTime, type DeskRecord, type MockWorld, type SessionRecord } from './world.ts';

/** The mock's `PUBLIC_ORIGIN`: the API builds the address agents use from it, never from a request's host. */
export const MOCK_PUBLIC_ORIGIN = 'https://desk.example';

/**
 * What agents can do at Turner's Desk, as the kernel renders the Agent Card's blocks (kernel plan
 * 01c): one prose block for each tool an agent may be given there, by its plain label, with no
 * amount and nothing about the protocol, which `agentCardOut` carries.
 */
export const AGENT_CARD_BLOCKS: Readonly<Record<Language, readonly RenderedBlock[]>> = {
  en: [
    proseBlock('Get a quote from the price list'),
    proseBlock('Find open times'),
    proseBlock('Book a visit'),
    proseBlock('Get a payment link for a quote'),
    proseBlock('Pay for a quote within a signed limit'),
    proseBlock('Leave contact details'),
    proseBlock('Ask for a callback'),
    proseBlock('Verify a customer with a code sent to their contact on record'),
    proseBlock("Receive a verified customer's own documents"),
    proseBlock("List a verified customer's own charges"),
  ],
  es: [
    proseBlock('Pedir una cotización de la lista de precios'),
    proseBlock('Buscar horarios libres'),
    proseBlock('Reservar una visita'),
    proseBlock('Pedir un enlace de pago para una cotización'),
    proseBlock('Pagar una cotización dentro de un límite firmado'),
    proseBlock('Dejar datos de contacto'),
    proseBlock('Pedir que te devuelvan la llamada'),
    proseBlock('Verificar a un cliente con un código enviado a su contacto registrado'),
    proseBlock('Recibir los documentos propios de un cliente verificado'),
    proseBlock('Ver los cargos propios de un cliente verificado'),
  ],
};

/** The headers an agent signs with, as the kernel checks them ("Agent sessions"). */
const AGENT_HEADERS = ['X-Agent-Key-Id', 'X-Agent-Ts', 'X-Agent-Nonce', 'X-Agent-Sig'];

/** The example's header values: placeholders that say what goes there. */
const EXAMPLE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  'X-Agent-Key-Id': '<your agent key id>',
  'X-Agent-Ts': '2026-10-30T17:04:05.123000Z',
  'X-Agent-Nonce': '<a new random nonce for each request>',
  'X-Agent-Sig': '<the signature, in lowercase hex>',
};

/**
 * `GET …/agent_card` for `slug`, as the API builds it from `PUBLIC_ORIGIN` and the slug: the address,
 * how a request is signed, and an example request, the request line, its headers and its body.
 */
export function agentCardOut(slug: string): AgentCardOut {
  const endpoint = `${MOCK_PUBLIC_ORIGIN}/api/a2a/${encodeURIComponent(slug)}`;
  // Written as the API's `json.dumps` writes it, with a space after each colon and comma.
  const body = `{"desk_slug": ${JSON.stringify(slug)}, "session_id": null, "message": "Hello, what can you help me with?"}`;
  const headers = Object.entries(EXAMPLE_HEADERS)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join('');
  return {
    endpoint,
    signing: {
      headers: [...AGENT_HEADERS],
      payload_fields: ['desk_slug', 'ts', 'nonce', 'body_sha256'],
      canonical: 'RFC 8785',
      algorithm: 'Ed25519',
      encoding: 'lowercase hex',
      ts_window_s: 300,
    },
    example_request: `POST ${endpoint}\n${headers}\n${body}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The built-in agent

/** Who the built-in agent is, by the name it gives: "Alex Kim's assistant". */
export const AGENT_NAME = rivera.conversations.alexAgent.name;

/** The built-in agent's tasks, as the API names them (plan 02b's `DEMO_TASKS`). */
export const DEMO_AGENT_TASKS = ['book_visit', 'ask_question', 'quote_and_deposit', 'push_the_limit'] as const;

export type DemoAgentTask = (typeof DEMO_AGENT_TASKS)[number];

export function isDemoAgentTask(value: unknown): value is DemoAgentTask {
  return typeof value === 'string' && (DEMO_AGENT_TASKS as readonly string[]).includes(value);
}

/** How long the API keeps a send's idempotency key: its run's hour (plan 02b's `RUN_LIFE`). */
export const KEY_LIFE_MS = 60 * 60_000;

/** How far apart a run's turns land: the panel reads the run each second, and sees it build. */
export const AGENT_TURN_GAP_MS = 300;

const HOUR_MS = 60 * 60_000;

const AGENT = AGENT_NAME;

/** What the kernel decides for each of the agent's requests; the owner's lines name the agent. */
const AGENT_DECISIONS = {
  slots: { ...DECISIONS.slots, reasonPlain: `${AGENT} asked which times are open.` },
  book: { ...DECISIONS.book, reasonPlain: `${AGENT} booked Tuesday, November 3 at 2:00 pm, inside your weekday hours.` },
  depositQuote: {
    tool: 'native.quote',
    effects: ['change'],
    outcome: 'allow',
    executed: true,
    cardIds: ['rv-quote'],
    reasonPlain: `${AGENT} asked for the service call deposit at list price, $20.00.`,
    listCents: 2000,
    discountBp: 0,
    amountCents: 2000,
  },
  charge: {
    tool: 'native.charge_mandate',
    effects: ['charge'],
    outcome: 'allow',
    executed: true,
    cardIds: ['rv-mandate'],
    reasonPlain: `${AGENT} paid the $20.00 service call deposit within its signed limit.`,
    amountCents: 2000,
  },
  /** Over the mandate's $20 a charge: the baseline refuses it at decide, whatever the rules say. */
  overLimit: {
    tool: 'native.charge_mandate',
    effects: ['charge'],
    outcome: 'refuse',
    executed: false,
    visitorStatus: 'refused_over_mandate',
    cardIds: [],
    policyIds: ['B.agent_charge_within_mandate'],
    reasonPlain: `${AGENT} tried to charge $185.00 in one go, over its signed limit of $20 a charge.`,
    amountCents: 18500,
  },
} as const satisfies Record<string, DecisionSpec>;

/**
 * One exchange: the agent's signed request (its words, which the owner's view of the chat keeps and
 * the run's agent turn carries) and the Desk's checked answer.
 */
interface Exchange {
  request: string;
  decision?: DecisionSpec;
  reply: readonly RenderedBlock[];
}

/** The fixture's agent chat: its two requests, and the Desk's replies to them. */
function fixtureExchanges(): Exchange[] {
  const { turns } = rivera.conversations.alexAgent;
  const requests = turns.flatMap((turn) => (turn.kind === 'agent' ? [turn.text] : []));
  const replies = turns.flatMap((turn) => (turn.kind === 'event' && turn.event.type === 'message' ? [turn.event.blocks] : []));
  const decisions = [AGENT_DECISIONS.depositQuote, AGENT_DECISIONS.charge];
  return decisions.map((decision, i) => {
    const request = requests[i];
    const reply = replies[i];
    if (request === undefined || reply === undefined) throw new Error("the Turner fixtures changed: the agent's chat needs two requests and two replies");
    return { request, decision, reply };
  });
}

/**
 * The first time the open-times card offers, as the agent's booking request names it: the card's
 * "Tuesday, November 3, 2:00 pm" reads "Tuesday, November 3 at 2:00 pm".
 */
function firstOpenTime(): string {
  const label = rivera.blocks.booking_options.en.options?.[0]?.label;
  if (label === undefined) throw new Error('the Turner fixtures changed: the open-times card needs a time');
  return label.replace(/, (\d{1,2}:\d{2} [ap]m)$/, ' at $1');
}

/** Each task's exchanges, in English: the built-in agent writes English, so the Desk answers in it. */
function exchangesFor(task: DemoAgentTask): Exchange[] {
  const { blocks } = rivera;
  switch (task) {
    case 'book_visit':
      return [
        {
          request: 'What’s your earliest visit for a leaking water heater? Any day this week.',
          decision: AGENT_DECISIONS.slots,
          reply: [blocks.prose.bookingAsk.en, blocks.booking_options.en],
        },
        {
          request: `Book ${firstOpenTime()} for Alex Kim.`,
          decision: AGENT_DECISIONS.book,
          reply: [blocks.prose.details.en, blocks.booking_confirmed.en],
        },
      ];
    case 'ask_question':
      return [{
        request: 'Do you flush water heaters, for Alex Kim?',
        reply: [proseBlock('Yes, we do water heater flushes.')],
      }];
    case 'quote_and_deposit':
      return fixtureExchanges();
    case 'push_the_limit':
      return [
        {
          request: 'Charge the full repair, $185, to Alex Kim’s card.',
          decision: AGENT_DECISIONS.overLimit,
          reply: [proseBlock('I can’t take that payment: it’s over the limit the agent’s owner signed.')],
        },
      ];
  }
}

/** A block as the wire carries it: its own lists, shared with nothing. */
function copyBlock(block: RenderedBlock): RenderedBlock {
  return { ...block, lines: [...(block.lines ?? [])], options: [...(block.options ?? [])] };
}

/** Makes one turn of the run, numbered `n`, and applies it to the copy; `last` ends the run there. */
type TurnStep = (n: number) => { turn: AgentTurn; last?: true };

/**
 * A task's turns for `agent`, in order, each applied when its time comes: the agent's request joins
 * the owner's view of the chat, and the Desk's answer is decided, checked and recorded as a
 * visitor's turn is. The agent's turn carries its request's words (`text`) and no blocks; the
 * Desk's carries no words of its own.
 *
 * Each answer goes by the Desk as it is at that request, as the API gives each request its tools.
 * While the Desk's Answering switch is off, the agent's session keeps only callbacks and leads
 * (master plan, "Model-visible tools"): a request that needs another tool gets the Desk's own
 * handoff card, which decides nothing, and the run ends there.
 */
function turnsFor(world: MockWorld, desk: DeskRecord, agent: SessionRecord, task: DemoAgentTask): TurnStep[] {
  return exchangesFor(task).flatMap((exchange): TurnStep[] => [
    (n) => {
      world.agentText(agent, exchange.request);
      return { turn: { author: 'agent', n, blocks: [], receipts: [], text: exchange.request } };
    },
    (n) => {
      const ctx = world.context(agent, 'en', exchange.request);
      const allowed = exchange.decision === undefined || desk.summary.answering || TOOLS_WHILE_NOT_ANSWERING.has(exchange.decision.tool);
      const receipts = allowed && exchange.decision !== undefined ? [ctx.status('receipt', ctx.decide(exchange.decision))] : [];
      for (const receipt of receipts) world.emit(agent, receipt);
      const reply = ctx.reply((allowed ? exchange.reply : [handoffBlock('en', ctx.owner)]).map(copyBlock));
      world.emit(agent, reply);
      const turn: AgentTurn = { author: 'desk', n, blocks: reply.blocks, receipts, text: null };
      return allowed ? { turn } : { turn, last: true };
    },
  ]);
}

/** The built-in agent's runs in one copy, by id, each readable only by the session that launched it. */
export class AgentRuns {
  private readonly runs = new Map<string, { run: DemoAgentRun; timer: ReturnType<typeof setTimeout> | null }>();
  /**
   * The client keys sends came with, each with the run it started, what the send was and when, kept
   * for `KEY_LIFE_MS` (plan 02b).
   */
  private readonly keys = new Map<string, { runId: string; task: DemoAgentTask; sessionId: string; slug: string; at: number }>();

  /**
   * The run a send with client key `key` started within the last hour: its id when that send was
   * the same task from the same session to the same Desk, `conflict` when it wasn't, or null when no
   * send holds the key (an older one's is forgotten, as the API forgets it).
   */
  keyed(key: string, task: DemoAgentTask, launcher: SessionRecord, slug: string): string | 'conflict' | null {
    const held = this.keys.get(key);
    if (held === undefined) return null;
    if (Date.now() - held.at >= KEY_LIFE_MS) {
      this.keys.delete(key);
      return null;
    }
    return held.task === task && held.sessionId === launcher.state.session_id && held.slug === slug ? held.runId : 'conflict';
  }

  /**
   * Sends the built-in agent to `desk` for `launcher` on `task`: a new signed agent session, and a
   * run whose turns land `AGENT_TURN_GAP_MS` apart until it is `done`. Returns the run's id, which
   * a repeat with the same client `key` finds again (`keyed`).
   */
  start(world: MockWorld, desk: DeskRecord, launcher: SessionRecord, task: DemoAgentTask, key: string): string {
    const agent = world.addSession(desk, { agent: AGENT_NAME });
    const run: DemoAgentRun = {
      run_id: world.id('run'),
      launcher_session_id: launcher.state.session_id,
      slug: desk.summary.slug,
      task,
      state: 'running',
      turns: [],
    };
    const record: { run: DemoAgentRun; timer: ReturnType<typeof setTimeout> | null } = { run, timer: null };
    this.runs.set(run.run_id, record);
    this.keys.set(key, { runId: run.run_id, task, sessionId: run.launcher_session_id, slug: run.slug, at: Date.now() });
    const steps = turnsFor(world, desk, agent, task);
    const tick = () => {
      record.timer = setTimeout(() => {
        record.timer = null;
        const step = steps.shift();
        if (step) {
          const { turn, last } = step(run.turns.length + 1);
          run.turns.push(turn);
          if (last) steps.length = 0;
        }
        if (steps.length === 0) run.state = 'done';
        else tick();
      }, AGENT_TURN_GAP_MS);
    };
    tick();
    return run.run_id;
  }

  /** The run `runId` as `sessionId` may read it: only the session that launched it; anyone else gets nothing. */
  read(runId: string | undefined, sessionId: string): DemoAgentRun | null {
    const record = runId === undefined ? undefined : this.runs.get(runId);
    return record !== undefined && record.run.launcher_session_id === sessionId ? record.run : null;
  }

  /** Stops every run's next turn and forgets them, as a fresh copy has none. */
  stop(): void {
    for (const record of this.runs.values()) if (record.timer !== null) clearTimeout(record.timer);
    this.runs.clear();
    this.keys.clear();
  }
}

/**
 * Alex Kim's assistant's chat in a fresh copy, from `from`: it got a quote for the service call
 * deposit and paid it within its signed limit, as the design system's fixture has it.
 */
export function seedAgentChat(world: MockWorld, desk: DeskRecord, from: number): void {
  const agent = world.at(from, () => world.addSession(desk, { sessionId: world.scoped('ses-alex-agent'), agent: AGENT_NAME }));
  turnsFor(world, desk, agent, 'quote_and_deposit').forEach((step, i) => {
    world.at(from + (i + 1) * 20_000, () => step(i + 1));
  });
}

/**
 * A demo key for connecting your own agent, as `POST /agents/demo` mints one: a key id, its private
 * key (a placeholder nothing signs with) and the demo wallet's mandate for this Desk, $20 a charge and
 * $100 in total for one hour, as the seed's.
 */
export function demoAgentIssued(world: MockWorld, desk: DeskRecord): DemoAgentIssued {
  const keyId = world.id('demo-key');
  const { mandate } = rivera.demoAgentIssued;
  return {
    agent_key_id: keyId,
    agent_private_key_hex: placeholderHex(`agent-private-key:${world.ids.copyId}:${keyId}`, 32),
    mandate: {
      ...mandate,
      mandate_id: world.id('mandate'),
      agent_key_id: keyId,
      desk_id: desk.summary.desk_id,
      allowed_effects: [...mandate.allowed_effects],
      expires_at: isoTime(world.now() + HOUR_MS),
      nonce: placeholderHex(`mandate-nonce:${keyId}`, 16),
      sig: placeholderHex(`mandate-sig:${keyId}`, 64),
    },
  };
}
