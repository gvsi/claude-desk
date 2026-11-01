/**
 * Setup's steps while their reads are out: each step keeps its real header and draws what it waits
 * for as its own shapes, then lands where the shapes were. A reload draws the header as shapes
 * until the interview is read, and hands off to the step's own shapes with no blank between.
 */
import { QueryClient } from '@tanstack/react-query';
import { http } from 'msw';
import { beforeAll, expect, it, onTestFinished, vi } from 'vitest';

import { newIdempotencyKey } from '../api/http.ts';
import { ROUTES } from '../api/routes.ts';
import type { SetupState } from '../api/views.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { worker } from '../mocks/browser.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { holdReads } from '../test/holdReads.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectScreenBasics } from '../test/screen.ts';
import { expectSkeletonLoad, expectSkeletonStill, SKELETON_TOLERANCE_PX, watchSkeletonGaps, type SkeletonAnchor } from '../test/skeleton.ts';

beforeAll(loadWebFonts);

const DESCRIPTION =
  "Turner Plumbing. I'm Mike, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters for homes and small shops. Weekdays mostly, emergencies on Saturday mornings.";

type Step = 'tools' | 'rules' | 'situations' | 'safety_check';

/** A new interview in the mock, its questions answered (the money limit as $500), moved on to `step`. */
async function interviewAt(step: Step): Promise<SetupState> {
  const started = await mockStore.dispatch('startSetup', {
    body: { description: DESCRIPTION, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() },
  });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS) {
    const text = question.key === 'money_limit' ? '$500 is fine. Anything bigger, ask me.' : 'Yes, that works.';
    await mockStore.dispatch('setupAnswer', { params, body: { question: question.key, text } });
  }
  if (step !== 'tools') await mockStore.dispatch('setupRules', { params });
  if (step === 'situations' || step === 'safety_check') await mockStore.dispatch('setupSituations', { params });
  if (step === 'safety_check') await mockStore.dispatch('setupSafetyCheck', { params });
  const current = await mockStore.dispatch('setup', { params });
  if ('network' in current || current.status !== 200) throw new Error('the mock reads the current setup');
  return current.body as SetupState;
}

/** Start from the loaded setup entry page, with this interview cached before its step mounts. */
async function loadedSetup(state: SetupState, viewport: Viewport = 'desktop') {
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  const { router } = await renderRoute('/app/setup', { viewport });
  const client = mounted.mock.contexts.at(-1) as QueryClient;
  mounted.mockRestore();
  client.setQueryData(['setup', state.interview_id], state);
  return () => router.navigate(`/app/setup/${state.interview_id}`);
}

/** Holds every post to `path` until the test lets them through to the mock, as `holdReads` does reads. */
function holdPosts(path: string): { held: () => number; release: () => void } {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  worker.use(
    http.post(path, async () => {
      waiting += 1;
      await released;
      return undefined;
    }),
  );
  return { held: () => waiting, release };
}

const path = (route: 'setup' | 'setupTools' | 'setupRules' | 'setupSituations' | 'setupSafetyCheck', state: SetupState) =>
  ROUTES[route].path.replace('{id}', state.interview_id);

/** The step's real title and, for the tools, "Continue": they stay real over the region and must not move. */
const TITLE = '.cd-page-header__title';
const MAIN_BUTTON = '.cd-setup-step__actions > .cd-button:first-child';

/** A part of a step: its shape's anchor, and a selector for the element it stands for on the page. */
interface Part {
  name: string;
  page: string;
}

interface StepLoad {
  status: string;
  /** The step's read the test holds, and how. */
  hold: (state: SetupState) => { held: () => number; release: () => void };
  /** Parts whose words are known: they land where their shapes were, within 2 px. */
  anchors: readonly SkeletonAnchor[];
  stays: readonly string[];
  /**
   * Parts whose words come with the read, drawn from estimates: every one of them, so that any move
   * under them is accounted for. Each may land at most one line taller or shorter than its shape.
   */
  estimated?: readonly Part[];
  /** Parts under estimated ones, which may move once as they land (decision 15): the last row in view and the main button. */
  moved?: (viewport: Viewport) => readonly Part[];
}

const TOOL_ROW = (card: number, row: number) => `.cd-setup-tools > .cd-card:nth-child(${card}) .cd-setup-tools__row:nth-child(${row})`;
/** A rule's row in the draft: the groups follow the payment limit's card, which is the first child. */
const GROUP_ROW = (child: number, row: number) => `.cd-outcome-groups > :nth-child(${child}) .cd-outcome-groups__row:nth-child(${row})`;
/** A situation's or a trick's row in its card. */
const RESULT_ROW = (row: number) => `.cd-setup-step__rows > li:nth-child(${row})`;
const MAIN_BUTTON_PART: Part = { name: 'main-button', page: MAIN_BUTTON };
/** The rows of a card of situations or tricks, as `prefix-0` and on. */
const resultRows = (prefix: string, rows: number): Part[] => Array.from({ length: rows }, (_, i) => ({ name: `${prefix}-${i}`, page: RESULT_ROW(i + 1) }));

/**
 * The most an estimated part may differ from its shape: one line of the words it holds (body and
 * control lines are 20 px, the tallest it uses). An estimate draws a fresh copy's own words at the
 * lines one platform's fonts give them; another platform's fonts wrap a part's words at most one line
 * differently (macOS and Linux differ by one line at most where they differ at all), so a part that
 * is off by more is drawn wrong, not wrapped differently.
 */
const ONE_LINE_PX = 20;

/** The line heights the estimated words are set in: caption, meta, and body or control. */
const LINE_HEIGHTS_PX = [17, 18, 20] as const;

/**
 * Each step's load. The tools' words are the app's own, so their shapes take the lines those words
 * take in this browser's fonts, and every row is compared whole. The rules, situations and tricks
 * come with the read: their shapes' lines are estimates, which can wrap differently on another
 * platform's fonts. What sits above the first of them is compared within 2 px, with that first row's
 * top, left and width but not its height, whose words aren't known. What sits under them may move
 * once as it lands, by exactly what the estimated parts above it differ by, and then stays
 * (`expectAcceptedMoves`).
 */
const STEPS: Readonly<Record<Step, StepLoad>> = {
  tools: {
    status: 'Reading your tools',
    hold: (state) => holdReads(path('setupTools', state)),
    anchors: [
      ...[1, 2, 3, 4, 5, 6].map((row) => ({ name: `tools-built-in-row-${row - 1}`, page: TOOL_ROW(1, row), size: true })),
      { name: 'tools-external-row-0', page: TOOL_ROW(2, 1), size: true },
    ],
    stays: [TITLE, MAIN_BUTTON],
  },
  rules: {
    status: 'Drafting your rules',
    hold: (state) => holdPosts(path('setupRules', state)),
    anchors: [
      { name: 'rules-money-limit', page: '.cd-outcome-groups > .cd-card:first-child', size: true },
      // The first rule's words come with the draft: its height is an estimate, checked below.
      { name: 'rules-auto-row-0', page: GROUP_ROW(2, 1), dimensions: ['width'] },
    ],
    stays: [TITLE],
    estimated: [
      ...Array.from({ length: 11 }, (_, i) => ({ name: `rules-auto-row-${i}`, page: GROUP_ROW(2, i + 1) })),
      ...Array.from({ length: 2 }, (_, i) => ({ name: `rules-ask-row-${i}`, page: GROUP_ROW(3, i + 1) })),
      { name: 'rules-never-row-0', page: GROUP_ROW(4, 1) },
      // Known words, but in boxes sized by their own words, so their lines are estimates too.
      { name: 'rules-always-on', page: '.cd-card:has(> .cd-always-on)' },
      { name: 'rules-checks', page: '.cd-setup-rules__checks' },
    ],
    // The last row in view: the first that asks at 1440, the ninth Claude does on its own at 390.
    moved: (viewport) => [
      viewport === 'desktop' ? { name: 'rules-ask-row-0', page: GROUP_ROW(3, 1) } : { name: 'rules-auto-row-8', page: GROUP_ROW(2, 9) },
      MAIN_BUTTON_PART,
    ],
  },
  situations: {
    status: 'Trying real situations on your draft rules',
    hold: (state) => holdPosts(path('setupSituations', state)),
    // The first situation's words come with the read: its height is an estimate, checked below.
    anchors: [{ name: 'situation-row-0', page: RESULT_ROW(1), dimensions: ['width'] }],
    stays: [TITLE],
    estimated: resultRows('situation-row', 6),
    // The last row in view: the sixth at 1440, the fourth at 390.
    moved: (viewport) => [{ name: `situation-row-${viewport === 'desktop' ? 5 : 3}`, page: RESULT_ROW(viewport === 'desktop' ? 6 : 4) }, MAIN_BUTTON_PART],
  },
  // Opened at the safety check, the first results are drawn still, so they land in place.
  safety_check: {
    status: 'Trying tricks people use on your draft rules',
    hold: (state) => holdPosts(path('setupSafetyCheck', state)),
    anchors: [
      { name: 'safety-count', page: '.cd-setup-safety__count', size: true },
      // The first trick's words come with the read: its height is an estimate, checked below.
      { name: 'trick-row-0', page: RESULT_ROW(1), dimensions: ['width'] },
    ],
    stays: [TITLE],
    estimated: resultRows('trick-row', 6),
    // The last row in view: the sixth at 1440, the fourth at 390.
    moved: (viewport) => [{ name: `trick-row-${viewport === 'desktop' ? 5 : 3}`, page: RESULT_ROW(viewport === 'desktop' ? 6 : 4) }, MAIN_BUTTON_PART],
  },
};

/** The page's element for `selector`, not a shape in a skeleton layer. */
function onPage(selector: string): Element | undefined {
  return [...document.querySelectorAll(selector)].find((element) => !element.closest('.cd-skeleton-screen__layer'));
}

/** Where a part was drawn and how big, in viewport px, and whether it was the page's element or its shape. */
interface Place {
  top: number;
  left: number;
  width: number;
  height: number;
  real: boolean;
}

/** The box's edges a place is told apart by: a part that moves or changes size takes a new place. */
const PLACE_EDGES = ['top', 'left', 'width', 'height'] as const;

/**
 * Every place each part is drawn at, read at every change and every frame from now until `stop`:
 * its shape while the shapes show, then the page's element from the moment it is drawn (while the
 * shapes fade over it) on. A place within 2 px of the one before, on every edge and in both
 * dimensions, is the same place. The shape's last box is kept, to compare the page's element with.
 */
function watchPlaces(parts: readonly Part[]) {
  const seen = parts.map(() => ({ shape: undefined as DOMRect | undefined, places: [] as Place[] }));
  const look = () => {
    parts.forEach((part, i) => {
      const record = seen[i]!;
      const element = onPage(part.page);
      let box: DOMRect;
      if (element) box = element.getBoundingClientRect();
      else {
        const shape = document.querySelector(`.cd-skeleton-screen__layer[data-state="shown"] [data-skeleton-anchor="${part.name}"]`);
        if (!shape) return;
        box = shape.getBoundingClientRect();
        record.shape = box;
      }
      const last = record.places.at(-1);
      const real = element !== undefined;
      const changed = !last || last.real !== real || PLACE_EDGES.some((edge) => Math.abs(box[edge] - last[edge]) > SKELETON_TOLERANCE_PX);
      if (changed) record.places.push({ top: box.top, left: box.left, width: box.width, height: box.height, real });
    });
  };
  const observer = new MutationObserver(look);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  let frame = 0;
  const tick = () => {
    look();
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  const stop = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
  onTestFinished(stop);
  return { seen, stop };
}

/** Waits `count` frames. */
async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Decision 15's accepted moves on a step whose words come with the read. Each estimated part lands
 * at most one line taller or shorter than its shape. Each part under them (the last row in view, the
 * main button) is drawn in one place while the shapes show and lands in one place, so it moves at
 * most once, in one direction, and doesn't move again; and it moves by exactly what the estimated
 * parts above it differ by, so the move is the words wrapping and nothing else. On a platform whose
 * fonts wrap the words as the estimate does, the move is zero.
 */
function expectAcceptedMoves(load: StepLoad, viewport: Viewport, watched: ReturnType<typeof watchPlaces>): void {
  const estimated = load.estimated ?? [];
  const moved = load.moved?.(viewport) ?? [];
  const records = new Map([...estimated, ...moved].map((part, i) => [part.name, watched.seen[i]!]));
  const shapeOf = (part: Part) => {
    const shape = records.get(part.name)?.shape;
    expect(shape, `${part.name} was drawn as a shape while the shapes showed`).toBeDefined();
    return shape!;
  };
  const pageOf = (part: Part) => {
    const element = onPage(part.page);
    expect(element, `${part.name} (${part.page}) is on the page`).toBeDefined();
    return element!.getBoundingClientRect();
  };
  const taller = new Map(estimated.map((part) => [part.name, pageOf(part).height - shapeOf(part).height]));
  for (const [name, difference] of taller) {
    expect(Math.abs(difference), `${name} lands ${difference} px off its shape's height: more than one line`).toBeLessThanOrEqual(ONE_LINE_PX + SKELETON_TOLERANCE_PX);
    // Every estimated row must change by wrapping, including rows above the last one in view.
    const wholeLine = [0, ...LINE_HEIGHTS_PX].some((line) => Math.abs(Math.abs(difference) - line) <= SKELETON_TOLERANCE_PX);
    expect(wholeLine, `${name} lands ${difference} px off its shape's height, which is not one whole line`).toBe(true);
  }
  for (const part of moved) {
    const places = records.get(part.name)!.places;
    const label = `${part.name}: ${JSON.stringify(places.map(({ top, height, real }) => `${real ? 'page' : 'shape'} ${Math.round(top)}+${Math.round(height)}`))}`;
    expect(places.filter(({ real }) => !real), `${label}: one place while the shapes show`).toHaveLength(1);
    expect(places.filter(({ real }) => real), `${label}: lands in one place and stays there`).toHaveLength(1);
    expect(places.at(-1)?.real, `${label}: the page's element comes after its shape`).toBe(true);
    const shape = shapeOf(part);
    const landed = pageOf(part);
    // Every estimated part that ends above this one moves it by its own difference in height.
    const above = estimated.filter((other) => other.name !== part.name && shapeOf(other).bottom <= shape.top + SKELETON_TOLERANCE_PX);
    const explained = above.reduce((sum, other) => sum + taller.get(other.name)!, 0);
    expect(Math.abs(landed.top - shape.top - explained), `${label}: moves ${landed.top - shape.top} px; the estimated parts above it differ by ${explained} px`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    expect(Math.abs(landed.left - shape.left), `${label}: lands at its shape's left`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    // A row's width comes from its column and the button's from its known label, never from the data.
    expect(Math.abs(landed.width - shape.width), `${label}: lands as wide as its shape`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    if (part.name === MAIN_BUTTON_PART.name) {
      expect(Math.abs(landed.height - shape.height), `${label}: lands as tall as its shape`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    }
  }
}

it('accepted_moves_reject_a_10_px_spacing_error_in_an_earlier_estimated_row', () => {
  const earlier: Part = { name: 'earlier-row', page: '#accepted-moves-earlier' };
  const last: Part = { name: 'last-row', page: '#accepted-moves-last' };
  const button: Part = { name: 'main-button', page: '#accepted-moves-button' };
  const fixture = document.createElement('div');
  fixture.style.width = '200px';
  fixture.innerHTML = `
    <div id="accepted-moves-earlier" style="height: 50px"></div>
    <div id="accepted-moves-last" style="height: 40px"></div>
    <div id="accepted-moves-button" style="height: 40px"></div>
  `;
  document.body.append(fixture);
  onTestFinished(() => fixture.remove());
  const parts = [earlier, last, last, button];
  const shapes = parts.map((part) => onPage(part.page)!.getBoundingClientRect());
  // Only the earlier shape has 10 px of extra space; no words wrap. Removing it shifts both
  // moved parts by exactly 10 px, so the summed-height and last-row checks alone accept it.
  fixture.querySelector<HTMLElement>(earlier.page)!.style.height = '40px';
  const watched: ReturnType<typeof watchPlaces> = {
    stop: () => {},
    seen: parts.map((part, i) => {
      const shape = shapes[i]!;
      const page = onPage(part.page)!.getBoundingClientRect();
      return {
        shape,
        places: [
          { top: shape.top, left: shape.left, width: shape.width, height: shape.height, real: false },
          { top: page.top, left: page.left, width: page.width, height: page.height, real: true },
        ],
      };
    }),
  };
  const load: StepLoad = { ...STEPS.situations, estimated: [earlier, last], moved: () => [last, button] };
  expect(() => expectAcceptedMoves(load, 'desktop', watched)).toThrow("earlier-row lands -10 px off its shape's height, which is not one whole line");
});

for (const viewport of ['desktop', 'phone'] as const) {
  for (const [step, load] of Object.entries(STEPS) as [Step, StepLoad][]) {
    it(`setup_steps_load_in_place: ${step} at ${viewport}`, async () => {
      const state = await interviewAt(step);
      const read = load.hold(state);
      const open = await loadedSetup(state, viewport);
      let watched!: ReturnType<typeof watchPlaces>;
      await expectSkeletonLoad({
        status: load.status,
        anchors: load.anchors,
        stays: load.stays,
        open: async () => {
          await open();
          await vi.waitFor(() => expect(read.held()).toBe(1));
          // Watch this step, after the entry page's own main button has left.
          watched = watchPlaces([...(load.estimated ?? []), ...(load.moved?.(viewport) ?? [])]);
        },
        release: read.release,
      });
      // Landed: the places keep being read for a while, so a later move would show as another place.
      await frames(10);
      watched.stop();
      expectAcceptedMoves(load, viewport, watched);
      await expectScreenBasics(document.body, { owner: true });
    });
  }
}

it('setup_reload_hands_off', async () => {
  // A reload at the tools: while the interview is read, the column draws a step's header as shapes;
  // then the real header lands and the tools list's own shapes carry on at once, with no frame
  // without shapes until the list lands. The page keeps one heading throughout: setup's name,
  // visually hidden, while the interview is read, then the step's own title.
  const state = await interviewAt('tools');
  const interview = holdReads(path('setup', state));
  const tools = holdReads(path('setupTools', state));
  const gaps = watchSkeletonGaps('.cd-setup-tools');
  let title: DOMRect | undefined;
  /** The page's headings at each commit from the interview's shapes on, with its region's layer state. */
  const headings: { layer: string; h1: string[] }[] = [];
  let watching: MutationObserver | undefined;
  onTestFinished(() => watching?.disconnect());
  await expectSkeletonLoad({
    status: 'Reading your tools',
    continues: true,
    anchors: STEPS.tools.anchors,
    stays: STEPS.tools.stays,
    open: async () => {
      await renderRoute(`/app/setup/${state.interview_id}`);
      await vi.waitFor(() => expect(interview.held()).toBe(1));
      const opening = await vi.waitFor(() => {
        const layer = document.querySelector<HTMLElement>('.cd-setup__column .cd-skeleton-screen__layer[data-state="shown"]');
        expect(layer, "the header's shapes show while the interview is read").not.toBeNull();
        return layer!;
      });
      expect(opening.closest('.cd-skeleton-screen')!.querySelector('[role="status"]')!.textContent).toBe('Opening your setup');
      title = opening.querySelector('[data-skeleton-anchor="page-title"]')!.getBoundingClientRect();
      // While the interview is read: one heading, setup's name, visually hidden in the page's main,
      // outside the hidden layer.
      const h1s = document.querySelectorAll('h1');
      expect(h1s).toHaveLength(1);
      expect(h1s[0]!.textContent).toBe('Set up your Desk');
      expect(h1s[0]!.classList.contains('cd-sr-only')).toBe(true);
      expect(h1s[0]!.closest('.cd-skeleton-screen__layer')).toBeNull();
      expect(h1s[0]!.closest('main')).not.toBeNull();
      const region = opening.closest('.cd-skeleton-screen')!;
      const record = () =>
        headings.push({
          layer: region.querySelector<HTMLElement>(':scope > .cd-skeleton-screen__body > .cd-skeleton-screen__layer')?.dataset.state ?? 'gone',
          h1: [...document.querySelectorAll('h1')].map((h1) => h1.textContent ?? ''),
        });
      record();
      watching = new MutationObserver(record);
      watching.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });
      interview.release();
      // The header lands real while the list keeps its shapes.
      await vi.waitFor(() => expect(tools.held()).toBe(1));
      await vi.waitFor(() => expect(document.querySelector('.cd-setup-step .cd-page-header__title')?.textContent).toBe('What Claude can use'));
    },
    release: tools.release,
  });
  const real = document.querySelector('.cd-setup-step .cd-page-header__title')!.getBoundingClientRect();
  expect(Math.abs(real.top - title!.top)).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
  expect(Math.abs(real.left - title!.left)).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
  expect(gaps()).toBe(0);
  // One heading at every commit: setup's name while the interview's shapes show, then the step's
  // title, already while those shapes fade over it, and after.
  watching!.disconnect();
  expect(headings.filter(({ h1 }) => h1.length !== 1), 'one h1 at every commit').toEqual([]);
  expect(headings.find(({ layer }) => layer === 'shown')?.h1).toEqual(['Set up your Desk']);
  expect(headings.find(({ layer }) => layer === 'leaving')?.h1).toEqual(['What Claude can use']);
  expect(headings.at(-1)).toEqual({ layer: 'gone', h1: ['What Claude can use'] });
  await expectScreenBasics(document.body, { owner: true });
});

for (const viewport of ['desktop', 'phone'] as const) {
  it(`setup_reload_at_the_questions_hands_off_into_the_chat: ${viewport}`, async () => {
    // A reload mid-interview: while the interview is read, the column draws a step's header as
    // shapes; then the conversation lands in its own frame, where the bar and the dock keep their
    // size and only the transcript scrolls. The shapes fade where they were, the title lands where
    // its shape was, and the dock sits at the window's foot.
    const started = await mockStore.dispatch('startSetup', {
      body: { description: DESCRIPTION, timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey() },
    });
    if ('network' in started || started.status !== 201) throw new Error('the mock starts a setup');
    const state = started.body as SetupState;
    const consented = await mockStore.dispatch('setupConsent', { params: { id: state.interview_id }, body: { allow: true } });
    if ('network' in consented || consented.status !== 200) throw new Error('the mock opens the questions');
    const interview = holdReads(path('setup', state));
    /** How far below the bar `element` is: the bar can grow when the business's name arrives. */
    const belowBar = (element: Element) =>
      element.getBoundingClientRect().top - document.querySelector('.cd-setup__bar')!.getBoundingClientRect().bottom;
    await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
    await vi.waitFor(() => expect(interview.held()).toBe(1));
    const shown = await vi.waitFor(() => {
      const layer = document.querySelector<HTMLElement>('.cd-setup__column .cd-skeleton-screen__layer[data-state="shown"]');
      expect(layer, "the header's shapes show while the interview is read").not.toBeNull();
      return layer!;
    });
    const shapeAnchor = shown.querySelector('[data-skeleton-anchor="page-title"]')!;
    const shape = { top: belowBar(shapeAnchor), left: shapeAnchor.getBoundingClientRect().left };
    /** The title's shape in the commit the conversation lands in, as the shapes start to fade. */
    let leaving: { top: number; left: number } | undefined;
    const watching = new MutationObserver(() => {
      const anchor = document.querySelector('.cd-skeleton-screen__layer[data-state="leaving"] [data-skeleton-anchor="page-title"]');
      if (anchor && leaving === undefined) leaving = { top: belowBar(anchor), left: anchor.getBoundingClientRect().left };
    });
    onTestFinished(() => watching.disconnect());
    watching.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    interview.release();
    await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
    watching.disconnect();

    expect(leaving, 'the shapes fade over the conversation').toBeDefined();
    expect(Math.abs(leaving!.top - shape.top), 'the shapes fade where they were (top)').toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    expect(Math.abs(leaving!.left - shape.left), 'the shapes fade where they were (left)').toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    // The title's place with the transcript at its top, wherever the transcript is pinned.
    const scroll = document.querySelector<HTMLElement>('.cd-setup-chat__scroll')!;
    const title = document.querySelector('.cd-setup-chat .cd-page-header__title')!;
    expect(Math.abs(belowBar(title) + scroll.scrollTop - shape.top), 'the title lands at its shape (top)').toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    expect(Math.abs(title.getBoundingClientRect().left - shape.left), 'the title lands at its shape (left)').toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    const dock = document.querySelector('.cd-setup-dock')!.getBoundingClientRect();
    expect(Math.abs(dock.bottom - window.innerHeight), "the dock sits at the window's foot").toBeLessThanOrEqual(1);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
    await expectScreenBasics(document.body, { owner: true });
  });
}

it('setup_tools_first_read_failure_clears_the_skeleton', async () => {
  const state = await interviewAt('tools');
  const tools = holdReads(path('setupTools', state));
  mockStore.inject({ route: 'setupTools', status: 503, times: 2 });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { retryScale: 0 });
  await vi.waitFor(() => expect(tools.held()).toBe(1));
  await vi.waitFor(() => expect(document.querySelector('.cd-setup-step .cd-skeleton-screen__layer')?.getAttribute('data-state')).toBe('shown'));

  tools.release();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy]')).toBeNull();
  await expect.element(screen.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setupTools')).toHaveLength(2);
});

it('setup_interview_first_read_failure_clears_the_skeleton', async () => {
  const state = await interviewAt('tools');
  const interview = holdReads(path('setup', state));
  const readsBefore = mockStore.requests.filter((r) => r.key === 'setup').length;
  mockStore.inject({ route: 'setup', status: 503, times: 2 });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { retryScale: 0 });
  await vi.waitFor(() => expect(interview.held()).toBe(1));
  await vi.waitFor(() => expect(document.querySelector('.cd-setup__column .cd-skeleton-screen__layer')?.getAttribute('data-state')).toBe('shown'));

  interview.release();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy]')).toBeNull();
  await expect.element(screen.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'setup')).toHaveLength(readsBefore + 2);
});

/** The safety check's count on the page, not its shape in a fading layer. */
const landedCount = () => [...document.querySelectorAll('.cd-setup-safety__count')].find((count) => !count.closest('.cd-skeleton-screen__layer'));

it('safety_check_lands_under_the_fading_skeleton', async () => {
  // The owner goes on from Real situations, through what customers will read: the check runs as
  // they watch. Its rows start landing one by one while the shapes fade over them, and the count
  // ticks with them to the check's words.
  const state = await interviewAt('situations');
  const check = holdPosts(path('setupSafetyCheck', state));
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await screen.getByRole('button', { name: 'Looks right', exact: true }).click();
  await expect.element(screen.getByRole('heading', { level: 1, name: 'What customers will read', exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Looks right', exact: true }).click();
  await vi.waitFor(() => expect(check.held()).toBe(1));
  await vi.waitFor(() => expect(document.querySelector('.cd-setup-step .cd-skeleton-screen__layer')?.getAttribute('data-state')).toBe('shown'));

  const firstLanding = new Promise<{ layer: string | null; count: string | null }>((resolve) => {
    const started = (event: AnimationEvent) => {
      const row = event.target instanceof Element ? event.target : null;
      if (event.animationName !== 'cd-safety-check-row-land' || !row?.matches('.cd-setup-step__rows > li:first-child > .cd-safety-check-row')) return;
      document.removeEventListener('animationstart', started, true);
      resolve({
        layer: document.querySelector('.cd-setup-step .cd-skeleton-screen__layer')?.getAttribute('data-state') ?? null,
        count: landedCount()?.querySelector('[aria-hidden="true"]')?.textContent ?? null,
      });
    };
    document.addEventListener('animationstart', started, true);
    onTestFinished(() => document.removeEventListener('animationstart', started, true));
  });
  check.release();
  const at = await firstLanding;
  expect(at.layer, 'the first row starts landing while the shapes fade').toBe('leaving');
  expect(at.count, 'the count ticks from the first row').toBe('1 of 6 stopped');

  await vi.waitFor(() => expect(document.querySelector('.cd-safety-check-row--live')).toBeNull(), { timeout: 5_000 });
  const count = landedCount()!;
  expect(count.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(count.textContent).toBe('6 of 6 stopped');
  expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
});

/** How long the long draft is held: a live draft can take many seconds. */
const LONG_DRAFT_MS = 2_000;

it('long_draft_keeps_one_status', async () => {
  // Review Focus 4: a long wait keeps sweeping, says its words once, and changes nothing else.
  const state = await interviewAt('tools');
  const draft = holdPosts(path('setupRules', state));
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'What Claude can use' })).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());

  // Every change from here: the status's words apart, anything else on the page once the shapes show.
  const said: string[] = [];
  const others: string[] = [];
  let shown = false;
  const statusOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('.cd-setup-step [role="status"]') ?? null;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const status = statusOf(record.target);
      if (status) {
        if (said.at(-1) !== status.textContent) said.push(status.textContent ?? '');
      } else if (shown) {
        others.push(`${record.type} on ${(record.target as Element).className ?? record.target.nodeName}`);
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  onTestFinished(() => observer.disconnect());

  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await vi.waitFor(() => expect(draft.held()).toBe(1));
  const heldAt = performance.now();
  await vi.waitFor(() => expect(document.querySelector('.cd-setup-step .cd-skeleton-screen__layer')?.getAttribute('data-state')).toBe('shown'));
  // Changes already queued for the observer belong to the shapes showing.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  shown = true;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, LONG_DRAFT_MS - (performance.now() - heldAt))));

  const layer = document.querySelector('.cd-setup-step .cd-skeleton-screen__layer')!;
  expect(layer.getAttribute('data-state')).toBe('shown');
  expect(layer.querySelector('.cd-skeleton')!.getAnimations().some((a) => a.playState === 'running'), 'the shapes still sweep').toBe(true);
  expect(said, 'the status says its words once').toEqual(['Drafting your rules']);
  expect(others, 'nothing else on the page changes').toEqual([]);

  draft.release();
  await expect.element(screen.getByRole('button', { name: 'Check real situations', exact: true })).toBeVisible();
});

it('setup_steps_still_under_reduced_motion', async () => {
  const state = await interviewAt('rules');
  const draft = holdPosts(path('setupRules', state));
  const open = await loadedSetup(state);
  const rules = STEPS.rules;
  await expectSkeletonStill({
    status: rules.status,
    anchors: rules.anchors,
    stays: rules.stays,
    open: async () => {
      await open();
      await vi.waitFor(() => expect(draft.held()).toBe(1));
    },
    release: draft.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

const peoplePath = (state: SetupState) => ROUTES.people.path.replace('{desk_id}', state.desk_id);

it('draft_waits_for_the_people_read', async () => {
  // The draft's rows name customers from the people read: with the draft ready and only the people
  // read out, the draft keeps its shapes, then lands where they were.
  const state = await interviewAt('rules');
  const people = holdReads(peoplePath(state));
  const open = await loadedSetup(state, 'phone');
  const rules = STEPS.rules;
  await expectSkeletonLoad({
    status: rules.status,
    anchors: rules.anchors,
    stays: rules.stays,
    open: async () => {
      const mark = mockStore.requests.length;
      await open();
      await vi.waitFor(() => expect(people.held()).toBe(1));
      await vi.waitFor(() => expect(mockStore.requests.slice(mark).some((r) => r.key === 'setupRules')).toBe(true));
    },
    release: people.release,
  });
  await expectScreenBasics(document.body, { owner: true });
});

it('draft_lands_when_the_people_read_fails', async () => {
  // A people read that fails for good doesn't hold the draft: the shapes go and the draft lands,
  // its rows in their general words, with nothing left busy.
  const state = await interviewAt('rules');
  mockStore.inject({ route: 'people', status: 500, times: 2 });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { retryScale: 0 });
  await expect.element(screen.getByRole('button', { name: 'Check real situations', exact: true })).toBeVisible();
  expect(mockStore.requests.filter((r) => r.key === 'people')).toHaveLength(2);
  await vi.waitFor(() => expect(document.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  expect(document.querySelector('[aria-busy]')).toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: 'Does on its own' }).elements()).toHaveLength(1);
});
