/**
 * The vision pages in a real browser against the mock API: a city permits office, a team Desk, a
 * returning visitor signed in with a Claude account, and the app on a phone. Each says it is vision
 * under the vision bar, with the way back to the owner's Desk; each is static, so it asks the API
 * for nothing; and each is drawn as its signed board draws it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import { VISION_LINE } from '../ds/index.ts';
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
