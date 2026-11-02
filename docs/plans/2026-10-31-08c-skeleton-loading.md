# Claude Desk Prototype — Plan 08c: Skeleton loading screens

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill, in this plan's worktree (`.worktrees/08c-skeleton-loading`, branch `plan/08c-skeleton-loading`), with a fresh implementer and a task review per task, landing through two stacked design PRs after the review panel (see Landing). **Task 1 belongs to the design system owner**, who builds it in parallel with the other lanes in its own worktree (`.worktrees/08c-skeleton-loading-ds`, branch `plan/08c-skeleton-loading-ds`, branched from this plan's branch). It gets the same task review, and the coordinator merges it into `plan/08c-skeleton-loading` before Task 2 starts. A web implementer builds the rest one at a time, in order of value: Tasks 2, 6 and 7 on `plan/08c-skeleton-loading` (the first PR), then Tasks 3, 4 and 5 on `plan/08c-skeleton-loading-pages` in `.worktrees/08c-skeleton-loading-pages`, branched from the first after Task 7 (the second PR, stacked with `gh stack`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every main screen opens on its own shape instead of a line of text. While a page's first reads are out, it draws its own parts as quiet shapes, with one band of light sweeping across them. Then the real page fades in exactly where the shapes were. The project owner asked for this on 2026-10-31 and signed the drawn proposal the same day.

**Architecture:**
- **One design system part** (Task 1): `Skeleton` (line, block and circle), `SkeletonCard`, and `SkeletonScreen`, the region that waits, sweeps, speaks and fades.
- **The frame's shapes** live beside the frame's own components in the design system (Task 2): `AppShell` gains `skeleton`, plus `SidebarSkeleton`, `ReviewerBarSkeleton` and `PageHeaderSkeleton`. They're built from those components' own classes, so they sit where the components do.
- **Page skeletons** live with their pages in the web app and use the page's own layout classes. Screen tests prove the shapes land within 2 px of the real elements.
- **Two places load:**
  - The owner's full-page loader (a reload, or a first open of a Desk) draws the frame and the page as shapes.
  - Inside the app, a page draws its real header and shapes for only what it is waiting on.
- No API, kernel, contract or copy change.

**Tech stack:** the web app's toolchain as plan 04 pins it, and the design system's as plans 03a and 03b do. No new dependencies.

**Spec and plans:** the approved skeleton loading proposal, P12-01 (the owner app) and P12-02 (the visitor's chat), from the UX craft review (kept outside the repository; the owner signed both as drawn, with one synced sweep, on 2026-10-31). Also `docs/specs/2026-10-28-claude-desk-design.md` ("Design system v2 (locked)"), plan 04 (Global Constraints, the owner app, setup and the public page), plans 03a and 03b (component rules, stories, board checks) and `web/src/ds/README.md`.

**Signed boards** (canvas page "UX craft proposals"):
- P12-01, laptop: `UXC-P1201-After` (`#artboard-dec46cf506e4`), the frame and Today at 1512, then the real Today fading in over them.
- P12-01, phone: `UXC-P1201-After-Phone` (`#artboard-1a93c5a1f31f`), the frame and Today at 390.
- P12-02, the visitor's chat: `UXC-P1202-After` (`#artboard-d122e70134a0`), at 390.

**Decisions this plan makes where the spec is silent.** Each names the design it turns down.
1. **Where a board and the real page differ, the skeleton follows the real page.** The boards set the look; the owner's rule that nothing jumps sets the layout. For example, the laptop board stops above Since last night and the phone board draws three Things to try rows where the seed has four; the skeletons draw what the page draws. Rejected: copying the boards exactly, which moves content when the page arrives.
2. **A line takes its type style's line box, with the pill centred in it.** Shapes and words then share their top edges and can be compared within 2 px. Rejected: free pills spaced by margins, as the boards draw them, which can't be measured against the page.
3. **During the 200 ms wait, the skeleton is laid out but invisible.** It holds the page's space from the first frame, so nothing under it moves when it shows. Rejected: drawing nothing for 200 ms, which moves the footer and anything below twice.
4. **A skeleton that mounts while another is on screen shows at once.** This is the full-page loader handing off to a page's own skeleton. Rejected: always waiting 200 ms, which leaves a 200 ms blank in the middle of a load.
5. **Every shape takes its sweep's phase from the document's clock,** so the band runs on across a hand-off. Rejected: each shape starting its own sweep when it mounts, which sends the band back to the left.
6. **Inside the app, a page's header stays real** and only what the page waits for is drawn as shapes. The full-page loader draws headers as shapes, as it does the frame. Rejected: header shapes inside the app too, which hide a title the app already knows.
7. **A page keeps its skeleton until every read that shapes its first view has settled** (data or error), secondary reads included: a read that only adds a name, a held request or a line to what the shapes cover still counts. Each task names its page's reads. Rejected: landing section by section, or letting a part with a fixed height land on its own, where later content still pushes or changes what the reader already sees.
8. **In the full-page loader, a route with no skeleton of its own** (Share, Settings, a customer, All rules, a rule draft, the briefing) draws the frame's shapes over an empty page area. Rejected: a generic page shape, which would be the wrong shape and would jump.
9. **No new canvas boards for the other screens.** The owner signed the rule for every screen it names, plus three boards, so each screen's look follows from its own page. The design PR's captures carry them to the owner's sign-off. Rejected: drawing about ten more boards first, a day of drawing for shapes the rule already fixes.
10. **The band lines up across shapes on every browser, by each shape's measured offset,** not by `background-attachment: fixed`. iOS Safari ignores fixed backgrounds, and a phone is where most people will open a public chat link, so a fixed background would break the one synced sweep the owner signed exactly there. Each `SkeletonScreen` measures its shapes' left edges in viewport coordinates once when they mount and again when the region resizes, and hands each shape its offset as a custom property; the sweep moves the band in viewport coordinates less that offset. Rejected: the fixed background the boards use, which works in Chromium only.
11. **The public chat's greeting and starter chips aren't built yet** (P1-02, accepted, not on `main`). The chat's skeleton draws what the chat draws when Task 6 runs. When the greeting and chips are on `main`, it draws them as the board does.
12. **The agents page draws its AI disclosure as a shape,** as the signed public chat skeleton does. Nothing on a visitor's skeleton states anything, and the real disclosure arrives with the page before anything Claude says. Rejected: keeping today's loading disclosure, which would be the one line of words on the skeleton, sitting where the title goes.
13. **There is no minimum time on screen.** A load that ends just after 200 ms shows the shapes briefly, and the 120 ms fade softens it. Rejected: holding the skeleton for a minimum time, which slows every load that ends just after 200 ms to hide a short flash.
14. **The hidden status fills when the shapes show.** A fast load says nothing, as it shows nothing. Rejected: filling it at mount, which announces a loading line the reader never sees.
15. **A skeleton draws a fresh copy's first view.** Parts of a page that come and go with the Desk's data (Today's Needs you, Live now and ticked Things to try rows; Rules' suggested rules; Conversations' recorded-history caption; the sidebar's Desk picker for a business with two Desks) are drawn as a fresh copy shows them, since that is the first view nearly every visitor to the demo gets. When the data differs, that part moves once as the page lands, and each task records that accepted behaviour in one test. Every "nothing jumps" acceptance line is scoped to a fresh copy at 1440×900 and 390×844, and the design PR says so. Rejected: a skeleton that guesses the Desk's data, which can't be known before the reads it waits for.
16. **The band's ends are transparent.** The gradient runs `transparent`, `fill-secondary`, `transparent` over the shape's `fill-hover`. The boards' `fill-hover` end stops paint the translucent fill twice inside the band and once outside it, which draws a hard edge stronger than the light itself (measured on `bg-app`: 41, then 53 one pixel inside the band, against 41, 41 with transparent ends). The peak is unchanged. The design PR names this as the one correction to the signed boards, with a capture taken mid-sweep. Rejected: the boards' `fill-hover` ends, which draw the edge.
17. **The full-page loader keeps a page's landmarks.** While loading, the owner's frame keeps a `main` with the visually hidden "Claude Desk" heading outside the hidden layer, as the frame's loading state does today. The public chat's status carries the visitor's language. Rejected: only the status while loading, which leaves no heading or landmark.

## Global Constraints

The master plan's Global Constraints apply as plan 04 copies them. Specific to this plan:

- **The signed look,** from the approved proposal, verbatim in substance:
  - Shapes are `fill-hover`. Lines are pills, at text heights. Cards keep their real border and fill.
  - One band of light (`fill-secondary`) sweeps the whole screen in sync, left to right, on `motion-writing` (1.6 s, the writing indicator's existing loop, so no new motion token). The band lines up in viewport coordinates on every shape, so every shape shows the same band at the same moment (decision 10).
  - The skeleton waits 200 ms before it shows, so a fast load goes straight to the page.
  - The real page fades in over it on `motion-fast`.
  - Each page's skeleton is built from its own components' sizes, so content lands where the shapes were.
  - The region's body is `aria-busy`, and the existing loading words stay as a visually hidden status outside it.
  - Under reduced motion, the shapes are still.
  - On the public chat, the footer stays real and nothing on the skeleton states anything.
- **No new words.** The hidden statuses are the existing loading words, in the reader's language:
  - Owner app: "Opening your Desk", "Reading your conversations", "Opening the conversation", "Loading your customers", "Reading your rules" and "Reading the attempts". "Checking the record" stays only as the entries view's existing visible line.
  - Setup: "Opening your setup", "Reading your tools", "Drafting your rules", "Trying real situations on your draft rules" and "Trying tricks people use on your draft rules".
  - Visitor pages: "Opening the chat" / "Abriendo el chat" and "Opening the page for AI agents" / "Abriendo la página para agentes de IA".
  - A skeleton draws no words of its own. The one text it draws is the real `ConceptFooter`, wherever the real page shows the footer.
- **Tokens only.** No raw colour, duration or easing in a component or a screen. These guards stay green: the design system's `no_raw_colors_outside_tokens`, `no_raw_durations` and `reduced_motion_covers_animation`, and the app's `no_raw_colors_or_durations_in_screens` (`app/guards.test.ts`). Timers in TypeScript are named constants (`SKELETON_DELAY_MS`), never literals in calls. The band's width is a new size token, `size-skeleton-band` (900 px, the boards').
- **Reduced motion.** No sweep and no fade: the shapes are still, and the page replaces them at once.
- **Accessibility.**
  - The skeleton layer is `aria-hidden` and `inert`, and nothing in it can take focus.
  - The region's status line is in the DOM from mount, so its words are announced when they come.
  - The region's body is `aria-busy="true"` only while loading.
  - A page that keeps its heading out of view while loading keeps a visually hidden `h1`, as Today's opening state does in #186.
  - After a load, axe and the screen basics pass as before (`expectScreenBasics`).
- **Safety invariants.** Skeletons show no content: no prices, dates, names, messages or statuses. On visitor surfaces, the real AI disclosure is part of the page that fades in, before anything Claude says. Nothing here touches the kernel, the API, the reply check or what a visitor is sent.
- **Design system process.**
  - Each design system change updates its component's README, stories and tests, and the design system reviewer reviews those parts in the PR.
  - The `UXC-*` boards aren't in the design system's reference list (`web/src/ds/reference/boards.ts`), so their stories say `canvas: 'none'` with a `canvasNote` naming the board and its id, as `web/src/ds/reference/README.md` allows.
  - The board stories that mount a changed component keep passing.
  - The design system README changes in three places (Task 1):
    - Motion gains the fourth loop: `motion-writing` for the skeleton's sweep.
    - "What not to do" says the skeleton's one synced sweep, while a page loads, is the one exception to "no shimmer or gradient washes" (owner, 2026-10-31).
    - The waiting states say how a page loads.
- **`LoadingLine` stays** for the loaders this plan doesn't cover:
  - a customer's page;
  - All rules;
  - a rule draft and its change;
  - the Demo inbox's open sheet (not the aside's button, which Today's skeleton draws);
  - the connector review inside setup's tools step;
  - setup's "Connecting Stripe";
  - the agents page's run panel, whose line is an action at work, not a page loading.
  - Its README says so.
- **Not in this plan:**
  - The same review's follow-on to #170 (Today's presence glyphs keep a 3:1 floor), which ships on its own.
  - The setup bar's step marker while the interview itself is read, which is unchanged.
- **Coordination.**
  - **#186** (Today drawn on every way in, with a one-step reload) is on `main` (008636e3), with the plain full-page loader in its single step. Task 2 builds on its `DeskGate`, and Task 7 swaps that step and Today's own hold to the skeleton. Until Task 7 lands, Task 2's acceptance covers loads that finish within `READ_AHEAD_MS` (3 s); a reload past that lands the frame and Today's own hold as #186 draws them, and Review Focus 3's deadline case is covered only by Task 7.
  - **#196** (Things to try ticks off; an answer lands) is open. Whichever of #196 and this plan lands second rebases. Today's skeleton draws a fresh copy's Today, with no row done.
  - **#239** (the public chat's head while the owner is in the chat) and **#240** (page titles balance their lines) touch the chat's head and the title type. The second to land rebases, and the anchor tests catch any drift.
  - **P11-01**, Today's "Not live yet" card for an unfinished setup, will add a card the skeleton doesn't draw. That card lands with movement, which its PR may address.
- **Viewports.** 1440×900 and 390×844, with no horizontal scroll or clipped text. Design QA compares Today and the public chat with their boards.
- **Git.** Small conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Interfaces

### The Skeleton part (Task 1, `web/src/ds/components/Skeleton/`, exported from `web/src/ds/index.ts`)

```ts
export type SkeletonText =
  | 'greeting' | 'page-title' | 'figure' | 'figure-small' | 'summary' | 'brand-name'
  | 'section' | 'control' | 'body' | 'message' | 'reply' | 'meta' | 'caption' | 'pill';

export interface SkeletonProps {
  shape: 'line' | 'block' | 'circle';
  /** line: the type style it stands in for (default 'body'). */
  text?: SkeletonText;
  /** line and block: px, or any CSS length or percentage. A line defaults to '100%'. */
  width?: number | string;
  /** block: px, or any CSS length. */
  height?: number | string;
  /** circle: the diameter in px (default 28, `size-avatar`). */
  size?: number;
  /** block: its corners (default 'control'). */
  radius?: 'control' | 'card' | 'composer' | 'full';
  /** Names the shape for screen tests, as `data-skeleton-anchor`. */
  anchor?: string;
  /** For the screen's own layout: a grid area, a breakpoint rule. */
  className?: string;
}
export function Skeleton(props: SkeletonProps): JSX.Element;

export interface SkeletonCardProps {
  /** As `Card`'s: 20 by default, 16 for a compact card, 0 for rows that pad themselves. */
  padding?: 0 | 16 | 20;
  anchor?: string;
  className?: string;
  children: ReactNode;
}
/** The real card's border, fill, radius and padding, holding shapes. */
export function SkeletonCard(props: SkeletonCardProps): JSX.Element;

export const SKELETON_DELAY_MS = 200;

export interface SkeletonScreenProps {
  /** True while a read the part's first view depends on is out: no data and no failure yet. */
  loading: boolean;
  /** The existing loading words, in the reader's language. */
  status: string;
  /** The part's shapes, built from its own components' sizes. */
  skeleton: ReactNode;
  /** The part itself, drawn once `loading` is false: its content, its empty state or its error. */
  children?: ReactNode;
  /** Places the region in the screen's layout. */
  className?: string;
  /** The status's language, when it differs from the page's (the public chat in setup's preview). */
  lang?: string;
}
export function SkeletonScreen(props: SkeletonScreenProps): JSX.Element;
```

**A line's box and pill.** A line is as tall as its type style's line height, with a `radius-full` pill centred in it. The pill heights below are the boards'. The design system owner may tune them against the boards in the artifact, and the README records the final table.

| `text` | Line box (px) | Pill (px) |
|---|---|---|
| caption, meta, pill | 17, 18, 16 | 10 |
| body, control, section, message, reply | 20, 20, 20, 21, 23 | 12 |
| brand-name, summary | 22, 27 | 14 |
| page-title, figure-small | 32, 32 | 24 |
| figure, greeting | 40, 44 | 32, 36 |

**The sweep,** on every shape (`.cd-skeleton`). These are the boards' values, with the band's ends made transparent (decision 16) and the band placed by each shape's offset (decision 10); the tests read them back as computed styles.

```css
background-color: var(--fill-hover);
background-image: linear-gradient(90deg, transparent 0, var(--fill-secondary) 50%, transparent 100%);
background-size: var(--size-skeleton-band) 100%;
background-repeat: no-repeat;
/* --cd-skeleton-x: the shape's left edge in viewport px, set by its SkeletonScreen (decision 10). */
background-position: calc(-1 * var(--size-skeleton-band) - var(--cd-skeleton-x, 0px)) 0;
animation: cd-skeleton-sweep var(--motion-writing) linear infinite;
/* @keyframes cd-skeleton-sweep: to { background-position: calc(100vw + var(--size-skeleton-band) - var(--cd-skeleton-x, 0px)) 0 } */
/* Under prefers-reduced-motion: reduce, animation: none. */
```

When a shape mounts, a layout effect sets its `cd-skeleton-sweep` animation's `startTime` to 0 (Web Animations), so every shape shows the band at the same moment, whenever it mounted. Its `SkeletonScreen` sets `--cd-skeleton-x` on each shape from `getBoundingClientRect().left` in that same layout effect, and again from one `ResizeObserver` on the region and a window `resize` listener, so the band sits at the same viewport position on every shape. Vertical scrolling doesn't move a horizontal band, so scroll needs no measuring. Nothing about the band depends on ancestors' `transform` or containment.

**`SkeletonScreen`'s DOM and states.** The screen tests rely on these names.
- The region is `div.cd-skeleton-screen`. Its first child is `p[role=status].cd-sr-only` (with `lang` when given): empty, then `status` once the shapes show, then empty again. The status sits outside every busy element, so assistive technology announces it while the load is out.
- Its second child is `div.cd-skeleton-screen__body`, with `aria-busy="true"` while `loading` (absent otherwise). The layer and `children` live in the body.
- While there is a skeleton, the body holds `div.cd-skeleton-screen__layer[aria-hidden=true]` with `data-state`. `inert` is set by attribute in a layout effect (`setAttribute('inert', '')`, as `TodayPreview` does), since the pinned React types have no `inert` prop. The layer moves through these states:

| `data-state` | When | What it does |
|---|---|---|
| `waiting` | `loading`, for `SKELETON_DELAY_MS` after mount | Laid out in flow, `visibility: hidden`. The status is empty. |
| `shown` | after the wait, or at mount when an ancestor `SkeletonScreen`'s layer is `shown` or `leaving` (a hand-off, carried by context) | Visible in flow. The status holds the words. |
| `leaving` | `loading` turned false while `shown` | `children` render in flow. The layer lies over them at the same top-left (`position: absolute; inset: 0; overflow: hidden; z-index: 1; pointer-events: none`, with the region `position: relative` only in this state). Its resting opacity in this state is 0; the `cd-skeleton-leave` animation (`motion-fast`, `motion-ease`) runs it from 1 to 0, so a layer whose fade can't run is invisible at once. It is removed by a native listener on the layer for `animationend` and `animationcancel` that acts only when `event.target` is the layer and `event.animationName` is `cd-skeleton-leave` (the shapes' sweep events bubble), with a named fallback timer. The layer's background is `bg-app`. |
| (no layer) | `loading` false from mount; or it turned false while `waiting`; or it turned false under reduced motion | `children` only. Under reduced motion, `shown` goes straight here in the same commit, with no fade. |

If `loading` turns true again, the region goes back to `waiting`.

### The frame's shapes (Task 2, in the design system)

Each is built from its component's own classes and tokens, and each has a story that renders it beside the real component, checking that the parts sit within 2 px.
- **`AppShellProps.skeleton?: boolean`:** the compact top bar draws the mark, the business and Menu as shapes. In this mode the column and main area render as `div`s with the same classes, not `aside` and `main`, so the page keeps one `main` (decision 17); the README and story say so. The column and main area are unchanged; they hold whatever `sidebar` and `children` the shell is given.
- **`SidebarSkeleton({ rows, about }: { rows: number; about: number })`:** the lockup (the mark as a block, the wordmark as a line, the badge as a pill), the business row, `rows` page rows (an icon block and a label line, each `size-nav-row`), `about` rows under the About group's title line, and the foot (the Answering switch and its line, then the owner's avatar circle and two lines). The owner app passes the rows it draws (seven until the Connectors pages are built) and its About links' count.
- **`ReviewerBarSkeleton()`:** the bar's ground and hairline, one line and the Reset demo button as a block. It is 36 px, two lines where the real bar wraps on a phone.
- **`PageHeaderSkeleton({ subtitleLines = 1, actions = false, actionsBelowOnPhone = false, hideSubtitleOnPhone = false })`:** `subtitleLines` is `number | { wide: number; phone: number }`, the phone count applying under 640 px as `PageHeader`'s rules do, because a subtitle wraps differently at each width. It draws a `page-title` line, the subtitle's body lines and a `size-control` block for the actions, laid out by `PageHeader`'s own rules at each width.

### Screen-test helpers (Task 2, `web/src/test/`)

```ts
// holdReads.ts: moved from today.screen.test.tsx unchanged; that file then imports it.
export function holdReads(path: string): { held: () => number; release: () => void };

// skeleton.ts
export const SKELETON_TOLERANCE_PX = 2;
export interface SkeletonAnchor {
  /** The shape's `anchor`. */
  name: string;
  /** A CSS selector for the real element it stands for. */
  page: string;
  /** Also compares width and height: a card, a button, the composer. */
  size?: boolean;
}
export interface SkeletonLoad {
  /** The hidden status's words; they also pick the region. */
  status: string;
  anchors: readonly SkeletonAnchor[];
  /** Real elements outside the region that must not move: a button under a list. An element the skeleton draws too, such as a concept footer inside a whole-page region, is an anchor with `size`, not a `stays`. */
  stays?: readonly string[];
  /** Starts the load with its reads held: a render, or a move inside the app. */
  open: () => Promise<void>;
  /** Lets the held reads through. */
  release: () => void;
  /** The region starts `shown`, as at a hand-off, instead of after the wait. */
  continues?: boolean;
}
export async function expectSkeletonLoad(load: SkeletonLoad): Promise<void>;
export async function expectSkeletonStill(load: SkeletonLoad): Promise<void>;
/** Counts animation frames, from the first shown skeleton until the selector's element exists, with no skeleton layer visible. */
export function watchSkeletonGaps(until: string): () => number;
```

`expectSkeletonLoad` asserts these, in order:
1. **The wait.** The region appears, its body with `aria-busy="true"`, its layer `waiting`, invisible, and an empty status. The layer turns `shown` no sooner than `SKELETON_DELAY_MS` after the region appeared, measured by a mutation observer started before `open()`. With `continues`, it is `shown` on the region's first frame instead.
2. **The look.** While `shown`:
   - The status reads `status` exactly and is visually hidden.
   - The layer is `aria-hidden` and `inert`, holds nothing focusable, and holds no text but the concept footer's.
   - Every `.cd-skeleton` computes `background-color` as `fill-hover`, a gradient with transparent ends and a `fill-secondary` centre, and the `cd-skeleton-sweep` animation at 1.6 s, linear, infinite.
   - At one moment, the band's centre in viewport coordinates (its background position plus the shape's left edge) is within 1 px across every shape.
   - Every sweep's `currentTime` is within 17 ms (one frame) of the others'.
3. **The record.** Each anchor's rect and each `stays` element's rect.
4. **The fade.** After `release()`, the layer turns `leaving`:
   - every anchor's real element is already in the DOM under it;
   - it runs `cd-skeleton-leave` at 120 ms;
   - its pointer events are off.
   Then it is removed, `aria-busy` is gone and the status is empty.
5. **Nothing jumps.** Each real element's top and left are within 2 px of its shape's (width and height too, with `size`). Each `stays` element is where it was.

`web/src/test/screen.ts`'s `expectScreenBasics` changes in Task 2: it first waits until no `.cd-skeleton-screen__layer` is in the document, plus one frame, and counts only concept footers outside layers. A test calls `expectScreenBasics` after `expectSkeletonLoad` or `expectSkeletonStill`, never before, because its `holdAtRest` stops every animation for the rest of the test.

`expectSkeletonStill` turns reduced motion on (`reduceMotion(true)` from `web/src/ds/test/reducedMotion.ts`, turned back off when the test finishes). Then:
- the shapes have no running animation and compute `animation-name: none`;
- on `release()`, the layer goes from `shown` to gone with no `leaving` state, and the page's anchors exist in that same frame.

**How tests start a load.** In-app loads first open Today, then hold the page's reads and move there: the sidebar row at 1440, `router.navigate` at 390. Full-page loads hold the Desks read (`ROUTES.desks`) and render the route. That keeps the 200 ms wait deterministic: an in-app region never meets a full-page skeleton it would continue.

### Page skeletons (Tasks 2 to 7)

Each lives beside its page, uses its page's own CSS classes for layout, and marks the shapes the tests compare with `anchor`.
- `owner/OwnerFrameSkeleton.tsx`:
  - `OwnerFrameSkeleton({ pathname }: { pathname: string })`: `AppShell skeleton` with `ReviewerBarSkeleton`, `SidebarSkeleton`, the route's page skeleton and the real `ConceptFooter` in the frame footer's place.
  - `pageSkeletonFor(pathname: string, search: string): { page: ReactNode | null; fill: boolean; centered: boolean }`, always returned. `fill` and `centered` come from the frame's own `FILL_PAGES` and `CENTERED_PAGES`, which `OwnerLayout.tsx` exports. `page` is null for a route with no skeleton (decision 8). Pathnames match exactly, as `opensToday` does: only the Desk root and `/today`, `/conversations` and `/conversations/:id`, `/people`, `/rules` and `/safety` get page shapes, so All rules, a rule draft and a customer's page draw none. `/safety?view=entries` draws none either (Task 4).
- `owner/today/TodaySkeleton.tsx`: `TodaySkeleton()`.
- `owner/conversations/ConversationsSkeleton.tsx`: `ConversationsSkeleton({ withHeader, open }: { withHeader: boolean; open: boolean })` and `ConversationSkeleton()`, the open conversation's pane.
- `owner/people/PeopleSkeleton.tsx`, `owner/rules/RulesSkeleton.tsx` and `owner/safety/SafetySkeleton.tsx`: each `({ withHeader }: { withHeader: boolean })`. `withHeader` is true in the full-page loader (the header drawn as shapes) and false inside the app (under the real header).
- `setup/StepSkeletons.tsx`: `ToolsListSkeleton()`, `DraftRulesSkeleton()`, `SituationsSkeleton()` and `SafetyCheckSkeleton()`.
- In the design system's `PublicShell` folder: `PublicBrandHeaderSkeleton({ hours }: { hours: boolean })` and `PublicShellSkeleton({ language, footer }: { language: CopyLanguage; footer: boolean })`.
- `public/agents/AgentsSkeleton.tsx`: `AgentsSkeleton()`.

## Review Focus

The five conditions most likely to bite a person, each with its test in the task that owns the code:
1. **A first read that fails.** The skeleton ends, and the page's error and "Try again" draw in its place, with no `aria-busy` left behind. Task 1 has the `Fails` story; Task 3 has `customers_failure_ends_the_skeleton`.
2. **A revisit whose reads are cached.** No skeleton, no wait and no blank: the page draws at once. Task 3 has `cached_customers_skip_the_skeleton`.
3. **The full-page loader handing off to a page's own skeleton.** No frame without shapes, no shape moves and the band runs on. Tasks 3 and 4 run a full-page test per page; Task 7 has `deadline_hands_off_to_todays_skeleton`.
4. **A long wait,** such as a live rules draft that takes 10 s or more. It keeps sweeping, its status is announced once, and nothing else changes. Task 5 has `long_draft_keeps_one_status`.
5. **A visitor whose browser asks for Spanish.** The hidden status is in Spanish and no words are drawn. Task 6 has `public_chat_opens_in_spanish`.

---

## Tasks

### Task 1: the Skeleton part and its synced sweep (design system owner)

**Files:**
- `web/src/ds/components/Skeleton/`: `Skeleton.tsx`, `SkeletonScreen.tsx`, `Skeleton.css`, `Skeleton.stories.tsx`, `Skeleton.browser.test.tsx`, `Skeleton.webkit.test.tsx` and `README.md`.
- `web/vitest.config.ts`: a `ds-webkit` project (WebKit only, motion on) that runs `src/ds/components/Skeleton/*.webkit.test.tsx`; and the root `Makefile`, whose web-test target installs `webkit` beside `chromium`. The band's alignment across shapes and after a resize, and the edge pixel sample, are checked in `Skeleton.webkit.test.tsx` and the Chromium browser test, not in a story play.
- `web/src/ds/index.ts`.
- `web/src/ds/tokens.json`, with `tokens.css` regenerated (`npm run tokens`), for `size-skeleton-band`.
- `web/src/ds/README.md` (the motion loops, the one gradient exception, how a page loads).
- `web/src/ds/components/LoadingLine/README.md` ("When to use": the loaders it still covers, Global Constraints, including the pages Tasks 3 to 5 will move to skeletons; Task 3 takes those off in the second PR).

**Interfaces:** produces the Skeleton part, exactly as "Interfaces" defines it. Consumes nothing new.

- [ ] Tests first, one at a time.
  - **Story plays** (`--project storybook`, with motion). Each story says `canvas: 'none'` with a `canvasNote` naming `UXC-P1201-After` (`#artboard-dec46cf506e4`), or `UXC-P1202-After` (`#artboard-d122e70134a0`) for the chat's shapes.
    - `Shapes`:
      - Each line's box is its style's line height, with the table's pill centred in it.
      - Blocks and circles take their sizes and radii.
      - `SkeletonCard` computes the card's 1 px `line-card` border, `fill-card`, 12 px radius and padding.
      - Every shape computes `fill-hover`, is `aria-hidden`, and carries `data-skeleton-anchor` when given `anchor`.
    - `Sweep`:
      - The computed sweep values listed in "Interfaces".
      - The gradient's ends are `transparent` and its centre is `fill-secondary` (decision 16); a capture sampled just outside and just inside the band's edge on `bg-app` shows no step.
      - A shape mounted 300 ms after another has a sweep whose `currentTime` is within 17 ms of the first's.
      - Three shapes at different left edges (one in an indented card) show the band's centre at the same viewport x within 1 px, in Chromium and in WebKit (the `ds-webkit` project), including after the window resizes (decision 10). These two checks live in the browser tests; the story shows the sweep.
    - `Waits`:
      - At mount the layer is `waiting` and invisible, but it already holds its height: a sibling under the region doesn't move when the layer shows. The status is empty and `aria-busy="true"`.
      - It turns `shown`, with the words in the status, no sooner than `SKELETON_DELAY_MS` after mount.
    - `FastLoad`: `loading` turns false at 100 ms. The layer is never `shown` (an attribute observer checks), the children draw, and no `cd-skeleton-leave` runs.
    - `Lands`: `loading` turns false after `shown`.
      - The layer turns `leaving` over the children at the same top-left, and an anchored shape's rect is unchanged across the switch.
      - `cd-skeleton-leave` runs for 120 ms, ease-out, from opacity 1 to 0. The layer is `inert` and its pointer events are off. A button among the children takes a click during the fade.
      - Afterwards the layer is gone, `aria-busy` is gone, the status is empty and the region has no `position`.
    - `Continues`: a `SkeletonScreen` that mounts inside one whose layer is `leaving` is `shown` on its first frame.
    - `Fails`: `loading` turns false with an error `Notice` as the children. The layer leaves as in `Lands`, and the notice is in the region with no `aria-busy`.
    - `Spanish`: under `lang="es"`, the status reads "Abriendo el chat" once shown.
  - **Browser tests** (`--project ds-browser`, which forces reduced motion):
    - `skeleton_is_still_under_reduced_motion`: no shape has a running animation, and each computes `animation-name: none`.
    - `skeleton_leaves_at_once_under_reduced_motion`: when `loading` turns false, the layer is removed in the same commit, with no `leaving` state.
- [ ] Implement as "Interfaces" defines it and the boards draw it. The README covers:
  - when to use it: a page or a part of a page whose first read is out; not an action at work (a busy `Button`), not someone writing (`WritingIndicator`), and not the loaders that keep `LoadingLine`;
  - the line table;
  - the sweep and its phase;
  - the states;
  - building a page's skeleton from its own components' classes;
  - accessibility;
  - how the band lines up across shapes (decision 10).
- [ ] Run:
  - `cd web && npx vitest run --project storybook src/ds/components/Skeleton`
  - `npx vitest run --project ds-browser src/ds/components/Skeleton`
  - `npx vitest run --project unit src/ds/tokens.test.ts`
  - `npm run check:ds`
- [ ] Commit: `feat(ds): add the Skeleton part and its synced sweep for pages that are loading`.
- [ ] Once the task review is clean, the design system owner adds the part to the Design System artifact (the Skeleton card: shapes, the sweep and a `SkeletonScreen` that lands), so canvas boards can import `ClaudeDesk.Skeleton`, `ClaudeDesk.SkeletonCard` and `ClaudeDesk.SkeletonScreen`. The screen tasks need only the code, so the artifact may trail.

**Acceptance:**
- Every story and browser test above passes, along with `npm run check:ds`.
- A story shows the shapes sweeping as one band across the canvas.
- The README and the design system README read as the Global Constraints say.

**Design evidence:**
- The Skeleton stories captured at 1440×900 and 390×844: a contact sheet of the shapes, and a story mid-sweep.
- A recording of `Lands`: wait, sweep, fade.

### Task 2: the owner app opens on its own shape: the frame and Today

**Files:**
- Design system:
  - `web/src/ds/components/AppShell/`: `AppShell.tsx`, `AppShell.css`, `README.md`, `AppShell.stories.tsx`.
  - `web/src/ds/components/Sidebar/`: new `SidebarSkeleton.tsx`, plus `Sidebar.css`, `README.md`, `Sidebar.stories.tsx`.
  - `web/src/ds/components/ReviewerBar/`: new `ReviewerBarSkeleton.tsx`, plus its CSS, `README.md` and stories.
  - `web/src/ds/components/PageHeader/`: new `PageHeaderSkeleton.tsx`, plus its CSS, `README.md` and stories.
  - `web/src/ds/index.ts`.
- Web app:
  - `web/src/owner/OwnerLayout.tsx` (`DeskGate`; `OwnerState` keeps only its error) and `OwnerLayout.css`.
  - New `web/src/owner/OwnerFrameSkeleton.tsx`.
  - New `web/src/owner/today/TodaySkeleton.tsx`, and `web/src/owner/today/Today.css`.
- Tests:
  - New `web/src/test/holdReads.ts` and `web/src/test/skeleton.ts`.
  - `web/src/test/screen.ts`: `expectScreenBasics` waits for skeleton layers to go and counts footers outside them (see "Screen-test helpers").
  - `web/src/test/watch.ts`: `pageNow` names the full-page skeleton's layer, in any state, `loading`; the error `OwnerState` stays `error`.
  - New `web/src/owner/loading.screen.test.tsx`.
  - `web/src/owner/today/today.screen.test.tsx`, which imports `holdReads` and updates the tests that read "Opening your Desk" as visible text.
  - `web/src/owner/arrival.screen.test.tsx`, where it reads the same.

**Interfaces:**
- Consumes the Skeleton part (Task 1).
- Produces the frame's shapes, the screen-test helpers, `OwnerFrameSkeleton`, `pageSkeletonFor` and `TodaySkeleton`, as "Interfaces" defines them.

**What changes:**
- **`DeskGate`.** Wherever it would have drawn the loading `OwnerState`, it now draws one `SkeletonScreen` (status "Opening your Desk", skeleton `OwnerFrameSkeleton` for the current address) around what it draws next: the frame, the error state or not found. The frame fades in over the shapes. While loading, it keeps a `main` labelled by the visually hidden "Claude Desk" heading outside the layer, as the loading `OwnerState` does today (decision 17).
  - Decision 15's accepted case for Today: after the held request is answered, a reload draws Needs you's shape and Today lands without it. `today_reload_after_the_held_request_is_answered` records that one move, so a later change to it is deliberate.
  - Today's read ahead on a reload keeps the skeleton up exactly as long as it kept the loading page, so a reload of Today is one skeleton, then Today drawn. The Demo inbox's first read (`ownerInbox`) joins Today's gate, prefetched beside Needs you within `READ_AHEAD_MS`, because the aside otherwise lands as "Opening your Demo inbox" and changes under the fade; its failure stays the inbox's own, as #186 does for the other reads.
  - The region around the frame must not change the frame's layout; the frame anchors catch it.
- **`TodaySkeleton`** draws the seed's first view at both widths:
  - the greeting and its presence line;
  - the link pill;
  - Things to try's heading, its meta line, and its card of four rows (icon tile, two lines, button);
  - Needs you's heading and one held request's card (the context line, the request, the reason and the two answers);
  - Since last night's heading, its summary lines and three rows;
  - the aside: the public page card, the Demo inbox's button, Last 7 days' heading, figure, line and seven bars, and the two sections under hairlines.
  On a phone, the column stacks as Today's does.
- **`pageSkeletonFor`** returns Today's skeleton on Today's address, and null elsewhere until Tasks 3 and 4.

- [ ] Tests first, in `web/src/owner/loading.screen.test.tsx`, one at a time:
  - `today_reload_after_the_held_request_is_answered` and `reload_with_two_desks_moves_once`: decision 15's accepted moves (Needs you absent; the sidebar's Desk picker present), each recorded as one move.
  - `reload_waits_for_the_demo_inbox`: hold `ownerInbox` alone on a reload of Today; the skeleton stays, then Today lands without a jump.
  - `reload_opens_on_the_frames_shape` at 1440×900 and 390×844.
    - Hold the Desks, Today and Needs you reads, and render `/app/<desk>/today`.
    - Run `expectSkeletonLoad` with status "Opening your Desk".
    - Anchors at 1440, frame: the reviewer bar (size), the sidebar's mark, business row, first and last page rows, and the owner's avatar.
    - Anchors at 390, frame: the reviewer bar (size), the top bar (size), its mark and Menu.
    - Anchors at both widths, Today: the greeting, the link pill (size), Things to try's heading, its card (size), its first and last row tiles, Needs you's heading, the held request's card (top, left, width), Since last night's heading, the public page card (size), Last 7 days' heading and the first bar.
  - `reload_is_still_under_reduced_motion`: `expectSkeletonStill` on the same load at 1440.
  - `other_page_reload_draws_the_frame_alone`: hold the Desks and render `/app/<desk>/share`. The frame's shapes show, the page area is empty and no words are drawn. The real frame fades in.
  - `desks_failure_ends_the_skeleton`: the Desks read fails twice. The error state with "Try again" replaces the skeleton, with no `aria-busy`.
  - In the design system stories: `AppShell › Skeleton`, `SidebarSkeleton`, `ReviewerBarSkeleton` and `PageHeaderSkeleton` each sit within 2 px of the real component rendered beside them, at 1512 and 390.
  - Update the existing tests that expect "Opening your Desk" as visible text, or `.cd-owner-state` while loading, to the hidden status and the new `pageNow`. The sequences `watchPages` records keep their steps.
- [ ] Implement as above and as the boards draw (`#artboard-dec46cf506e4`, `#artboard-1a93c5a1f31f`), following the real page where they differ (decision 1).
- [ ] Run:
  - `cd web && npx vitest run --project screens src/owner/loading.screen.test.tsx src/owner/today src/owner/arrival.screen.test.tsx src/app`
  - `npx vitest run --project storybook src/ds/components/AppShell src/ds/components/Sidebar src/ds/components/ReviewerBar src/ds/components/PageHeader src/ds/boards`
  - `npm run check:ds`
  - `npx vitest run --project unit src/app/guards.test.ts`
- [ ] Commit: `feat(web): open the owner app on its own shape: the frame and Today as skeletons`.

**Acceptance:**
- A reload of any owner page shows nothing for 200 ms, then the frame's shapes, sweeping as one band. On Today's address the frame also draws Today's shapes.
- The frame and Today then fade in on `motion-fast` with nothing moving more than 2 px.
- A fast load goes straight to the page.
- Under reduced motion the shapes are still and the page appears at once.

**Design evidence:**
- The full-page skeleton and the landed Today, captured at 1440×900 and 390×844, each beside its board.
- A recording of a reload of Today at each size, with the reads held about 1.5 s, by DevTools request blocking or an init script that delays `/api/` answers.

### Task 3: Conversations and Customers draw their shape while they load

**Files:**
- `web/src/owner/conversations/ConversationsPage.tsx`, `ConversationDetail.tsx` and `Conversations.css`, plus new `ConversationsSkeleton.tsx`.
- `web/src/owner/people/PeoplePage.tsx` and `People.css`, plus new `PeopleSkeleton.tsx`.
- `web/src/owner/OwnerFrameSkeleton.tsx` (both pages in `pageSkeletonFor`).
- `web/src/ds/components/LoadingLine/LoadingLine.stories.tsx`: its `canvas: 'N-Run2-People-Loading'` changes to `canvas: 'none'`, with a `canvasNote` naming the nearest board that still draws `LoadingLine` (a customer's page or the Demo inbox).
- `web/src/ds/boards/PeopleLoading.stories.tsx` and `web/src/ds/reference/README.md`. The Customers loading board story now draws the skeleton. Its `canvasNote` and the N-Run2-People-Loading row say the loading state follows P12-01 (`#artboard-dec46cf506e4`), which the owner signed on 2026-10-31.
- `web/src/owner/loading.screen.test.tsx`, `web/src/owner/people/people.screen.test.tsx` (`people_loading_then_failure_offers_a_retry`) and `web/src/owner/conversations/conversations.screen.test.tsx`, where they read the loading words.

**Interfaces:** consumes the Skeleton part, the screen-test helpers and `pageSkeletonFor` (Task 2). Produces `ConversationsSkeleton`, `ConversationSkeleton` and `PeopleSkeleton`.

**What changes:**
- **Conversations.**
  - The list's title stays real inside the app. A `SkeletonScreen` ("Reading your conversations") holds everything under the title until the list read settles: the recorded-history caption (a caption line, since a fresh copy replays recorded history), the failure notice's place and the list, as day headings and `ConversationListItem` rows filling the column. The caption depends on the list read, so it sits inside the region, never above it.
  - With a conversation in the address, `ConversationDetail` holds its pane the same way ("Opening the conversation") with `ConversationSkeleton`: the header line and a few messages in the reading column, a visitor's bubble at the right and Claude's lines at the left, each with a receipt line. Its readiness includes the Needs you read as well as the transcript, since the pane draws held requests from it (`ConversationDetail.tsx`); a test holds Needs you alone, with the transcript ready, and checks the pane keeps its skeleton, then lands without a jump, and lands on its error when Needs you fails.
  - In the full-page loader, `ConversationsSkeleton({ withHeader: true, open })` draws the title too, on the fill page's columns.
- **Customers.**
  - The header stays real inside the app. A `SkeletonScreen` ("Loading your customers") holds everything under it until the people read settles: the section heads and the seed's `PersonRow` and `LeadRow` rows.
  - Nothing real sits under the region but the frame's footer, which `stays`.
  - The failure path keeps its `ReadFailed` notice and "Try again".

- [ ] Tests first, one at a time:
  - `conversations_without_recorded_history_moves_once`: decision 15's accepted move when a copy has no recorded history (the caption absent).
  - `conversations_load_in_place` and `customers_load_in_place`, at 1440×900 and 390×844: in-app loads through `expectSkeletonLoad`.
    - Conversations' anchors: the first day heading, the first and last rows in view (size), and with a conversation open, its header and first message.
    - Customers' anchors: the first section head, the first and last rows (size). `stays`: the frame's concept footer.
  - `conversations_still_under_reduced_motion` and `customers_still_under_reduced_motion`: `expectSkeletonStill` at 1440.
  - `customers_reload_hands_off`, at 1440 and 390:
    - Hold the Desks and the people read, and render Customers.
    - The full-page skeleton draws Customers' header and rows. Release the Desks: the frame lands, and Customers' own skeleton continues at once (`continues: true`).
    - Its rows' shapes sit within 2 px of the full-page skeleton's. `watchSkeletonGaps` counts 0 frames without a skeleton until the rows land.
  - `conversation_reload_hands_off` at 390: the same, for an open conversation's address.
  - `customers_failure_ends_the_skeleton`: the people read fails twice. The skeleton leaves, the failure notice and "Try again" draw, and `aria-busy` is gone. "Try again" reads it again.
  - `cached_customers_skip_the_skeleton`: open Customers, go to Today, come back. No skeleton layer ever mounts on the way back (a mutation watcher checks), and the rows draw at once.
  - Update `people_loading_then_failure_offers_a_retry` and any Conversations test that reads the loading words as visible text to the hidden status.
- [ ] Implement as above.
- [ ] Run:
  - `cd web && npx vitest run --project screens src/owner/loading.screen.test.tsx src/owner/people src/owner/conversations`
  - `npx vitest run --project storybook src/ds/boards/PeopleLoading.stories.tsx`
  - `npx vitest run --project unit src/app/guards.test.ts`
- [ ] Commit: `feat(web): draw Conversations and Customers as their own shapes while they load`.

**Acceptance:**
- Both pages, and an open conversation, load as the Global Constraints say, inside the app and from a reload, with no blank between the frame's skeleton and the page's.
- No real content moves more than 2 px when the page lands.
- A cached revisit and a failed read behave as Review Focus 1 and 2 say.

**Design evidence:**
- Each page's skeleton and landed state at 1440×900 and 390×844, including an open conversation.
- A recording of each page's in-app load, and of a reload of Customers at 1440×900.

### Task 4: Rules and Safety draw their shape while they load

**Files:**
- `web/src/owner/rules/RulesPage.tsx` and `RulesPage.css`, plus new `RulesSkeleton.tsx`.
- `web/src/owner/safety/SafetyPage.tsx` and `Safety.css`, plus new `SafetySkeleton.tsx`.
- `web/src/owner/OwnerFrameSkeleton.tsx`.
- `web/src/owner/loading.screen.test.tsx`, plus `web/src/owner/rules/rules.screen.test.tsx` and `web/src/owner/safety/safety.screen.test.tsx` where they read the loading words.

**Interfaces:** consumes as Task 3. Produces `RulesSkeleton` and `SafetySkeleton`.

**What changes:**
- **Rules.**
  - Inside the app, the header, Ask Claude's composer and its chips stay real.
  - One `SkeletonScreen` ("Reading your rules") holds everything under them until the rules and suggestions reads settle, and the people read too, since `hubSections` reads it. That covers the suggested rule cards the seed shows, the connector sections with their tool rows and the payment limit's line, "See all rules", and the always-on rules, which move inside the region so nothing real sits under it.
  - In the full-page loader, `withHeader` adds the header, the composer and the chips as shapes. On a phone, the header follows `PageHeader`'s phone rules, with the actions below and no subtitle.
- **Safety.**
  - The header stays real inside the app.
  - In the attempts view, one `SkeletonScreen` ("Reading the attempts") holds the headline, the bar and the attempts until the attempts read, Today's read (the headline's week), the record (ledger) read and the health read settle. The health read counts because the check line adds its development-key paragraph from it (`ChainStatus`), and a fresh copy's mock reports that key. The ledger counts because the open attempt's detail draws from it (`AttemptDetail.tsx`: its replay label and conversation link) and the record's check line can wrap at 390. The headline is the one `cd-type-summary` paragraph `.cd-safety__headline` (`SafetyPage.tsx`), drawn as summary lines at its responsive line count; there is no separate figure. The bar draws the segmented control and the check line's place.
  - The check line has no region of its own (decision 7).
  - The entries view (`?view=entries`) keeps today's loading as it is. The region stays at the same place in the tree in both views, with `loading={view === 'attempts' && !ready}`, so a view switch never remounts the bar or drops the segmented control's focus; the attempts read stays mounted in the entries view, so switching back doesn't bring the skeleton back. In the full-page loader, `pageSkeletonFor` returns no page shapes for the entries view. A test reloads `/safety?view=entries` and checks no attempt shapes draw.

- [ ] Tests first, one at a time:
  - `rules_after_a_suggestion_is_taken_moves_once`: decision 15's accepted move (one suggested rule card fewer).
  - `safety_view_switch_keeps_focus`: arrow from Attempts to Entries and back; focus stays on the segmented control's chosen option, and switching back draws no skeleton.
  - `rules_load_in_place` and `safety_load_in_place`, at 1440×900 and 390×844, through `expectSkeletonLoad`.
    - Rules' anchors: the first suggested rule card (size), the first connector section's head, its first tool row, "See all rules", and the always-on rules' heading.
    - Safety's anchors: the headline paragraph (`.cd-safety__headline`), the segmented control (size), the first and last attempt rows in view (size), and at 1440 the open attempt's title.
    - With only the ledger held at 390, a recorded attempt whose detail shows the replay label keeps the skeleton until the ledger settles, then lands without a jump.
  - `safety_waits_for_the_record_and_health`: at 390, hold only the ledger read, then only the health read. Each time the whole region keeps its skeleton until that read settles, then lands without a jump, the check line with its development-key paragraph included. When either read fails for good, the page lands on its own error for that part, with no `aria-busy` left.
  - `rules_still_under_reduced_motion` and `safety_still_under_reduced_motion`: `expectSkeletonStill` at 1440.
  - `rules_reload_hands_off` and `safety_reload_hands_off`, at 1440: as in Task 3, with `watchSkeletonGaps` at 0.
  - Update the Rules and Safety tests that read the loading words as visible text.
- [ ] Implement as above.
- [ ] Run:
  - `cd web && npx vitest run --project screens src/owner/loading.screen.test.tsx src/owner/rules src/owner/safety`
  - `npx vitest run --project unit src/app/guards.test.ts`
- [ ] Commit: `feat(web): draw Rules and Safety as their own shapes while they load`.

**Acceptance:**
- Both pages load as the Global Constraints say, inside the app and from a reload.
- Safety lands once every read its first view draws from has settled, the record and health included, without moving anything.
- No real content moves more than 2 px.

**Design evidence:**
- Each page's skeleton and landed state at 1440×900 and 390×844.
- A recording of each page's in-app load.

### Task 5: setup's steps draw their shape while they load

**Files:**
- `web/src/setup/SetupPage.tsx` (the interview's read), `ToolsStep.tsx`, `RulesStep.tsx` (draft and situations; the draft's readiness includes the people read, which puts customers' names in its rows, and a test holds people alone with the draft ready, including its failure), `SafetyStep.tsx` and `SetupPage.css`.
- New `web/src/setup/StepSkeletons.tsx`.
- New `web/src/setup/loading.screen.test.tsx`, and `web/src/setup/setup.screen.test.tsx` where it reads the loading words.

**Interfaces:**
- Consumes the Skeleton part, `PageHeaderSkeleton` and the screen-test helpers.
- Produces `ToolsListSkeleton`, `DraftRulesSkeleton`, `SituationsSkeleton` and `SafetyCheckSkeleton`.

**What changes.** Setup's bar stays real throughout.
- **The interview's read** ("Opening your setup"): a `SkeletonScreen` in the column with `PageHeaderSkeleton`. Every step opens with a `PageHeader`. When the step mounts with its own read still out, its region continues at once (decision 4).
- **Tools** ("Reading your tools"): `SetupToolsList`'s groups and rows as shapes. "Continue" stays real under the region and `stays`.
- **Your rules** ("Drafting your rules"): the draft's groups of rules, with a main button under them.
- **Real situations** ("Trying real situations on your draft rules"): a card of `SituationRow` shapes and "Looks right" as a block.
- **Safety check** ("Trying tricks people use on your draft rules"): one region while the draft or the check is out. It draws the count (a `summary` line), the lead line, `SafetyCheckRow` shapes at their 90 px and the actions.
- When the check's rows arrive, the skeleton fades as they start landing one by one (P6-01, from #190), and the count ticks as it does now.
- The live drafting waits can take many seconds. The region keeps sweeping and its status is announced once.

- [ ] Tests first, one at a time:
  - `setup_steps_load_in_place` at 1440×900 and 390×844, for the tools, rules, situations and safety steps, each with its read held, through `expectSkeletonLoad`. Anchors: the step's header title, the first and last rows in view (size) and the main button (size). For tools, `stays`: "Continue".
  - `setup_reload_hands_off`, at 1440: hold the interview and the tools reads, and render a setup at the tools step. The header shapes hand off to the tools list's skeleton with `watchSkeletonGaps` at 0. The header lands real while the list keeps sweeping.
  - `safety_check_lands_under_the_fading_skeleton`: once the check is released, the first row's landing animation starts while the layer is `leaving`, and the count reads the check's final words when the rows have landed.
  - `long_draft_keeps_one_status` (Review Focus 4): hold the draft 2 s. The layer stays `shown`, the status text is set once and unchanged (a mutation watcher counts one change), and nothing else on the page changes.
  - `setup_steps_still_under_reduced_motion`: `expectSkeletonStill` on the rules step at 1440.
  - Update the setup tests that read the loading words as visible text.
- [ ] Implement as above.
- [ ] Run:
  - `cd web && npx vitest run --project screens src/setup`
  - `npx vitest run --project unit src/app/guards.test.ts`
- [ ] Commit: `feat(web): draw setup's steps as their own shapes while they load`.

**Acceptance:**
- Each step loads as the Global Constraints say, and a reload mid-setup has no blank between the header's shapes and the step's.
- The safety check's rows still land one by one with the count ticking.
- No real content moves more than 2 px.

**Design evidence:**
- Each step's skeleton and landed state at 1440×900 and 390×844.
- A recording of the safety check loading and its rows landing.

### Task 6: the public chat and the agents page draw their shape while they open

**Files:**
- Design system: `web/src/ds/components/PublicShell/` (new `PublicShellSkeleton.tsx` and `PublicBrandHeaderSkeleton.tsx`, plus `PublicShell.css`, `README.md` and `PublicShell.stories.tsx`), and `web/src/ds/index.ts`.
- Web app:
  - `web/src/public/PublicChat.tsx` (the `desk === null` opening branch; `not_found` and `unavailable` keep `PublicState`) and `PublicChat.css`.
  - `web/src/public/agents/AgentCardPage.tsx` (`AgentsState`'s opening; not found and unavailable keep their layout) and `AgentCardPage.css`, plus new `AgentsSkeleton.tsx`.
- Tests: new `web/src/public/loading.screen.test.tsx`, and `web/src/public/agents/agents.screen.test.tsx`, whose retry tests read "Opening the page for AI agents" as visible text.

**Interfaces:**
- Consumes the Skeleton part and the screen-test helpers.
- Produces `PublicShellSkeleton`, `PublicBrandHeaderSkeleton` and `AgentsSkeleton`. `PublicChat` passes its `language` to `SkeletonScreen`'s `lang`, so setup's preview reads a Spanish status as Spanish.

**What changes:**
- **`PublicBrandHeaderSkeleton`:** the header at `size-brand-header` on `bg-panel`, since the business's colours aren't known yet, with the 40 px monogram as a block and the name and tagline as lines. With `hours`, it also draws the opening-hours status: on the name's row above 640 px, and on its own row below, as `PublicShell.css` places it, so the phone header has the real header's height. A fresh copy's Desk has opening hours, so the skeleton draws the open status as one caption line (decision 15). Tests cover the open, closed and no-hours headers in English and Spanish at 390: open matches within 2 px; closed and no-hours record the accepted one-line difference.
- **`PublicShellSkeleton`:** built from `PublicShell`'s own classes and measurements, so each part sits where the shell puts it at every width, short windows included. It draws:
  - the brand header's shape;
  - the chat head (the title, the disclosure and "Ask for", as shapes);
  - the empty conversation;
  - the composer's box at its real size and radius, with one placeholder line;
  - from 900 px, the about column: its heading, a card and the two agents links, as shapes;
  - with `footer`, the real `ConceptFooter` (`poweredBy`) where the shell draws it.
  When the greeting and starter chips (P1-02) are on `main`, it draws them where P1-02 places them, as the board does; until then it leaves them out (decision 11).
- **The public chat.** `PublicChat` shows the skeleton in a `SkeletonScreen` (`copy.opening`, in the browser's language) while the chat opens. Embedded in setup's preview step, it draws with `footer` false inside the preview column.
- **The agents page.** `AgentsSkeleton` draws the brand header's shape with `hours={false}`, since the agents page's header never shows opening hours (`AgentCardPage` passes no `openStatus`); the chat passes `hours`. It then draws the back link, the title, the disclosure, the "Send an agent" card with its limit panel and chips, and the cards after it, in `size-agents-column`, with the real `ConceptFooter`.
  - The "Try again" focus rule is unchanged in what the reader gets: the new "Try again" takes focus back after a second failure. Its "had focus" flag moves from `AgentsState` to `AgentCardPage`'s `retry`, because `AgentsState` unmounts while the skeleton shows and would forget it.
- Nothing on either skeleton states anything (decision 12). The real AI disclosure is part of the page that fades in.

- [ ] Tests first, one at a time:
  - `public_chat_opens_in_place` at 1440×900 and 390×844: hold the chat's opening reads and run `expectSkeletonLoad` with "Opening the chat".
    - Anchors: the brand header (size), the chat head's title and disclosure, the composer (size), the concept footer (size), and at 1440 the about column's heading.
    - The layer's only text is the footer's.
  - `public_chat_opens_in_spanish` (Review Focus 5): at 390 with `language: 'es-MX'`, the status reads "Abriendo el chat" and the layer draws no words but the footer's.
  - `setup_preview_opens_in_place`, at 1440: setup's preview step with the chat's opening held. The skeleton sits inside the preview column with no footer of its own, then the chat lands.
  - `agents_page_opens_in_place` at 1440×900 and 390×844, with "Opening the page for AI agents". Anchors: the brand header (size), the back link, the title, the disclosure, and the "Send an agent" card (size).
  - `public_chat_still_under_reduced_motion` and `agents_page_still_under_reduced_motion`: `expectSkeletonStill` at 390 and 1440.
  - Story `PublicShell › Skeleton`: at 390, 1280 and a short 390×480 window, each part sits within 2 px of `PublicShell`'s.
  - Update the agents page's retry tests to the hidden status. Their focus assertions stay as they are.
- [ ] Implement as above and as the board draws (`#artboard-d122e70134a0`), following the real page where they differ.
- [ ] Run:
  - `cd web && npx vitest run --project screens src/public src/setup`
  - `npx vitest run --project storybook src/ds/components/PublicShell src/ds/boards`
  - `npm run check:ds`
  - `npx vitest run --project unit src/app/guards.test.ts`
- [ ] Commit: `feat(web): draw the public chat and the agents page as their own shapes while they open`.

**Acceptance:**
- A visitor's first sight after 200 ms is the chat's shape, sweeping, with the real footer.
- The chat then fades in where the shapes were, in English and Spanish, on its own page and inside setup's preview.
- The agents page opens the same way.
- Nothing on either skeleton states anything.

**Design evidence:**
- The chat's skeleton and landed chat at 1440×900 and 390×844, the phone beside its board.
- The agents page's skeleton and landed page at both sizes.
- A recording of the chat opening at 390×844 and of the agents page opening at 1440×900.

### Task 7: the one-step reload and Today's own hold show Today's skeleton (after #186)

**Precondition:** none: #186 is on `main` (008636e3). Build on its gate as it is:
- keep #186's gate (which reads, the 3 s deadline, `useTodayOpening`, `reachPlace` and its visually hidden "Today" heading);
- keep this plan's `SkeletonScreen` around what `DeskGate` draws.
This task lands in the first design PR (see Landing).

**Files:**
- `web/src/owner/today/TodayPage.tsx`: #186's `opening` branch.
- `web/src/owner/useDesks.ts`, only if Today's opening needs it.
- `web/src/test/watch.ts`: `pageNow` names Today's own skeleton.
- `web/src/owner/loading.screen.test.tsx` and `web/src/owner/today/today.screen.test.tsx` (#186's tests).

**Interfaces:** consumes `TodaySkeleton`, the Skeleton part and the screen-test helpers.

**What changes:**
- **Today's own hold.** While #186's `opening` is true, `TodayPage` draws a `SkeletonScreen` ("Opening your Desk") with `TodaySkeleton` instead of the loading line, and its visually hidden `h1` stays outside the layer. This covers a Desk switch and a move from another page.
- **The reload.** The one-step reload is the full-page skeleton from Task 2, kept up for as long as #186 keeps its loading page. If the deadline passes with Today's reads still out, the frame lands and Today's own skeleton continues at once, with the same shapes in the same place.

- [ ] Tests first, one at a time:
  - `switching_desks_opens_on_todays_shape`, at 1440 and 390, through `expectSkeletonLoad`, with Today's anchors from Task 2.
  - `reload_is_one_skeleton_then_today`: #186's reload, with `watchPages` showing one loading step, then Today. No Today-only skeleton mounts in between.
  - `deadline_hands_off_to_todays_skeleton` (Review Focus 3): Needs you held past the deadline. The full-page skeleton hands off to Today's own (`continues: true`), with `watchSkeletonGaps` at 0 and Today's shapes within 2 px across the switch.
  - `switching_to_a_desk_already_read_skips_the_skeleton`: no layer mounts.
  - `todays_hold_still_under_reduced_motion`: `expectSkeletonStill` on a Desk switch at 1440.
  - #186's own tests pass, with their loading words read as the hidden status.
- [ ] Implement as above.
- [ ] Run: `cd web && npx vitest run --project screens src/owner/loading.screen.test.tsx src/owner/today src/owner/arrival.screen.test.tsx`.
- [ ] Commit: `feat(web): show Today's own shape for the one-step reload and while Today opens`.

**Acceptance:**
- A reload of Today is one skeleton, then Today.
- A Desk switch shows Today's shape after 200 ms, then Today in place.
- A deadline that passes hands off with no gap and no movement.

**Design evidence:**
- Today's own skeleton inside the real frame at 1440×900 and 390×844.
- A recording of a Desk switch and of a slow reload past the deadline.

## Landing

Two stacked design PRs, in order of value, so the signed boards ship first:
- **First PR** (`plan/08c-skeleton-loading`, `feat(web): open the owner app and the public chat on their own shape while they load`): Tasks 1, 2, 6 and 7. It carries all three signed boards: the owner app's reload with Today, and the visitor's chat. Task 1 is the design system owner's, built in parallel.
- **Second PR** (`plan/08c-skeleton-loading-pages`, stacked on the first with `gh stack`, `feat(web): open the owner app's other pages and setup on their own shape`): Tasks 3, 4 and 5, which have no board of their own (decision 9). It rebases when the first merges.
- **Cut line.** If the second PR slips, its pages keep `LoadingLine`, and `LoadingLine`'s README lists them.
- **Captures.** The description carries every task's design evidence, captured after testing by the agent that tested it, through `pr-media` as AGENTS.md's "Design PRs" describes:
  - screenshots at 1440×900 and 390×844 of each screen's skeleton and landed page, Today and the public chat beside their boards;
  - a recording of each load.
- **Gates.** The review panel (Opus 5.5 and GPT-6.1 Sol; the Fable seat is paused), the design system reviewer's review of the design system parts, green CI, and the project owner's sign-off before merge.

## Review Ledger

Ruling (Task 7): past #186's 3 s deadline the frame lands and Today's own skeleton continues until Today's reads settle (decision 7); #186's two tests updated to that sequence.

Ruling (Task 2): the link pill's width is data-dependent (random slug); its position and height land, its width changes once.

**Plan review, round 1** (Opus 5.5 and GPT-6.1 Sol; the Fable seat is paused). Changes:
- **The sweep lines up on every browser** by each shape's measured offset, not a fixed background, which iOS Safari ignores (decision 10). Task 1's `Sweep` story checks it in WebKit too. The ancestor rule about transforms and containment is gone.
- **The band's ends are transparent** (decision 16), named in the design PR as the one correction to the boards.
- **A skeleton draws a fresh copy's first view** (decision 15), with each data-dependent part listed and acceptance scoped to a fresh copy.
- **The status sits outside the busy element:** the region holds the status, then a busy body. The full-page loader keeps its `main` and hidden heading (decision 17). The public chat's status carries its language.
- **Readiness includes secondary reads** (decision 7): Safety's record read (no early landing for the check line), the open conversation's Needs you read and setup draft's people read, each with a held-read test.
- **`pageSkeletonFor` takes the search string,** always returns `fill` and `centered`, and matches exact pathnames. Safety's entries view draws no attempt shapes.
- **Smaller fixes:** the screen basics helper waits for layers to go and runs after the skeleton checks; the leaving layer rests at opacity 0 and its removal ignores bubbled sweep events; `inert` is set by attribute; `subtitleLines` takes a wide and a phone count; Conversations' region starts under the title, caption included; whole-page footers are sized anchors; `LoadingLine`'s stories move off the Customers board; the public header draws its opening-hours row; the agents page's "Try again" focus flag moves to `AgentCardPage`; Safety's headline anchor is its summary paragraph.
- **Landing:** two stacked design PRs, the signed boards first (Tasks 1, 2, 6 and 7), then Tasks 3 to 5, with a cut line. #186 is on `main`, so Task 7 has no precondition.

**Plan review, round 2.** Round 1's P1 is resolved: the band lines up by measured offsets, checked in Chromium and WebKit. Fixed from round 2:
- Safety's old early-landing test is replaced by one that waits for the record and health reads, since both shape the check line. A fresh copy's mock reports the development key, so health counts.
- `PublicBrandHeaderSkeleton` takes `hours`: the chat draws the opening-hours row, and the agents page, whose header never shows it, doesn't.
- The public chat's footer is a sized anchor, not a `stays`.
- Today's gate also reads the Demo inbox, so the aside doesn't land as a loading line after the fade; the Demo inbox's open sheet keeps `LoadingLine`.
- Safety's region keeps one place in the tree in both views, so switching views keeps the segmented control's focus.
- The WebKit alignment check runs in a new `ds-webkit` project, and CI installs WebKit.
- The build order follows the landing: Tasks 2, 6 and 7 first, then 3 to 5 on a stacked branch.
- Decision 15's accepted moves each have a test; `AppShell`'s skeleton mode draws no second `main`; leftover wording from the fixed background and the old `aria-busy` placement is gone; decisions 16 and 17 name what they turn down.

Round 2 raised no P1, so the plan review ends here (round cap); these fixes weren't re-reviewed.
