/**
 * What a fresh mock copy holds, by seed. `rivera` is the master plan's Turner seed as far as the
 * mocked routes read it (Turner Plumbing, Mike Turner, the Main line Desk with its rule cards and
 * open status, the public website and price list knowledge, and the seeded hold) plus Dana's live
 * chat and Alex Kim's assistant's, a visiting agent's; `rivera_quiet` has no hold and no chats;
 * `rivera_two_desks` adds an "Emergencies" Desk. Seeded chats are replayed through the
 * script's own steps, so their ledger entries, receipts and transcript items line up the way the
 * live ones do.
 */
import type { HoursWindow, KnowledgeItem, OpenStatus, RuleCard, ToolName, ToolProfile } from '../api/contracts.ts';
import type { JobProposal, PolicyVersionOut, RulesPreset } from '../api/views.ts';
import { RIVERA_MONEY_CAP_CENTS, placeholderHex, rivera } from '../ds/fixtures/index.ts';
import { paletteBrand } from '../public/palette.ts';
import { seedAgentChat } from './agents.ts';
import { businessToolRows, seedBusinessTools } from './businessTools.ts';
import { DECISIONS, SEEDED_HOLD_STEPS, writing, type Language, type Step } from './script.ts';
import type { DeskRecord, MockWorld, ReplayTurn, ToolRecord } from './world.ts';

export type MockSeed = 'rivera' | 'rivera_quiet' | 'rivera_two_desks' | 'rivera_ended_document' | 'rivera_no_brand';

export interface CopyIds {
  copyId: string;
  businessId: string;
  deskId: string;
  slug: string;
  emergenciesDeskId: string;
  emergenciesSlug: string;
}

/** The first copy's ids: what tests name until a start over issues a new copy. */
export const RIVERA = {
  copyId: 'copy-demo-7f3a',
  businessId: 'biz-rivera',
  deskId: 'desk-rivera-main',
  slug: 'turner-plumbing-abc123',
  emergenciesDeskId: 'desk-rivera-emergencies',
  emergenciesSlug: 'turner-plumbing-em24hr',
} as const satisfies CopyIds;

/**
 * Each copy gets its own ids and slugs, as the API's do: copy 1 is `RIVERA`, later copies are
 * numbered (the screen tests' start over makes copy 2). The dev server numbers its copies at random,
 * with six base-36 digits, so a public link names one copy and a link from before a restart names none.
 */
export function copyIds(copyNo: number): CopyIds {
  if (copyNo === 1) return { ...RIVERA };
  const tag = copyNo.toString(36);
  return {
    copyId: `${RIVERA.copyId}-${tag}`,
    businessId: `${RIVERA.businessId}-${tag}`,
    deskId: `${RIVERA.deskId}-${tag}`,
    slug: `turner-plumbing-${tag.padStart(6, '0')}`,
    emergenciesDeskId: `${RIVERA.emergenciesDeskId}-${tag}`,
    emergenciesSlug: `turner-plumbing-e${tag.padStart(5, '0')}`,
  };
}

export const BUSINESS = {
  name: rivera.business.name,
  owner_display_name: rivera.business.ownerName,
  timezone: 'America/Los_Angeles',
  brand: paletteBrand('teal'),
} as const;

/** Mon–Fri 08:00–18:00 and Sat 09:00–13:00. */
export const RIVERA_HOURS: HoursWindow[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00:00', end: '18:00:00' },
  { days: ['sat'], start: '09:00:00', end: '13:00:00' },
];

/**
 * Around the clock: each day's window ends at midnight (an end of 00:00 closes the day), where the
 * next day's begins, so the windows touch and the kernel says "Open now" with no end.
 */
const ALL_DAY_EVERY_DAY: HoursWindow[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00:00', end: '00:00:00' },
];

/** When the kernel computed the mock's open statuses: a Friday, 90 seconds before Turner's 6:00 pm close. */
const OPEN_STATUS_AS_OF = '2026-10-30T17:58:30-07:00';
const RIVERA_CLOSES = '2026-10-30T18:00:00-07:00';

/**
 * The main line's open status at that moment: open until the 6:00 pm close, which is also when its
 * text next changes. It never moves on, so every screen reads the same line; a test plants a closed
 * or null status with `mockStore.inject`.
 */
const RIVERA_OPEN_STATUS: Record<Language, OpenStatus> = {
  en: {
    open: true,
    until: RIVERA_CLOSES,
    opens_at: null,
    text: 'Open now, until 6:00 pm',
    as_of: OPEN_STATUS_AS_OF,
    refresh_at: RIVERA_CLOSES,
  },
  es: {
    open: true,
    until: RIVERA_CLOSES,
    opens_at: null,
    text: 'Abierto ahora, hasta las 18:00',
    as_of: OPEN_STATUS_AS_OF,
    refresh_at: RIVERA_CLOSES,
  },
};

/** The Emergencies Desk's, open around the clock: no end to name, and the text holds until local midnight. */
const NEXT_MIDNIGHT = '2026-10-31T00:00:00-07:00';
const OPEN_ALL_WEEK: Record<Language, OpenStatus> = {
  en: { open: true, until: null, opens_at: null, text: 'Open now', as_of: OPEN_STATUS_AS_OF, refresh_at: NEXT_MIDNIGHT },
  es: { open: true, until: null, opens_at: null, text: 'Abierto ahora', as_of: OPEN_STATUS_AS_OF, refresh_at: NEXT_MIDNIGHT },
};

const PROOF_CHECKS = [
  'never_errors',
  'baseline_auto',
  'baseline_approvable',
  'auto_within_cards',
  'review_only_narrows',
  'hold_within_cards',
  'money_needs_card',
] as const;

/** A preset card, with every field the API sends at its default. */
function presetCard(fields: Pick<RuleCard, 'card_id' | 'applies_to' | 'mode' | 'who' | 'reason'> & Partial<RuleCard>): RuleCard {
  return { person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, is_default: false, ...fields };
}

const STARTER_CARDS: RuleCard[] = [
  presetCard({ card_id: 'preset-find-slots', applies_to: 'native.find_slots', mode: 'auto', who: 'anyone', reason: 'Anyone can see the times you have open.' }),
  presetCard({ card_id: 'preset-capture-lead', applies_to: 'native.capture_lead', mode: 'auto', who: 'anyone', reason: 'Anyone can leave their name and how to reach them.' }),
  presetCard({ card_id: 'preset-request-callback', applies_to: 'native.request_callback', mode: 'auto', who: 'anyone', reason: 'Anyone can ask you to call them back.' }),
  presetCard({
    card_id: 'preset-start-verification',
    applies_to: 'native.start_verification',
    mode: 'auto',
    who: 'anyone',
    reason: 'Anyone can ask for a code, which goes only to the contact you have on record.',
  }),
  presetCard({ card_id: 'preset-fetch-website', applies_to: 'native.fetch_website', mode: 'auto', who: 'anyone', reason: 'Claude can read your website to learn about your business.' }),
  presetCard({ card_id: 'preset-read-memory', applies_to: 'native.read_memory', mode: 'auto', who: 'anyone', reason: 'Claude can read the notes you brought in to learn about your business.' }),
  presetCard({ card_id: 'preset-web-search', applies_to: 'native.web_search', mode: 'auto', who: 'anyone', reason: 'Claude can search the web to learn how businesses like yours work.' }),
];

const RECOMMENDED_CARDS: RuleCard[] = [
  presetCard({ card_id: 'preset-quote', applies_to: 'native.quote', mode: 'auto', who: 'anyone', reason: 'Quotes from your price list, at list price.' }),
  presetCard({
    card_id: 'preset-book-weekday',
    applies_to: 'native.book',
    mode: 'auto',
    who: 'anyone',
    hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '17:00:00' },
    review: true,
    reason: 'Weekday bookings in working hours, checked by the reviewer.',
  }),
  presetCard({ card_id: 'preset-documents', applies_to: 'native.release_document', mode: 'auto', who: 'record_owner', reason: "Customers get their own documents after confirming it's them." }),
  presetCard({ card_id: 'preset-charge-ask', applies_to: 'effect:charge', mode: 'ask', who: 'anyone', reason: 'Taking a payment asks you first.' }),
  presetCard({ card_id: 'preset-pay-out-ask', applies_to: 'effect:pay_out', mode: 'ask', who: 'anyone', reason: 'Sending money out asks you first.' }),
];

/**
 * The presets' cards, as the master plan's `desk.presets.PRESETS` has them (`backend/desk/presets.py`):
 * "Ask me first" lets Claude show open times, take leads and callbacks, start verifications and read
 * the owner's material on its own; "Recommended rules" adds quotes at list price, weekday bookings,
 * customers' own documents and an ask before money moves. Its booking card here books Monday to
 * Friday, 9 to 5, the fallback for a Desk with no hours: a draft of the preset gives it the Desk's
 * own weekday hours (`presetCards`). Read-only: copy a card before changing it.
 */
export const PRESETS: Readonly<Record<RulesPreset, readonly RuleCard[]>> = {
  ask_first: STARTER_CARDS,
  auto: [...STARTER_CARDS, ...RECOMMENDED_CARDS],
};

/** The days "Recommended rules" books on its own, in week order. */
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
type Weekday = (typeof WEEKDAYS)[number];
const isWeekday = (day: string): day is Weekday => (WEEKDAYS as readonly string[]).includes(day);

/** "Recommended rules"'s weekday booking card, which `presetCards` gives the Desk's own hours. */
const PRESET_BOOKING_CARD = 'preset-book-weekday';
/** The reason of a booking card in the Desk's own hours: the example Desk's own weekday rule's words, naming no hours. */
const OPENING_HOURS_REASON = 'Weekday bookings in opening hours, checked by the reviewer.';

/** Seconds since midnight of a contract time ("08:00:00"); an end at 00:00 is midnight, the day's end. */
function secondsOf(time: string, end = false): number {
  const [h = '0', m = '0', s = '0'] = time.split(':');
  const total = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return end && total === 0 ? 24 * 3600 : total;
}

/**
 * The weekday part of a Desk's opening hours, as the API's `weekday_windows` reads it: each window's
 * days cut to Monday to Friday, a window left with none dropped (a Saturday's, say), and windows with
 * the same start and end merged, their days in week order; an end of 00:00 stays midnight. They come
 * by their first day, then their start, then their end (midnight last), however the Desk keeps them.
 */
export function weekdayWindows(hours: readonly HoursWindow[]): HoursWindow[] {
  const merged = new Map<string, { start: string; end: string; days: Set<Weekday> }>();
  for (const window of hours) {
    const weekdays = window.days.filter(isWeekday);
    if (weekdays.length === 0) continue;
    const key = `${window.start}-${window.end}`;
    const entry = merged.get(key) ?? { start: window.start, end: window.end, days: new Set<Weekday>() };
    for (const day of weekdays) entry.days.add(day);
    merged.set(key, entry);
  }
  const windows = [...merged.values()].map(({ start, end, days }) => {
    const [first, ...rest] = WEEKDAYS.filter((day) => days.has(day));
    if (first === undefined) throw new Error('a weekday window has a weekday');
    return { days: [first, ...rest], start, end } satisfies HoursWindow;
  });
  const firstDay = (window: HoursWindow) => WEEKDAYS.indexOf(window.days[0] as Weekday);
  return windows.sort(
    (a, b) => firstDay(a) - firstDay(b) || secondsOf(a.start) - secondsOf(b.start) || secondsOf(a.end, true) - secondsOf(b.end, true),
  );
}

/** Whether two windows name the same days, in the same order, and the same start and end. */
function sameWindow(a: HoursWindow, b: HoursWindow | null | undefined): boolean {
  return b != null && a.start === b.start && a.end === b.end && a.days.length === b.days.length && a.days.every((day, i) => day === b.days[i]);
}

/**
 * The preset's cards for a Desk with these opening hours, as the API's `preset_cards` drafts them:
 * "Recommended rules" books weekdays in the Desk's own hours, its weekday booking card giving way to
 * one card per weekday window (`weekdayWindows`), in that order and in its place, each the preset's
 * card in all but its hours, its reason (`OPENING_HOURS_REASON`) and, for several windows, its id,
 * numbered `-1`, `-2` and on. Hours with
 * none on a weekday give no booking card, so weekday bookings ask first. No hours at all, or exactly
 * the card's own (Monday to Friday, 9 to 5), give the preset's cards as they are, as does "Ask me
 * first", which books nothing.
 */
export function presetCards(preset: RulesPreset, hours: readonly HoursWindow[]): RuleCard[] {
  const cards = [...PRESETS[preset]];
  const at = cards.findIndex((card) => card.card_id === PRESET_BOOKING_CARD);
  const booking = cards[at];
  if (booking === undefined || hours.length === 0) return cards;
  const windows = weekdayWindows(hours);
  const [only] = windows;
  if (only !== undefined && windows.length === 1 && sameWindow(only, booking.hours)) return cards;
  const bookings = windows.map((window, i) => ({
    ...booking,
    card_id: windows.length === 1 ? booking.card_id : `${booking.card_id}-${i + 1}`,
    hours: window,
    reason: OPENING_HOURS_REASON,
  }));
  return [...cards.slice(0, at), ...bookings, ...cards.slice(at + 1)];
}

/**
 * The active rules: version 7, proved, with the starter preset's cards the seed keeps, as the
 * kernel's Turner seed does, then the seed's own, at Turner's $500 payment limit. An approval's card
 * draft becomes version 8.
 */
export function activePolicy(deskId: string): PolicyVersionOut {
  const sha = (part: string) => placeholderHex(`sha256:${deskId}:7:${part}`, 32);
  return {
    desk_id: deskId,
    version: 7,
    parent_version: 6,
    cards: [...PRESETS.ask_first, ...Object.values(rivera.ruleCards)].map((card) => ({ ...card })),
    cedar_sha256: sha('cedar'),
    schema_sha256: sha('schema'),
    baseline_sha256: sha('baseline'),
    profiles_sha256: sha('profiles'),
    invariants_sha256: sha('invariants'),
    review_thresholds_version: 1,
    status: 'active',
    proof: {
      ok: true,
      method: 'symcc',
      cases: null,
      timed_out: false,
      checks: PROOF_CHECKS.map((name) => ({ name, ok: true, counterexample_plain: null, counterexample_raw: null })),
    },
    auto_money_cap_cents: RIVERA_MONEY_CAP_CENTS,
  };
}

/** A built-in tool's profile: its adapter's, pinned at the adapter profile's hash, enabled and with no reason to review it. */
function nativeTool(
  tool: ToolName,
  fields: Pick<ToolProfile, 'effects' | 'reversible' | 'resource_kind' | 'description_confirmed'>,
): ToolRecord {
  return {
    tool,
    source: 'native',
    business: null,
    adapter: tool.slice('native.'.length),
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    definition_sha256: placeholderHex(`sha256:profile:${tool}`, 32),
    pending_definition_text: null,
    pending_sha256: null,
    status: 'enabled',
    review_reason: null,
    ...fields,
  };
}

/**
 * The tools a Turner copy starts with, as the kernel's tool rows have them: every built-in tool,
 * with the effects the master plan's tool table gives each, and both of the mock payments server's,
 * connected and pinned (the fixtures' profiles). Every one is on, so none waits for review.
 */
export function riveraTools(): ToolRecord[] {
  return [
    nativeTool('native.quote', { effects: ['change'], reversible: true, resource_kind: 'desk', description_confirmed: "Price a job from the business's price list." }),
    nativeTool('native.find_slots', { effects: ['read'], reversible: true, resource_kind: 'desk', description_confirmed: 'Find open times on the calendar.' }),
    nativeTool('native.book', { effects: ['change'], reversible: true, resource_kind: 'slot', description_confirmed: 'Book a visit in an open time.' }),
    nativeTool('native.release_document', {
      effects: ['private_data', 'send_message'],
      reversible: false,
      resource_kind: 'document',
      description_confirmed: 'Send a verified customer a link to one of their own documents.',
    }),
    nativeTool('native.payment_link', { effects: ['charge'], reversible: false, resource_kind: 'quote', description_confirmed: 'Make a one-time payment link for a quote.' }),
    nativeTool('native.charge_mandate', {
      effects: ['charge'],
      reversible: false,
      resource_kind: 'quote',
      description_confirmed: "Charge a visiting agent within its owner's signed limit.",
    }),
    nativeTool('native.capture_lead', { effects: ['change'], reversible: true, resource_kind: 'desk', description_confirmed: "Save a visitor's name and how to reach them." }),
    nativeTool('native.request_callback', { effects: ['change'], reversible: true, resource_kind: 'desk', description_confirmed: 'Ask the owner to call a visitor back.' }),
    nativeTool('native.start_verification', {
      effects: ['send_message'],
      reversible: false,
      resource_kind: 'desk',
      description_confirmed: 'Send a code to the contact on record.',
    }),
    nativeTool('native.fetch_website', { effects: ['read'], reversible: true, resource_kind: 'desk', description_confirmed: "Read the business's website." }),
    nativeTool('native.read_memory', { effects: ['read'], reversible: true, resource_kind: 'desk', description_confirmed: 'Read the notes the owner brought in.' }),
    nativeTool('native.web_search', { effects: ['read'], reversible: true, resource_kind: 'desk', description_confirmed: 'Searches the web to learn how businesses like yours work.' }),
    { ...rivera.toolProfiles.listCharges, business: null, review_reason: null },
    { ...rivera.toolProfiles.createRefund, business: null, review_reason: null },
  ];
}

/**
 * Mike's urgent business tool, as the kernel's Turner seed gives every copy (`RIVERA_BUSINESS_TOOLS`):
 * an emergency callback that alerts him at once, whatever his notification settings.
 */
const RIVERA_URGENT_JOB = {
  title: 'Emergency callback',
  how: 'Asks Mike to call back urgently about an emergency.',
  config: { block: 'urgent', urgent_when: 'A burst or leaking pipe, flooding, a sewage backup, or no water' },
} as const satisfies Pick<JobProposal, 'title' | 'how' | 'config'>;

/** The kernel seed's card that lets anyone use Mike's urgent tool (`rv-urgent`). */
const RIVERA_URGENT_CARD = presetCard({
  card_id: 'rv-urgent',
  applies_to: 'desk.emergency-callback',
  mode: 'auto',
  who: 'anyone',
  reason: 'Anyone can ask for an urgent callback, which alerts you at once.',
});

/**
 * Gives a Turner copy's Desk its urgent tool, turned on, and the card that allows it, as the
 * kernel's copy does: the tool built as setup builds a Desk's own tools, then turned on as the
 * seed's rules version activates, with `rv-urgent` last among the seed's cards.
 */
function seedRiveraUrgentTool(desk: DeskRecord): void {
  seedBusinessTools(desk, businessToolRows([RIVERA_URGENT_JOB]).map((row) => ({ ...row, status: 'enabled', review_reason: null })));
  desk.policy = { ...desk.policy, cards: [...desk.policy.cards, { ...RIVERA_URGENT_CARD }] };
}

const MINUTE = 60_000;

/** What the seeded visitor asked, twelve minutes before the copy opened: the hold on Today. */
function seededHoldText(): string {
  const turn = rivera.conversations.visitor.turns.find((t) => t.kind === 'visitor');
  if (turn?.kind !== 'visitor') throw new Error("the Turner fixtures changed: the seeded hold needs the visitor's message");
  return turn.text;
}

/** Dana's live chat from the fixtures: her three messages, Mike's whisper and Claude's three checked replies. */
function danaTurns(): ReplayTurn[] {
  const turns = rivera.conversations.danaLive.turns;
  const texts = turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
  const whisper = turns.find((t) => t.kind === 'whisper');
  const replies = turns.flatMap((t) => (t.kind === 'event' && t.event.type === 'message' ? [t.event.blocks] : []));
  const actions = [DECISIONS.quote, DECISIONS.slots, DECISIONS.book];
  return texts.map((text, i) => {
    const spec = actions[i];
    const blocks = replies[i];
    if (!spec || !blocks) throw new Error("the Turner fixtures changed: Dana's live chat needs three replies");
    const steps: Step[] = [(ctx) => ctx.status('receipt', ctx.decide(spec)), writing, (ctx) => ctx.reply(blocks)];
    return { text, whisper: i === 1 && whisper?.kind === 'whisper' ? whisper.text : undefined, steps };
  });
}

/** Fills a new copy's world for `seed`, with everything dated before `world.now()`. */
export function seedWorld(world: MockWorld): void {
  const { ids, seed } = world;
  const opened = world.now();
  const main = world.addDesk({
    desk_id: ids.deskId,
    slug: ids.slug,
    name: rivera.business.deskName,
    hours: RIVERA_HOURS,
    openStatus: RIVERA_OPEN_STATUS,
  });
  seedRiveraUrgentTool(main);
  const knowledge: KnowledgeItem[] = [
    {
      item_id: 'kn-website',
      source: 'website',
      label: { readers: ['public'], record_owner: null },
      title: 'Your website, turner-plumbing.example, read during setup',
      text: "Turner Plumbing is Mike Turner's home plumbing business: drain clearing, leak repair and water heater flushes. We work in Oakland, Berkeley, Alameda and Emeryville.",
    },
    {
      item_id: 'kn-price-list',
      source: 'setup',
      label: { readers: ['public'], record_owner: null },
      title: 'Price list, from your answers in setup',
      text: 'The price list Mike gave in setup covers the service call deposit, drain clearing, a water heater flush and leak repair. Each price is given in a quote from this list.',
    },
  ];
  // The kernel stores these one after another on its live clock: website first, then price list.
  for (const [i, item] of knowledge.entries()) {
    world.knowledge.set(`${ids.deskId}:${item.item_id}`, { deskId: ids.deskId, item, createdAt: opened - (knowledge.length - i), forced: false });
  }
  if (seed === 'rivera_no_brand') main.brand = {};

  if (seed === 'rivera_two_desks') {
    world.addDesk({
      desk_id: ids.emergenciesDeskId,
      slug: ids.emergenciesSlug,
      name: 'Emergencies',
      hours: ALL_DAY_EVERY_DAY,
      openStatus: OPEN_ALL_WEEK,
    });
  }
  if (seed === 'rivera_quiet') return;
  if (seed === 'rivera_ended_document') {
    const rule = main.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
    const draft = world.draft(main, [{ ...rule, mode: 'ask', reason: 'Ask me before sharing a customer’s document.' }]);
    world.confirmDraft(main, draft.version);
    const chat = world.addSession(main);
    world.verify(chat, rivera.people.dana);
    world.replay(chat, opened - MINUTE, [{ text: 'Please send me my drain clearing invoice.', steps: [
      (ctx) => ctx.status('held', ctx.decide({ ...DECISIONS.releaseInvoice, outcome: 'hold', executed: false, hold: 'ask',
        reasonPlain: 'Dana Whitfield asked for her drain clearing invoice. Your rule asks before sharing documents.' })),
      writing,
      (ctx) => ctx.reply([rivera.blocks.handoff[ctx.language]]),
    ] }]);
    // The chat ends for good: the visitor's page hears the session error, and a new chat can't resume it.
    world.emit(chat, { type: 'error', code: 'session' });
    chat.ended = true;
    return;
  }

  // Alex Kim's assistant, a signed visiting agent, got a quote for the service call deposit and paid
  // it within its signed limit, forty minutes before the copy opened.
  seedAgentChat(world, main, opened - 40 * MINUTE);

  // The seeded hold: a visitor not on record asked for 15% off, longer ago than "live".
  const heldAt = opened - 12 * MINUTE;
  const visitor = world.at(heldAt, () => world.addSession(main, { sessionId: world.scoped('ses-visitor-web') }));
  world.replay(visitor, heldAt, [{ text: seededHoldText(), steps: SEEDED_HOLD_STEPS }]);

  // Dana's chat, her last message a minute before the copy opened: live on Today.
  const danaFrom = opened - 5 * MINUTE;
  const dana = world.at(danaFrom, () => world.addSession(main, { sessionId: world.scoped('ses-dana-web') }));
  world.replay(dana, danaFrom, danaTurns(), 2 * MINUTE);
}
