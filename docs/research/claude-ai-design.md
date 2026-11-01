# claude.ai design system: extracted reference

Research date: 2026-10-28.

Background research for the Claude Desk design; claims are cited, and anything not confirmed from a source is marked UNVERIFIED.

This was a read-only look at the claude.ai web app's UI conventions, in one agent-owned browser tab (now closed): navigation by URL, `getComputedStyle`, a walk over `document.styleSheets`, and screenshots. Build `4dde4bda39`. Personal details of the account used (names, chat titles, message text) are replaced with placeholders.

**Theme observed: dark.** `html[data-mode="dark"][data-theme="claude"][data-color-version="v2"][data-density="comfortable"]`, sidebar width 280, `data-reply-face="serif"`.

A neutral-gray variant of the theme was active; both palettes are recorded below.

The classic claude.ai palette (warm `#faf9f5`, `#262624`, `#141413`) is still in the stylesheets as the `[data-theme=claude]` base. **Claude Design still uses the warm palette** (`#1c1b19` app background). The prototype should pick one family and not mix them.

---

## (a) Tokens

### Color: active neutral-gray variant (what the observed session showed)

| Role | Light | Dark |
|---|---|---|
| Page / `surface-1` (main bg) | `#ffffff` | `#191919` |
| `surface-0` (deepest) | `#f9f9f9` | `#0b0b0b` (modal backdrop page) |
| `surface-2/3` (cards, dialog, composer in light) | `#ffffff` | `#1f1f1f` |
| Composer box | `#ffffff` + ring `rgb(0 0 0/.12)` | `#303030` + inset ring `rgb(255 255 255/.08)` |
| `surface-popover` (menus, tooltips) | `#ffffff` | `#303030` |
| Sidebar bg | `#fafafa` | `#1f1f1f` |
| Sidebar/page seam (1px) | `#0000001a` | `#ffffff1a` |
| Text primary | `#000000e6` (90%) | `#ffffffed` (93%) |
| Text secondary | `#00000099` (60%) | `#ffffff91` (57%) |
| Text muted / tertiary | `#00000077` (47%) | `#ffffff66` (40%) |
| Placeholder | `#878787` | `#878787` |
| `border` (hairline) | `#00000014` | `#ffffff0a` |
| `border-line` (dividers) | `#0000001f` | `#ffffff1f` |
| Message/section line | `#0000001a` | `#ffffff1a` |
| Ghost hover | `#0000000d` | `#ffffff13` (7.5%) |
| Ghost selected (active nav row) | `#0000001a` | `#ffffff26` (15%) |
| `fill-secondary` (chip/button paint) | `#0000000d` | `#ffffff26` |
| `fill-secondary-hover` | `#00000013` | `#ffffff37` |
| `fill-primary` (solid CTA) | `#191919`, text white | `#efefef`, text `#191919` |
| `fill-primary-hover` | `#3c3c3c` | `#d7d7d7` |
| Card fill (CardLink overlay) | `#00000006` | `#ffffff08` (≈3%) |
| Segmented-control track | `#0000000d` | `rgb(255 255 255/.05)` |
| Inline code bg | `alpha-1` | `rgba(255,255,255,.075)` |
| Accent (links, focus, selection) | fill `#257de0`, text `#1757ac` | fill `#257de0`, text `#6aabf1` |
| Danger | fill `#dc3c3d`, text `#a42528` | fill `#dc3c3d`, text `#f17778` |
| Success | `#10a122` / text `#006c10` | text `#53c556` |
| Warning | `#fbb315` / text `#794c02` | text `#e49c06` |
| Pro (violet) | `#785ee8` / `#5437b8` | text `#a89af0` |
| Brand clay (Spark logo, brand fill) | `#d97757`; emphasized `#c6613f` | same |
| Backdrop (modal scrim) | `#0006` | `rgba(0,0,0,.5)` |

The neutral ramp (`--cds-gray-*`, neutral variant) runs: 10 `#fcfcfc` · 20 `#f9f9f9` · 50 `#efefef` · 100 `#e0e0e0` · 200 `#c2c2c2` · 300 `#a4a4a4` · 400 `#878787` · 500 `#6b6b6b` · 600 `#515151` · 700 `#383838` · 750 `#2c2c2c` · 800 `#202020` · 840 `#181818`. There are also full red/orange/yellow/green/aqua/blue/violet/magenta ramps from 10 to 890.

### Color: classic warm claude.ai palette (`[data-theme="claude"]` base; also what Claude Design uses)

| Token | Light | Dark |
|---|---|---|
| `bg-000` (raised: cards, composer) | `#ffffff` | `#30302e` |
| `bg-100` (page) | `#faf9f5` | `#262624` |
| `bg-200` (sidebar) | `#f5f4ed` | `#1f1e1d` |
| `bg-300` | `#f0eee6` | `#141413` |
| `bg-400` | `#e8e6dc` | `#000000` |
| `text-100` | `#141413` | `#faf9f5` |
| `text-200` / `300` | `#3d3d3a` | `#c2c0b6` |
| `text-400` / `500` (muted) | `#73726c` | `#9c9a92` |
| `border-*` (always used at low alpha, ~10–30%) | `#1f1e1d` | `#dedcd1` |
| `accent-000` / `100` (blue) | `#1b67b2` / `#2c84db` | `#74abe2` / `#2c84db` |
| `brand-100` (clay) | `#c6613f` | `#d97757` |
| `danger-100` | `#b53333` | `#dd5353` |
| `accent-pro-100` | `hsl(251 40% 45%)` ≈ `#5a48a1` | `hsl(251 40% 54%)` ≈ `#7464be` |

The "v2" warm gray ramp (`--cds-gray-*`, warm variant): 0 `#fff` · 10 `#fcfcfb` · 20 `#f9f9f7` · 50 `#f0efec` · 80 `#e7e6e1` · 100 `#e1e0d9` · 200 `#c3c2b7` · 300 `#a5a49a` · 400 `#898781` · 500 `#6d6b67` · 600 `#52514e` · 700 `#383835` · 750 `#2c2c2a` · 800 `#20201f` · 850 `#151515` · 900 `#0b0b0b`.

Supporting brand neutrals: heather `#cbcadb`, plum `#827dbd`, cactus `#bcd1ca`, mineral `#629987`. These are used for pictogram highlights.

Claude Design (`--om-*`, dark):

| Role | Value |
|---|---|
| App bg | `#1c1b19` |
| Panel | `#222220` |
| Surface / elevated | `#2a2927` |
| Muted | `#2e2c26` |
| Selected | `#3c392f` |
| Text primary | `#faf9f5eb` |
| Text secondary | `#faf9f5a3` |
| Text tertiary | `#faf9f599` |
| Border default | `#faf9f51f` |
| Border card | `#faf9f524` |
| Primary accent | `#e08968` (clay, lighter for dark mode) |
| Link / secondary | `#7eaeda` |
| Blue | `#4d90e0` |
| Success | `#6fa859` |
| Warning | `#dabe4a` |
| Error | `#dc8290` |
| Pro | `#9a8fe0` |
| Sage | `#8fae6a` |

### Typography

| Family token | Value | On Google Fonts? | Closest Google Fonts substitute |
|---|---|---|---|
| `--font-anthropic-sans` (UI) | `"anthropic-sans", system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. Variable weight 300–800 plus a `GRAD` axis. | **No** (proprietary) | **Hanken Grotesk** or **Instrument Sans** (variable). Inter is acceptable but reads generic. Use variable wght ~360 (body) and ~420 (controls). |
| `--font-anthropic-serif` (greeting, page titles, Claude's replies, wordmark) | `"anthropic-serif", Georgia, …`. Variable wght 300–800 with an `opsz` axis (uses opsz 20/24/28/48). Wordmark uses `font-feature-settings: "ss01","dlig"`. | **No** | **Source Serif 4** (variable, opsz+wght: closest behavior) or **Newsreader** (opsz). Fallback: Georgia. Avoid Playfair/DM Serif (too high-contrast). |
| `--font-anthropic-mono` (code) | `"anthropic-mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | **No** | **JetBrains Mono** or **IBM Plex Mono**, at 13–14px |
| Icons | `Anthropicons-Variable` icon font (PUA glyphs, e.g. U+E064 "pencil") | **No** | Lucide or Phosphor (Regular) at 1.5px stroke, rounded caps, 16–20px |

Dark mode drops the weight axis: regular is wght 360, medium 460, semibold 540, bold 560. That compensates for halation on dark backgrounds, so dark text is visibly lighter than light-mode text. In the neutral variant the role weights are body 400 (wght 360), control 435 (wght 395), header 520 (wght 480), badge 540 (wght 520).

Type scale (comfortable density, measured):

| Use | Family | Size / line-height | Weight (axis) | Notes |
|---|---|---|---|---|
| Home greeting "Afternoon, {first name}" | serif | 38 / 47.5 | wght 290, opsz 48 | Centered, preceded by a clay Spark glyph 27px (`#d97757`) |
| Claude Design hero "What should we create?" | serif | 36 / 39.6 | wght 420, opsz 36 | letter-spacing −0.4px |
| Page title (`h1` "Projects", "Customize", project name) | serif | 24 / 32 | wght 460 (fw 500), opsz 24 | Left-aligned, ~24px from top |
| Settings dialog H2 | sans | 22 / 28 | wght 480 | |
| Wordmark "Claude" | serif | 20 | wght 500 | ss01 + dlig |
| Section header ("Appearance", "Top connectors") | sans | 15 / 20 | wght 480 (fw 520) | |
| Sidebar group label ("Chats and tasks") | sans | 13 / 16 | wght 480 | |
| UI body / nav rows / buttons | sans | 14 / 20–21 | wght 395 (fw 435) | |
| Chat list rows | sans | 14 / 21 | wght 360 | |
| Composer input | sans | 15 / 21 | wght 360 | |
| Claude's reply (prose) | **serif** | 15 / 21 (prose up to 16/24 at "lg") | wght 360; bold = wght 460 | Reply headings are sans 14, same size as body |
| User message | sans | 15 / 21 | wght 360 | In a bubble |
| Secondary description | sans | 13 / 17 | 360, color secondary | |
| Meta / caption ("Created by …", hints) | sans | 12 / 17 | 360, secondary | |
| Badge / pill | sans | 10–12 / 12–15 | wght 520 | Outlined |
| Counter | sans | 11 / 17 | wght 395 | Pill, fill 5% |
| Eyebrow ("CURATED BY ANTHROPIC") | sans | 12 | wght 395, uppercase, +0.3px | Secondary color |
| Inline code | mono | 13.5 | 400 | |
| Code block | mono | 14 / 22.75 | 400 | |

The Tailwind base scale is also present: 12/16, 14/20, 16/24, 18/28, 20/28, 24/32, 30/36, 36/40. Tracking tokens are tight −0.025em and wide +0.025em, but default letter-spacing is normal almost everywhere.

### Radii

| Token | Value |
|---|---|
| `--cds-radius` (comfortable density) | 8px (compact: 6px) |
| Size steps | xs 6, sm 7, lg 10 |
| Buttons, nav rows, inputs, chips, select triggers | **8px** |
| Small icon buttons (24px) | 6px |
| Segmented control | track 7–8px, thumb 5–6px |
| `radius-card` | `cds-radius + 4px` → **11–12px** (cards, user bubble 12px, dialog 12px, hero 12px) |
| Composer | **14px** (`--cds-radius-composer` .875rem). Claude Design composer: 16px. |
| Panels | `--cds-panel-radius` 12px (the neutral variant flattens these to 0 for side panels). Project side column: 16px. |
| Code block | 8px |
| Inline code | 4px |
| Pills (badge 11px, counter, switch) | full (9999px) |

### Spacing (comfortable density; 4px base, `--spacing: .25rem`)

| Token | Value |
|---|---|
| pad-xs | 6px |
| pad-sm | 8px |
| pad-md | 12px |
| pad-lg | 16px |
| pad-xl | 24px |
| gap-xs | 8px |
| gap-sm | 12px |
| gap-md | 16px |
| gap-lg | 28px |
| gap-xl | 40px |

Controls are 32px tall (`--cds-h-control`). Sizes: xs 24, sm 28, lg 40.

Chat column: 768px (transcript 768px max; messages measured at 736px wide). Content pages (Projects, Customize) use a 960px column, centered in the remaining space.

Sidebar geometry:

| Property | Value |
|---|---|
| Width | 280px (`--df-sidebar-width` 288 in desktop frame) |
| Row height | 32px |
| Row radius | 8px |
| Row inner padding | 2px |
| Icon slot | 28px |
| Icon size | 20px |
| Row font | 14px |
| Group label | 13px |
| Group top padding | 16px |
| Footer buttons | 32px |

### Shadows

The system almost never uses drop shadows on base surfaces. It relies on 1px rings plus tiny, very diffuse shadows.

| Name | Light | Dark |
|---|---|---|
| `shadow-sm` | `0 1px 2px hsl(gray-900/6%), 0 2px 8px hsl(gray-900/8%)` | shadow color `#0000003d` |
| `shadow-md` | `0 2px 4px /7%, 0 6px 16px /8%` | |
| `shadow-lg` | `0 4px 8px /8%, 0 12px 28px -2px /8%` | |
| `shadow-popover` | `0 8px 24px #0000001f, 0 2px 6px #00000014` | `0 8px 24px #00000052, 0 2px 6px #0003` |
| Composer | `0 4px 20px rgb(0 0 0/.035)` + ring 1px `rgb(0 0 0/.12)` | `0 4px 20px rgb(0 0 0/.035–.075)` + **inset** 1px `rgb(255 255 255/.08)` |
| Dialog | outer ring 1px `border` + shadow-sm | inset 1px `#ffffff0a` + `0 1px 2px /6%, 0 2px 8px rgba(0,0,0,.24)` |
| Card ring | `0 0 0 1px border` | inset 1px `alpha-2` |
| Desktop-frame card | `0 0 0 1px gray-900/6%, 0 4px 24px gray-900/4%` | |
| Float | `0 0 0 .5px #0000000d, 0 2px 8px #0000000a, 0 12px 32px #00000008` | |
| Pop | `0 0 0 .5px #0000000f, 0 4px 12px #0000000f, 0 16px 40px #00000014` | |

Focus ring: `inset 0 0 0 1px page-bg, 0 0 0 1px accent, 0 0 6px 1px accent/12%`. In dark mode the glow is 60% of accent-600. It is blue (`#257de0`), never clay.

In dark mode, rings switch from outer to **inset** (`--cds-ring-outer 0, --cds-ring-inner 1px`).

### Motion

| Token | Value |
|---|---|
| `--cds-dur-fast` | 60ms (hover paints) |
| `--cds-dur-snap` | 120ms |
| `--cds-dur-base` | 200ms (composer bg/shadow) |
| `--cds-dur-sheet` | 300ms |
| `--cds-dur-slow` | 450ms |
| `--cds-ease-out` | `cubic-bezier(.165,.84,.44,1)` |
| `--cds-ease-snap` | `cubic-bezier(.32,.72,0,1)` (sheets/sidebar, same as `--df-ease-out`) |
| `--cds-ease-overshoot` | `cubic-bezier(.34,1.3,.64,1)` |
| Tailwind default | 150ms `cubic-bezier(.4,0,.2,1)` |
| Button press spring (`--cds-btn-spring`) | `linear(0, .2459, .6526, .9468, 1.0764, 1.0915, 1.0585, 1.0219, .9993, .9914, .9921, .9957, .9988, 1.0004, 1)` |

- **Button "squish":** a separate paint layer scales on `:active`.
- **Card press:** scale .99 and translate 2px.
- **Message actions:** reveal in 120ms after a 100ms delay; hide in 60ms.
- **Skeletons:** reveal after a 0.5s delay.
- **Reduced motion:** honored, and there is a Motion: System/On/Off setting.

---

## (b) Component patterns (dark, comfortable, measured)

**App shell.**
- The sidebar is a full-height `aside` (280px, bg `#1f1f1f`, 1px right border `#ffffff1a`) on a `#191919` main pane.
- There is no top app bar on home. Conversation and project pages have a transparent 45px title row (breadcrumb "Projects / How to use Claude", or the chat title with a chevron) and a right-aligned "Share" ghost button.
- No shadows between panes; only the seam.

**Sidebar.**
- Top row:
  - Collapse icon (16px).
  - Serif wordmark "Claude" at 20px.
  - A 2-item segmented switcher (chat / code icons, 28px).
- Primary nav rows: New (+), Search (shows ⇧⌘K on hover), Projects, Artifacts, Scheduled, Customize.
  - Each row: 32px high, radius 8, icon 20px in a 28px slot, 4px gap, text 14px wght 395, color primary.
  - Hover fill 7.5% white; selected fill 15% white (no accent color, no left bar).
- Group label: "Chats and tasks ▾", 13px wght 480, with a filter icon at the right.
- Chat rows: 14px wght 360. A tiny dot (or clock icon for scheduled) in the leading slot. Truncation fades out (`df-fade-truncate`).
- "19 new" badge: outlined pill, 22px tall, 1.5px border `#ffffff33`, 12px wght 520, padding 0 7px.
- "View all": secondary color.
- Footer: avatar (initial letter, 20px circle) + "{name} · {organization} ▾" + device icon, 32px row.

**Composer (home).**
- Box: 656×103, bg `#303030`, radius 14, padding 8, inset ring 8% white, soft 0 4px 20px shadow.
- Placeholder "How can I help you today?" in 15px gray `#878787`.
- Bottom row, left: "+" icon button (28px) and the segmented control "Chat | Cowork".
  - Track: 5% white, radius 7, padding 1.
  - Thumb: radius 5, 15% white.
  - Labels: 14px wght 395, padding 0 10px, height 26.
- Bottom row, right: "Opus 5.5 Medium" ghost dropdown (model in primary, effort in secondary 57%), mic + caret, voice-waveform icon.
- There is **no big colored send button** until text is entered.
- In a conversation the composer collapses to one line (44px tall, 768px wide), docked at the bottom with the placeholder "Write a message…". Under it: the disclaimer "Claude is AI and can make mistakes. Please double-check responses." (12px secondary) and the model label at the right.

**Suggestion chips (home).**
- Content: "Write, Learn, Code, Career chat, Claude's choice".
- Size: 28px tall, radius 8, padding 0 9px, gap 6. Icon 20px (icon font) + 14px label.
- Paint: `fill-secondary` (15% white), hover 22%. No border, transition 60ms.
- 8px gap between chips, centered 40px below the composer.

**Buttons.**

| Variant | Spec |
|---|---|
| Secondary / default | fill 15% white (dark) or 5% black (light), text primary, radius 8, height 28 (sm) / 32 (md) / 40 (lg), padding ~9–16px, label 14–15px wght 395 |
| Primary | solid inverted: dark mode `#efefef` with text `#191919` ("Add", "New project"); light mode `#191919` with white text. **Not clay, not blue.** |
| Ghost / icon | transparent, 24–28px square, radius 6–8, hover 7.5% |
| Brand (rare) | `fill-brand` = `#c6613f`, hover `#d97757`, white text. Claude Design's send button is `#d97757`, 48px square, radius 10. |
| Hero CTA on an image ("Explore") | 40px, radius 10, `rgba(0,0,0,.55)` fill |

**User message.**
- Right-aligned bubble with max-width 85%.
- bg `rgb(255 255 255/.05)`, radius 12, padding 12px 16px.
- Text: sans 15/21.

**Assistant message.**
- **No bubble, no avatar.** Full-column serif prose 15/21 wght 360, left-aligned.
- Paragraph spacing ≈ 0.75em.
- Inline code: mono 13.5, bg 7.5% white, radius 4, padding 1px 4px.
- Code block: container bg `bg-000/50`, 0.5px border, radius 8. `pre` padding 14px, mono 14/22.75.
- Action row: 3 small icon buttons (copy, read aloud, retry), ~20px, muted, revealed under the reply.

**Dialog (Settings).**
- 1024×800, centered over a `rgba(0,0,0,.5)` scrim. bg `#1f1f1f`, radius 12, 1px ring 5% white.
- Header bar: 44px with a bottom border 12% white, "Settings" 15px wght 480, close X at the right.
- Left nav: 212px wide, bg `#191919`, right border 10%.
  - Search field at the top: 28px, radius 8, fill 5%, inset ring 4%.
  - Group labels ("Preferences / Customize / {organization} / Platform"): 12px secondary.
  - Nav items: 32px, radius 8, 20px line icons + 14px label; selected fill 15%.
  - External items carry a ↗ arrow.
- Content area (24px padding):
  - Section headers 15px wght 480; sections separated by ~28px.
  - **Settings rows:** label left (14px), control right. Rows are ~56px tall with 1px dividers (`#ffffff1a`).
  - Controls are **borderless ghost select triggers**: value + chevron, 28px, radius 8.
  - Theme uses an icon segmented control (monitor / sun / moon), 80×28.
- Toggle: 36×20 pill, track 10% white (off), 16px white knob with shadow-sm. "On" uses the accent blue track.
- Row with description: 14px label + 14px secondary description below, 4px gap, row padding 12px 0.

**Customize > Connectors page.**
- Serif H1 "Customize" 24px.
- Tab row:
  - Plain text tabs "Skills | Connectors | Plugins", 28px, radius 8; selected has a 15% fill.
  - A segmented "Yours | Discover".
  - Search field (28px, 5% fill).
  - Filter icon.
  - Primary "+ Add ▾" (light solid).
- Hero carousel card:
  - 960×279, radius 12, padding 24, muted desaturated teal-gray gradient image.
  - Eyebrow "CURATED BY ANTHROPIC", then a 22px sans title and a 14px secondary subtitle.
  - A row of app tiles, a dark translucent "Explore" button, and dots pagination below.
- Section header: "Top connectors" 15px wght 480 + a counter pill "8050" + right link "Show all →".
- Connector cards in a 2-column grid (474 wide, 12px gap):
  - Card: radius 11, padding 14, fill 3% white, no border/shadow.
  - Icon tile: 48px, bg `#1f1f1f`, 1px border 10%, radius 7, 34px logo inside.
  - Title: 14px wght 395 + a verified check icon + an optional outlined "Auto-connect" badge.
  - Description: 13px secondary, max 2 lines.
  - Meta row: outlined "✓ Added" badge (10px wght 520, 1.5px border 20%, radius 8) · "by Google" 13px secondary.
  - Right: a 28px "+" secondary icon button.

**Projects list.**
- Serif H1 "Projects".
- Tabs (Your projects / Organization / Shared with you), with a 15% fill on the active tab.
- Right side: search and sort icons + light solid "New project" button.
- Project card: 504×68, fill ~3%, radius 11. 32px icon tile, title 14px + outlined "Example project" badge, date 12px secondary.

**Project detail.**
- Breadcrumb top row.
- Serif H1 24px (opsz 24, wght 460).
- Meta: 12px secondary "Created by Anthropic · ⌂ Shared with your organization", then a 14px secondary description.
- The full composer is embedded.
- Tabs "Chats and tasks | Activity" + "🔒 All chats are private unless shared" at the right (13px secondary).
- Empty state: centered line icon (24px) + one 14px secondary sentence, 64px vertical padding. No illustration, no CTA.
- Right column (352px, radius 16, 0.5px border):
  - Tip card: bg `#111111`, radius 12, padding 20; hand-drawn-ish icon, 14px wght 395 title, 12–13px secondary body.
  - "Context" section: secondary 14px heading + search icon; file tile 157×128, radius 8, 1px border, filename 12px, size 10px, "MD" chip.
  - "Scheduled" section with a + button and a 12px secondary hint.

**Claude Design shell.**
- Warm palette.
- Full-width announcement bar: clay 16% tint (`rgba(224,137,104,.16)`), 13px text, clay link `#efad94`, close X.
- Top bar: serif "Claude Design" 20px with a tiny "Beta" (10px, muted) under it, avatar at the right, hairline bottom border. No left sidebar.
- Hero: serif 36px "What should we create?" centered.
- Composer card:
  - `#20201f`, 1px border 10%, radius 16, padding 14, very soft warm glow shadow `0 15px 30px rgba(240,239,236,.07)`.
  - Bottom row of 48px bordered "pill-boxes": +, "Design system / None" (stacked 10.5px label over a 13px value), </>, "Model / Opus 5.5", and a clay 48px send.
- Attached template drawer underneath:
  - Faint blue tint `rgba(77,185,255,.09)` with a blue border.
  - "CHOOSE A TEMPLATE" eyebrow, 11px wght 600 uppercase, blue-gray `#7fa9d3c7`.
  - 6×2 grid of template tiles: monochrome line pictograms with occasional clay accents; 11.5px labels; selected tile 13% fill + inset blue ring, radius 10.
- Below: tabs Projects / Design systems / Templates (14px wght 500, selected chip), search, star, list/grid toggle, list rows.

**Menus and popovers.** Not opened: the model menu did not open on a programmatic click and was not retried. From tokens:
- Surface `#303030` dark / white light, radius ~10–12.
- `shadow-popover` + 1px ring.
- Items 32px, radius 8, 14px; hover = ghost fill.
- `--cds-menu-gutter` 6px; tooltips use `surface-3`.

**Artifact panel.** Not captured. The chats sampled had no artifact.

---

## (c) ASCII wireframes (desktop, ~1880px viewport)

### Home `/new`
```
┌──────────────────────┬───────────────────────────────────────────────────────────────┐
│ ▢ Claude      [💬|</>]│                                                           (◌) │
│ ＋ New    (filled row) │                                                               │
│ ⌕ Search              │                                                               │
│ ▤ Projects            │                                                               │
│ ⧉ Artifacts           │                     ✳ Afternoon, {name}        (serif 38, light)│
│ ◷ Scheduled           │        ┌───────────────────────────────────────────────┐      │
│ ▭ Customize           │        │ How can I help you today?                     │ r14  │
│                       │        │                                               │#303030│
│ Chats and tasks ▾   ≡ │        │ ＋ [Chat|Cowork]         Opus 5.5 Medium ⌄ 🎙 ⫶ │      │
│ · {chat title}…       │        └───────────────────────────────────────────────┘      │
│ ◷ {task}     (19 new) │         [✎ Write] [🎓 Learn] [</> Code] [Career] [💡 Claude's] │
│ · {chat title}…       │                                                               │
│ · …                   │                                                               │
│ View all              │                                                               │
│                       │                                                               │
│ (◌) {name}·{org}    ⌄ ▣│                                                               │
└──────────────────────┴───────────────────────────────────────────────────────────────┘
 280px #1f1f1f │ 1px seam                    main #191919, composer 656px centered ~1/3 down
```

### Conversation `/chat/:id`
```
┌──────────────────────┬───────────────────────────────────────────────────────────────┐
│ (sidebar as above,   │ {chat title} ⌄                                        [⇪ Share]│ 45px row
│  current chat row    │                                    ┌─────────────────────────┐│
│  filled 15%)         │                                    │ {user message}…         │ user bubble 5%, r12
│                      │                                    └─────────────────────────┘│
│                      │      {Claude's reply, first paragraph}…                      │
│                      │      {reply continues} (serif 15/21, no avatar)               │
│                      │      {next paragraph, with `inline code`}…                    │
│                      │      ⧉ 🔊 ↻   (tiny muted actions)                            │
│                      │                                                               │
│                      │     ┌─────────────────────────────────────────────────────┐   │
│                      │     │ ＋ Write a message…                         🎙 ⌄ ⫶   │ 44px r14
│                      │     └─────────────────────────────────────────────────────┘   │
│                      │      Claude is AI and can make mistakes…    Opus 5.5 Medium   │ 12px
└──────────────────────┴───────────────────────────────────────────────────────────────┘
                         column 768px max (messages 736px), centered
```

### Settings (modal over app, `#settings/general`)
```
            ┌──────────────────────────────────────────────────────────────┐
            │ Settings                                                  ✕  │ 44px, border-b
            ├──────────────┬───────────────────────────────────────────────┤
            │ [⌕ Search   ]│ Appearance                                    │
            │ Preferences  │ Theme                          [🖥|☀|☾]       │
            │ ⚙ General ▓▓ │ ───────────────────────────────────────────── │
            │ 👤 Account   │ Interface font        Default · Anthropic Sans ⌄│
            │ 🛡 Privacy   │ ───────────────────────────────────────────── │
            │ ◔ Usage      │ Response font                 Anthropic Serif ⌄│
            │ ▭ Capabilities│ …Transcript text size / width / Motion        │
            │ ◎ Memory     │                                               │
            │ 🎨 Design sys │ Voice                                         │
            │ </> Claude Code│ Language / Style / Speed           value ⌄    │
            │ ☑ Cowork     │                                               │
            │ Customize    │ Notifications                                 │
            │ Skills/Conn… │ Response completions                    (○──) │
            │ {Org}        │ Get notified when Claude has finished…        │
            │ Org        ↗ │                                               │
            │ Platform     │                                               │
            │ API keys   ↗ │                                               │
            └──────────────┴───────────────────────────────────────────────┘
             212px #191919        content on #1f1f1f, 1024×800, r12, scrim 50%
```

### Connectors (`/customize/connectors`; Settings › Connectors now says "Connectors have moved to Customize. Head there to browse, connect, and manage them.")
```
 Customize                                               (serif 24)
 [Skills] [Connectors▓] [Plugins]  [Yours|Discover▓]     [⌕ Search    ] ≡  [＋ Add ⌄]
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │                         CURATED BY ANTHROPIC                                   │
 │  (‹)                    Claude for science                               (›)   │ r12
 │              Search literature, plan experiments, and analyze results.         │ muted gradient
 │                  [M] [bR] [NIH] [•] [◎] [⊞] [♡]                                │
 │                               [ Explore ]                                      │
 └───────────────────────────────────────────────────────────────────────────────┘
                                  ▬ • •
 Top connectors (8050)                                              Show all →
 ┌──────────────────────────────────────┐ ┌──────────────────────────────────────┐
 │ [▲]  Google Drive ✓                (+)│ │ [M]  Gmail ✓                      (+)│ r11, 3% fill
 │ 48px Search, read, and upload files…  │ │      Draft replies, summarize…      │
 │      [✓ Added] · by Google            │ │      [✓ Added] · by Google          │
 └──────────────────────────────────────┘ └──────────────────────────────────────┘
 … 2-col grid, 12px gaps …   Trending connectors (10)                Show all →
```

### Projects (`/projects`) and a project (`/project/:id`)
```
 Projects                                                (serif 24)
 [Your projects▓] [Organization] [Shared with you]          ⌕  ⇅  [New project]
 ┌──────────────────────────────────────────┐
 │ [▤] How to use Claude (Example project)  │ r11, 3% fill
 │     Oct 6                                │
 └──────────────────────────────────────────┘

 Projects / How to use Claude                                          (breadcrumb row)
 How to use Claude                                         📌  ⌂ Share  ⋯   (serif 24)
 Created by Anthropic · ⌂ Shared with your organization                     (12 secondary)
 An example project that also doubles as a how-to guide…                   (14 secondary)
 ┌─────────────────────────────────────────────┐   ┌───────────────────────────┐
 │ How can I help you today?                   │   │ ┌───────────────────────┐ │
 │ ＋ [Chat|Cowork]     Opus 5.5 Medium 🎙 ⫶    │   │ │ ✋ Add relevant context│ │ tip #111, r12
 └─────────────────────────────────────────────┘   │ │ Upload documents…     │ │
 [Chats and tasks▓] [Activity]   🔒 All chats are private… │ └───────────────────────┘ │
                                                   │ Context              ⌕   │
                 💬                                │ ┌─────────┐               │
   Claude references the same knowledge every time │ │guide.md │ [MD]          │
   you talk to it in this project.                 │ └─────────┘               │
                                                   │ Scheduled              ＋ │
                                                   └───────────────────────────┘ r16
```

### Claude Design (`/design`)
```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Claude Design is moving to Artifacts in the Claude app. You can keep using… Learn more ✕│ clay 16% tint (banner text observed 2026-10-28)
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Claude Design                                                                   (◌)  │ serif 20
│ Beta                                                                                 │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                         What should we create?        (serif 36, wght 420)           │
│          ┌──────────────────────────────────────────────────────────────┐           │
│          │                                                              │ r16 #20201f│
│          │ [＋] [Design system▾ None] [</>]        [Model▾ Opus 5.5] [↑] │ 48px pills │
│          ├──────────────────────────────────────────────────────────────┤           │
│          │ CHOOSE A TEMPLATE ^                       (blue-tint drawer) │           │
│          │ [Blank▓][Mobile app][Slides][Document][Wireframe][Animation] │           │
│          │ [UI mockups][Résumé][3D object][Research][HTML email][Color+type]│        │
│          └──────────────────────────────────────────────────────────────┘           │
│  [Projects▓] Design systems  Templates                 [⌕ Search ] ☆ [≡|⊞]           │
│  [🍎] Learn about Claude Design  Quick tutorial                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
  app bg #1c1b19 (warm), no sidebar, content ~984px centered
```

---

## (d) Voice and microcopy patterns

- **Greeting is personal and time-aware, nothing more:** "Afternoon, {first name}". No exclamation mark, no "I'm your AI assistant".
- **Placeholders are plain questions or verbs:** "How can I help you today?" on home, "Write a message…" in a thread (uses the ellipsis character "…", not three dots). Design: "What should we create?" (first-person plural, collaborative).
- **Nav labels are one word and sentence case:** New, Search, Projects, Artifacts, Scheduled, Customize. Section labels: "Chats and tasks", "Top connectors", "Trending connectors".
- **Sentence case everywhere.** The only exception is tiny uppercase eyebrows ("CURATED BY ANTHROPIC", "CHOOSE A TEMPLATE").
- **Descriptions are one sentence, functional, and end with a period:**
  - "Get notified when Claude has finished a response. Useful for long-running tasks."
  - "Claude references the same knowledge every time you talk to it in this project."
  - "Upload documents, code, and other files to the project for Claude to reference in your chats."
  - "Set up recurring tasks for this project."
- **Claude is referred to by name in the third person**, never "AI", "assistant" or "bot": "Claude is AI and can make mistakes. Please double-check responses."
- **Reassurance about privacy is stated flatly:** "All chats are private unless shared."
- **Status words are terse badges:** "Added", "Auto-connect", "Example project", "{n} new", "Beta".
- **Moved or deprecated notices are direct and give one action:** "Connectors have moved to Customize. Head there to browse, connect, and manage them." and "Claude Design is moving to Artifacts in the Claude app. You can keep using this version until December 14. Learn more" (banner text observed 2026-10-28).
- **Meta lines use a middle dot (" · "):** "{name} · {organization}", "Created by Anthropic · Shared with your organization", "Default · Anthropic Sans".
- **Suggestion chips are verbs or nouns, not prompts:** Write, Learn, Code, Career chat, Claude's choice.
- Uses curly apostrophes (’).

---

## (e) What makes it feel like claude.ai

1. **Serif for Claude's voice, sans for the machine.** Greetings, page titles, the wordmark and *Claude's replies* use a soft, light, optical-sized serif. All chrome is a quiet sans. This split is the single strongest identity cue.
2. **Light weights, especially in dark mode.** Body text is wght ~360, controls ~395, headers ~480, and the greeting is 290. Nothing is bold-heavy. Dark mode is deliberately lighter than light mode.
3. **Monochrome UI; color only means something.** Surfaces are neutral, or warm-neutral in the classic and Design palettes. Accent blue is reserved for focus, links and selection. Clay `#d97757` appears almost only as the Spark logo (and Design's send button). Primary buttons are inverted neutrals (near-white on dark), not brand color.
4. **Selection by fill, not by color.** Active nav, tabs and segmented items are a 15% white (or 10% black) wash with radius 8. No accent bars, no underlines, no glowing outlines.
5. **Hairlines and almost-no shadows.** 1px rings at 4–12% alpha (inset in dark mode), seams at 10%, and shadows so diffuse they read as depth rather than float (composer `0 4px 20px` at 3.5%).
6. **Consistent soft geometry.** 8px on controls, 11–12px on cards, bubbles and dialogs, 14–16px on the composer, and full pills only for badges, counters and toggles. Everything sits on a 32px control height and a 4px grid.
7. **The composer is the hero.** Centered, generous, a slightly raised surface, with tools tucked into a bottom row of ghost controls. The model name is plain text, not a loud selector.
8. **Calm, sparse layouts.** A 768px reading column, 960px content pages, lots of empty space. Empty states are one icon and one sentence.
9. **Line icons from one family at one size** (20px slot, thin stroke, rounded), always in text color. Never filled, never colored.
10. **Assistant replies are typeset like a document**, not a chat app: no avatar, no bubble, serif paragraphs. Only the user's turn sits in a faint bubble.
11. **Quick, small motion.** 60–200ms with ease-out or snappy curves, a subtle spring "squish" on press, and reduced motion respected. Nothing bounces or shimmers for decoration. Shimmer is used only for "Claude is thinking" text.
12. **Plainspoken, sentence-case copy** that names Claude and states facts briefly.

## What NOT to do (knock-off and "AI vibe-coded" risks)

- **No purple/blue gradients, neon glows, glassmorphism, or animated orbs.** claude.ai has no gradient buttons and no glow focus rings beyond a 6px soft accent halo.
- **No pure black `#000` or blue-black backgrounds.** Use `#191919` / `#1f1f1f` (neutral) or `#262624` / `#1c1b19` (warm), and do not combine the two families on one screen.
- **Don't make clay orange the UI accent.** Using it for every button, link or focus ring is the most common knock-off tell. Keep it to the mark and at most one brand moment.
- **No bold or semibold body text, and no all-caps headings.** Avoid Inter at 500–600 everywhere. Get the light-weight, serif-greeting feel or it reads generic.
- **Don't put Claude's replies in bubbles with avatars**, and don't add "AI" sparkle icons. The Spark asterisk is Anthropic's mark; don't use it as a generic AI icon or redraw it.
- **No heavy drop shadows, thick borders (>1px), or card-on-card stacking.** Separate with fills and hairlines.
- **No emoji in UI chrome**, and no exclamation-mark microcopy ("Let's go! 🚀").
- **Don't copy trademarked assets** (Anthropic Sans/Serif files, the Claude wordmark, the Spark). Use substitutes: Source Serif 4 or Newsreader, Hanken Grotesk or Instrument Sans, JetBrains Mono, Lucide icons. Make the concept read as "in the family" without impersonating the product. For a concept labeled as part of the Claude family, follow the Claude Design precedent: a serif product name with a small "Beta" under it, and no claim to be the official app.
- **Don't fill dashboards with colorful stat tiles.** Use the neutral card (3% fill, radius 11) and outlined badges.
- **Don't over-animate.** No staggered entrance cascades, parallax or typing effects on static text.

---

## Screenshots and raw extractions

Screenshots and raw extractions were kept locally and are not published.

**Gaps.** The menu/popover styles and the artifact panel were not observed directly. Menu values above come from tokens.
