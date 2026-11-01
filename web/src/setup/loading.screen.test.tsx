/**
 * Setup's steps while their reads are out: each step keeps its real header and draws what it waits
 * for as its own shapes, then lands where the shapes were. A reload draws the header as shapes
 * until the interview is read, and hands off to the step's own shapes with no blank between.
 */
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
  "Rivera Plumbing. I'm Maria, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters for homes and small shops. Weekdays mostly, emergencies on Saturday mornings.";

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
  if (step === 'tools') return state;
  await mockStore.dispatch('setupRules', { params });
  if (step === 'rules') return state;
  await mockStore.dispatch('setupSituations', { params });
  if (step === 'situations') return state;
  await mockStore.dispatch('setupSafetyCheck', { params });
  return state;
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

interface StepLoad {
  status: string;
  /** The step's read the test holds, and how. */
  hold: (state: SetupState) => { held: () => number; release: () => void };
  anchors: (viewport: Viewport) => readonly SkeletonAnchor[];
  stays: readonly string[];
}

const TOOL_ROW = (card: number, row: number) => `.cd-setup-tools > .cd-card:nth-child(${card}) .cd-setup-tools__row:nth-child(${row})`;
/** A rule's row in the draft: the groups follow the payment limit's card, which is the first child. */
const GROUP_ROW = (child: number, row: number) => `.cd-outcome-groups > :nth-child(${child}) .cd-outcome-groups__row:nth-child(${row})`;
/** A situation's or a trick's row in its card. */
const RESULT_ROW = (row: number) => `.cd-setup-step__rows > li:nth-child(${row})`;

const STEPS: Readonly<Partial<Record<Step, StepLoad>>> = {
  tools: {
    status: 'Reading your tools',
    hold: (state) => holdReads(path('setupTools', state)),
    anchors: (viewport) => [
      { name: 'tools-built-in-row-0', page: TOOL_ROW(1, 1), size: true },
      // The last row in view: Stripe under "Connect your own" at 1440, Documents at 390.
      viewport === 'desktop'
        ? { name: 'tools-external-row-0', page: TOOL_ROW(2, 1), size: true }
        : { name: 'tools-built-in-row-4', page: TOOL_ROW(1, 5), size: true },
    ],
    stays: [TITLE, MAIN_BUTTON],
  },
  rules: {
    status: 'Drafting your rules',
    hold: (state) => holdPosts(path('setupRules', state)),
    anchors: (viewport) => [
      { name: 'rules-money-limit', page: '.cd-outcome-groups > .cd-card:first-child', size: true },
      { name: 'rules-auto-row-0', page: GROUP_ROW(2, 1), size: true },
      // The last row in view: the first that asks at 1440, the ninth Claude does on its own at 390.
      viewport === 'desktop'
        ? { name: 'rules-ask-row-0', page: GROUP_ROW(3, 1), size: true }
        : { name: 'rules-auto-row-8', page: GROUP_ROW(2, 9), size: true },
      { name: 'main-button', page: MAIN_BUTTON, size: true },
    ],
    stays: [TITLE],
  },
  situations: {
    status: 'Trying real situations on your draft rules',
    hold: (state) => holdPosts(path('setupSituations', state)),
    anchors: (viewport) => [
      { name: 'situation-row-0', page: RESULT_ROW(1), size: true },
      // The last row in view: the sixth at 1440, the fourth at 390.
      viewport === 'desktop' ? { name: 'situation-row-5', page: RESULT_ROW(6), size: true } : { name: 'situation-row-3', page: RESULT_ROW(4), size: true },
      { name: 'main-button', page: MAIN_BUTTON, size: true },
    ],
    stays: [TITLE],
  },
  // Opened at the safety check (a reload), the first results are drawn still, so they land in place.
  safety_check: {
    status: 'Trying tricks people use on your draft rules',
    hold: (state) => holdPosts(path('setupSafetyCheck', state)),
    anchors: (viewport) => [
      { name: 'safety-count', page: '.cd-setup-safety__count' },
      { name: 'trick-row-0', page: RESULT_ROW(1), size: true },
      // The last row in view: the sixth at 1440, the fourth at 390.
      viewport === 'desktop' ? { name: 'trick-row-5', page: RESULT_ROW(6), size: true } : { name: 'trick-row-3', page: RESULT_ROW(4), size: true },
      { name: 'main-button', page: MAIN_BUTTON, size: true },
    ],
    stays: [TITLE],
  },
};

for (const viewport of ['desktop', 'phone'] as const) {
  for (const [step, load] of Object.entries(STEPS) as [Step, StepLoad][]) {
    it(`setup_steps_load_in_place: ${step} at ${viewport}`, async () => {
      const state = await interviewAt(step);
      const read = load.hold(state);
      await expectSkeletonLoad({
        status: load.status,
        anchors: load.anchors(viewport),
        stays: load.stays,
        open: async () => {
          await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
          await vi.waitFor(() => expect(read.held()).toBe(1));
        },
        release: read.release,
      });
      await expectScreenBasics(document.body, { owner: true });
    });
  }
}

it('setup_reload_hands_off', async () => {
  // A reload at the tools: while the interview is read, the column draws a step's header as shapes;
  // then the real header lands and the tools list's own shapes carry on at once, with no frame
  // without shapes until the list lands.
  const state = await interviewAt('tools');
  const interview = holdReads(path('setup', state));
  const tools = holdReads(path('setupTools', state));
  const gaps = watchSkeletonGaps('.cd-setup-tools');
  let title: DOMRect | undefined;
  await expectSkeletonLoad({
    status: 'Reading your tools',
    continues: true,
    anchors: STEPS.tools!.anchors('desktop'),
    stays: STEPS.tools!.stays,
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
  await expectScreenBasics(document.body, { owner: true });
});

it('safety_check_lands_under_the_fading_skeleton', async () => {
  // The owner goes on from Real situations: the check runs as they watch. Its rows start landing
  // one by one while the shapes fade over them, and the count ticks with them to the check's words.
  const state = await interviewAt('situations');
  const check = holdPosts(path('setupSafetyCheck', state));
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`);
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
        count: document.querySelector('.cd-setup-safety__count [aria-hidden="true"]')?.textContent ?? null,
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
  const count = document.querySelector('.cd-setup-safety__count')!;
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
  const rules = STEPS.rules!;
  await expectSkeletonStill({
    status: rules.status,
    anchors: rules.anchors('desktop'),
    stays: rules.stays,
    open: async () => {
      await renderRoute(`/app/setup/${state.interview_id}`);
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
  const rules = STEPS.rules!;
  await expectSkeletonLoad({
    status: rules.status,
    anchors: rules.anchors('phone'),
    stays: rules.stays,
    open: async () => {
      await renderRoute(`/app/setup/${state.interview_id}`, { viewport: 'phone' });
      await vi.waitFor(() => expect(people.held()).toBe(1));
      await vi.waitFor(() => expect(mockStore.requests.some((r) => r.key === 'setupRules')).toBe(true));
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
