# PublicShell

`PublicShell` is the public page around a conversation: the business's brand header with its open status, the chat with the AI disclosure, the composer and the business's charter beside it.

## When to use

- On the public page of a Desk, around the visitor's `Transcript` and `Composer`.
- Inside an owner screen that shows the public page (Today's side panel, setup) with `footer={false}`.
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
  - A secondary "Ask for {ownerName}" / "Pedir hablar con {ownerName}" button, which calls `onAskForOwner`.
  - The conversation (`children`), then the `composer` with `ConceptFooter poweredBy` under it. The composer and footer stay at the bottom of the window while the conversation scrolls. The conversation sets `--cd-row-max: 100%`, so each `TranscriptRow` fills the chat column, edge to edge with the composer.
- **The about column**, 300 px on the panel at the right, named "About {name}" / "Sobre {name}":
  - The `about` blocks in order: cards as `ReplyCard`s in the page's language, prose as text.
  - The `aboutLinks` under "For AI agents" / "Para agentes de IA". Only paths on this site become links (`/d/…`); a scheme or another host is left out.
  - With neither, there is no about column.

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

## Layout

The shell is an inline-size container, so it lays out by its own width, not the window's. Below 900 px the about column moves under the chat, full width. Below 720 px (each state of the handoff board at 640 px, a phone, or the owner's 420 px panel) the gutters are 16 px instead of 40, and below 640 px the open status also has its own line under the name.

## Standalone or embedded

- Standalone (the default), the shell is the page: the header is the `banner`, the chat is the `main` region, the about column is a `complementary` region, and the business's name is the page's `h1`.
- With `footer={false}` the shell sits inside an owner screen that has its own landmarks and footer. The footer is left out, the header and chat are plain blocks, the business's name is a paragraph, and the about column is a region named "About {name}".

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
- `ownerName` (`owner_display_name`), `language`, `onAskForOwner`.
- `openStatus`, `PublicDesk.open_status` passed through as served, `null` included. The screen keeps it current by refetching the Desk, once after the kernel's `refresh_at` minus its `as_of` and again when the tab becomes visible; the shell only draws what it's given.
- `about`, the `PublicDesk.charter` blocks, and `aboutLinks` for people's agents.
- `composer`, a visitor `Composer` in the page's language, and `children`, the conversation.
- `banner`, a full-width line above the brand header, such as the `VisionBar` on the Claude account vision page (N-R2-Vision-ClaudeAccount). It sits inside the shell, so the page stays the window's height and the composer and footer stay at its foot.
- `inertAsk` is for the vision pages only (the city office and the Claude account), which make no requests. "Ask for {ownerName}" keeps its look, focus and place, but pressing it does nothing and `onAskForOwner` is never called. The first press shows "This is a vision page, so nothing is sent." (`VISION_INERT_LINE`) in a polite `role="status"` line, a secondary caption 8 px under the chat's head; later presses change nothing. The line is there, empty and taking no room, from the start, so its change is announced. Never on a real page.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `brand` | `PublicBrand` | Required. `{ name; tagline; monogram; field; ink; inkSecondary; accent }`. |
| `ownerName` | `string` | Required. |
| `language` | `'en' \| 'es'` | Required. |
| `openStatus` | `PublicOpenStatus` | `PublicDesk['open_status']`, the kernel's object or `null`. Only `text` and `open` are read. |
| `onAskForOwner` | `() => void` | Required. |
| `inertAsk` | `boolean` | Vision pages only: Ask does nothing and its first press shows the vision line. `false` by default. |
| `about` | `RenderedBlock[]` | The charter blocks. |
| `aboutLinks` | `{ label: string; href: string }[]` | Paths on this site only. |
| `footer` | `boolean` | `true` by default; `false` when embedded. |
| `composer` | `ReactNode` | Required. |
| `banner` | `ReactNode` | Above the brand header, inside the window's height. |
| `children` | `ReactNode` | Required. |

`PublicBrand` and `PublicOpenStatus` are exported with the component. `PublicOpenStatus` is `PublicDesk['open_status']`, the generated `OpenStatus` or `null`.
