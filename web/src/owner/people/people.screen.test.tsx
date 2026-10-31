/**
 * Customers, the share kit and the setup's live step in a real browser against the mock API: the
 * people on record with their contacts masked, the leads with recorded ones tagged, a person's own
 * rules read only, and the Desk's public link with its QR card and ready-made words.
 */
import { describe, expect, it } from 'vitest';

import { rivera } from '../../ds/fixtures/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectScreenBasics } from '../../test/screen.ts';

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

const SAM = { name: 'Sam Ortiz', note: 'Wants a quote to replace a kitchen faucet.', minutesAgo: 20 };
const JORDAN = { name: 'Jordan Pike', note: 'Asked about a gas line for an outdoor grill. Not on your price list.', minutesAgo: 60 * 26 };

/** An email address written out in full: no "•" standing in for its name. */
const UNMASKED_EMAIL = /[\w.+-]*[\w+-]@[\w-]+\.[\w.]+/g;

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
});
