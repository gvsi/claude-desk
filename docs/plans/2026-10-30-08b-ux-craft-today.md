# Claude Desk Prototype — Plan 08b: UX craft on Today

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill: a fresh implementer and a task review per task, in this plan's worktree (`.worktrees/08b-ux-craft-today`, branch `plan/08b-ux-craft-today`), landing through one design PR after the review panel. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three changes on Today, which the project owner signed on the design canvas on 2026-10-30.
- The Desk link's copy button visibly says it copied.
- Answering a held request lands instead of swapping in one frame.
- Things to try ticks off each thing as it's done, instead of removing it.

**Architecture:**
- Two design system components gain a state: `Greeting` shows "Copied", and `ApprovalCard` animates from held to answered.
- Today wires the first.
- Things to try (`web/src/owner/arrival/ThingsToTry.tsx`) gains a done state per row, computed from reads the owner app already has. No API or kernel change: the API lead confirmed the four signals come from existing reads (2026-10-30).
- Motion uses the design system's tokens, and the base stylesheet stops it under reduced motion.

**Tech stack:** the web app's toolchain as plan 04 pins it, and the design system's as plans 03a and 03b do. No new dependencies.

**Spec / plans:** `docs/specs/2026-10-28-claude-desk-design.md` ("Design system v2 (locked)"); plan 04 (Global Constraints, Today); plans 03a and 03b (component rules, stories, board checks); `web/src/ds/README.md`.

**Signed boards** (canvas page "UX craft proposals", `#page-54f7c3a5c3cf`; signed by the project owner on 2026-10-30, as drawn):
- P2-01, Things to try ticks off: `UXC-P201-Before` (`#artboard-9518b456a575`) and `UXC-P201-After` (`#artboard-bd77a87643a0`).
- P2-02, the answer lands: `UXC-P202-Before` (`#artboard-77469d4a302e`) and `UXC-P202-After` (`#artboard-29c2c26976df`).
- P2-03, Copied: `UXC-P203-Before` (`#artboard-58f03f543b85`) and `UXC-P203-After` (`#artboard-b61b4190cb78`).

Spec note: the UX craft review's note (craft-2026-10-30-1840.md, kept outside the repository). Where the note and this plan differ, this plan wins.

**A signed decision changes.** N-Today-Empty-Run1's decision 1 says "'Answer a held request' in Things to try waits until something is held". The project owner approved changing its second half on 2026-10-30 (P2-01, as drawn): the row still waits until something is held, but once answered it stays, ticked, instead of leaving. Nothing else in that decision changes: Needs you and Live now still don't show when empty.

## Global Constraints

The master plan's Global Constraints apply as plan 04 copies them. Specific to this plan:

- **Signed words.**
  - New copy: "Copied"; "Done"; "Done. Your answer went to the visitor's chat."; "{n} of 4 done. No real customer sees any of it."; "All 4 done. No real customer sees any of it."
  - Each finished row gets a short line in the same plain voice: "Done. You chatted as a customer.", "Done. Safety shows what was stopped.", "Done. Your answer went to the visitor's chat." and "Done. Your new Desk is live."
  - The ApprovalCard's state words stay the signed ones (N-Answers-TwoButtons, option 2).
- **Tokens only.** No raw colour, duration or easing in a design system component or a screen. The design system guards (`no_raw_colors_outside_tokens`, `no_raw_durations`, `reduced_motion_covers_animation`) and `app/guards.test.ts` stay green. Timers in TypeScript are named constants, not literals in calls.
- **Status by words, not colour alone.** The Done pill pairs a handled `StatusDot` with "Done". The answered card keeps its state words beside its dot.
- **No fake progress.** A row ticks only on what the reads show the owner did in this copy, never on replayed history (`replayed` rows, the seed's own stopped reply or approval) and never on a click alone.
- **Reduced motion.** Every animation stops under `prefers-reduced-motion: reduce` (the base stylesheet). The end states draw directly.
- **Design system process.** Each design system change updates the component's README, its stories and its tests. A story names its board in `parameters.canvas` when the board is in the design system's reference list (`web/src/ds/reference/boards.ts`). The UX craft boards (`UXC-*`) aren't in that list, so their stories say `canvas: 'none'` with a `canvasNote` naming the UXC board, as `web/src/ds/reference/README.md` allows. The board stories that mount it keep passing. the design system reviewer reviews the design system parts in the PR.
- **Coordination.** PR #105 (`design/vision-pieces`) adds `inertAnswers` to `ApprovalCard`. Whichever lands second rebases, and this plan's answered-state animation must not run on an inert card. PR #92 (Settings, with Delete this Desk) has merged, so the plan branch starts from current `origin/main`. Task 3 reads Desks through the existing hook and adds no new read.
- **Viewports.** 1440×900 and 390×844, with no horizontal scroll or clipped text. QA compares with the boards at 1512.
- Git: small conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Tasks

### Task 1: the Desk link says Copied (P2-03)

**Files:** `web/src/ds/components/Greeting/{Greeting.tsx,Greeting.css,README.md,Greeting.stories.tsx}`; `web/src/owner/today/TodayPage.tsx`; `web/src/owner/today/today.screen.test.tsx`.

- [ ] Tests first:
  - A Greeting story with `link.copied: true` shows "Copied" in the pill and the check icon.
  - The pill's width is unchanged from `copied: false` (measured).
  - The icon button's label stays "Copy your Desk link".
  - In `today.screen.test.tsx`: after a successful copy, the pill reads "Copied", then the link again after `COPIED_FOR_MS`. A failed copy shows no "Copied", and the existing screen-reader status line keeps its words.
- [ ] Implement as the board draws (`UXC-P203-After`).
  - `link` gains `copied?: boolean`.
  - When true, the copy icon gives way to a check and the link's words to "Copied" in `text-primary`, crossfading in `motion-fast`. The button presses in on `:active` (`scale(0.97)`, `motion-fast`). The pill keeps its width: the label is laid over the link's words, not swapped for shorter text.
  - Today sets it for `COPIED_FOR_MS = 1600`, then clears it. Each successful copy restarts the timer, and unmounting clears it.
  - The "Copied" words and the check are `aria-hidden`. The existing screen-reader status line speaks.
- [ ] Run the Greeting stories (`npx vitest run --project storybook src/ds/components/Greeting`), `npm run check:ds` (the design system guards, plus every story under reduced motion) and `npx vitest run --project screens src/owner/today`.
- [ ] Commit: `feat(ds): let the greeting's link say Copied after a copy`.

### Task 2: answering a held request lands (P2-02)

**Files:** `web/src/ds/components/ApprovalCard/{ApprovalCard.tsx,ApprovalCard.css,README.md,ApprovalCard.stories.tsx}` and its tests; `web/src/owner/approvals/HeldRequest.tsx`; `web/src/owner/today/NeedsYou.tsx` and `TodayPage.tsx` (its held filter); `web/src/owner/conversations/ConversationDetail.tsx` (`renderHeld`); `web/src/owner/today/today.screen.test.tsx` and the conversations screen test.

**The project owner's decision (2026-10-30, through the UX craft reviewer's questions): "Stay in its slot."** A request answered on Today settles where it was answered in Needs you, with Dismiss under it. The "Answered just now" heading goes. In a conversation it settles in its slot, as it does now.

**One card from held to answered.** Today and a conversation both replace the held card with a new answered one, so an animation inside `ApprovalCard` alone would never run:
- On Today, `TodayPage` filters answered requests out of `held`, and `NeedsYou` mounts them as `AnsweredRequest` under "Answered just now".
- In a conversation, `renderHeld` swaps `HeldRequest` for `AnsweredRequest`, a different component type, so React remounts the card.

The change:
- `HeldRequest` renders every request held or answered in this view as one `ApprovalCard` instance, from held to its final state. It reads `answers.answered` for its own decision, and renders `DraftedRule` for an answered entry that drafted a rule. `AnsweredRequest` is removed. `answers.answered` lives in each screen's memory, so no reload or Demo inbox link ever mounts a card already answered. The one real case is a conversation moving a held card into its row once the hold's receipt arrives (`OwnerTranscript.tsx`). There, `HeldRequest` mounts with the answer already given and draws it without animation.
- **The settled item is the card, then the drafted-rule notice when there is one, then Dismiss.** They fade in with the answered layer, inside the region whose height is measured and eased, so nothing below jumps for a frame. The measured wrapper sits on `HeldRequest`'s item, not inside `ApprovalCard`, or the card gets a footer slot. Either is fine as long as everything under the card is inside the eased height.
- Today's Needs you shows one list: the held requests and those answered here, oldest first by `held_at`, each keyed by `decision_id`, then the callbacks. It renders the list while open plus answered-here is above zero, not only while something is open. Otherwise answering the only held request, the seeded case, would unmount the card. A request answered here shows its final line with Dismiss under it. The section's count still counts only what's open. Dismiss's focus rule (the next answered card, else the one before, else the section) and "Open the request" work over that one list.
- `renderHeld` renders `HeldRequest` for both states of a request answered here.

- [ ] Tests first:
  - Through the real screens (the `screens` project runs with motion):
    - On Today, answering the seeded hold with "Allow this time" keeps the same card element in the same place (element identity before and after). It shows "You allowed this. It's done." with Dismiss under it, and no "Answered just now" heading. Once the card settles, the section after Needs you ends higher by the held item's height minus the settled item's height (card, drafted rule, Dismiss), and it moves in one direction only, eased, never jumping. After an "Always" answer the settled item (card, drafted rule, Dismiss) can be taller than the held one, and then the section moves down, eased.
    - The same on Today and in a conversation for an "Always" answer, which adds the drafted-rule notice under the card.
    - In a conversation, the same card element settles in its slot.
  - In ApprovalCard story plays (`--project storybook`, which runs with motion; name the stories, for example `AnswerLands` and `DenyLands`). `ds-browser` forces reduced motion, so only the end-state-at-once assertion goes there:
    - While the card settles, the held and answered layers cross, and its height eases from the held height to the answered height.
    - From the first frame, the outgoing layer is `inert` and `aria-hidden="true"`. A single `role="status"` node changes its text in place. The focus rescue that today waits for focus to fall to `body` won't fire, because an inert button keeps focus until the next frame. So the outgoing layer must never hold focus. Either it's drawn as a fresh, inert copy and the focused button leaves with the commit that lands the answer, or focus moves first. Either way, the status line takes focus before paint.
    - At the end, the answers row is gone from the accessibility tree and from the height, and the state words read as signed.
  - Tone, from the returned decision:
    - Allow ends handled with one pulse.
    - Deny ends refused with one pulse.
    - An unknown outcome keeps its held dot and gets no pulse.
    - A late answer (409 `expired`) reaches its final line with that state's tone.
  - A card that mounts already answered (a reload) draws its answered state with no animation.
  - Under reduced motion, nothing animates and the end state draws at once.
  - Keyboard: after answering with Enter, focus is where the README's current rule puts it, checked once the transition has finished (animations done, plus one frame), not right after the answer.
  - Update the existing tests that expect "Answered just now".
- [ ] Implement as the board draws (`UXC-P202-After`), only when the answer is given on this card in this view. `answeredHere` now survives because the instance does.
  1. The chosen answer presses in (`scale(0.97)`, `motion-fast`).
  2. The held content fades out (`motion-fast`) as the answered content fades in (`motion-base`, emphasis ease).
  3. The dot's tone comes from the returned decision throughout (`receiptTone`): handled, refused or held. It pulses once (scale 1 to 1.8 to 1 over `motion-base`), only when its tone changes from held. An unknown outcome stays held, with no pulse.
  4. The card's height eases to its answered height (`motion-base`, emphasis ease), so the next section glides up. It animates through a measured `height` on a wrapper, cleared at the end. `interpolate-size` is allowed only behind `@supports`, never instead of the measured wrapper. Never animate `height: auto` without a measured start and end. Skip the height lock when reduced motion matches. Clear it on `transitionend` or `transitioncancel`, with a timeout fallback. Use CSS transitions, or Web Animations only behind an explicit `matchMedia` check, since the base stylesheet doesn't govern script-driven animations.
  - An inert card (#105) never animates.
- [ ] Run:
  - the ApprovalCard stories;
  - the board stories that mount it: `npx vitest run --project storybook src/ds/boards`;
  - `npm run check:ds`: the design system guards, plus every story under reduced motion in `ds-browser`;
  - `npx vitest run --project screens src/owner/today src/owner/conversations`.
- [ ] Commit: `feat(web): let an answered request land in its place instead of swapping in one frame`.

### Task 3: Things to try ticks off as you go (P2-01)

**Files:** `web/src/owner/arrival/ThingsToTry.tsx`, `web/src/owner/arrival/ideas.ts`, a new `web/src/owner/arrival/doneSignals.ts` (the four signals, pure), a new `web/src/owner/arrival/useDoneSignals.ts` (the reads behind them), `web/src/owner/today/TodayPage.tsx` (what it passes the list), `web/src/owner/today/Today.css` (or the arrival CSS the list uses), `web/src/mocks/world.ts` (its `answer()` writes the kernel's approval summary, `{decision_id, action_id, answer, state}` with `state: 'approved'` for an allow and `'denied'` for a deny, instead of `{answer}` alone, so the ledger signal can match in the mock), any other mock seed or handler a signal needs, and `web/src/owner/arrival.screen.test.tsx` and `today.screen.test.tsx`.

**Scope (rulings by the UX craft reviewer, the proposals' owner, 2026-10-30).** The list is the copy's tour.
- Signals 1 to 3 read from the Desk the copy started with (the seeded one), on whichever Desk the list shows.
- Signal 4 is copy-wide.
- The seeded Desk is the first Desk in the copy's Desks read (the API lists Desks in the order they were made), while it is listed. Settings can now delete a Desk (#92). Once the seeded one isn't listed, signals 1 to 3 keep what this view already saw and tick nothing new, and signal 4 counts the Desks other than the seeded one that this view has seen. Ruling by the coordinator, 2026-10-30, as Opus recommended in round 2; the UX craft reviewer may overrule it.
- The count stays "of 4", the four things in the intro dialog, even before "Answer a held request" is drawn.

**The signals and their reads** (all existing routes and query keys, no new endpoint; the API lead confirmed the data exists, 2026-10-30). Each predicate is a pure function in `doneSignals.ts` over the read types in `web/src/api/views.ts` and `contracts.gen.ts`:

| Signal | Reads (route, query key) | Done when | Read only when |
|---|---|---|---|
| 1. Chat as a customer | `conversations` (`conversationsKey`), the full list, not Today's five-minute `live`. Then `conversation` for each `owner_preview` session not yet done, under the key the conversation page uses. | The transcript has a `delivered` item whose message author (`EvMessage.author`) is `claude` or `desk`. `agent_text` is what a visiting agent wrote, not a reply. Being listed alone doesn't prove a reply. | The list shows. Transcripts only once an `owner_preview` conversation exists. |
| 2. Try to break it | `safety` (Safety's key), joined to `ledger` (Safety's key, `verify: true`) by `Attempt.ledger_seq` = entry `seq`. | The entry's `event.session_id` is an `owner_preview` session from signal 1's read, and the entry isn't replayed (`summary.replayed`). The seed's own stopped reply doesn't count. | An `owner_preview` conversation exists. |
| 3. Answer a held request | `ledger` (the same key) | An `approval` entry, not replayed, with `summary.answer` present, no `summary.refused`, and `summary.state` one of `approved`, `denied` or `refused_at_execution`. Those are the entries `approvals.py` writes when it takes an answer. Its notes for an answer it refused don't count, unlike Today's stepped-in count, which this doesn't change. Or: an `answers.answered` entry in this view whose returned `decision.state` is one of `approved`, `executed`, `failed`, `unknown`, `denied` or `refused_at_execution`, and only while the list shows on the seeded Desk. A 409 that settles a request as `expired` or `cancelled` lands in `answers.answered` too (`useAnswer.ts`), and it is not an answer. | The list shows. |
| 4. Create your own Desk | the copy's Desks read (`desksQuery`) | Two or more Desks. | Always (already read). |

- **Where:** `useDoneSignals` is called in `ThingsToTry` with `enabled: !hidden`, so a hidden list reads nothing. The ledger read verifies the whole chain on every read, so it must not poll for a list nobody sees. `ThingsToTry` derives the held row's state from the `firstHeld` and in-view answer that `TodayPage` passes, plus signal 3.
- **Refresh:** each read follows Today's poll interval and refetches on window focus, since the owner comes back from the preview tab.
- **Loading or failure:** a read that's loading or failed ticks nothing and shows no error. The list is a guide, and its rows stay as they were.
- **Lasting:** once a row is seen done in this view, it stays done. After a reload it's done again from the same durable reads. "Already done at load" means done in the first settled read of its queries, and that row draws its check still, with no animation.

**"Answer a held request", row by row.** Today the row vanishes mid-answer: `ThingsToTry` draws it only while `firstHeld` is set, and `TodayPage` drops a request from `held` as soon as `answers.answered` has it. `TodayPage` now passes the row's state instead of only `firstHeld`:

| State | When | Row |
|---|---|---|
| absent | Nothing held yet, and signal 3 is false | Not drawn, as signed. |
| waiting | A request is held, or its answer is still out | "Open the request", as now, in place. |
| done | Signal 3 | Check, "Done. Your answer went to the visitor's chat.", Done pill, in place. |

- [ ] Tests first:
  - The unit tests for each signal, including data that must not count:
    - replayed entries;
    - the seed's own stopped reply;
    - a refusal note (`summary.refused`, decision still held);
    - an expired or cancelled attempt;
    - an owner's own message (`delivered`, authored by the owner) in a preview chat.
  - Screen tests:
    - A fresh copy shows "About 10 minutes. No real customer sees any of it." and no row done.
    - Answering the held request leaves the row in place through the answer, never gone for a frame. It then shows its check, "Done. Your answer went to the visitor's chat.", a Done pill, and the line "1 of 4 done. No real customer sees any of it.".
    - Nothing under the list moves: the section after it keeps its top, at 1440×900 and at 390×844.
    - A late answer (the 409 `expired` injection of `answer_conflict_shows_final_state`) leaves the row unticked and the count unchanged.
    - Answer, then reload Today: the row is done from the first settled reads, with no animation, through the ledger signal alone.
    - A stopped attempt in the preview session ticks "Try to break it" without a reload.
    - With all four signals, the line reads "All 4 done. No real customer sees any of it.".
    - Before anything is held (`rivera_quiet`), "Answer a held request" still waits (not drawn), as signed, and a done count still reads "of 4".
    - On a second Desk in the same copy, the list reads signals 1 to 3 from the seeded Desk.
  - Update the existing tests that expect the row to leave once answered: that's the decision the owner changed. That includes `allow_once_executes_and_updates`.
- [ ] Implement as the board draws (`UXC-P201-After`).
  - A row keeps the height it had before it turns done (a measured minimum height), so a done line shorter than the detail it replaces moves nothing below.
  - A done row's icon gives way to a check that draws once (`motion-base`, emphasis ease) when it becomes done in view. A row that's already done at load draws its check still.
  - The row's detail becomes its done line, and the button gives way to a `Pill` with a handled `StatusDot` and "Done", so the row keeps its height.
  - The list's meta line counts.
  - "Hide this list" and "Show things to try" behave as now.
- [ ] Run `npx vitest run --project unit src/owner/arrival`, `npx vitest run --project screens src/owner`, and the app guards.
- [ ] Commit: `feat(web): tick off Things to try as each is done instead of removing it`.

## Landing

One design PR from `plan/08b-ux-craft-today`, titled `feat(web): let Today confirm what you did: Copied, a landing answer and a list that ticks off`. It carries screenshots at 1440×900 and 390×844 of Today before and after answering, and of a conversation's held card before and after answering. It also carries a short recording of each interaction: the copy, the answer on Today and in a conversation, and the list ticking. the UX craft reviewer (QA) captures them after testing. Then the review panel (Opus 5.5 and GPT-6.1 Sol), the design system reviewer's review of the design system parts, green CI, and the project owner's sign-off before merge.

## Review Ledger

**Round 1 (2026-10-30), Opus 5.5 and GPT-6.1 Sol, both "with fixes"; validated and fixed by the coordinator.**
- The answer can't land on the real screens (both seats, P1): Today and a conversation remount the card on answer. The project owner decided "Stay in its slot". Task 2 now keeps one card instance from held to answered, through `HeldRequest`, Needs you's single list and `renderHeld`, with screen tests on both pages.
- Refused answers would tick the list (both seats, P1/P2): signal 3 now counts only the entries the kernel writes when it takes an answer (`summary.state`, no `summary.refused`), with negative tests.
- The row vanishes mid-answer (Opus, P1): a state table for "Answer a held request", and `TodayPage` passes its state.
- Reads and joins unspecified (both seats, P2): a contract table of routes, keys, joins, when each is read, refresh and failure handling.
- Dot tone (Sol, P2): the tone comes from the returned decision throughout, and pulses only when it changes from held.
- Crossfade accessibility (Opus, P2): the outgoing layer is `inert` and `aria-hidden`, with one status node.
- Test commands (both seats): `screens`, not `screen`, plus `npm run check:ds`.
- P3s taken: Copied's timer restarts and clears, and its words are `aria-hidden`; measured height required; refresh on focus; Conversations captures in Landing.
- Rulings by the UX craft reviewer: signals 1 to 3 from the seeded Desk and signal 4 copy-wide; the count stays "of 4".
- Valid P1s, so the fixes get a second round (P1 extension).

**Round 2 (2026-10-30), Opus 5.5 and GPT-6.1 Sol, both "with fixes", no P1; validated and fixed by the coordinator.** Both seats confirmed the one-card model, the ledger predicate, the join and the tone fix.
- Signal 3's in-view shortcut (both seats, P2): it counted a 409 that settled a request as `expired` or `cancelled`. Now limited to answer states, and to the seeded Desk, with a screen test.
- The settled item (Opus, P2): Dismiss and the drafted-rule notice sit inside the eased height. Needs you keeps the list while an answered-here card remains. The height test's arithmetic is corrected, and "Always" cases are added.
- Focus with an inert outgoing layer (Opus, P2, reproduced in Chromium): focus moves to the status line before the layer goes inert. The keyboard check runs after the transition.
- The mock's approval summary (Opus, P2): `world.ts` writes the kernel's shape, with a reload test so the ledger path is covered.
- Motion test context (Opus, P2): motion assertions go in storybook plays, and only the end state in `ds-browser`.
- P3s taken:
  - the height lock under reduced motion;
  - `AnsweredRequest` removed, with the real remount case named;
  - signal 1 is a `delivered` message from `claude` or `desk`;
  - rows keep their height;
  - the reads live in `ThingsToTry` with `enabled: !hidden`;
  - "done at load" is defined;
  - #92 is merged, so the branch starts from current main.
- Ruling (the coordinator): what happens to the seeded Desk after a deletion, as Opus recommended. the UX craft reviewer may overrule it.
- Round cap reached (2 completed rounds, the second with no P1). These fixes aren't re-reviewed as a plan; each task's review and the PR panel check them.

**During Task 2 (2026-10-30), rulings by the coordinator:** the section below may move down, eased, when the settled item is taller than the held one; the old "never moves down" can't hold after an "Always" answer. The outgoing layer's focus rule is stated by outcome (it never holds focus; the status line takes focus before paint), not by mechanism.
- Task 2: P3 parked — the ApprovalCard story records the first frame's focus but doesn't assert it (assert the leaving layer isn't focused and focus is the status line) — the settled-focus test covers the end state.
- Task 2: P3 parked — the "Always" screen test accepts either direction and its fixture moves about 1 px; add a case where the settled item is taller and assert it eases down — the rule is stated and the one-direction check holds.
