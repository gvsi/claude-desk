/**
 * Setup reads every rule card in Rules' words. For the Turner Plumbing and Chen & Co. Desks, Rules
 * and setup's Your rules, connector review, job review, real situations and the chat's job card draw
 * the same sentence for the same card, and the same line under it. Each check runs both screens on
 * the same tools and cards and reads what each one draws, as DOM text.
 */
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import type { HoursWindow, RuleCard } from '../api/contracts.ts';
import { newIdempotencyKey } from '../api/http.ts';
import type { ProposalCard as Proposal, RulesDraft, SetupState, SituationResult } from '../api/views.ts';
import { businessToolRows, seedBusinessTools } from '../mocks/businessTools.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import type { DeskRecord, ToolRecord } from '../mocks/world.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { START_EXAMPLES } from './copy.ts';
import { ProposalCard } from './ProposalCard.tsx';

/** What a Desk's rules are read from: its tools, its cards and its payment limit. */
interface Fixture {
  tools: ToolRecord[];
  cards: RuleCard[];
  cap: number;
}

/** The "A CPA firm in San Jose" example's description: Chen & Co. */
const CPA = START_EXAMPLES.en.examples.find(({ chip }) => chip === 'A CPA firm in San Jose')?.description ?? '';

/** Weekdays, 9 to 5: the hours the chat's job card reads. */
const HOURS: HoursWindow = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '17:00:00' };

const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Every tool on, so Rules and Your rules both list each one. */
const allOn = (tools: readonly ToolRecord[]): ToolRecord[] =>
  tools.map((tool) => ({ ...structuredClone(tool), status: 'enabled', review_reason: null, pending_sha256: null, pending_definition_text: null }));

function deskOf(state: SetupState): DeskRecord {
  const desk = mockStore.world.desk(state.desk_id);
  if (!desk) throw new Error('The mock made the setup Desk');
  return desk;
}

/** Turner Plumbing as its own Desk has it. */
function turner(): Fixture {
  const desk = mockStore.world.desk(RIVERA.deskId);
  if (!desk) throw new Error('The seed has Turner Plumbing');
  return { tools: allOn(desk.tools), cards: structuredClone(desk.policy.cards), cap: desk.policy.auto_money_cap_cents ?? 0 };
}

/**
 * Chen & Co.'s setup at Tools, the way the owner gets there: "Yes, use it", "Both, about evenly",
 * then "Use your suggestions", which accepts the chat's cards, makes its jobs and connects Stripe.
 */
async function chenAtTools(): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', { body: { description: CPA, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() } });
  if ('network' in started || started.status !== 201) throw new Error('The mock starts setup');
  const id = (started.body as SetupState).interview_id;
  const call = async (key: 'setupConsent' | 'setupAnswer' | 'setupSuggestions', body: unknown) => {
    const response = await mockStore.dispatch(key, { params: { id }, query: { cards: '1' }, body });
    if ('network' in response || response.status !== 200) throw new Error(`The mock takes ${key}`);
    return response.body as SetupState;
  };
  let state = await call('setupConsent', { allow: true });
  state = await call('setupAnswer', { question: state.question, text: 'Both, about evenly' });
  state = await call('setupSuggestions', {});
  if (state.step !== 'tools') throw new Error('Using the suggestions moves setup on to Tools');
  return state;
}

/** The interview's draft, made now, so a test can set its cards before the screen reads it. */
async function draftOf(state: SetupState): Promise<RulesDraft> {
  const drafted = await mockStore.dispatch('setupRules', { params: { id: state.interview_id } });
  if ('network' in drafted || drafted.status !== 200) throw new Error('The mock drafts setup rules');
  return drafted.body as RulesDraft;
}

/**
 * Chen & Co.'s Desk at Your rules: its tools, the draft's cards and the draft's limit. Its retainer
 * link is one of its jobs, as when the owner sets the retainer's amount in the chat.
 */
async function chen(): Promise<{ state: SetupState; fixture: Fixture }> {
  const state = await chenAtTools();
  const desk = deskOf(state);
  seedBusinessTools(desk, businessToolRows([{
    title: 'Send a retainer link',
    how: 'Clients you’ve priced get a secure link to pay a retainer before you start.',
    config: { block: 'purpose_payment', purpose: 'Engagement retainer', amount_cents: 50_000 },
  }], desk.tools.map(({ tool }) => tool)));
  const draft = await draftOf(state);
  return { state, fixture: { tools: allOn(deskOf(state).tools), cards: structuredClone(draft.cards), cap: draft.auto_money_cap_cents ?? 0 } };
}

/** One rule row as drawn: its sentence, and the line under it (who it is for, and its qualifiers). */
interface Drawn {
  sentence: string;
  line: string;
}

const drawn = (row: Element): Drawn => ({
  sentence: squash(row.querySelector('.cd-rule-sentence__sentence')?.textContent),
  line: squash(row.querySelector('.cd-house-rules__rule-line')?.textContent),
});

/**
 * Every rule row a tools view draws, with its words: "Across your Desk"'s, each money band's, each
 * tool's, a card's by its id and any other (an always-on rule, a money job's own) by its words, and
 * "Other tools"' rules that cover no tool on the page, by card.
 */
function drawnRules(root: Element): Map<string, Drawn> {
  const rows = new Map<string, Drawn>();
  const across = [...root.querySelectorAll('section')].find((section) => squash(section.querySelector('h2')?.textContent) === 'Across your Desk');
  for (const row of across?.querySelectorAll('.cd-house-rules__rule') ?? []) rows.set(`across|${drawn(row).sentence}`, drawn(row));
  for (const band of root.querySelectorAll<HTMLElement>('[data-money-band]')) {
    for (const row of band.querySelectorAll('.cd-house-rules__rule')) rows.set(`band:${band.dataset.moneyBand}|${drawn(row).sentence}`, drawn(row));
  }
  for (const tool of root.querySelectorAll<HTMLElement>('.cd-house-rules__tool[data-tool]')) {
    for (const row of tool.querySelectorAll<HTMLElement>('.cd-house-rules__rule')) {
      rows.set(`${tool.dataset.tool}|${row.dataset.ruleId ?? drawn(row).sentence}`, drawn(row));
    }
  }
  for (const row of root.querySelectorAll<HTMLElement>('.cd-house-rules__rules--loose > .cd-house-rules__rule')) {
    rows.set(`loose|${row.dataset.ruleId ?? drawn(row).sentence}`, drawn(row));
  }
  return rows;
}

/** The rule rows a tools view draws under one tool, by card. */
function toolRules(root: Element, tool: string): Map<string, Drawn> {
  const section = root.querySelector(`.cd-house-rules__tool[data-tool="${tool}"]`);
  return new Map([...section?.querySelectorAll<HTMLElement>('.cd-house-rules__rule[data-rule-id]') ?? []].map((row) => [row.dataset.ruleId!, drawn(row)]));
}

/** Who a rule is for: the first words of the line under it. */
const whoOf = (line: string) => line.split(' · ')[0] ?? '';

/** Rules on Turner's Desk, set to `fixture`, once its rows are drawn. */
async function rulesPage(fixture: Fixture): Promise<Element> {
  const desk = mockStore.world.desk(RIVERA.deskId);
  if (!desk) throw new Error('The seed has Turner Plumbing');
  desk.tools = structuredClone(fixture.tools);
  desk.policy = { ...desk.policy, cards: structuredClone(fixture.cards), auto_money_cap_cents: fixture.cap };
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/rules`);
  await expect.poll(() => screen.container.querySelectorAll('.cd-house-rules__tool [data-rule-id]').length).toBeGreaterThan(0);
  return screen.container;
}

/** Setup's Your rules for an interview at Tools whose Desk and draft are set to `fixture`. */
async function yourRules(state: SetupState, fixture: Fixture) {
  deskOf(state).tools = structuredClone(fixture.tools);
  const draft = await draftOf(state);
  const record = deskOf(state).drafts.get(draft.version);
  if (!record) throw new Error('The mock keeps the draft');
  record.draft = { ...record.draft, cards: structuredClone(fixture.cards), auto_money_cap_cents: fixture.cap };
  // Drafting the rules moves the interview on to them, so setup opens at Your rules.
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Your rules', exact: true })).toBeVisible();
  // The draft's own rows, once its shapes have gone.
  await expect.poll(() => screen.container.querySelector('.cd-skeleton-screen__layer') === null && screen.container.querySelectorAll('.cd-house-rules__tool [data-rule-id]').length > 0).toBe(true);
  return screen;
}

/** The rule lines an open review, or the chat's job card, draws: each one's tool, sentence and who. */
function boxRules(root: Element): { tool: string; sentence: string; who: string }[] {
  return [...root.querySelectorAll('.cd-rule-sentence')].map((rule) => {
    const meta = squash(rule.querySelector('.cd-rule-sentence__meta')?.textContent);
    return {
      tool: squash(rule.querySelector('.cd-rule-sentence__meta .cd-user-name')?.textContent),
      sentence: squash(rule.querySelector('.cd-rule-sentence__sentence')?.textContent),
      who: meta.slice(meta.lastIndexOf(' · ') + 3),
    };
  });
}

/** The rules box of the open review. */
const reviewBox = (root: Element) => root.querySelector('.cd-connector-review__rules') ?? root.ownerDocument.createElement('div');

/** Rules' tool section for a tool title, by its name in the section's heading. */
function toolByTitle(root: Element, title: string): string {
  const section = [...root.querySelectorAll<HTMLElement>('.cd-house-rules__tool[data-tool]')].find((tool) => squash(tool.querySelector('.cd-house-rules__tool-name')?.textContent) === title);
  if (!section?.dataset.tool) throw new Error(`Rules lists ${title}`);
  return section.dataset.tool;
}

/** Each review line reads as Rules reads the same tool: one of its rule sentences, for the same people. */
function expectReviewMatches(review: ReturnType<typeof boxRules>, page: Element): void {
  expect(review.length).toBeGreaterThan(0);
  for (const line of review) {
    const rules = [...toolRules(page, toolByTitle(page, line.tool)).values()];
    const same = rules.find((rule) => rule.sentence === line.sentence);
    expect(same, `${line.tool}: "${line.sentence}" is one of ${JSON.stringify(rules)}`).toBeDefined();
    expect(line.who, line.tool).toBe(whoOf(same?.line ?? ''));
  }
}

/** Payments and Stripe turned off: the draft's money rules that cover no tool left on sit under "Other tools". */
const paymentsOff = (fixture: Fixture): Fixture => ({
  ...fixture,
  tools: fixture.tools.map((tool) => (/^(payments\.|native\.(payment_link|charge_mandate)$)/.test(tool.tool) ? { ...tool, status: 'disabled' } : tool)),
});

it.each(['Turner Plumbing', 'Chen & Co.', 'Chen & Co. with the payment connectors off'] as const)('Your rules draws every rule of %s as Rules does', async (name) => {
  const at = name === 'Turner Plumbing' ? { state: await chenAtTools(), fixture: turner() } : await chen();
  const fixture = name === 'Chen & Co. with the payment connectors off' ? paymentsOff(at.fixture) : at.fixture;
  const rules = await rulesPage(fixture);
  const page = drawnRules(rules);
  // Every card Rules draws, by its id.
  const cards = [...page.keys()].filter((key) => fixture.cards.some((card) => key.endsWith(`|${card.card_id}`)));
  expect(cards.length).toBeGreaterThan(3);
  // Chen & Co.'s retainer link moves money: on both pages its list ends with its own money rules.
  const moneyJobs = fixture.tools.filter((tool) => tool.source === 'business' && tool.effects.some((effect) => effect === 'charge' || effect === 'pay_out'));
  expect(moneyJobs.length).toBe(name === 'Turner Plumbing' ? 0 : 1);
  for (const job of moneyJobs) {
    const cap = fixture.cap > 0 ? `Claude asks you before any payment over $${fixture.cap / 100}, whatever the other rules say` : 'Claude asks you before any payment';
    expect(page.get(`${job.tool}|${cap}`), job.tool).toEqual({ sentence: cap, line: '' });
    expect(page.get(`${job.tool}|Claude never moves money without your rule or a signed limit`), job.tool).toBeDefined();
    // Neither takes "Change" or Details: the limit changes from the Payments or Stripe band.
    const own = [...rules.querySelectorAll(`.cd-house-rules__tool[data-tool="${job.tool}"] .cd-house-rules__rule`)].slice(-2);
    for (const row of own) expect(row.querySelector('button'), job.tool).toBeNull();
  }
  // With the payment connectors off, rules that cover no tool left on are listed under "Other tools".
  const loose = [...page.keys()].filter((key) => key.startsWith('loose|'));
  expect(loose.length > 0).toBe(name === 'Chen & Co. with the payment connectors off');
  const screen = await yourRules(at.state, fixture);
  // Every row, in the same words, for the same people, on both pages.
  expect(drawnRules(screen.container)).toEqual(page);
});

it('the Stripe review reads each tool as Rules reads it, on Turner Plumbing and on Chen & Co.', async () => {
  for (const isChen of [false, true]) {
    const state = await chenAtTools();
    const desk = deskOf(state);
    if (!isChen) {
      const plumbing = turner();
      desk.policy = { ...desk.policy, cards: structuredClone(plumbing.cards), auto_money_cap_cents: plumbing.cap };
      desk.tools = plumbing.tools.map((tool) => (tool.tool.startsWith('payments.') ? { ...tool, status: 'needs_review', review_reason: 'new' } : tool));
    }
    const fixture: Fixture = { tools: allOn(desk.tools), cards: structuredClone(desk.policy.cards), cap: desk.policy.auto_money_cap_cents ?? 0 };
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
    await screen.getByRole('button', { name: 'Review Stripe', exact: true }).click();
    await expect.element(screen.getByRole('region', { name: 'The rules that will cover them' })).toBeVisible();
    const review = boxRules(reviewBox(screen.container));
    expect(review.map((line) => line.tool)).toEqual(['See charges', 'Refund']);
    expectReviewMatches(review, await rulesPage(fixture));
  }
});

it('a job review reads its job as Rules reads it, on Chen & Co.', async () => {
  const state = await chenAtTools();
  const desk = deskOf(state);
  const jobs = desk.tools.filter((tool) => tool.source === 'business' && tool.business?.title);
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) {
    job.status = 'needs_review';
    job.review_reason = 'new';
  }
  const fixture: Fixture = { tools: allOn(desk.tools), cards: structuredClone(desk.policy.cards), cap: desk.policy.auto_money_cap_cents ?? 0 };
  for (const job of jobs) {
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
    await screen.getByRole('region', { name: 'Your Desk’s jobs' }).getByRole('button', { name: `Review ${job.business!.title}`, exact: true }).click();
    await expect.element(screen.getByRole('region', { name: 'The rule that will cover it' })).toBeVisible();
    const review = boxRules(reviewBox(screen.container));
    expect(review.map((line) => line.tool)).toEqual([job.business!.title]);
    expectReviewMatches(review, await rulesPage(fixture));
  }
});

it('a real situation decided by a card reads that card as Rules does, and one with no card keeps the kernel’s words, on Chen & Co.', async () => {
  const { state, fixture } = await chen();
  const screen = await yourRules(state, fixture);
  await screen.getByRole('button', { name: 'Check real situations', exact: true }).click();
  const rows = screen.getByRole('list', { name: 'Real situations', exact: true }).getByRole('listitem');
  await expect.poll(() => rows.elements().length).toBe(6);
  const shown = new Map(rows.elements().map((row) => [
    squash(row.querySelector('.cd-situation-row__title')?.textContent),
    {
      sentence: squash(row.querySelector('.cd-situation-row__reason .cd-rule-sentence__sentence')?.textContent) || null,
      reason: squash(row.querySelector('.cd-situation-row__reason')?.textContent),
    },
  ]));
  const answered = await mockStore.dispatch('setupSituations', { params: { id: state.interview_id } });
  const results = (answered as { body: SituationResult[] }).body;
  const page = await rulesPage(fixture);
  const byCard = new Map([...page.querySelectorAll<HTMLElement>('.cd-house-rules__tool .cd-house-rules__rule[data-rule-id]')].map((row) => [row.dataset.ruleId!, drawn(row).sentence]));
  let compared = 0;
  for (const { situation, result } of results) {
    const row = shown.get(situation.title);
    expect(row, situation.title).toBeDefined();
    if (result.card_ids.length === 0) {
      expect(row!.sentence, situation.title).toBeNull();
      expect(row!.reason).toBe(result.reason_plain);
      continue;
    }
    const [only] = result.card_ids;
    if (result.card_ids.length !== 1 || !byCard.has(only!)) continue;
    expect(row!.sentence, situation.title).toBe(byCard.get(only!));
    compared += 1;
  }
  expect(compared).toBeGreaterThan(1);
});

it('the chat’s job card reads the rule a job starts under as Rules reads the same card, on Chen & Co.', async () => {
  const state = await chenAtTools();
  // The jobs setup made into the Desk's own tools (a retainer with no amount isn't one).
  const jobs = state.messages.flatMap(({ card }) => {
    const tool = deskOf(state).tools.find((row) => row.source === 'business' && row.business?.title === card?.job?.title);
    return card?.kind === 'job' && card.state !== 'changed' && card.job?.can_do_today && card.job.config && tool ? [{ card, tool }] : [];
  });
  expect(jobs.length).toBeGreaterThan(1);
  for (const { card, tool } of jobs) {
    const job = card.job!;
    const proposal: Proposal = { ...structuredClone(card), state: 'proposed' };
    const chat = await render(<ProposalCard proposal={proposal} hours={HOURS} live disabled={false} busyAction={null} failed={false} amountRequired={false} onRetry={() => {}} onDecision={() => {}} />);
    const box = chat.getByRole('group', { name: 'The rule it will start under', exact: true });
    await expect.element(box).toBeVisible();
    const [rule] = boxRules(box.element());
    await chat.unmount();
    // The same card as a rule on the Desk: the job's own tool, its autonomy, and the Desk's hours for a booking.
    const card_: RuleCard = {
      card_id: 'job-rule', applies_to: tool.tool, mode: job.autonomy, who: 'anyone', person_id: null, agent_key_id: null,
      max_amount_cents: null, max_discount_bp: 0, hours: job.job === 'schedule' ? HOURS : null, review: false, is_default: false, reason: '',
    };
    const page = await rulesPage({ tools: allOn(deskOf(state).tools), cards: [card_], cap: 0 });
    const onRules = toolRules(page, tool.tool).get('job-rule');
    expect(rule?.sentence, job.title).toBe(onRules?.sentence);
    expect(rule?.tool, job.title).toBe(job.title);
    expect(rule?.who, job.title).toBe(whoOf(onRules?.line ?? ''));
  }
});
