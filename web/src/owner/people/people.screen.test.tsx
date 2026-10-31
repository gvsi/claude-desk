/**
 * Customers, the share kit and the setup's live step in a real browser against the mock API: the
 * people on record with their contacts masked, the leads with recorded ones tagged, a person's own
 * rules read only, and the Desk's public link with its QR card and ready-made words.
 */
import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';

import type { RuleCard } from '../../api/contracts.ts';
import type { RulesView, SetupState } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { copyResultLine } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { SETUP_QUESTIONS } from '../../mocks/setup.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { assertNoJargon, expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { SHARE_COPY, displayLink } from '../share/shareCopy.ts';

const DESK = `/app/${RIVERA.deskId}`;
const PEOPLE = `${DESK}/people`;
const LA = 'America/Los_Angeles';
/** The owner's line for a read the server failed. */
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';
const { bob, dana } = rivera.people;

interface LeadFields {
  name: string;
  note: string;
  /** How long ago they came in. */
  minutesAgo: number;
  replayed?: boolean;
}

/** Adds a lead to the mock's Desk, as the kernel keeps one. Returns when it came in. */
function addLead({ name, note, minutesAgo, replayed }: LeadFields): string {
  const createdAt = mockStore.world.now() - minutesAgo * MINUTE;
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

/** The QR code the share kit draws for `url`, as the image it shows. */
async function qrImage(url: string): Promise<string> {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
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
  const description = "Rivera Plumbing. I'm Maria, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters.";
  const started = await mockStore.dispatch('startSetup', { body: { description, timezone: LA } });
  if ('network' in started || started.status !== 200) throw new Error('the mock starts a setup');
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
});

describe('customers', () => {
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

    // The leads, newest first: each one's name, its note as they wrote it, and when it came in.
    const leads = screen.getByRole('list', { name: 'Leads' });
    await expect.element(screen.getByLabelText('2 leads')).toBeVisible();
    const rows = leads.getByRole('listitem').elements();
    const now = new Date();
    expect(rows.map((row) => [...row.querySelectorAll('[data-copy="user"]')].map((el) => el.textContent))).toEqual([
      [SAM.name, SAM.note],
      [JORDAN.name, JORDAN.note],
    ]);
    expect(rows[0]?.textContent).toContain(formatWhen(samAt, LA, now));
    expect(rows[1]?.textContent).toContain(formatWhen(jordanAt, LA, now));
    expect(formatWhen(samAt, LA, now)).toMatch(/, \d{1,2}:\d{2} (am|pm)$/);
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
    // Each section's head over a hairline; every row one height, tagged or not.
    for (const head of main.querySelectorAll('.cd-people__head')) {
      expect(getComputedStyle(head).borderBottomWidth).toBe('1px');
      expect(getComputedStyle(head).paddingBottom).toBe('8px');
    }
    const rows = [...main.querySelectorAll<HTMLElement>('.cd-people__rows > li')];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))).toEqual(new Set([51]));

    // The frame with Customers current, no card on the page, and Tab through each person on record,
    // then the caption: the leads link nowhere.
    const people = screen.getByRole('list', { name: 'Contacts on record' }).getByRole('link').elements() as HTMLElement[];
    const caption = screen.getByRole('link', { name: 'Includes recorded history' }).element() as HTMLElement;
    expect(screen.getByRole('list', { name: 'Leads' }).getByRole('link').elements()).toEqual([]);
    await expectOwnerBoard(screen.container, { current: 'Customers', cards: false, tabStops: [...people, caption] });
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
    // While the list is on its way: the loading line under a hairline, where the list goes.
    mockStore.inject({ route: 'people', status: 200, delayMs: 300, body: { people: [], leads: [] } });
    const slow = await renderRoute(PEOPLE, { pollScale: 100 });
    const loading = slow.screen.getByRole('status').filter({ hasText: /^Loading your customers$/ });
    await expect.element(loading).toBeVisible();
    await expect.element(slow.screen.getByText('No customers yet', { exact: true })).toBeVisible();
    expect(loading.query()).toBeNull();

    // A read that fails (and its one retry): what went wrong and a way to read it again, no list.
    mockStore.inject({ route: 'people', status: 503, times: 2 });
    const { screen } = await renderRoute(PEOPLE, { pollScale: 100 });
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
      `Book a visit ${DANA_BOOK.reason} ${dana.name} · Saturdays, 9:00 am to 1:00 pm Automatic`,
      `Share a document ${DANA_DOCS.reason} ${dana.name} · Verified Automatic`,
      `Payment link ${DANA_LINK.reason} ${dana.name} · Up to $300 Automatic up to $300; over $300, ask me first`,
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

  it('person_page_states_name_a_next_step', async () => {
    // Someone outside this copy's list: what happened and the way back, nothing of anyone's.
    const { screen, router } = await renderRoute(`${PEOPLE}/per-someone-else`);
    await expect.element(screen.getByText("This customer isn't in your copy", { exact: true })).toBeVisible();
    expect(screen.getByRole('region').query()).toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
    await screen.getByRole('link', { name: 'Go to Customers' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(PEOPLE);

    // While the list is on its way, the loading line; while the rules are, theirs. The list, still
    // polling, goes first, and a read it sent late reaches nothing, so it can't take the answers
    // meant for the page.
    await cleanup();
    mockStore.nextEpoch();
    mockStore.inject({ route: 'people', status: 200, delayMs: 300, body: (await mockStore.dispatch('people', { params: { desk_id: RIVERA.deskId } }) as { body: unknown }).body });
    mockStore.inject({ route: 'rules', status: 503, times: 2 });
    const slow = (await renderRoute(`${PEOPLE}/${dana.personId}`, { pollScale: 100 })).screen;
    await expect.element(slow.getByRole('status').filter({ hasText: /^Loading this customer$/ })).toBeVisible();
    // The rules can't be read: her contact still shows, and the rules say what went wrong.
    await expect.element(slow.getByRole('region', { name: 'Contact on record' })).toBeVisible();
    await expect.element(slow.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    expect(slow.getByRole('region', { name: `Rules for ${dana.name}` }).query()).toBeNull();
    await slow.getByRole('button', { name: 'Try again' }).click();
    await expect.element(slow.getByRole('region', { name: `Rules for ${dana.name}` })).toBeVisible();

    // A failed read of the list: what went wrong and Try again, no one's contact.
    mockStore.inject({ route: 'people', status: 503, times: 2 });
    const failed = (await renderRoute(`${PEOPLE}/${dana.personId}`, { pollScale: 100 })).screen;
    await expect.element(failed.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    expect(failed.getByText(dana.maskedContact).query()).toBeNull();
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect.element(failed.getByRole('heading', { level: 1, name: dana.name })).toBeVisible();
  });
});

describe('share', () => {
  it('share_page_uses_the_desk_slug', async () => {
    const { screen } = await renderRoute(`${DESK}/share`);
    const url = `${window.location.origin}/d/${RIVERA.slug}`;
    const business = rivera.business.name;
    const owner = rivera.business.ownerName;

    await expect.element(screen.getByRole('heading', { level: 1, name: 'Share' })).toBeVisible();
    await expect.element(screen.getByText('Put your Desk where customers already look for you.', { exact: true })).toBeVisible();

    // The Desk's own public link, from its slug: copied whole, and opened in a new tab.
    const link = screen.getByRole('region', { name: 'Your link' });
    await expect.element(link.getByText(url, { exact: true })).toBeVisible();
    const open = link.getByRole('link', { name: /^Open/ });
    const words = screen.getByRole('list', { name: 'Ready-made words' });
    await expect.element(screen.getByRole('img', { name: `QR code for ${url}` })).toBeVisible();

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

    // The printable card: the business, the QR code for the link, the link as people type it, and
    // who answers there.
    const card = screen.getByRole('figure', { name: business });
    const qr = card.getByRole('img', { name: `QR code for ${url}` });
    await expect.element(qr).toBeVisible();
    await expect.element(qr).toHaveAttribute('src', await qrImage(url));
    await expect.element(card.getByText(displayLink(url), { exact: true })).toBeVisible();
    await expect.element(card.getByText(`Answered by Claude, an AI. Ask for ${owner} any time.`, { exact: true })).toBeVisible();

    // The ready-made words, each with its Copy, which copies its words.
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Ready-made words' })).toBeVisible();
    const blocks = SHARE_COPY(business, owner, url);
    expect(words.getByRole('listitem').elements().map((row) => row.querySelector('.cd-copy-list__words')?.textContent)).toEqual(blocks.map((b) => b.text));
    await words.getByRole('button', { name: 'Copy Voicemail' }).click();
    expect(writeText).toHaveBeenLastCalledWith(blocks[2]?.text);

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

  it('share_kit_on_the_live_step', async () => {
    const state = await setupAtPreview();
    const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
    await screen.getByRole('button', { name: 'Go live' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rivera Plumbing is live' })).toBeVisible();
    const url = `${window.location.origin}/d/${state.slug}`;

    // Under the link and Go to Today, the share kit as Share has it, with no second link card: the
    // printable card with the QR code for the API's public link, the ready-made words, and the
    // website embed coming later.
    const heading = screen.getByRole('heading', { level: 2, name: 'Share it' });
    await expect.element(heading).toBeVisible();
    const card = screen.getByRole('figure', { name: 'Rivera Plumbing' });
    await expect.element(card.getByRole('img', { name: `QR code for ${url}` })).toBeVisible();
    await expect.element(card.getByText(displayLink(url), { exact: true })).toBeVisible();
    await expect.element(card.getByText(`Answered by Claude, an AI. Ask for ${rivera.business.ownerName} any time.`, { exact: true })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Ready-made words' }).getByRole('listitem').elements()).toHaveLength(3);
    await expect.element(screen.getByText('Coming later', { exact: true })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Your link' }).query()).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy link' }).elements()).toHaveLength(1);
    const today = screen.getByRole('link', { name: 'Go to Today' }).element();
    expect(today.compareDocumentPosition(heading.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // "Copy link" writes the API's public link.
    const writeText = stubClipboard();
    await screen.getByRole('button', { name: 'Copy link' }).click();
    expect(writeText).toHaveBeenCalledWith(url);
    await expectScreenBasics(screen.container, { owner: true });
  });
});

describe('customers and share, everywhere', () => {
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
