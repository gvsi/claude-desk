/**
 * What a fresh mock copy holds, by seed. `rivera` is the master plan's Rivera seed as far as the
 * mocked routes read it (Rivera Plumbing, Maria Rivera, the Main line Desk with its rule cards and
 * open status, and the seeded hold) plus Dana's live chat and Alex Kim's assistant's, a visiting
 * agent's; `rivera_quiet` has no hold and no chats; `rivera_two_desks` adds an "Emergencies" Desk. Seeded chats are replayed through the
 * script's own steps, so their ledger entries, receipts and transcript items line up the way the
 * live ones do.
 */
import type { HoursWindow, OpenStatus, RuleCard } from '../api/contracts.ts';
import type { PolicyVersionOut, RulesPreset } from '../api/views.ts';
import { RIVERA_MONEY_CAP_CENTS, placeholderHex, rivera } from '../ds/fixtures/index.ts';
import { seedAgentChat } from './agents.ts';
import { DECISIONS, SEEDED_HOLD_STEPS, writing, type Language, type Step } from './script.ts';
import type { MockWorld, ReplayTurn } from './world.ts';

export type MockSeed = 'rivera' | 'rivera_quiet' | 'rivera_two_desks';

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
  slug: 'rivera-plumbing-abc123',
  emergenciesDeskId: 'desk-rivera-emergencies',
  emergenciesSlug: 'rivera-plumbing-em24hr',
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
    slug: `rivera-plumbing-${tag.padStart(6, '0')}`,
    emergenciesDeskId: `${RIVERA.emergenciesDeskId}-${tag}`,
    emergenciesSlug: `rivera-plumbing-e${tag.padStart(5, '0')}`,
  };
}

export const BUSINESS = {
  name: rivera.business.name,
  owner_display_name: rivera.business.ownerName,
  timezone: 'America/Los_Angeles',
  brand: { ...rivera.business.brand },
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

/** When the kernel computed the mock's open statuses: a Friday, 90 seconds before Rivera's 6:00 pm close. */
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
 * customers' own documents and an ask before money moves. Read-only: copy a card before changing it.
 */
export const PRESETS: Readonly<Record<RulesPreset, readonly RuleCard[]>> = {
  ask_first: STARTER_CARDS,
  auto: [...STARTER_CARDS, ...RECOMMENDED_CARDS],
};

/**
 * The active rules: version 7, proved, with the starter preset's cards the seed keeps, as the
 * kernel's Rivera seed does, then the seed's own, at Rivera's $500 payment limit. An approval's card
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

const MINUTE = 60_000;

/** What the seeded visitor asked, twelve minutes before the copy opened: the hold on Today. */
function seededHoldText(): string {
  const turn = rivera.conversations.visitor.turns.find((t) => t.kind === 'visitor');
  if (turn?.kind !== 'visitor') throw new Error("the Rivera fixtures changed: the seeded hold needs the visitor's message");
  return turn.text;
}

/** Dana's live chat from the fixtures: her three messages, Maria's whisper and Claude's three checked replies. */
function danaTurns(): ReplayTurn[] {
  const turns = rivera.conversations.danaLive.turns;
  const texts = turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
  const whisper = turns.find((t) => t.kind === 'whisper');
  const replies = turns.flatMap((t) => (t.kind === 'event' && t.event.type === 'message' ? [t.event.blocks] : []));
  const actions = [DECISIONS.quote, DECISIONS.slots, DECISIONS.book];
  return texts.map((text, i) => {
    const spec = actions[i];
    const blocks = replies[i];
    if (!spec || !blocks) throw new Error("the Rivera fixtures changed: Dana's live chat needs three replies");
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
