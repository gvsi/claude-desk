# Claude Desk Prototype — Plan 08a: UX craft on the About pages

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill: a fresh implementer and a task review per task, in this plan's worktree (`.worktrees/08a-ux-craft-about`, branch `plan/08a-ux-craft-about`), landing through one design PR after the review panel. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three changes on the two About this prototype reading pages, which the project owner signed on the design canvas on 2026-10-30. On first view, each lead figure plays once to show its argument: the capability chart draws its forecast, and the architecture figure traces one request through the kernel. The contents list marks the section being read, and following one of its links scrolls smoothly and moves focus to that section.

**Architecture:** All changes stay in `web/src/about/` (plus one test project in `web/vitest.config.ts`), with no API, no data and no design-system change. A small hook, `usePlayOnce`, marks a figure as played the first time it is at least a third in view, through an `IntersectionObserver`. The figure's CSS keys its animation on that mark, so a figure that never comes into view, or a browser without the observer, shows the figure complete. The contents list reads which heading is current with a second observer and marks its link with `aria-current="location"`. The design system's base stylesheet stops every animation and transition under reduced motion, but it doesn't undo a hidden start state, so this plan never hides a part except behind `prefers-reduced-motion: no-preference` on screen. Smooth scrolling applies only to a contents link's jump; every scroll the page makes itself (opening a document, the address's section, Back and Forward) stays instant.

**Tech stack:** the web app's toolchain as plan 04 pins it. No new dependencies.

**Spec / plans:** `docs/specs/2026-10-28-claude-desk-design.md` ("Design system v2 (locked)": motion between 60 and 200 ms, at most one small moment per screen, reduced motion respected); plan 07 (the readers: Global Constraints, "Figures say only what the text says", the static and offline rule); `web/src/ds/README.md` (Motion).

**Signed boards** (canvas page "UX craft proposals", `#page-54f7c3a5c3cf`; signed by the project owner on 2026-10-30, as drawn):
- P3-01, the forecast: `UXC-P301-Before` (`#artboard-d9b2893c8c25`) and `UXC-P301-After` (`#artboard-bf4559edf06d`).
- P3-02, the trace: `UXC-P302-Before` (`#artboard-9f22aaa6ecca`) and `UXC-P302-After` (`#artboard-1b43f1271bc4`).
- P3-03, the marker: `UXC-P303-Before` (`#artboard-06296d5e8909`) and `UXC-P303-After` (`#artboard-1ba9a2f503b7`).

The spec of each is the UX craft review's note (craft-2026-10-30-1914.md, kept outside the repository). Where that note and this plan differ, this plan wins.

## Global Constraints

The master plan's Global Constraints apply as plan 07 copies them. Specific to this plan:

- **Static and offline, as plan 07 says.** The pages still make no request. The new hooks read the DOM and nothing else.
- **Figures say only what the text says.** No label, value or element is added, removed or reworded. Each animation shows existing parts in a new order. The tests that pin the chart and the architecture figure to the documents keep passing unchanged.
- **Tokens only.** No raw colour, no raw duration and no raw easing in `reader.css`. Every duration is a motion token or a `calc()` of them, every easing is `--motion-ease` or `--motion-ease-emphasis`, and `app/guards.test.ts`'s `RAW_MS` and `RAW_CSS_SECONDS` stay green.
- **Exceptions, signed.** The forecast's fit line draws over three `motion-base` (600 ms), longer than the design system's 60 to 200 ms range. The project owner approved this for an explanatory figure on 2026-10-30. Every other step stays within the range. The contents bar's slide is a second small moment on both About pages, after each page's lead figure, signed with P3-03 (ruling by the UX craft reviewer, the proposals' owner, 2026-10-30). The fit eases with `motion-ease-emphasis`, because the board's ease-in-out isn't a token.
- **Phone contents list unchanged.** No signed board draws a marker on the phone, so the phone's disclosure list stays as it is (ruling by the UX craft reviewer, 2026-10-30). The marker is the laptop's sticky list only.
- **Checks that read the page wait for it to rest.** The screens project and the end-to-end tests run with motion, so an axe check or a fit check on an About page waits until every figure's animations have finished (`document.getAnimations()` settled), or runs under emulated reduced motion.
- **Plays once.** A figure plays the first time it is a third in view in that page load, and never again until the page reloads, including after the reader opens the other document and comes back (the figure remounts). Scrolling back shows it complete. A figure above the fold plays on load.
- **Complete by default.** With no observer, before hydration, in print, or under `prefers-reduced-motion: reduce`, the figure is drawn complete, before, during and after its first time in view. The animated state is reached only by adding the played mark, never by hiding parts by default. Every rule that hides, scales or clips a part for the animation (the `ready` state and the `played` keyframes' start) sits inside `@media screen and (prefers-reduced-motion: no-preference)`, and `usePlayOnce` sets no `data-play` at all when reduced motion matches.
- **Test contexts.** The `about` test project forces `reducedMotion: 'reduce'` (`web/vitest.config.ts`), which hides the behaviour this plan adds. Task 1 adds an `about-motion` project: the same setup with `reducedMotion: 'no-preference'`, including only `src/about/**/*.motion.browser.test.tsx`, which the `about` project excludes. Animation order, playing once and smooth scrolling are tested there. Reduced-motion and complete-figure assertions stay in the existing `about` files. `npm test` runs both.
- **Accessibility.** The figures keep their `role="img"`, labels and tables. The motion is decorative. The contents marker is `aria-current="location"` on the link, plus the visual state, and never colour alone: the 2 px bar marks it too.
- **Viewports.** 1440×900 and 390×844, with no horizontal scroll or clipped text. QA compares with the boards at 1512. On a phone the contents list is unchanged: no marker and no `aria-current`. Following a link still scrolls and moves focus (#123).
- Git: small conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Interfaces

- `web/src/about/figures/usePlayOnce.ts` (new): `usePlayOnce<T extends Element>(name: FigureName): [ref: RefObject<T>, play: 'ready' | 'played' | null]`, and the figure root sets `data-play={play ?? undefined}`. Threshold 0.33. It disconnects after the first hit. The names played in this page load live in a module-level set, so a figure that remounts after playing (the reader switched documents and came back) gets `null` and stays complete. It returns `null` with no `IntersectionObserver`, and when `prefers-reduced-motion: reduce` matches. Otherwise it returns `'ready'` from a layout effect once mounted (so there's no frame of a complete figure that then hides), `'played'` on the hit, and `null` again once every animation under the figure has finished. It waits on each animation's `finished` promise, which settles whether the animation runs its course or is cancelled with its part, and then rechecks for animations that started meanwhile. The timing therefore lives only in the CSS, and no timeout copies it. With the mark off, a part drawn later in that page load is complete by default and doesn't play on its own; a layout switch redraws some parts, such as the architecture figure's outcomes on a phone and the chart's short labels. The figure's CSS animates only under `[data-play="played"]` and hides parts only under `[data-play="ready"]`, both inside the media block named in Global Constraints, so the default is complete.
- `web/src/about/useCurrentSection.ts` (new): `useCurrentSection(ids: readonly string[]): [current: string | null, follow: (id: string) => void]`. `follow` is what a contents link's click calls to hold its target as current during its own jump (read from the router instead, the hold would start a render late). The current section is the last heading whose top is above 40% of the viewport, or the last section when the page is scrolled to its end. It returns null before the first heading. An `IntersectionObserver` over the headings (and a sentinel at the page's end) only says when to look again. Each callback recomputes from every heading's `getBoundingClientRect()`, never from the callback's own entries. A jump can carry headings straight across the observer's band with no callback at all, so the hook also recomputes once each scroll comes to rest: on `scrollend`, or where a browser lacks it, on a scroll debounced by about 100 ms. That is one recompute per scroll, not a listener doing work on every frame. While a contents link's own jump is under way, the target is current at once and recomputes wait until that scroll ends (or a 1 s fallback), so the bar slides once to its row instead of stepping through each section it passes. With no current section the bar is hidden; when one first appears, the bar shows on its row without sliding from the top. The hook runs only in the laptop's list (`!compact`).
- `forgetPlayedFigures()`: a test-only export from `usePlayOnce.ts` that empties the played set. Every `*.motion.browser.test.tsx` calls it in `afterEach`, because browser tests share modules within a file. In the `screens` project, `about.screen.test.tsx`'s later tests see figures already played, which is fine: they check the page, not the animation.

## Tasks

### Task 1: `usePlayOnce` and the capability chart's forecast (P3-01)

**Files:** `web/vitest.config.ts` (the `about-motion` project, and `about` excluding its files), `web/src/about/figures/usePlayOnce.ts` (new), `web/src/about/figures/Tau3Chart.tsx`, `web/src/about/reader.css`, `web/src/about/figures.browser.test.tsx`, `web/src/about/figures.motion.browser.test.tsx` (new), `web/src/about/guards.test.ts`, `web/e2e/about-readers.spec.ts` (the print step, and its axe and fit checks), `web/src/about/about.screen.test.tsx` (its axe check).

- [ ] First, make the page checks that run with motion wait for the page to rest (Global Constraints): `about.screen.test.tsx`'s axe check, and the e2e test's axe and fit checks, wait until every `[data-play]` is `played` or absent and `document.getAnimations()` is empty, or run under `emulateMedia({ reducedMotion: 'reduce' })` where the runner allows it.

- [ ] First, the `about-motion` project (Global Constraints, "Test contexts"), with one trivial motion test that proves `matchMedia('(prefers-reduced-motion: reduce)').matches` is false there and true in `about`.
- [ ] Tests first, in `figures.motion.browser.test.tsx` (normal motion):
  - `play_once_marks_a_figure_the_first_time_it_is_in_view`: mount `Tau3Chart` below the fold. Its root has `data-play="ready"`; scroll it into view and it gets `played`; scroll away and back and it stays `played` (no replay).
  - `played_figure_stays_complete_after_a_remount`: play `Tau3Chart`, unmount it, mount it again (as switching to the proposal and back does): no `data-play`, nothing hidden.
  - `chart_plays_in_its_signed_order`: with `played`, each Claude point's `animation-delay` grows in date order, 80 ms apart. The fit starts after the last point, and the band, the rule, "Prediction date" and the band's two labels after the fit. The axis ticks and their labels show from the start. Name each part through a `data-` hook on it (for example `data-tau3-part="fit"`), not by position.
  - `chart_is_complete_without_an_observer`: with `IntersectionObserver` stubbed away and a fresh, unplayed chart, there is no `data-play`, and every point, the fit, the band and the labels have computed opacity 1, transform `none` and clip-path `none`.
  - `fit_reveal_ends_unclipped`: once the fit's animation has finished, its computed `clip-path` is `none` and its round caps are whole. The reveal's reference box covers the stroke (`stroke-box`, or insets that allow for the stroke width), and the animation fills backwards, not forwards.
- [ ] Tests first, in `figures.browser.test.tsx` (reduced motion):
  - `chart_is_complete_under_reduced_motion`: mount it below the fold, then scroll it into view. Before and after, there is no `data-play`, no element under the chart has a computed `animation-name` other than `none`, and every part has opacity 1, transform `none` and clip-path `none`.
- [ ] A guard in `guards.test.ts`: every `reader.css` rule whose selector names `data-play` sits inside `@media screen and (prefers-reduced-motion: no-preference)`. This is what keeps print and reduced motion complete. Add a print step to `e2e/about-readers.spec.ts`: open `/about/prediction#limitations`, so the lead chart is off screen, and assert it is `data-play="ready"`. Then, with `emulateMedia({ media: 'print' })`, every part of it is visible.
- [ ] Implement the order the board draws (`UXC-P301-After`).
  - The grid, the axes, the 80% bar and its label show from the start.
  - The seven Claude points scale in from 0.5 with an opacity fade (`motion-base`, `motion-ease-emphasis`), 80 ms apart in date order. The step is `calc(var(--motion-base) * 0.4)`, applied per point as `calc(var(--cd-tau3-i) * var(--motion-base) * 0.4)`, where `--cd-tau3-i` is a custom property the component sets from the point's index in date order.
  - After the last point: the top score, the Opus 5 ring and the point labels fade in (`motion-base`).
  - Then the fit draws left to right with a `clip-path: inset(0 100% 0 0)` to `inset(0)` reveal over `calc(var(--motion-base) * 3)`, `motion-ease-emphasis`.
  - Then the band, the rule, "Prediction date" and the band's two labels fade in (`motion-base`).
  - SVG parts that scale use `transform-box: fill-box; transform-origin: center`.
  - The compact chart on a phone plays the same sequence.
- [ ] Run `cd web && npx vitest run --project about src/about/figures.browser.test.tsx`, `npx vitest run --project about-motion src/about/figures.motion.browser.test.tsx`, then `npx vitest run --project unit src/about src/app/guards.test.ts`, `npx vitest run --project screens src/about` and `npx playwright test e2e/about-readers.spec.ts`.
- [ ] Commit: `feat(web): draw the capability chart's forecast once when it first comes into view`.

### Task 2: the architecture figure traces one request (P3-02)

**Files:** `web/src/about/figures/ArchitectureFigure.tsx`, `web/src/about/reader.css`, `web/src/about/figures.browser.test.tsx`, `web/src/about/figures.motion.browser.test.tsx`.

- [ ] Tests first:
  - In the motion file, `architecture_traces_its_path_once`: with `played`, the steps carry increasing delays in this order: the visitor box, the chat layer, Decide, "Runs", Check reply, "Shown", the ledger. With `ready` or no mark, nothing is highlighted.
  - In the reduced-motion file: no `data-play`, no animation and no highlight under the figure, before and after it comes into view.
  - The figure's labels test (plan 07) passes unchanged.
- [ ] Implement as the board draws (`UXC-P302-After`). Each step's outline brightens to `text-secondary` on a `fill-hover` ground, in `motion-fast`, holds for two `motion-base`, and goes back in `motion-fast`. The steps are `--motion-stagger` × 2 apart (300 ms). Afterwards the figure rests exactly as today. Reuse `usePlayOnce`. The highlight is an inset `box-shadow` and a background, so nothing reflows. The compact figure on a phone traces the same path down its stack.
- [ ] Run the figure tests (both projects), the about unit tests, the guards, `npx vitest run --project screens src/about` and `npx playwright test e2e/about-readers.spec.ts`, as in Task 1.
- [ ] Commit: `feat(web): trace one request through the architecture figure once when it first comes into view`.

### Task 3: the contents list marks where you are (P3-03)

**Files:** `web/src/about/useCurrentSection.ts` (new), `web/src/about/ReaderPage.tsx` (`Contents`), `web/src/about/reader.css`, `web/src/about/reader.browser.test.tsx`, `web/src/about/reader.motion.browser.test.tsx` (new), `web/e2e/about-readers.spec.ts`.

- [ ] Tests first, in `reader.browser.test.tsx` (reduced motion):
  - `contents_marks_the_section_being_read`: scroll to "Limitations" (the prediction page) and only its link has `aria-current="location"`. Scroll to "Readiness" and the mark moves. At 390 px, no link in the phone's list has `aria-current`.
  - `contents_link_moves_focus_to_its_section`: activate "Limitations" in the list. The heading `#limitations` is focused (it has `tabindex="-1"`, and shows no focus ring, as `ApprovalCard`'s focused card doesn't), the router location's hash is `#limitations` (the tests use a `MemoryRouter`), and the heading's top is at the existing 88 px offset, with the existing `scroll-margin-top` intact. The jump is instant: the heading is in place in the same frame.
  - `contents_mark_follows_a_jump_past_the_band`: an instant jump that carries headings straight past the 40% band (on the prediction page at 1440×900, from Limitations' place to Readiness') marks Readiness once the scroll rests.
  - `contents_marks_a_short_last_section`: in a window tall enough that the last heading never reaches 40% (sized from the page; 1400 px no longer is), scrolled to the page's end, the last section is marked even if its heading never reaches 40%. After an instant jump to a section and then a small scroll up, the mark is the section now above 40%, not a stale one.
  - The back and forward restoring in `useReadingPlace` still passes its existing tests.
- [ ] Tests first, in `reader.motion.browser.test.tsx` (normal motion):
  - `contents_link_scrolls_smoothly`: activate "Limitations". Right after the click the page hasn't reached the heading yet, and within a second it rests with the heading at the 88 px offset and focused.
  - `contents_bar_slides_once_to_its_target`: following a link two sections down changes the bar's transform once, to the target row, and `aria-current` never names a section in between.
  - `page_scrolls_stay_instant_with_motion`: opening the other document, opening an address with a section, and Back and Forward each land at their place in the same frame, and the place `useReadingPlace` records afterwards is that place, not one passed on the way.
- [ ] Implement as the board draws (`UXC-P303-After`).
  - The list's links are `text-secondary`, and the current one is `text-primary` with a 2 px `text-primary` bar at its row's left edge (inset 12 px into the gutter). The bar slides between rows in `motion-base`, `motion-ease-emphasis`, drawn as one element translated to the current row, not a border per row.
  - On a phone, the disclosure list stays as it is: no marker (Global Constraints).
  - No `scroll-behavior` in CSS. A root `smooth` would also glide `useReadingPlace`'s `window.scrollTo` and `scrollIntoView` calls, which name no behavior (Back and Forward would animate and record wrong places), and the readers' end-to-end test's own scrolls.
  - `Contents`' links keep their `href="#…"` and get a click handler. It skips modified clicks (new tab, new window). It prevents the default jump, pushes the hash through the router's `navigate` first (before scrolling, so the history entry being left keeps the reader's place for Back), and calls `heading.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' })`, where `reduced` is `matchMedia('(prefers-reduced-motion: reduce)')` read at the click. The heading's `scroll-margin-top` still applies. Pushing the hash doesn't rerun `useReadingPlace` (that runs only when a document draws). Then it focuses the heading with `preventScroll: true`.
  - Add a step to `e2e/about-readers.spec.ts`: follow a contents link, then Back, then Forward. Back lands where the reader was before following the link, within `expectBackAt`'s 56 px. Forward lands with the heading at its scroll margin.
  - Ruling (this plan, 2026-10-30, agreed with the About pages' owner, the About pages' owner): moving focus to the section is issue #123. It is the same interaction, so it is folded in here, and this plan's PR closes #123.
  - Keep as they are: `useReadingPlace`'s Back and Forward restoring (it records the place only while the pathname matches), the h2s' `scroll-margin-top` for the pinned bar (`--about-top`), the scroll margin on focusable elements outside the bar, and the static bar in print.
- [ ] Run `npx vitest run --project about src/about/reader.browser.test.tsx`, `npx vitest run --project about-motion src/about/reader.motion.browser.test.tsx`, the about unit tests and the readers' end-to-end test (`npx playwright test e2e/about-readers.spec.ts`).
- [ ] Commit: `feat(web): mark the section being read in the About pages' contents and move focus to it`, with `Closes #123.` in the body.

## Landing

One design PR from `plan/08a-ux-craft-about`, titled `feat(web): play the About pages' figures once and mark where the reader is`. It carries screenshots at 1440×900 and 390×844 of both pages (the top with the figure, and a scrolled view with the marker), plus a short recording of each figure playing and of a contents link being followed, captured by the coordinator after QA. Then the review panel (Opus 5.5 and GPT-6.1 Sol, with no critical surface touched), green CI, and the project owner's sign-off before merge (AGENTS.md "Design PRs").

## Review Ledger

**Round 1 (2026-10-30), Opus 5.5 and GPT-6.1 Sol, both "with fixes"; validated and fixed by the coordinator.**
- Test contexts (both seats, P1/P2): there's no `browser` project, and `about` forces reduced motion, so the motion tests couldn't run. Added the `about-motion` project and split the tests by context.
- Smooth scroll (both seats, P1/P2): a root `scroll-behavior: smooth` would glide `useReadingPlace`'s restores and the e2e test's scrolls. The contents link's click handler now scrolls smoothly; every other scroll stays instant. Added an e2e Back/Forward step.
- Complete figures (both seats, P2): the base stylesheet stops animations but doesn't undo a hidden start. The hide rules now sit only under `screen` plus `no-preference`, `usePlayOnce` sets nothing under reduced motion, and a guard plus an e2e print step check it.
- Plays once across documents (both seats, P2/P3): played names live in a module-level set.
- Fit reveal (Opus, P2, unconfirmed): reference box and end state specified, with a test.
- Stale section marker (Opus, P2): recompute from every heading's rect on each callback, and mark the last section at the page end.
- P3s taken: `data-` hooks for the chart's parts; checks wait for animations to finish; focused heading has no ring; router location in the test.
- Rulings by the UX craft reviewer (the proposals' owner): no phone marker; the bar slide is a signed second moment; the fit eases with `motion-ease-emphasis`; no ring on a focused heading.
- Opus rated the test-context and smooth-scroll findings P1, so these fixes get a second round (P1 extension).

**Round 2 (2026-10-30), Opus 5.5 and GPT-6.1 Sol, both "with fixes", no P1; validated and fixed by the coordinator.** Both seats confirmed round 1's fixes hold.
- Stale marker after a jump (Sol, P2): a jump can carry headings past the band with no observer callback, which Sol reproduced in Chromium. The hook now also recomputes once each scroll rests, and holds the target during a link's own jump, so the bar slides once (Opus, P3).
- Phone marker (Opus, P2): the Viewports bullet still asked for one. Now: no marker and no `aria-current` on the phone, with a 390 px assertion.
- Played set across tests (Opus, P2): a test-only `forgetPlayedFigures()` called in each motion file's `afterEach`.
- P3s taken: the no-observer test moved to the motion project (both seats); the page checks that run with motion wait for rest, with an owning task and run commands; the e2e print and Back/Forward steps get sound premises and pass conditions; the second moment covers both About pages.
- Round cap reached (2 completed rounds, the second with no P1). These fixes aren't re-reviewed as a plan; each task's review and the PR panel check them.
- Task 2: P3 parked — a step that already finished can relight once if the layout crosses 1100 px during the 2.44 s trace (rotating a tablet mid-trace); the figure still ends at rest, and a switch after the play has ended replays nothing — rare and harmless, needs per-part played state across remounts.

**During Task 3 (2026-10-31), rulings by the coordinator:** `useCurrentSection` also returns `follow`, the click handler updates the address before it scrolls (in the other order, Back under reduced motion landed 848 px off), and the short-last-section test sizes its window from the page. Interfaces and Task 3 now say so.
- Task 3: P3 parked — the 1 s hold fallback in `useCurrentSection` (scrollend missing) and its restart during continued scrolling have no direct test; normal scroll completion is covered — a timer regression would leave the marker held a second longer.
