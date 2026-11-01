# PublicShell

`PublicShell` is the public page around a conversation: the business's brand header with its open status, the chat with the AI disclosure, the composer and the business's charter beside it. It is a column the window's height in which only the conversation scrolls.

## When to use

- On the public page of a Desk, around the visitor's `Transcript` and `Composer`.
- Inside an owner screen that shows the public page (Today's side panel, setup) with `footer={false}`. It is then the height of the panel that holds it (see "Standalone or embedded").
- Not for owner pages: they use `AppShell`.

## What it shows

- **The brand header**, `size-brand-header` tall, in the business's colors:
  - The monogram (`aria-hidden`) in a square ringed in the secondary ink.
  - The name and the tagline.
  - The open status, when the Desk has hours (see "Open status" below). The header holds no other line and no free text: everything a visitor reads is the kernel's or the shell's own copy.
  - The `accent` only as the 2 px rule under the header: never text, never a ground for text, never the only sign of a control.
  - Colors are set as `--brand-field`, `--brand-ink`, `--brand-ink-secondary` and `--brand-accent`. Only a plain `#rrggbb` or a token (`var(--token)`) is used; anything else falls back to `bg-panel`, `text-primary`, `text-secondary` and `line-hairline` (`guards.ts`).
- **The chat** in a column at most 680 px wide:
  - "Chat with {name}" and, under it, the AI disclosure. It can't be turned off:
    - "You're chatting with Claude, an AI answering for {name}. Ask for {ownerName} anytime."
    - "Estás hablando con Claude, una IA que responde por {name}. Puedes pedir hablar con {ownerName} cuando quieras."

    When `{name}` already ends in '.', '!' or '?', the period after it is left out (`afterName`), so 'Chen & Co.' reads 'Chen & Co. Ask for …'.

  - A secondary "Ask for {ownerName}" / "Pedir hablar con {ownerName}" button, which calls `onAskForOwner`.
  - **When the owner gave no name** (`ownerName` is null), the disclosure and the button ask for a person instead, and name no one:
    - "You're chatting with Claude, an AI answering for {name}. Ask for a person anytime."
    - "Estás hablando con Claude, una IA que responde por {name}. Puedes pedir hablar con una persona cuando quieras."
    - "Ask for a person" / "Pedir hablar con una persona".

    "a person" is the shell's own copy, so only the business's name is marked as written by someone.
  - **While the owner is in the chat** (`ownerInChat`, take-over option A, N-R2-TakeOver-A-1512-EN and N-R2-TakeOver-A-390-EN), the disclosure's line says so instead, in the same element, type and place, and "Ask for {ownerName}" isn't shown:
    - "{ownerName} is in this chat. Claude, an AI, is paused until {ownerName} hands it back."
    - "{ownerName} está en este chat. Claude, una IA, está en pausa hasta que {ownerName} le devuelva el chat."

    With no owner name, the line names no one:
    - "The business owner is in this chat. Claude, an AI, is paused until they hand it back."
    - "El dueño del negocio está en este chat. Claude, una IA, está en pausa hasta que le devuelva el chat."

    The line still names Claude as an AI and says it is paused, so the AI disclosure is never off; it is the shell's own copy, and the consumer can't empty it or pass other words. Each `{ownerName}` is marked as written by someone (`data-copy="user"`), as the other names are. When the owner hands back, the usual disclosure and the button come back. The shell draws only its head: the chat's own lines ("Maria Rivera joined the chat", "Claude is helping again.") are the page's `SystemLine`s in the conversation.
  - **Focus.** If "Ask for {ownerName}" has focus as the owner joins, focus goes on to the composer's text box (or, while that is disabled, to the conversation's scroll region, the stop after Ask), without scrolling, so it doesn't drop to the page and the visitor stays where they were reading. Focus anywhere else, or nowhere, stays where it is.
  - The conversation (`children`) in its scroll region, then the `composer` with `ConceptFooter poweredBy` under it (see "The page never scrolls"). The conversation sets `--cd-row-max: 100%`, so each `TranscriptRow` fills the chat column, edge to edge with the composer.
- **The about column**, 300 px on the panel at the right, from the header to the foot of the window, named "About {name}" / "Sobre {name}":
  - The `about` blocks in order: cards as `ReplyCard`s in the page's language, prose as text.
  - The `aboutLinks` under "For AI agents" / "Para agentes de IA". Only paths on this site become links (`/d/…`); a scheme or another host is left out.
  - A charter taller than the window scrolls in the column, on its own.
  - With neither blocks nor links, there is no about column.

Names (the business's, the Desk's, the owner's) are shown as written. The page carries `lang` from `language`.

## Open status

The header says whether the business is open now, in the kernel's words.

- **The kernel writes it.** The kernel works out `PublicDesk.open_status` from the business's hours, on its own clock and in the business's time zone, and writes `text` in English or Spanish ("Open now, until 6:00 pm", "Cerrado ahora. Abre el lunes a las 8:00").
- **The page shows it verbatim.** The shell shows `text` exactly as given and reads nothing else of the status but `open`. It does no time formatting or arithmetic, and the browser's clock and time zone decide nothing. This is the one clock time a visitor surface shows outside a card.
- **The dot follows `open`.** Open is a filled `handled` dot; closed is a hollow `info` dot. The dot is `aria-hidden`: the words carry the meaning.
- **Closed adds one line of the shell's own**, under the kernel's words in the secondary ink. It follows `language` like the rest of the shell's copy, and isn't shown when open:
  - "Claude can still help."
  - "Claude puede ayudarte igual."
- **Type and color.** The kernel's words are `meta`, in the brand's ink and marked `data-copy="user"`, as the name is. The closed line is `caption`, a step quieter, 2 px under them.
- **Placement.** At the right end of the header's row, level with the monogram. Below 640 px of shell width it takes its own line under the monogram and name, from the left gutter, 8 px below them, however short it is. A long line wraps inside the header and never scrolls sideways.
- **No status, no line.** Without `openStatus`, with `null` (a Desk without hours, or a computation the kernel dropped), or with anything that isn't a non-empty `text` and a boolean `open`, there is no line and no dot, and the header is exactly as it is without hours.

## The page never scrolls

The shell is the window's height (`100dvh`, or `100vh` in a browser without dynamic viewport units), and the document itself never scrolls, as with `AppShell`.

- **Pinned at the top:** the `banner`, if any, then the brand header, and under it the chat's head with "Chat with {name}", the AI disclosure and "Ask for {ownerName}" (while the owner is in the chat, the line that says so, and no button).
- **Pinned at the bottom:** the composer area (`.cd-public-shell__composer`, the `composer`), and the footer under it.
- **The scroll region** (`.cd-public-shell__scroll`) between them is the only part that scrolls. It holds the conversation, runs the chat's full width (so the scrollbar is at the chat's edge and the wheel scrolls it anywhere over the chat), and is positioned, so a receipt's screen-reader label scrolls with it instead of stretching the document. It is a stop in the tab order after "Ask for {ownerName}", a group named by the chat's title, so a conversation with nothing to focus in it still scrolls from the keyboard.
- **The disclosure must stay in view.** It is part of the always-on baseline: however long the chat, and wherever the visitor has scrolled to, the chat's head with the disclosure is on screen and nothing covers it. Nothing may be added to the page that scrolls it away or covers it, such as content under the composer or a page that scrolls as a whole.
- **A long draft scrolls in the composer.** The composer's text box grows with what is typed up to a sixth of the shell's height (two lines at least, and never more than its own six), then scrolls inside, so a draft can't push the chat's head off the screen. The shell writes its measured height as `--cd-public-shell-height` for this.
- **What the page does:** keeping the newest message just above the composer as the chat goes on, and leaving a visitor who has scrolled back to read where they are, is the page's job (`PublicChat`), in whichever element scrolls the conversation (see "When the scroller changes"). The shell scrolls the conversation itself only to keep the visitor's place when it switches between tall and short, and to bring the composer out from under the chat's head on a short shell.
- **On a phone,** `100dvh` follows the browser's toolbars as they show and hide, so the composer stays above them. Where the browser shrinks the page for the on-screen keyboard (Chrome on Android with the page's `interactive-widget=resizes-content`), the shell shrinks with it and the composer stays just above the keyboard.
- **Safari on an iPhone** keeps the page's height for the keyboard and shrinks only the visual viewport. While the visual viewport is shorter than the window at a scale of 1 (a keyboard, not a zoom), the shell on a page of its own takes the visual viewport's height and moves down to where it shows (`visualViewport.offsetTop`), so it turns short and the chat's head stays at the top of what shows; it goes back when the keyboard closes. This is checked in Chromium with a faked visual viewport, and still needs a check on a real iPhone.

### A short shell

On a short shell, pinning the brand header and the footer as well would leave the conversation a sliver, so they scroll with the conversation and only the chat's head and the composer stay put. The shell is short:

- below 520 px of shell height (a phone on its side, a short phone, a 640 px phone with its on-screen keyboard open), or
- when the banner (if any), the brand header, the chat's head, the composer area and the footer, pinned, would leave the conversation under 120 px, whatever the height: a tagline that wraps, the longest closed status or a long draft can fill a shell well over 520 px. It is measured with the about column where it is, and the composer area is watched, so a growing draft can turn the shell short.
- It turns tall again only with 16 px more than that to spare, so it can't flap as a draft grows and shrinks at the edge.
- While the page passes `keepComposerRoom`, the composer area counts at the tallest it has been since. The public chat passes it while a request is open, because the line it shows above the composer for that request comes and goes as the request's receipt leaves the view and comes back. Each switch between tall and short moves the conversation, which can bring that receipt into view or out of it again, so without kept room the line and the shell would answer each other for ever on a window at the edge. Once the page lets the room go, the shell fits itself again at once.

The shell decides in a layout effect and sets `cd-public-shell--short` on its root itself (React's class for the shell leaves it out, and the shell puts it back after each render), so it is in place before the page's own layout effects run and the page scrolls the right element from the first render on, as when a chat is reopened.

On a short shell:

- The shell itself scrolls (the document still never does), and its scroll region grows with the conversation. The banner (if any) and the brand header are at the top of what scrolls, the footer at its end.
- The chat's head with the disclosure sticks to the top of the shell and the composer area to its bottom, each 8 px tighter at top and bottom, over the app ground. Their ground runs out into the gutters, so the about column passing under them doesn't show beside them.
- **Keyboard scrolling skips nothing.** The shell's scroll padding is the chat's head's and the composer area's heights (`--cd-public-head-height`, `--cd-public-composer-height`, which the shell writes), so focus and Page Up and Page Down bring things into view between them, not under them. Focus in the chat's head scrolls nothing. Focus coming into the composer's text box, by Tab or by script, still scrolls a short shell that is back in the chat in Chromium, so the shell's own move of focus there (when Ask leaves as the owner joins) passes `preventScroll`.
- At the top of a chat, the brand header, the chat's head and a composer holding a long draft can be taller than the shell together. The chat's head then stays over the composer, so the composer can never cover the disclosure; when the composer takes focus or grows there, the shell scrolls by the overlap, so the composer comes out from under the chat's head.
- Where the page keeps a chat it follows (the newest message just above the composer), the footer is just below the window and the conversation has the shell's height less the chat's head and the composer: at least 96 px at 568 × 320, 320 × 480, 360 × 380, 320 × 520, 320 × 545, 320 × 560 and 360 × 520, in English and in Spanish with the longest closed status, with a long draft or a wrapped tagline. Scrolled right to the end, the footer shows under the composer.

### When the scroller changes

When the shell turns short or tall, the element that scrolls the conversation changes: the scroll region while tall, the shell itself while short. The shell then:

1. keeps the visitor's place on the new scroller, even when the width changes too, as when a phone turns. The place is what is first under the chat's head: the about column while it opens the scroll region and still reaches under the head (the chat's start on a narrow shell), and the first message otherwise. It stays where it was under the head; when part of it is above the head's edge, the same share of it stays above, however it has wrapped, so the same part of it is at the edge and it is still what is first under the head. If the about column was the place and has since moved beside the chat, nothing is put back.

   The shell hears of a new size only once the browser has laid the page out at it. At the same width nothing under the chat's head has moved by then, and the shell reads the place there. At a new width the about column, the messages and the chat's head have already wrapped onto other lines, and the browser's scroll anchoring may have moved the conversation to keep some other element still, so the shell puts back the place it read after the last scroll of the conversation, or the last time it laid itself out, at the old width. A scroll at the new width before the shell hears of it isn't taken for the visitor's, so a visitor's own scroll in that very frame is lost with it;
2. sends one event from its root, once per switch, after the place is kept:

```ts
import { PUBLIC_SHELL_SCROLLER_EVENT, type PublicShellScrollerDetail } from '../ds/index.ts';

// 'cd-public-shell-scroller': a CustomEvent<PublicShellScrollerDetail>, bubbling, dispatched on the
// shell's root element (.cd-public-shell), synchronously in the ResizeObserver callback in which the
// shell switched. detail.scroller is the element that now scrolls the conversation.
shell.addEventListener(PUBLIC_SHELL_SCROLLER_EVENT, (event) => {
  const { scroller } = (event as CustomEvent<PublicShellScrollerDetail>).detail;
  // A visitor who was at the end: bring the end back above the composer, on `scroller`.
});
```

It isn't sent when the shell first lays out (it is short or tall from its first render), when only the about column moves, or when nothing switched. The old scroller's scroll position resets as it stops scrolling; a page that follows the chat should treat the event, not that reset, as the change.

## Layout

The shell is an inline-size container, so it lays out by its own width, not the window's. Below 720 px (each state of the handoff board at 640 px, a phone, or the owner's 420 px panel) the gutters are 16 px instead of 40, and below 640 px the open status also has its own line under the name.

From 900 px of shell width the about column stands at the right of the chat. Below 900 px there is no room for it beside the chat, and the page doesn't scroll, so it opens the scroll region instead: the first thing above the conversation, the region's full width on the panel, with a hairline between it and the first message. It scrolls away as the chat goes on and comes back at the chat's start. Where the conversation comes to rest with the column's own hairline within 24 px under the chat's head (a chat a little shorter than the region, followed to its end), that hairline is left out, so the head's own line is the one line there rather than two a few px apart; from 24 px down the column draws it as ever. Only the column's own hairline steps aside: a card's edge inside the column passing under the head is content scrolling, as a message's is. The shell judges this after every render, scroll and resize, the column's own included (it watches the column while the column opens the scroll region, as the web font arriving can change its height), and the line keeps its pixel, so nothing moves. With forced colors the line takes the system's `Canvas` color there, as the browser would otherwise draw a transparent border in its text color. Until the shell has measured itself it opens the scroll region too, where it takes nothing from the chat's width, so the chat never lays out squeezed beside it. The shell watches its own width and moves the column before the browser paints, then judges short or tall with the column in place, and the rest of the page stays mounted as it moves (an unsent draft is kept, and stays focused). If focus is on a link in the column when it moves, focus goes to the same link in the moved column.

Beside the chat, a charter taller than the column scrolls in the column, on its own. While it does, the column is a stop in the tab order (it is already named by its heading), so it scrolls from the keyboard too, and it stays one while it has focus, so focus doesn't drop to the page when the window grows and the column stops scrolling under it. When it fits, or when it opens the scroll region, it isn't a stop of its own.

## Standalone or embedded

- Standalone (the default), the shell is the page: the header is the `banner`, the chat is the `main` region, the about column is a `complementary` region, and the business's name is the page's `h1`.
- With `footer={false}` the shell sits inside an owner screen that has its own landmarks and footer. The footer is left out, the header and chat are plain blocks, the business's name is a paragraph, and the about column is a region named "About {name}".
- Embedded, the shell is the height of the panel that holds it (`height: 100%`). In a panel with a set height, as each state of the handoff board is, the conversation scrolls inside the shell as on the page; in a panel that grows with what it holds, the shell grows with the conversation and the panel scrolls.

## The brand header on its own

`PublicBrandHeader`, in this folder and exported from the package, is the shell's brand header as a component of its own: the shell draws it, and a public page without a chat, such as `/d/:slug/agents`, draws it over its own title.

- It takes `brand`, `language` and `openStatus` as the shell does, and maps the brand to its `--brand-*` properties with the same checks.
- `landmark` (default `true`) makes it the page's `banner`; `false` inside an owner screen.
- `nameAsHeading` (default `true`) makes the business's name the page's `h1`. A page with its own title passes `false`, so the name is a line and the page keeps one `h1`.
- It is its own inline-size container, so its 16 px gutters below 720 px and its status line under the name below 640 px follow its own width, inside the shell or on a page of its own.

## What the consumer provides

- `brand` from the kernel-served `PublicDesk`, through the screen's mapping:
  - `name` is `business_name`, `tagline` the Desk's name, `monogram` the first letter.
  - `field` and `accent` are the brand's colors.
  - `ink` and `inkSecondary` are `var(--text-primary)` and `var(--text-secondary)`.
  - The mapping keeps both inks at 4.5:1 over the field, falling back to `bg-panel` when they can't.
- `ownerName` (`owner_display_name`), or null when the owner gave no name, `language`, `onAskForOwner`. The kernel has no field that says no name was given: the public page's mapping (`brandFrom`) reads setup's fallback name, "Owner", as null, so the page never asks for "Owner". The charter's cards never name the owner, so a null name leaves them as they are.
- `ownerInChat`, whether the owner is in the chat. Its one source is the kernel's session mode: `SessionState.mode === 'owner'` when the chat opens or reloads, kept current by the stream's `owner_joined` and `owner_left` (the events the page also draws as the joined and "Claude is helping again." lines). The line tells the visitor a person is in the chat, so it is never set from anything else. `PublicChat` passes `chat.ownerInChat` from `PublicChatProvider`, which derives it through `ownerInChatNow`. The flag is false while the stream is disconnected or catching up, or the session mode is not confirmed. While it is set, the chat's head says the owner is in the chat and Claude, an AI, is paused, and "Ask for {ownerName}" isn't shown (see "What it shows"). The chat's head changes height with it, and the shell watches its head, so it judges short or tall again as the owner joins and hands back.
- `openStatus`, `PublicDesk.open_status` passed through as served, `null` included. The screen keeps it current by refetching the Desk, once after the kernel's `refresh_at` minus its `as_of` and again when the tab becomes visible; the shell only draws what it's given.
- `about`, the `PublicDesk.charter` blocks, and `aboutLinks` for people's agents.
- `composer`, a visitor `Composer` in the page's language, pinned at the bottom, and `children`, the conversation, in the scroll region. Whatever the page adds after the conversation (notices, the element it keeps above the composer) goes in `children` too.
- `banner`, a full-width line above the brand header, such as the `VisionBar` on the Claude account vision page (N-R2-Vision-ClaudeAccount). It sits inside the shell, at the top of its column, so the page stays the window's height and the composer and footer stay at its foot. It is pinned with the brand header, and on a short shell it scrolls away with it (see "A short shell").
- `inertAsk` is for the vision pages only (the city office and the Claude account), which make no requests. "Ask for {ownerName}" keeps its look, focus and place, but pressing it does nothing and `onAskForOwner` is never called. The first press shows "This is a vision page, so nothing is sent." (`VISION_INERT_LINE`) in a polite `role="status"` line, a secondary caption on a row of its own in the chat's pinned head, 8 px under the title and the button; later presses change nothing. The line is there, empty and taking no room, from the start, so its change is announced. Never on a real page.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `brand` | `PublicBrand` | Required. `{ name; tagline; monogram; field; ink; inkSecondary; accent }`. |
| `ownerName` | `string \| null` | Required. `owner_display_name`, or null when the owner gave no name: the head then asks for a person. |
| `language` | `'en' \| 'es'` | Required. |
| `openStatus` | `PublicOpenStatus` | `PublicDesk['open_status']`, the kernel's object or `null`. Only `text` and `open` are read. |
| `onAskForOwner` | `() => void` | Required. |
| `ownerInChat` | `boolean` | The owner is in the chat: the head says so and that Claude, an AI, is paused, and Ask isn't shown. Only from the kernel's session mode: `SessionState.mode === 'owner'` as the chat opens or reloads, then the stream's `owner_joined` and `owner_left`. `PublicChat` passes `chat.ownerInChat`, derived by `PublicChatProvider` through `ownerInChatNow`; it is false while the stream is disconnected or catching up, or the mode is not confirmed. `false` by default. |
| `inertAsk` | `boolean` | Vision pages only: Ask does nothing and its first press shows the vision line. `false` by default. |
| `about` | `RenderedBlock[]` | The charter blocks. |
| `aboutLinks` | `{ label: string; href: string }[]` | Paths on this site only. |
| `footer` | `boolean` | `true` by default; `false` when embedded. |
| `composer` | `ReactNode` | Required. Pinned at the bottom, with the footer under it (the footer scrolls on a short shell). |
| `keepComposerRoom` | `boolean` | While true, the composer area counts at the tallest it has been since when the shell decides whether it is short, so a line the page shows above the composer and takes away again can't switch it (see "A short shell"). `false` by default. |
| `banner` | `ReactNode` | Above the brand header, inside the window's height; pinned with the header, and scrolls with it on a short shell. |
| `children` | `ReactNode` | Required. The conversation, in the scroll region. |

`PublicBrand`, `PublicOpenStatus`, `PUBLIC_SHELL_SCROLLER_EVENT` and `PublicShellScrollerDetail` are exported with the component. `PublicOpenStatus` is `PublicDesk['open_status']`, the generated `OpenStatus` or `null`.

## While the page opens

`PublicShellSkeleton({ language, footer })` and `PublicBrandHeaderSkeleton({ hours })` are exported
alongside the shell. Put them in a `SkeletonScreen`, which owns the 200 ms wait, one synced sweep,
hidden status and 120 ms fade. They draw no content or controls; the real `ConceptFooter poweredBy`
is the shell skeleton's only text when `footer` is true. The consumer keeps a hidden heading and
main landmark outside the layer on a standalone loading page.

The brand shape uses `bg-panel` until the business's colours arrive, its real monogram size and
name/tagline line boxes, and one open-hours line when `hours` is true. It follows the header's own
container rules: the status wraps below the name under 640 px. A fresh copy's open header matches;
at 390 px, closed and no-hours headers change height once (19 px taller and 16 px shorter).
The agents page passes `hours={false}` because its real header has no hours.

The shell shape shares the shell's layout and visual-viewport measurement hooks, including short
windows and embedded panels. History is unknown until the page lands, so every load draws the first
view, placed by the same `useFirstView` hook as the real one: a greeting line (two on a phone), its
meta line, the inline composer and three starter chips as wide as the fresh copy's. It draws the
real fresh copy's five charter cards and two agents links: beside the chat from 900 px, and under
the footer below that, as the first view does. In setup's fresh preview (`footer={false}`), there
is no charter or footer, so neither is drawn.

A first visit to a Desk with starters lands in place. A resumed chat keeps its head in place, and
its composer moves down to the bottom as it lands. A Desk without starters lands on the greeting
alone, without the meta line and chips: on a laptop the shorter group is centred about 30 px lower,
and on a phone the composer moves up by the meta line, and the footer and About by the chips as
well. Text that depends on other Desk data, such as a long greeting or longer starters, can change
size once when it arrives.

The `Skeleton`, `SkeletonPhone` and `SkeletonShort` stories compare the shapes with the real shell's
first view at 1280 px, 390 px and 390×480. They reference P12-02, `UXC-P1202-After`
(`#artboard-d122e70134a0`), and follow the real page wherever it differs from that board.

## Before the first message

Pass `firstView` only after session history has loaded and while the chat is empty. The shell shows
“How can {business} help?” and, when there are starters, “Try one of these, or ask in your own
words.” (with the signed Spanish copy when `language="es"`). The business name keeps `data-copy="user"`; the surrounding words are
app copy. The disclosure and its punctuation stay in their usual head above the invitation.

`starters={{ words, onPick, disabled }}` supplies localized business content to `SuggestionChips`;
only the first three words entries appear. Omit it, or pass an empty array, for the greeting alone: no meta line and no chips. `onPick`
must use the same send path as the composer. PublicChat reads `(desk.starters ?? []).slice(0, 3)`
and sends picks through its ordinary visitor send handler, including in Today and setup previews.

On a wide shell, the invitation and composer sit slightly above the middle of the transcript column,
with 20 px between the invitation and composer and the chips below. On a narrow shell they sit inline
under the chat head, before the footer and About cards. The narrow body scrolls with its disclosure
head sticky and the brand header above it. Existing conversations keep their normal scroll layout.

When `firstView` becomes false, the invitation and chips fade for `motion-fast`. The desktop composer
moves to its dock using only a transform, for `motion-base + motion-instant` (260 ms) with
`motion-ease-emphasis`; the transcript can show the visitor's bubble immediately. A narrow shell
only fades. With reduced motion, the invitation disappears and the composer moves immediately.
A shell that opens without `firstView` plays none of this motion.

The vision pages use populated, static conversations; they omit `firstView` and retain their existing
inert composers and suggestions. Stories: `FirstViewEnglish`, `FirstViewSpanish`,
`FirstViewWithoutStarters`.
