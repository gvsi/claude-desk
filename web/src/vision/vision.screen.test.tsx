/**
 * The vision pages in a real browser against the mock API: a city permits office, a team Desk, a
 * returning visitor signed in with a Claude account, and the app on a phone. Each says it is vision
 * under the vision bar, with the way back to the owner's Desk; each is static, so it asks the API
 * for nothing; and each is drawn as its signed board draws it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import { SPEC, expectFooter, expectOwnerFrame, expectTabOrder, expectVisionBar, one, some } from '../ds/boards/spec.ts';
import { VISION_LINE } from '../ds/index.ts';
import { expectComputed } from '../ds/test/expectComputed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';

const CITY_OFFICE = '/vision/city-office';
const TEAM_DESK = '/vision/team-desk';
const CLAUDE_ACCOUNT = '/vision/claude-account';
const PHONE = '/vision/phone';
const VISION_ROUTES = [CITY_OFFICE, TEAM_DESK, CLAUDE_ACCOUNT, PHONE] as const;

/** Where "Back to your Desk" goes: the app's entry, which opens a returning owner's Today. */
const BACK_HREF = '/';

/**
 * Real places and offices the fictional city office must not name: Rivera's own service area,
 * the region around it, and a government site's domain.
 */
const REAL_PLACE = /\b(?:Oakland|Berkeley|Alameda|Emeryville|San Francisco|California|Bay Area)\b|\.gov\b/i;

/**
 * A fee, a date or a time, a permit's number or its status: what only a card may say. Claude's
 * words state none of them, nor the generic word "status" (the board story's own check).
 */
const FACT_IN_PROSE =
  /\$\s?\d|\d{1,2}:\d{2}|\b\d{1,2} de [a-z]+|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\bStatus\b|\bB-\d{4}-\d{4}\b|\bissued\b|\bpassed\b|\bapproved\b/i;

/** The same facts anywhere on the page outside a fact card, where labels may still say "status". */
const FACT_OUTSIDE_A_CARD =
  /\$\s?\d|\d{1,2}:\d{2}|\b\d{1,2} de [a-z]+|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\bB-\d{4}-\d{4}\b|\b(?:issued|passed|approved)\b/i;

/** Each fee, date and permit status the city office shows, as its cards write it. */
const CITY_FACTS = [
  'Plan check passed',
  'Kitchen remodel, permit B-2026-0412',
  'Fee due before issue: $1,286',
  'Cierra el 15 de diciembre, 5:00 pm',
  'Permit B-2026-0377',
  'Status: issued',
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function main(screen: RenderResult) {
  return screen.getByRole('main');
}

/** The page's text with every fact card taken out. */
function textOutsideFactCards(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const card of copy.querySelectorAll('.cd-fact-card')) card.remove();
  return copy.textContent ?? '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Vision pages', () => {
  it('vision_pages_are_labelled_and_offline', async () => {
    const fetches = vi.spyOn(window, 'fetch');
    for (const path of VISION_ROUTES) {
      const { screen } = await renderRoute(path);
      // The vision bar, word for word, with the way back to the owner's Desk.
      const bar = screen.getByRole('note', { name: 'Vision' });
      await expect.element(bar).toBeVisible();
      await expect.element(bar).toHaveTextContent(`Vision${VISION_LINE}Back to your Desk`);
      await expect.element(bar.getByRole('link', { name: 'Back to your Desk' })).toHaveAttribute('href', BACK_HREF);
      // Static: in a while on the page, nothing was asked of the API, or of anything else.
      await wait(300);
      expect(mockStore.requests, path).toEqual([]);
      expect(fetches, path).not.toHaveBeenCalled();
    }

    // The city office names no real place or office: Meridian Bay Permits is fictional.
    const { screen } = await renderRoute(CITY_OFFICE);
    const page = screen.container;
    await expect.element(main(screen).getByRole('region', { name: 'Live now' })).toBeVisible();
    expect(page.textContent).toContain('Meridian Bay Permits');
    expect(page.textContent).not.toMatch(REAL_PLACE);

    // Every fee, date and permit status is in a card, and none is in Claude's words.
    const live = main(screen).getByRole('region', { name: 'Live now' }).element();
    for (const fact of CITY_FACTS) {
      const shown = [...page.querySelectorAll<HTMLElement>('p, span, li')].filter((el) => el.textContent === fact);
      expect(shown, fact).toHaveLength(1);
      expect(shown[0]?.closest('.cd-fact-card'), `${fact} is in a card`).not.toBeNull();
    }
    const prose = [...live.querySelectorAll<HTMLElement>('.cd-claude-message__prose')];
    expect(prose).toHaveLength(4);
    for (const line of prose) expect(line.textContent ?? '', 'Claude’s words state no fee, date or status').not.toMatch(FACT_IN_PROSE);
    expect(textOutsideFactCards(page)).not.toMatch(FACT_OUTSIDE_A_CARD);
  });
});

describe('Vision pages against their boards', () => {
  it('city_office_matches_its_board', async () => {
    // As Boards/Vision, city office draws it, measured in the window the screens run in.
    const { screen } = await renderRoute(CITY_OFFICE);
    const live = main(screen).getByRole('region', { name: 'Live now' });
    await expect.element(live).toBeVisible();
    const root = screen.container;
    const bar = await expectVisionBar(root, BACK_HREF);
    await expectOwnerFrame(root, 'Today', { fill: true });
    const sidebar = screen.getByRole('complementary', { name: 'Claude Desk' });
    expect(top(sidebar.element())).toBe(bottom(bar));

    // The city's sidebar: its business, its people's word, its Answering line and its supervisor.
    await expect.element(sidebar.getByRole('button', { name: 'Switch business, current: Meridian Bay Permits' })).toBeVisible();
    await expect.element(sidebar.getByRole('link', { name: 'Residents' })).toBeVisible();
    await expect.element(sidebar.getByRole('switch', { name: 'Answering' })).toHaveAccessibleDescription('Claude answers under the City’s rules');
    await expect.element(sidebar.getByText('Permit Center supervisor')).toBeVisible();

    // The page padded 24 px 40 px from the sidebar's seam, the greeting at its top.
    const area = main(screen).element();
    const greeting = main(screen).getByRole('heading', { level: 1, name: 'Good morning, Nadia' }).element();
    expectComputed(greeting, SPEC.greeting);
    expect(round(greeting.getBoundingClientRect().left)).toBe(264 + 40);
    expect(round(top(greeting) - top(area))).toBe(24);
    await expect.element(main(screen).getByText('Nine residents are talking to the Desk right now.')).toBeVisible();
    await expect.element(main(screen).getByText('desk.example/meridian-bay-permits')).toBeVisible();

    // Live now: the four conversations, each with who, their level and what it is about.
    await expect.element(live.getByRole('link', { name: 'See all in Conversations' })).toBeVisible();
    const items = live.getByRole('listitem').elements();
    expect(items.map((item) => one(item, '[data-copy="user"]').textContent)).toEqual(['Marcus Bell', 'Visitor in Eastshore', 'Visitor', 'Joan Park']);
    expect(items.map((item) => one(item, '.cd-pill').textContent)).toEqual(['Verified', 'Public', 'Public', 'Verified']);
    expect(items.map((item) => one(item, '.cd-vision-live__head').lastElementChild?.textContent)).toEqual([
      'Permit status, 3 min',
      'Program deadline, in Spanish',
      'Asked about a neighbor’s permit',
      'Eligibility, waiting 4 min',
    ]);
    // Rows under hairlines, not cards: the only cards in Live now are the fact cards.
    const liveRegion = live.element();
    expect(liveRegion.querySelectorAll('.cd-card:not(.cd-fact-card .cd-card)')).toHaveLength(0);
    for (const item of items.slice(1)) expectComputed(item, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });

    // Claude's words in serif, word for word as ruled, each leading into its card.
    const prose = some(liveRegion, '.cd-claude-message__prose');
    for (const line of prose) expectComputed(line, SPEC.reply);
    expect(prose.map((line) => line.textContent)).toEqual([
      'Here’s where your kitchen remodel stands.',
      'Esta es la fecha límite del programa.',
      'Plans and applicant details go only to the applicant. Here’s what’s public.',
      'Whether your garage conversion is exempt is a plan checker’s decision. I’ve asked one to join.',
    ]);
    const facts = some(liveRegion, '.cd-fact-card');
    expect(facts.map((fact) => one(fact, '.cd-fact-card__label').textContent)).toEqual(['Permit status', 'Fecha límite', 'Public record']);
    expect(one(liveRegion, '.cd-fact-card[lang="es"]').textContent).toContain('Programa de refuerzo sísmico');
    // Each card 8 px under Claude's words.
    for (const fact of facts) expect(round(top(fact) - bottom(fact.previousElementSibling as HTMLElement))).toBe(8);

    // Each receipt under its conversation in its tone: handled, handled, refused, held for a person.
    const receipts = items.map((item) => one(item, '.cd-margin-line'));
    expect(receipts.map((receipt) => one(receipt, '.cd-status-dot').className.replace('cd-status-dot cd-status-dot--', ''))).toEqual([
      'handled',
      'handled',
      'refused',
      'held',
    ]);
    for (const receipt of receipts) expectComputed(receipt, SPEC.receipt);
    const assign = live.getByRole('listitem').nth(3).getByRole('button', { name: 'Assign staff' });

    // The right column: what can't be switched off, and today's numbers, 360 px wide, 32 px from Live now.
    const alwaysOn = main(screen).getByRole('region', { name: 'Always on' }).element();
    expect(round(alwaysOn.getBoundingClientRect().left - liveRegion.getBoundingClientRect().right)).toBe(32);
    expect(round(alwaysOn.getBoundingClientRect().width)).toBe(360);
    expectComputed(alwaysOn, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    expect([...alwaysOn.querySelectorAll('li')].map((item) => item.querySelector('.cd-type-control')?.textContent)).toEqual([
      'No legal or financial determinations without a qualified person',
      'Files only to the applicant',
      'No promised outcomes',
    ]);
    await expect.element(main(screen).getByText('Can’t be switched off', { exact: true })).toBeVisible();
    await expect
      .element(main(screen).getByText('Also always on: says it’s an AI, and logs every conversation for City records.', { exact: true }))
      .toBeVisible();
    expect(alwaysOn.querySelectorAll('button, input, a')).toHaveLength(0);
    const today = main(screen).getByRole('region', { name: 'Today so far' }).element();
    expect(round(top(today) - bottom(alwaysOn))).toBe(16);
    expect([...today.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '214 questions answered in 6 languages',
      '38 applicants verified for their own files',
      '7 handed to staff',
      '0 determinations made without a person',
    ]);
    await expectFooter(root);

    // focus_order_is_logical: the bar's link, the sidebar, then the page from the top.
    await expectTabOrder(userEvent, [
      bar.querySelector('a') as HTMLElement,
      sidebar.getByRole('button', { name: 'Switch business, current: Meridian Bay Permits' }).element() as HTMLElement,
      sidebar.getByRole('switch', { name: 'Answering' }).element() as HTMLElement,
      main(screen).getByRole('button', { name: 'Copy your Desk link' }).element() as HTMLElement,
      live.getByRole('link', { name: 'See all in Conversations' }).element() as HTMLElement,
      assign.element() as HTMLElement,
    ]);
  });
});

const round = Math.round;
const top = (el: Element) => el.getBoundingClientRect().top;
const bottom = (el: Element) => el.getBoundingClientRect().bottom;
