/**
 * What a fresh mock copy holds, by seed. `rivera` is the master plan's Rivera seed as far as the
 * mocked routes read it (Rivera Plumbing, Maria Rivera, the Main line Desk, its rule cards and the
 * seeded hold) plus Dana's live chat; `rivera_quiet` has no hold and no chats; `rivera_two_desks`
 * adds an "Emergencies" Desk. Seeded chats are replayed through the script's own steps, so their
 * ledger entries, receipts and transcript items line up the way the live ones do.
 */
import type { HoursWindow, PolicyVersion } from '../api/contracts.ts';
import { placeholderHex, rivera } from '../ds/fixtures/index.ts';
import { DECISIONS, ruleNamed, writing, type Step } from './script.ts';
import type { MockWorld, ReplayTurn } from './store.ts';

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

/** Each copy gets its own ids, as the API's do: copy 1 is `RIVERA`, later copies are numbered. */
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

const ALL_DAY_EVERY_DAY: HoursWindow[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00:00', end: '23:59:59' },
];

const PROOF_CHECKS = [
  'never_errors',
  'baseline_auto',
  'baseline_approvable',
  'auto_within_cards',
  'review_only_narrows',
  'hold_within_cards',
  'money_needs_card',
] as const;

/** The active rules: version 7 with the seed's cards, proved. An approval's card draft becomes version 8. */
export function activePolicy(deskId: string): PolicyVersion {
  const sha = (part: string) => placeholderHex(`sha256:${deskId}:7:${part}`, 32);
  return {
    desk_id: deskId,
    version: 7,
    parent_version: 6,
    cards: Object.values(rivera.ruleCards).map((card) => ({ ...card })),
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
  const main = world.addDesk({ desk_id: ids.deskId, slug: ids.slug, name: rivera.business.deskName, hours: RIVERA_HOURS });
  if (seed === 'rivera_two_desks') {
    world.addDesk({ desk_id: ids.emergenciesDeskId, slug: ids.emergenciesSlug, name: 'Emergencies', hours: ALL_DAY_EVERY_DAY });
  }
  if (seed === 'rivera_quiet') return;

  // The seeded hold: a visitor not on record asked for 15% off, longer ago than "live".
  const heldAt = opened - 12 * MINUTE;
  const visitor = world.at(heldAt, () => world.addSession(main, { sessionId: world.scoped('ses-visitor-web') }));
  world.replay(visitor, heldAt, [{ text: seededHoldText(), steps: ruleNamed('discount').steps }]);

  // Dana's chat, her last message a minute before the copy opened: live on Today.
  const danaFrom = opened - 5 * MINUTE;
  const dana = world.at(danaFrom, () => world.addSession(main, { sessionId: world.scoped('ses-dana-web') }));
  world.replay(dana, danaFrom, danaTurns(), 2 * MINUTE);
}
