/**
 * Customers, the share kit and the setup's live step in a real browser against the mock API: the
 * people on record with their contacts masked, the leads with recorded ones tagged, a person's own
 * rules read only, and the Desk's public link with its QR card and ready-made words.
 */
import { http, HttpResponse } from 'msw';
import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';

import type { RuleCard } from '../../api/contracts.ts';
import { newIdempotencyKey } from '../../api/http.ts';
import type { RulesView, SetupState } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { copyResultLine } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { worker } from '../../mocks/browser.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { SETUP_QUESTIONS } from '../../mocks/setup.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE } from '../../mocks/world.ts';
import { SPEC, expectTabOrder, footerLink } from '../../ds/boards/spec.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { holdReads } from '../../test/holdReads.ts';
import { liveSetupDeskIds } from '../../test/liveSetupDesk.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { assertNoJargon, expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { SHARE_COPY, displayLink } from '../share/shareCopy.ts';

const DESK = `/app/${RIVERA.deskId}`;
const PEOPLE = `${DESK}/people`;
const LA = 'America/Los_Angeles';
/** The owner's line for a read the server failed. */
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';
const { bob, dana } = rivera.people;

/** The one instant the Customers tests run at: Friday, October 30, 12:30 pm in Los Angeles. */
const NOW = Date.parse('2026-10-30T19:30:00Z');

/**
 * Holds the page's clock at `NOW` (moving on from there, so reads and polls still happen), the
 * same instant the leads are dated from, so "Today" and every time read the same on every run.
 */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
}

/** A request the test lets land when it chooses. */
function held(): { until: Promise<void>; release: () => void } {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  return { until, release };
}

interface LeadFields {
  name: string;
  note: string | null;
  /** How long ago they came in. */
  minutesAgo: number;
  replayed?: boolean;
}

/** Adds a lead to the mock's Desk, as the kernel keeps one, dated from `NOW`. Returns when it came in. */
function addLead({ name, note, minutesAgo, replayed }: LeadFields): string {
  const createdAt = NOW - minutesAgo * MINUTE;
  mockStore.world.leads.push({
    leadId: `lead-${mockStore.world.leads.length + 1}`,
    deskId: RIVERA.deskId,
    sessionId: `ses-lead-${mockStore.world.leads.length + 1}`,
    displayName: name,
    note,
    createdAt,
    ...(replayed === undefined ? {} : { replayed }),
  });
  return new Date(createdAt).toISOString();
}

/** The rules as the mock reads them now, with `cards` added to the active version, answering every read from here on. */
async function withCards(cards: RuleCard[]): Promise<void> {
  const answer = await mockStore.dispatch('rules', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads the rules');
  const view = answer.body as RulesView;
  mockStore.inject({ route: 'rules', status: 200, times: 10_000, body: { ...view, active: { ...view.active, cards: [...view.active.cards, ...cards] } } });
}

const CARD = { agent_key_id: null, max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, is_default: false } as const;

/** Dana's own rules (N-Run2-People-Person), a payment link of hers up to $300, and one for Bob. */
const DANA_BOOK: RuleCard = {
  ...CARD,
  card_id: 'card-dana-book',
  applies_to: 'native.book',
  mode: 'auto',
  who: 'person',
  person_id: dana.personId,
  hours: { days: ['sat'], start: '09:00', end: '13:00' },
  reason: 'Dana can book Saturday morning visits.',
};
const DANA_DOCS: RuleCard = {
  ...CARD,
  card_id: 'card-dana-docs',
  applies_to: 'native.release_document',
  mode: 'auto',
  who: 'person',
  person_id: dana.personId,
  reason: "Dana gets her own invoices and warranties after confirming it's her.",
};
const DANA_LINK: RuleCard = {
  ...CARD,
  card_id: 'card-dana-link',
  applies_to: 'native.payment_link',
  mode: 'auto',
  who: 'person',
  person_id: dana.personId,
  max_amount_cents: 30_000,
  reason: 'Dana can get a payment link for her quote.',
};
const BOB_REFUND: RuleCard = { ...CARD, card_id: 'card-bob-refund', applies_to: 'payments.create_refund', mode: 'never', who: 'person', person_id: bob.personId, reason: 'No refunds for Bob.' };

const SAM = { name: 'Sam Ortiz', note: 'Wants a quote to replace a kitchen faucet.', minutesAgo: 20 };
const JORDAN = { name: 'Jordan Pike', note: 'Asked about a gas line for an outdoor grill. Not on your price list.', minutesAgo: 60 * 26 };

/** An email address written out in full: no "•" standing in for its name. */
const UNMASKED_EMAIL = /[\w.+-]*[\w+-]@[\w-]+\.[\w.]+/g;

/** The Desk's rules read, as the owner app makes it. */
const RULES_READ = '/api/owner/desks/:deskId/rules';

/** The voicemail's words as Share shows them, or null before they show. */
function voicemailIn(root: HTMLElement): string | null {
  return [...root.querySelectorAll('.cd-copy-list__words')].find((words) => words.textContent?.startsWith('You’ve reached'))?.textContent ?? null;
}

/** The sentence a voicemail says only with an urgent callback tool on. */
const EMERGENCY = 'For an emergency, leave a message';

/** Turns Turner's urgent callback tool on or off on the Desk, as the owner would elsewhere. */
function riverasUrgentTool(status: 'enabled' | 'disabled'): void {
  const desk = mockStore.world.desk(RIVERA.deskId);
  if (!desk) throw new Error('the mock has the main Desk');
  desk.tools = desk.tools.map((row) => (row.tool === 'desk.emergency-callback' ? { ...row, status, review_reason: null } : row));
}

/** Turner's business and owner, as the share kit names them. */
const RIVERA_BUSINESS = rivera.business.name;
const RIVERA_OWNER = rivera.business.ownerName;

/**
 * The QR code the share kit draws for `url`, as the image it shows: as the signed board draws it
 * (N-Live-REV-QR-B), dark modules #1c1b19 on the light #eae6dc of its sand tile, with a quiet zone
 * of one module.
 */
async function qrImage(url: string): Promise<string> {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1c1b19', light: '#eae6dc' } });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Puts a clipboard in the browser that records what it was given. */
function stubClipboard() {
  const writeText = vi.fn(async (_: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

/** A setup interview made through the mock, its rules confirmed, at the owner's preview before going live. */
async function setupAtPreview(): Promise<SetupState> {
  const description = "Turner Plumbing. I'm Mike, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters.";
  const started = await mockStore.dispatch('startSetup', { body: { description, timezone: LA, idempotency_key: newIdempotencyKey() } });
  // A new interview answers 201, as the API's does.
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS) await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text: 'Yes, that works.' } });
  for (const key of ['setupRules', 'setupSituations', 'setupSafetyCheck', 'setupConfirm'] as const) {
    const answer = await mockStore.dispatch(key, { params });
    if ('network' in answer || answer.status !== 200) throw new Error(`the mock answers ${key}`);
  }
  return state;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('customers', () => {
  beforeEach(freezeClock);

  it('people_lists_contacts_and_leads', async () => {
    const samAt = addLead(SAM);
    const jordanAt = addLead(JORDAN);
    const { screen } = await renderRoute(PEOPLE);

    // Titled with the people label the sidebar shows, and what the page is for.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    await expect
      .element(screen.getByText('Leads and customers on this Desk. Verified means a code reached their contact on record.', { exact: true }))
      .toBeVisible();

    // The people on record by name, each with the contact on record as the API masked it, and a
    // link to their page.
    const contacts = screen.getByRole('list', { name: 'Contacts on record' });
    await expect.element(contacts).toBeVisible();
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Contacts on record' })).toBeVisible();
    await expect.element(screen.getByLabelText('2 contacts on record')).toBeVisible();
    const people = contacts.getByRole('listitem').elements();
    expect(people.map((row) => row.querySelector('[data-copy="user"]')?.textContent)).toEqual([bob.name, dana.name]);
    expect(people.map((row) => row.textContent)).toEqual([
      `${bob.name}Contact on record: ${bob.maskedContact}`,
      `${dana.name}Contact on record: ${dana.maskedContact}`,
    ]);
    expect(people.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual([`${PEOPLE}/${bob.personId}`, `${PEOPLE}/${dana.personId}`]);

    // No contact written out in full anywhere on the page: each one is masked.
    const page = screen.getByRole('main').element().textContent ?? '';
    expect(page.match(UNMASKED_EMAIL) ?? []).toEqual([]);
    expect(page).toContain(bob.maskedContact);

    // The leads, newest first: each one's name, when it came in, and its note as they wrote it, bare,
    // as the design system's LeadRow sets it: the section's heading says they are leads, so no
    // "Lead ·" before it (N-Run2-People-Phone).
    const leads = screen.getByRole('list', { name: 'Leads' });
    await expect.element(screen.getByLabelText('2 leads')).toBeVisible();
    const rows = leads.getByRole('listitem').elements();
    expect(rows.map((row) => [...row.querySelectorAll('[data-copy="user"]')].map((el) => el.textContent))).toEqual([
      [SAM.name, SAM.note],
      [JORDAN.name, JORDAN.note],
    ]);
    expect(rows.map((row) => row.querySelector('.cd-lead-row__note')?.textContent)).toEqual([SAM.note, JORDAN.note]);
    expect(leads.element().textContent).not.toContain('Lead ·');
    // On the business's clock: 20 minutes and 26 hours before 12:30 pm on October 30.
    expect(rows.map((row) => row.querySelector('.cd-lead-row__time')?.textContent)).toEqual(['Today, 12:10 pm', 'Oct 29, 10:30 am']);
    expect([formatWhen(samAt, LA, new Date(NOW)), formatWhen(jordanAt, LA, new Date(NOW))]).toEqual(['Today, 12:10 pm', 'Oct 29, 10:30 am']);
    // Live leads: no Recorded tag, and no caption about recorded history.
    expect(screen.container.querySelector('.cd-recorded-tag')).toBeNull();
    expect(screen.getByRole('link', { name: 'Includes recorded history' }).query()).toBeNull();

    await expectScreenBasics(screen.container, { owner: true });
  });

  it('recorded_leads_are_tagged', async () => {
    addLead(SAM);
    addLead({ ...JORDAN, replayed: true });
    const { screen, router } = await renderRoute(PEOPLE);

    const leads = screen.getByRole('list', { name: 'Leads' });
    await expect.element(leads).toBeVisible();
    const [live, recorded] = leads.getByRole('listitem').elements() as [HTMLElement, HTMLElement];
    // "Recorded" on the replayed lead only, at the end of its second line, under its time.
    expect(live.querySelector('.cd-recorded-tag')).toBeNull();
    const tag = recorded.querySelector('.cd-recorded-tag');
    expect(tag?.textContent).toBe('Recorded');
    const note = recorded.querySelector('.cd-lead-row__note');
    const time = recorded.querySelector('.cd-lead-row__time');
    expect(Math.round(tag?.getBoundingClientRect().right ?? 0)).toBe(Math.round(time?.getBoundingClientRect().right ?? -1));
    expect(tag?.getBoundingClientRect().top).toBe(note?.getBoundingClientRect().top);

    // Under the Leads header, the caption that links to the record, where each replayed entry says so.
    const section = screen.getByRole('region', { name: 'Leads' });
    const caption = section.getByRole('link', { name: 'Includes recorded history' });
    await expect.element(caption).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    const header = section.element().querySelector('.cd-section-header');
    const line = caption.element().closest('p');
    expect(Math.round((line?.getBoundingClientRect().top ?? 0) - (header?.getBoundingClientRect().bottom ?? 0))).toBe(4);
    expect(screen.getByRole('region', { name: 'Contacts on record' }).getByRole('link', { name: 'Includes recorded history' }).query()).toBeNull();
    await expectScreenBasics(screen.container, { owner: true });

    // It opens the record's every-entry view in the app.
    await caption.click();
    await expect.poll(() => `${router.state.location.pathname}${router.state.location.search}`).toBe(`${DESK}/safety?view=entries`);

    // With none replayed, neither the tag nor the caption.
    mockStore.world.leads.forEach((lead) => {
      lead.replayed = false;
    });
    const again = await renderRoute(PEOPLE);
    await expect.element(again.screen.getByRole('list', { name: 'Leads' })).toBeVisible();
    expect(again.screen.container.querySelector('.cd-recorded-tag')).toBeNull();
    expect(again.screen.getByRole('link', { name: 'Includes recorded history' }).query()).toBeNull();
  });

  it('leads_newest_first', async () => {
    // The list comes oldest first, as the mock keeps them; the page puts the newest first.
    addLead({ name: 'Ana Reyes', note: JORDAN.note, minutesAgo: 60 * 24 * 4 });
    addLead(JORDAN);
    addLead(SAM);
    const { screen } = await renderRoute(PEOPLE);
    const leads = screen.getByRole('list', { name: 'Leads' });
    await expect.element(leads.getByText('Ana Reyes', { exact: true })).toBeVisible();
    expect(leads.getByRole('listitem').elements().map((row) => row.querySelector('.cd-lead-row__name')?.textContent)).toEqual([SAM.name, JORDAN.name, 'Ana Reyes']);
  });

  it('lead_without_a_note_is_one_line', async () => {
    // A lead who left only their name: the name and the time, and no empty line under them.
    addLead({ name: 'Lee Park', note: null, minutesAgo: 5 });
    addLead(SAM);
    const { screen } = await renderRoute(PEOPLE);
    const leads = screen.getByRole('list', { name: 'Leads' });
    await expect.element(leads.getByText('Lee Park', { exact: true })).toBeVisible();
    const [lee, sam] = leads.getByRole('listitem').elements() as [HTMLElement, HTMLElement];
    expect(lee.textContent).toBe('Lee ParkToday, 12:25 pm');
    const note = lee.querySelector('.cd-lead-row__note');
    expect(note === null || note.getBoundingClientRect().height === 0).toBe(true);
    expect(lee.getBoundingClientRect().height).toBeLessThan(sam.getBoundingClientRect().height);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('people_match_their_board', async () => {
    addLead(SAM);
    addLead({ ...JORDAN, replayed: true });
    addLead({ name: 'Ana Reyes', note: JORDAN.note, minutesAgo: 60 * 24 * 4, replayed: true });
    const { screen } = await renderRoute(PEOPLE);
    await expect.element(screen.getByRole('list', { name: 'Leads' })).toBeVisible();

    // The 760 px column of N-History-People, centered in the page.
    const main = screen.getByRole('main').element();
    const column = main.querySelector('.cd-people');
    const content = main.querySelector('.cd-app-shell__content');
    expect(column?.getBoundingClientRect().width).toBe(760);
    expect(Math.round((column?.getBoundingClientRect().left ?? 0) - (content?.getBoundingClientRect().left ?? 0))).toBe(
      Math.round((content?.getBoundingClientRect().right ?? 0) - (column?.getBoundingClientRect().right ?? 0)),
    );
    // The concept footer in the same column, as the board draws it.
    const footer = screen.container.querySelector('[data-ds="concept-footer"]')?.getBoundingClientRect();
    expect(Math.round(footer?.left ?? 0)).toBe(Math.round(column?.getBoundingClientRect().left ?? -1));
    expect(footer?.right ?? Infinity).toBeLessThanOrEqual(column?.getBoundingClientRect().right ?? 0);

    // Each section's head over a hairline; every row one height, tagged or not.
    for (const head of main.querySelectorAll('.cd-people__head')) {
      expect(getComputedStyle(head).borderBottomWidth).toBe('1px');
      expect(getComputedStyle(head).paddingBottom).toBe('8px');
    }
    const rows = [...main.querySelectorAll<HTMLElement>('.cd-people__rows > li')];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))).toEqual(new Set([51]));

    // The frame with Customers current and no card on the page. Tab, once past the sidebar, stops at
    // each person's row (a link to their page), then the recorded-history link, and nowhere else: a
    // lead is a static row, since the list gives it no conversation or page to open.
    const people = screen.getByRole('list', { name: 'Contacts on record' }).getByRole('link').elements() as HTMLElement[];
    const caption = screen.getByRole('link', { name: 'Includes recorded history' }).element() as HTMLElement;
    expect(people).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Leads' }).getByRole('link').elements()).toEqual([]);
    await expectOwnerBoard(screen.container, { current: 'Customers', cards: false });
    const reached = await expectTabOrder(userEvent, [...people, caption]);
    expect(reached.filter((stop) => main.contains(stop))).toEqual([...people, caption, footerLink(screen.container)]);
  });

  it('empty_people_is_kind', async () => {
    mockStore.inject({ route: 'people', status: 200, times: 10_000, body: { people: [], leads: [] } });
    const { screen } = await renderRoute(PEOPLE);

    // N-Run2-People-Empty: the header, a hairline, then what will show up here and the next step.
    await expect.element(screen.getByText('No customers yet', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('When someone shares their details or verifies, they show up here.', { exact: true })).toBeVisible();
    const open = screen.getByRole('link', { name: /^Open your public page/ });
    await expect.element(open).toHaveAttribute('href', `/d/${RIVERA.slug}?preview=${RIVERA.deskId}`);
    await expect.element(open).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('list', { name: 'Contacts on record' }).query()).toBeNull();
    expect(screen.getByRole('list', { name: 'Leads' }).query()).toBeNull();
    const below = screen.container.querySelector('.cd-people__below');
    expect(below && getComputedStyle(below).borderTopWidth).toBe('1px');
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('people_loading_then_failure_offers_a_retry', async () => {
    // While the list is on its way: the list's shapes under the header, where the list goes, and
    // the loading words in a visually hidden status, until the test lets the answer land.
    const list = held();
    mockStore.inject({ route: 'people', status: 200, until: list.until, body: { people: [], leads: [] } });
    const slow = await renderRoute(PEOPLE, { pollScale: 100 });
    const loading = slow.screen.getByRole('status').filter({ hasText: /^Loading your customers$/ });
    await expect.element(loading).toBeInTheDocument();
    await expect.element(slow.screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    expect(loading.element().classList.contains('cd-sr-only')).toBe(true);
    const region = loading.element().closest('.cd-people__region');
    expect(region?.querySelector('.cd-skeleton-screen__body')?.getAttribute('aria-busy')).toBe('true');
    expect(region?.querySelector('.cd-skeleton-screen__layer [data-skeleton-anchor="person-row-0"]')).not.toBeNull();
    expect(slow.screen.getByText('No customers yet', { exact: true }).query()).toBeNull();
    list.release();
    await expect.element(slow.screen.getByText('No customers yet', { exact: true })).toBeVisible();
    expect(loading.query()).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();

    // A read that fails (and its one retry, at once): what went wrong and a way to read it again, no list.
    mockStore.inject({ route: 'people', status: 503, times: 2 });
    const { screen } = await renderRoute(PEOPLE, { pollScale: 100, retryScale: 0 });
    await expect.element(screen.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    expect(screen.getByRole('list').query()).toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
    await screen.getByRole('button', { name: 'Try again' }).click();
    await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
    expect(screen.getByText(UNAVAILABLE, { exact: true }).query()).toBeNull();
  });

  it('person_rules_from_cards', async () => {
    await withCards([DANA_BOOK, DANA_DOCS, DANA_LINK, BOB_REFUND]);
    const { screen, router } = await renderRoute(PEOPLE);

    // From the list, a person's page: the way back to Customers, and their name as its title.
    await screen.getByRole('link', { name: new RegExp(`^${dana.name}`) }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${PEOPLE}/${dana.personId}`);
    await expect.element(screen.getByRole('heading', { level: 1, name: dana.name })).toBeVisible();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await expect.element(crumbs.getByRole('link', { name: 'Customers' })).toHaveAttribute('href', PEOPLE);

    // The contact on record as the API masked it, and that codes go only there.
    const contact = screen.getByRole('region', { name: 'Contact on record' });
    await expect.element(contact.getByText(dana.maskedContact, { exact: true })).toBeVisible();
    await expect.element(contact.getByText('Codes go only to this contact. A number typed in a chat never replaces it.', { exact: true })).toBeVisible();

    // Her rules, from the active cards for her alone, in card order: what each is on, its reason,
    // what it enforces in the rules' words and its outcome, read only, with the way to change them.
    const rules = screen.getByRole('region', { name: `Rules for ${dana.name}` });
    await expect.element(rules).toBeVisible();
    const rows = rules.getByRole('listitem').elements();
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      `Book a visit ${DANA_BOOK.reason} ${dana.name} · Saturdays, 9:00 am to 1:00 pm Allow`,
      `Share a document ${DANA_DOCS.reason} ${dana.name} · Verified Allow`,
      `Payment link ${DANA_LINK.reason} ${dana.name} · Up to $300 Allow`,
    ]);
    expect(rules.getByRole('button').elements()).toEqual([]);
    await expect.element(rules.getByRole('link', { name: 'Change them on Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    await expectScreenBasics(screen.container, { owner: true });

    // Bob's page lists only his.
    const bobs = (await renderRoute(`${PEOPLE}/${bob.personId}`)).screen;
    const his = bobs.getByRole('region', { name: `Rules for ${bob.name}` });
    await expect.element(his.getByText(BOB_REFUND.reason, { exact: true })).toBeVisible();
    expect(his.getByRole('listitem').elements()).toHaveLength(1);

    // On a fresh copy, with no rule just for him, it says so and still offers the way to Rules.
    const fresh = (await renderRoute(`${PEOPLE}/${bob.personId}`, { seed: 'rivera' })).screen;
    const none = fresh.getByRole('region', { name: `Rules for ${bob.name}` });
    await expect.element(none.getByText(`No rules just for ${bob.name}.`, { exact: true })).toBeVisible();
    expect(none.getByRole('listitem').elements()).toEqual([]);
    await expect.element(none.getByRole('link', { name: 'Change them on Rules' })).toBeVisible();
  });

  it('person_page_names_the_tab', async () => {
    // Their name, as the page's title; while the list is on its way, the page they are under.
    document.title = 'Claude Desk';
    const list = held();
    const answer = await mockStore.dispatch('people', { params: { desk_id: RIVERA.deskId } });
    mockStore.inject({ route: 'people', status: 200, until: list.until, body: (answer as { body: unknown }).body });
    const { screen, router } = await renderRoute(`${PEOPLE}/${dana.personId}`, { pollScale: 100 });
    await expect.element(screen.getByRole('status').filter({ hasText: /^Loading this customer$/ })).toBeVisible();
    expect(document.title).toBe('Customers · Claude Desk');
    list.release();
    await expect.element(screen.getByRole('heading', { level: 1, name: dana.name })).toBeVisible();
    expect(document.title).toBe(`${dana.name} · Claude Desk`);

    // Back to the list by the breadcrumb, then to someone else's page from it.
    await screen.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Customers' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    expect(document.title).toBe('Customers · Claude Desk');
    await screen.getByRole('link', { name: new RegExp(`^${bob.name}`) }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: bob.name })).toBeVisible();
    expect(document.title).toBe(`${bob.name} · Claude Desk`);

    // Someone outside the copy: the not-found screen, under the app's own name. (React reports the
    // page's error on the console, as it does for any page that hands one to its route.)
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await router.navigate(`${PEOPLE}/per-someone-else`);
    await expect.element(screen.getByRole('main', { name: "This page doesn't exist" })).toBeVisible();
    expect(document.title).toBe('Claude Desk');
  });

  it('person_page_states_name_a_next_step', async () => {
    // Someone outside this copy's list: the app's not-found screen in place of the owner frame, as
    // for a Desk outside the copy, with its way back, no retry and nothing of anyone's. (React
    // reports the page's error on the console, as it does for any page that hands one to its route.)
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { screen } = await renderRoute(`${PEOPLE}/per-someone-else`);
    await expect.element(screen.getByRole('main', { name: "This page doesn't exist" })).toBeVisible();
    await expect.element(screen.getByText('Check the link, or start again from the home page.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'start again from the home page' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('complementary', { name: 'Claude Desk' }).query()).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' }).query()).toBeNull();
    expect(screen.getByText(dana.maskedContact).query()).toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
    reported.mockRestore();

    // While the list is on its way, the loading line; while the rules are, theirs. The list, still
    // polling, goes first, and a read it sent late reaches nothing, so it can't take the answers
    // meant for the page.
    await cleanup();
    mockStore.nextEpoch();
    const list = held();
    mockStore.inject({ route: 'people', status: 200, until: list.until, body: (await mockStore.dispatch('people', { params: { desk_id: RIVERA.deskId } }) as { body: unknown }).body });
    mockStore.inject({ route: 'rules', status: 503, times: 2 });
    const slow = (await renderRoute(`${PEOPLE}/${dana.personId}`, { pollScale: 100, retryScale: 0 })).screen;
    await expect.element(slow.getByRole('status').filter({ hasText: /^Loading this customer$/ })).toBeVisible();
    expect(slow.getByRole('region', { name: 'Contact on record' }).query()).toBeNull();
    list.release();
    // The rules can't be read: her contact still shows, and the rules say what went wrong.
    await expect.element(slow.getByRole('region', { name: 'Contact on record' })).toBeVisible();
    await expect.element(slow.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    expect(slow.getByRole('region', { name: `Rules for ${dana.name}` }).query()).toBeNull();
    await slow.getByRole('button', { name: 'Try again' }).click();
    await expect.element(slow.getByRole('region', { name: `Rules for ${dana.name}` })).toBeVisible();

    // A failed read of the list: what went wrong and Try again, no one's contact.
    mockStore.inject({ route: 'people', status: 503, times: 2 });
    const failed = (await renderRoute(`${PEOPLE}/${dana.personId}`, { pollScale: 100, retryScale: 0 })).screen;
    await expect.element(failed.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    expect(failed.getByText(dana.maskedContact).query()).toBeNull();
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect.element(failed.getByRole('heading', { level: 1, name: dana.name })).toBeVisible();
  });
});

describe('a person outside the list', () => {
  it('person_page_does_not_reuse_a_read_started_before_leaving', async () => {
    const stale = { people: [{ person_id: bob.personId, display_name: bob.name, masked_contact: bob.maskedContact }], leads: [] };
    mockStore.inject({ route: 'people', status: 200, body: stale });
    const { screen, router } = await renderRoute(PEOPLE);
    await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();

    const old = held();
    const before = mockStore.requests.filter((r) => r.key === 'people').length;
    mockStore.inject({ route: 'people', status: 200, body: stale, until: old.until });
    await expect.poll(() => mockStore.requests.filter((r) => r.key === 'people').length).toBeGreaterThan(before);
    await router.navigate(`${DESK}/share`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Share', exact: true })).toBeVisible();

    const now = held();
    const answer = await mockStore.dispatch('people', { params: { desk_id: RIVERA.deskId } });
    mockStore.inject({ route: 'people', status: 200, until: now.until, body: (answer as { body: unknown }).body });
    await router.navigate(`${PEOPLE}/${dana.personId}`);
    await expect.element(screen.getByRole('status').filter({ hasText: /^Loading this customer$/ })).toBeVisible();
    old.release();
    now.release();
    await expect.element(screen.getByRole('heading', { level: 1, name: dana.name })).toBeVisible();
    expect(screen.getByText("This page doesn't exist").query()).toBeNull();
  });

  it('person_page_reads_the_list_again_before_not_found', async () => {
    // Customers read the list before Dana was on it.
    mockStore.inject({ route: 'people', status: 200, body: { people: [{ person_id: bob.personId, display_name: bob.name, masked_contact: bob.maskedContact }], leads: [] } });
    const { screen, router } = await renderRoute(PEOPLE, { pollScale: 100 });
    await expect.element(screen.getByRole('list', { name: 'Contacts on record' })).toBeVisible();
    expect(screen.getByText(dana.name).query()).toBeNull();

    // Her page, opened from that older list: it reads the list again and waits for that read
    // before it decides she isn't in the copy, and the fresh read has her.
    const now = held();
    const answer = await mockStore.dispatch('people', { params: { desk_id: RIVERA.deskId } });
    mockStore.inject({ route: 'people', status: 200, until: now.until, body: (answer as { body: unknown }).body });
    await router.navigate(`${PEOPLE}/${dana.personId}`);
    await expect.element(screen.getByRole('status').filter({ hasText: /^Loading this customer$/ })).toBeVisible();
    expect(screen.getByText("This page doesn't exist").query()).toBeNull();
    now.release();
    await expect.element(screen.getByRole('heading', { level: 1, name: dana.name })).toBeVisible();
    expect(screen.getByText("This page doesn't exist").query()).toBeNull();
  });
});

describe('share', () => {
  it('more_channels_matches_the_signed_section_on_desktop_and_phone', async () => {
    const channels = [
      ['Website embed', 'The same chat on your own site.'],
      ['WhatsApp', 'Customers message your Desk from WhatsApp.'],
      ['iMessage', 'The same chat in Messages on iPhone.'],
      ['Phone calls', 'Your Desk answers your business line by voice.'],
    ];
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(`${DESK}/share`, { viewport });
      const section = screen.getByRole('region', { name: 'More channels' });
      await expect.element(section).toBeVisible();
      const heading = section.getByRole('heading', { level: 2, name: 'More channels' }).element();
      expect(heading.classList).toContain('cd-share-kit__heading');
      const cards = section.element().querySelectorAll('.cd-card');
      expect(cards).toHaveLength(1);
      const card = cards[0] as HTMLElement;
      expect(getComputedStyle(card).padding).toBe('0px');
      const words = screen.getByRole('list', { name: 'Ready-made words' }).element();
      expect(Math.round(heading.getBoundingClientRect().top - words.getBoundingClientRect().bottom)).toBe(8);
      expect(Math.round(card.getBoundingClientRect().top - heading.getBoundingClientRect().bottom)).toBe(12);
      const rows = section.getByRole('listitem').elements();
      expect(rows.map((row) => [row.querySelector('.cd-share-kit__later-title')?.textContent, row.querySelector('.cd-share-kit__later-line')?.textContent, row.querySelector('.cd-pill')?.textContent])).toEqual(
        channels.map(([name, line]) => [name, line, 'Coming later']),
      );
      for (const [index, row] of rows.entries()) {
        const style = getComputedStyle(row);
        expect(style.padding).toBe('16px');
        expect(style.borderTopWidth).toBe(index === 0 ? '0px' : '1px');
        if (index > 0) expect(style.borderTopColor).toBe('rgba(250, 249, 245, 0.12)');
        expect(row.querySelector('button, a, input, [tabindex]')).toBeNull();
        for (const text of row.querySelectorAll('p, .cd-pill')) {
          expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
        }
        const pill = row.querySelector('.cd-pill')!.getBoundingClientRect();
        const text = row.querySelector('.cd-share-kit__later-text')!.getBoundingClientRect();
        expect(pill.left).toBeGreaterThanOrEqual(text.right);
      }
      expectNoHorizontalScroll();
    }
  });

  it('share_page_uses_the_desk_slug', async () => {
    const { screen } = await renderRoute(`${DESK}/share`);
    const url = `${window.location.origin}/d/${RIVERA.slug}`;
    const business = rivera.business.name;
    const owner = rivera.business.ownerName;

    await expect.element(screen.getByRole('heading', { level: 1, name: 'Share' })).toBeVisible();
    await expect.element(screen.getByText('Put your Desk where customers already look for you.', { exact: true })).toBeVisible();

    // The Desk's own public link, from its slug, as the board writes it: plainly, as people type it,
    // with Copy link the page's one primary button. It is copied whole, and opens in a new tab.
    const link = screen.getByRole('region', { name: 'Your link' });
    const shown = link.getByText(displayLink(url), { exact: true });
    await expect.element(shown).toBeVisible();
    expectComputed(shown.element() as HTMLElement, { fontSize: '15px', fontWeight: '520' });
    expect(link.element().querySelector('[data-copy="code"]')).toBeNull();
    expectComputed(link.getByRole('button', { name: 'Copy link' }).element() as HTMLElement, SPEC.primary);
    const open = link.getByRole('link', { name: /^Open/ });
    const words = screen.getByRole('list', { name: 'Ready-made words' });
    await expect.element(screen.getByRole('img', { name: `QR code for ${url}` })).toBeVisible();

    // The link card 24 px under the header, the printable card and the words 24 px under it, side by side.
    const header = screen.container.querySelector('.cd-page-header')?.getBoundingClientRect();
    const linkBox = link.element().getBoundingClientRect();
    const cardBox = screen.getByRole('figure').element().getBoundingClientRect();
    expect(Math.round(linkBox.top - (header?.bottom ?? 0))).toBe(24);
    expect(Math.round(cardBox.top - linkBox.bottom)).toBe(24);
    expect(Math.round(cardBox.width)).toBe(300);
    expect(Math.round(words.element().getBoundingClientRect().left - cardBox.right)).toBe(32);

    // The frame with Share current, its cards in the card look, and Tab through the link's two
    // buttons, Print card, then the words.
    await expectOwnerBoard(screen.container, {
      current: 'Share',
      tabStops: [
        link.getByRole('button', { name: 'Copy link' }).element() as HTMLElement,
        open.element() as HTMLElement,
        screen.getByRole('button', { name: 'Print card' }).element() as HTMLElement,
        words.getByRole('button', { name: 'Copy Google profile' }).element() as HTMLElement,
      ],
    });
    await expect.element(open).toHaveAttribute('href', url);
    await expect.element(open).toHaveAttribute('target', '_blank');
    const writeText = stubClipboard();
    await link.getByRole('button', { name: 'Copy link' }).click();
    await expect.element(link.getByText(copyResultLine('copied'), { exact: true })).toBeVisible();
    expect(writeText).toHaveBeenLastCalledWith(url);
    // A copy that didn't work selects the link as shown and says so.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    await link.getByRole('button', { name: 'Copy link' }).click();
    await expect.element(link.getByText(copyResultLine('failed', { what: 'link' }), { exact: true })).toBeVisible();
    expect(window.getSelection()?.toString()).toBe(displayLink(url));
    const copies = stubClipboard();

    // The printable card: the business, the QR code for the link, the link as people type it, and
    // who answers there.
    const card = screen.getByRole('figure', { name: business });
    const qr = card.getByRole('img', { name: `QR code for ${url}` });
    await expect.element(qr).toBeVisible();
    await expect.element(qr).toHaveAttribute('src', await qrImage(url));
    await expect.element(card.getByText(displayLink(url), { exact: true })).toBeVisible();
    await expect.element(card.getByText(`Answered by Claude, an AI. Ask for ${owner} any time.`, { exact: true })).toBeVisible();

    // The ready-made words, each with its Copy, which copies its words. Turner's urgent callback
    // tool is on, so once the Desk's tools are read the voicemail says Mike calls back about an
    // emergency.
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Ready-made words' })).toBeVisible();
    const blocks = SHARE_COPY(business, owner, url, { urgentCallback: true });
    await expect
      .poll(() => words.getByRole('listitem').elements().map((row) => row.querySelector('.cd-copy-list__words')?.textContent))
      .toEqual(blocks.map((b) => b.text));
    await words.getByRole('button', { name: 'Copy Voicemail' }).click();
    expect(copies).toHaveBeenLastCalledWith(blocks[2]?.text);

    // The website embed is coming later: no code to copy.
    const later = screen.getByText('Website embed', { exact: true }).element().closest('.cd-share-kit__later') as HTMLElement;
    expect(later.textContent).toBe('Website embedThe same chat on your own site.Coming later');
    expect(later.querySelector('button, code, a')).toBeNull();
    expect(screen.container.textContent).not.toMatch(/<script|embed\.js/);

    // Print card prints the card alone: only it is marked to print while the browser prints.
    let marked: string | null = null;
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      marked = document.documentElement.getAttribute('data-print-only');
      window.dispatchEvent(new Event('afterprint'));
    });
    await screen.getByRole('button', { name: 'Print card' }).click();
    expect(print).toHaveBeenCalledTimes(1);
    expect(marked).toBe('share-card');
    expect(document.documentElement.hasAttribute('data-print-only')).toBe(false);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('voicemail_promises_an_emergency_callback_only_with_an_urgent_callback_tool', async () => {
    const voicemail = voicemailIn;
    const rulesRead = () => mockStore.requests.filter((r) => r.key === 'rules').length;

    // A Desk Linda made in setup has no tool for urgent callbacks, only the callback every Desk has:
    // its voicemail stops after the link, before and after its tools are read.
    const linda = await liveSetupDeskIds("I'm Linda Chen. Chen & Co. keeps the books for small businesses in San Jose.");
    const lindasDesk = mockStore.world.desk(linda.deskId);
    if (!lindasDesk) throw new Error('setup made the Desk');
    expect(lindasDesk.tools.some((tool) => tool.tool === 'native.request_callback' && tool.status === 'enabled')).toBe(true);
    const lindaUrl = `${window.location.origin}/d/${linda.slug}`;
    const lindaWords = SHARE_COPY(lindasDesk.summary.business_name, 'Linda', lindaUrl, { urgentCallback: false })[2]?.text;
    expect(lindaWords).not.toContain('emergency');
    const ofLinda = await renderRoute(`/app/${linda.deskId}/share`);
    await expect.element(ofLinda.screen.getByRole('list', { name: 'Ready-made words' })).toBeVisible();
    expect(voicemail(ofLinda.screen.container)).toBe(lindaWords);
    await expect.poll(rulesRead).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(voicemail(ofLinda.screen.container)).toBe(lindaWords);
    await cleanup();

    // Turner's Desk, whose urgent callback tool the seed turns on as the kernel's does: the voicemail
    // word for word, emergency callback included, once its tools are read. Until then it is drawn
    // without that sentence, so it never draws a promise and takes it back.
    const rivera = mockStore.world.desk(RIVERA.deskId);
    if (!rivera) throw new Error('the mock has the main Desk');
    expect(rivera.tools.find((tool) => tool.tool === 'desk.emergency-callback')).toMatchObject({ source: 'business', status: 'enabled' });
    const held = holdReads('/api/owner/desks/:deskId/rules');
    const ofRivera = await renderRoute(`${DESK}/share`);
    const url = `${window.location.origin}/d/${RIVERA.slug}`;
    await expect.element(ofRivera.screen.getByRole('list', { name: 'Ready-made words' })).toBeVisible();
    await expect.poll(held.held).toBeGreaterThan(0);
    expect(voicemail(ofRivera.screen.container)).toBe(SHARE_COPY(RIVERA_BUSINESS, RIVERA_OWNER, url, { urgentCallback: false })[2]?.text);
    held.release();
    await expect.poll(() => voicemail(ofRivera.screen.container)).toBe(
      'You’ve reached Turner Plumbing. For quotes and bookings, visit ' +
        `${window.location.host} slash d slash ${RIVERA.slug}, where Claude, an AI, answers any time. For an emergency, leave a message and Mike Turner will call you back.`,
    );
  });

  it('a_cached_emergency_promise_waits_for_shares_own_read', async () => {
    // Rules read with Turner's urgent callback on, a read the app keeps; then the tool goes off
    // elsewhere. Share, in the same app, leaves the promise out while its own read is out, and
    // after it lands with the tool off.
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Your Desk’s jobs' })).toBeVisible();
    riverasUrgentTool('disabled');
    const held = holdReads(RULES_READ);
    const reads = mockStore.requests.filter((r) => r.key === 'rules').length;
    await router.navigate(`${DESK}/share`);
    await expect.element(screen.getByRole('list', { name: 'Ready-made words' })).toBeVisible();
    await expect.poll(held.held).toBeGreaterThan(0);
    expect(voicemailIn(screen.container)).not.toContain(EMERGENCY);
    held.release();
    await expect.poll(() => mockStore.requests.filter((r) => r.key === 'rules').length).toBeGreaterThan(reads);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const url = `${window.location.origin}/d/${RIVERA.slug}`;
    expect(voicemailIn(screen.container)).toBe(SHARE_COPY(RIVERA_BUSINESS, RIVERA_OWNER, url, { urgentCallback: false })[2]?.text);
  });

  it('a_rules_read_started_before_share_never_decides_the_promise', async () => {
    // Rules has read the rules. Its next read, started with the urgent tool still on, is held; the
    // tool goes off elsewhere and the owner opens Share, then that old answer arrives. Share never
    // promises the emergency callback: only its own read, made on Share, decides.
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Your Desk’s jobs' })).toBeVisible();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release());
    let old: unknown = null;
    worker.use(
      http.get(RULES_READ, async () => {
        if (old !== null) return undefined;
        // The answer as it was when this read started: the urgent tool on.
        const answer = await mockStore.dispatch('rules', { params: { desk_id: RIVERA.deskId } });
        if ('network' in answer) throw new Error('the mock reads the rules');
        old = answer.body;
        await released;
        return HttpResponse.json(old as RulesView, { status: answer.status });
      }),
    );
    // All rules reads the same rules as it opens, so a read is out as the owner moves on.
    await router.navigate(`${DESK}/rules/all`);
    await expect.poll(() => old).not.toBeNull();
    riverasUrgentTool('disabled');
    let promised = false;
    const watch = new MutationObserver(() => {
      if (voicemailIn(screen.container)?.includes(EMERGENCY)) promised = true;
    });
    watch.observe(screen.container, { childList: true, subtree: true, characterData: true });
    onTestFinished(() => watch.disconnect());
    await router.navigate(`${DESK}/share`);
    await expect.element(screen.getByRole('list', { name: 'Ready-made words' })).toBeVisible();
    release();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const url = `${window.location.origin}/d/${RIVERA.slug}`;
    expect(voicemailIn(screen.container)).toBe(SHARE_COPY(RIVERA_BUSINESS, RIVERA_OWNER, url, { urgentCallback: false })[2]?.text);
    expect(promised).toBe(false);
  });

  it('a_failed_read_leaves_the_cached_emergency_promise_out', async () => {
    // The same cached read with the tool on, but Share's own read fails, its retry too.
    const { screen, router } = await renderRoute(`${DESK}/rules`, { retryScale: 0 });
    await expect.element(screen.getByRole('region', { name: 'Your Desk’s jobs' })).toBeVisible();
    riverasUrgentTool('disabled');
    let failed = 0;
    worker.use(
      http.get(RULES_READ, () => {
        failed += 1;
        return HttpResponse.json({ detail: 'unavailable' }, { status: 503 });
      }),
    );
    await router.navigate(`${DESK}/share`);
    await expect.element(screen.getByRole('list', { name: 'Ready-made words' })).toBeVisible();
    expect(voicemailIn(screen.container)).not.toContain(EMERGENCY);
    await expect.poll(() => failed).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(voicemailIn(screen.container)).not.toContain(EMERGENCY);
  });

  it('a_fresh_read_with_the_urgent_tool_on_keeps_the_promise', async () => {
    // A cached read with the tool on, the tool still on: the promise only once Share's own read lands.
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Your Desk’s jobs' })).toBeVisible();
    const held = holdReads(RULES_READ);
    await router.navigate(`${DESK}/share`);
    await expect.element(screen.getByRole('list', { name: 'Ready-made words' })).toBeVisible();
    await expect.poll(held.held).toBeGreaterThan(0);
    expect(voicemailIn(screen.container)).not.toContain(EMERGENCY);
    held.release();
    const url = `${window.location.origin}/d/${RIVERA.slug}`;
    await expect.poll(() => voicemailIn(screen.container)).toBe(SHARE_COPY(RIVERA_BUSINESS, RIVERA_OWNER, url, { urgentCallback: true })[2]?.text);
  });

  it('the_qr_code_sits_on_a_sand_tile', async () => {
    // N-Live-REV-QR-B: the code on a 152 px sand tile, padded 12 px, at the card's radius, with an
    // inset hairline; the code itself 128 px inside it.
    const { screen } = await renderRoute(`${DESK}/share`);
    const url = `${window.location.origin}/d/${RIVERA.slug}`;
    const qr = screen.getByRole('figure').getByRole('img', { name: `QR code for ${url}` });
    await expect.element(qr).toBeVisible();
    const tile = qr.element().parentElement as HTMLElement;
    expect(tile.className).toBe('cd-share-card__qr');
    expectComputed(tile, {
      boxSizing: 'border-box',
      width: '152px',
      height: '152px',
      paddingTop: '12px',
      paddingRight: '12px',
      paddingBottom: '12px',
      paddingLeft: '12px',
      borderTopLeftRadius: '12px',
      borderBottomRightRadius: '12px',
      backgroundColor: 'rgb(234, 230, 220)',
      boxShadow: 'rgba(28, 27, 25, 0.13) 0px 0px 0px 1px inset',
    });
    const outer = tile.getBoundingClientRect();
    const inner = qr.element().getBoundingClientRect();
    expect([inner.width, inner.height, inner.left - outer.left, inner.top - outer.top]).toEqual([128, 128, 12, 12]);
    await expect.element(qr).toHaveAttribute('src', await qrImage(url));
  });

  it('print_card_prints_the_card_alone', async () => {
    const { screen } = await renderRoute(`${DESK}/share`);
    await expect.element(screen.getByRole('img', { name: /^QR code for/ })).toBeVisible();
    // Found now: hidden on paper, they leave the accessibility tree.
    const card = screen.getByRole('figure').element() as HTMLElement;
    const title = screen.getByRole('heading', { level: 1, name: 'Share' }).element();
    const printButton = screen.getByRole('button', { name: 'Print card' }).element();
    // On paper: about 720 px of printable width, with Print card's mark on the page.
    await page.viewport(720, 900);
    await cdp().send('Emulation.setEmulatedMedia', { media: 'print' });
    document.documentElement.setAttribute('data-print-only', 'share-card');
    try {
      // The card alone, at its own 300 px, centred, in dark ink on its light ground.
      const box = card.getBoundingClientRect();
      expect(Math.round(box.width)).toBe(300);
      expect(Math.round(box.left)).toBe(Math.round((document.documentElement.clientWidth - 300) / 2));
      // On paper the kit stops being a size container, so it can't hold the fixed card's place.
      expect(getComputedStyle(card.closest('.cd-share-kit') as HTMLElement).containerType).toBe('normal');
      // At the top of the page, and nothing over it: the card is what its centre hits.
      expect(Math.round(box.top)).toBe(0);
      const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      expect(centre !== null && card.contains(centre)).toBe(true);
      expect(getComputedStyle(card).visibility).toBe('visible');
      expect(getComputedStyle(card).backgroundColor).toBe('rgb(250, 249, 245)');
      expect(getComputedStyle(card).printColorAdjust).toBe('exact');
      // The QR code's sand tile prints as it shows, its colors exact too.
      const tile = card.querySelector('.cd-share-card__qr') as HTMLElement;
      expectComputed(tile, { backgroundColor: 'rgb(234, 230, 220)', boxShadow: 'rgba(28, 27, 25, 0.13) 0px 0px 0px 1px inset', printColorAdjust: 'exact', paddingTop: '12px' });
      expect(getComputedStyle(title).visibility).toBe('hidden');
      expect(getComputedStyle(printButton).visibility).toBe('hidden');
      // A white sheet, even with background graphics on: no dark page under the card.
      expect(getComputedStyle(document.documentElement).colorScheme).toBe('light');
      expect(getComputedStyle(document.body).backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(getComputedStyle(document.documentElement).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    } finally {
      document.documentElement.removeAttribute('data-print-only');
      await cdp().send('Emulation.setEmulatedMedia', { media: '' });
    }
    // Without the mark, printing the page leaves it as it is.
    await cdp().send('Emulation.setEmulatedMedia', { media: 'print' });
    expect(getComputedStyle(title).visibility).toBe('visible');
    await cdp().send('Emulation.setEmulatedMedia', { media: '' });
  });

  it('share_fits_between_a_phone_and_a_laptop', async () => {
    const { screen } = await renderRoute(`${DESK}/share`);
    await expect.element(screen.getByRole('img', { name: /^QR code for/ })).toBeVisible();
    // At 820 px the sidebar stays, so the kit stacks: nothing scrolls sideways, the page or its main area.
    await page.viewport(820, 1000);
    const main = screen.getByRole('main').element();
    await expect.poll(() => main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const card = screen.getByRole('figure').element().getBoundingClientRect();
    const words = screen.getByRole('list', { name: 'Ready-made words' }).element().getBoundingClientRect();
    expect(words.top).toBeGreaterThan(card.bottom);
    expect(Math.round(words.width)).toBeGreaterThan(300);
  });

  it('share_on_a_phone_keeps_its_board_gaps', async () => {
    const { screen } = await renderRoute(`${DESK}/share`, { viewport: 'phone' });
    await expect.element(screen.getByRole('img', { name: /^QR code for/ })).toBeVisible();
    // N-Run2-Share-Phone: 16 px between the header, the link card, the printable card and Print
    // card and the ready-made words; More channels follows 8 px under the words.
    const header = screen.container.querySelector('.cd-page-header')!.getBoundingClientRect();
    const link = screen.getByRole('region', { name: 'Your link' }).element().getBoundingClientRect();
    const card = screen.getByRole('figure').element().getBoundingClientRect();
    const print = screen.getByRole('button', { name: 'Print card' }).element().getBoundingClientRect();
    const heading = screen.getByRole('heading', { level: 2, name: 'Ready-made words' }).element().getBoundingClientRect();
    const words = screen.getByRole('list', { name: 'Ready-made words' }).element().getBoundingClientRect();
    const later = screen.getByRole('heading', { level: 2, name: 'More channels' }).element().getBoundingClientRect();
    expect([link.top - header.bottom, card.top - link.bottom, heading.top - print.bottom, later.top - words.bottom].map(Math.round)).toEqual([16, 16, 16, 8]);
  });
});

describe("setup's live step", () => {
  it('live_step_shares_the_apis_public_link', async () => {
    // The API names the public link on another address than this page's: the link and the "Share it"
    // card's QR code share that one, not one built from the slug here.
    const state = await setupAtPreview();
    const apiLink = `https://desk.example/d/${state.slug}`;
    mockStore.inject({ route: 'goLive', status: 200, afterCommit: true, body: { public_url: apiLink, slug: state.slug } });
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
    await screen.getByRole('button', { name: 'Go live' }).click();
    const card = screen.getByRole('region', { name: 'Share it' });
    await expect.element(card.getByRole('img', { name: `QR code for ${apiLink}` })).toBeVisible();
    await expect.element(screen.getByText(apiLink, { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain(`${window.location.host}/d/${state.slug}`);
    const writeText = stubClipboard();
    await screen.getByRole('button', { name: 'Copy link' }).click();
    expect(writeText).toHaveBeenCalledWith(apiLink);
  });
});

describe('customers and share, everywhere', () => {
  beforeEach(freezeClock);

  /** Each page of this task with what shows once it is drawn: the list with leads, a person's page with rules, and Share. */
  async function everyPage(): Promise<{ name: string; path: string; ready: string }[]> {
    addLead(SAM);
    addLead({ ...JORDAN, replayed: true });
    await withCards([DANA_BOOK, DANA_DOCS, DANA_LINK]);
    return [
      { name: 'customers', path: PEOPLE, ready: JORDAN.note },
      { name: 'person', path: `${PEOPLE}/${dana.personId}`, ready: DANA_DOCS.reason },
      { name: 'share', path: `${DESK}/share`, ready: 'Ready-made words' },
    ];
  }

  it('people_have_no_jargon', async () => {
    for (const { name, path, ready } of await everyPage()) {
      const { screen } = await renderRoute(path);
      await expect.element(screen.getByText(ready, { exact: true }).first()).toBeVisible();
      try {
        await expectScreenBasics(screen.container, { owner: true });
        assertNoJargon(screen.container);
      } catch (err) {
        throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  it('people_and_share_fit_a_phone', async () => {
    for (const { name, path, ready } of await everyPage()) {
      const { screen } = await renderRoute(path, { viewport: 'phone' });
      await expect.element(screen.getByText(ready, { exact: true }).first()).toBeVisible();
      expect(document.documentElement.scrollWidth, name).toBeLessThanOrEqual(window.innerWidth);
      expectNoHorizontalScroll();
      // Nothing in the page runs past its column.
      const content = screen.container.querySelector('.cd-app-shell__content')?.getBoundingClientRect();
      for (const el of screen.getByRole('main').element().querySelectorAll('*')) {
        expect(Math.round(el.getBoundingClientRect().right), `${name}: ${el.className}`).toBeLessThanOrEqual(Math.round(content?.right ?? 0));
      }
    }
  });
});
