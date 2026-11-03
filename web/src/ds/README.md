Claude Desk is a public, always-on Claude for a person or small business: strangers and their agents talk to it, and it answers, books, quotes and takes payments under the owner's rules. The interface is warm and quiet, in a warm dark theme and a light one on warm paper, so that the one thing that stands out is what Claude did and why: the receipts attached under each message. Build every surface (the owner app, the public page and setup) from these tokens and rules.

## Content

- Write in sentence case everywhere: page titles, buttons, labels and menus. Never set words in all caps; acronyms such as AI, PDF and SMS stay as they are.
- Be plain, literal and specific. No wordplay, no exclamation marks, and no "→" or other arrows on buttons.
- Make buttons say exactly what happens: "Allow this time", "Open payment page", "Download". Never "Continue" or "OK" when a verb can say more.
- Let Claude speak in the first person, in serif (`reply`, `summary`, `greeting`): "These times are open on Mike's calendar. Which of them works for you?" People speak in sans (`message`).
- Never let Claude's prose say that something is booked, paid, refunded, discounted or what it costs, or that Claude did something no receipt records. The typed card and its receipt say it; the prose only leads into them: "Here are the details."
- Separate facts with commas or separate lines, never with "A · B · C" strings.
- Set off a name someone chose (a visitor's, an agent's) as user text: its own `.cd-user-name` element marked `data-copy="user"`, first in its line, and never joined to a status or a trust word in one run of text. A status sits beside it in its own `Pill`, as "Signed" or "Not signed" does on an agent's request.
- Write English and Spanish wherever a visitor reads.
- Call the product Claude Desk: one is "your Desk", several are "Desks". Every surface carries the footer "Concept prototype by Giovanni Alcantara, not an Anthropic product" in `caption`.
- Say on every visitor surface that Claude is an AI answering for the business: "You're chatting with Claude, an AI answering for Turner Plumbing. Ask for Mike Turner anytime." While the owner is in the chat, the public page's chat head says instead: "{owner} is in this chat. Claude, an AI, is paused until {owner} hands it back." Both forms name Claude as an AI, and neither can be turned off.

## Visual foundations

### Themes

- There are two themes. Dark is the base the tokens are written in, and the boards are drawn in it; light overrides it. System, which follows the device, is the default choice. Light sets the same interface on warm paper: the dark theme's ink at its alpha steps, the primary button in ink on paper, darker steps of the status hues, a darker clay, and a lighter scrim and shadows. Components never name a theme: they use the tokens, and the tokens change with it.
- `tokens.json` holds both. `color.themes` lists `dark` then `light`, and each color and shadow token has a `dark` value and, where it changes, a `light` one. `npm run tokens` writes `tokens.css` from it, never by hand: the dark values on `:root` and `[data-theme="dark"]`, then the light values on `:root[data-theme="light"]` and, for a system that prefers light, under `@media (prefers-color-scheme: light)` on a root not marked dark. Both light blocks set `color-scheme: light`, so the browser's own scrollbars and form controls follow; `index.html` names both schemes.
- A token with no light value keeps its dark one in both themes. The aliases (`line-focus`, `button-primary-text`, `status-info`) resolve against the light values by themselves. The mark's colors, Google Calendar's blue, the intro illustration's secondary ink, avatar, line and check, the QR code's tile and hairline, and the inks on an owner's colour are the same in both. The illustration's ink and the QR code's ink, which alias `bg-app` in the dark theme, are written out in the light one, so they stay dark on their light grounds.
- Each person chooses in Settings › General › Appearance: System (the default), Light or Dark. The choice is kept in this browser (`web/src/lib/theme.ts`, beside the app's other conveniences in `web/src/lib/storage.ts`), applies at once and in the browser's other tabs, and `index.html`'s first script, before any stylesheet, marks the root with it before the page first paints, so a chosen theme never flashes the other. System leaves the root unmarked, and the system's preference picks the theme in CSS. A blocked storage reads as System. The public page has no control of its own: it follows the device, and any choice made in that browser.
- Storybook draws every story dark, whatever the viewer's system prefers; its Theme toolbar, or `&globals=theme:light` in a story's address, draws it light. The test browsers prefer dark too, so the tests check the dark theme unless one asks for light (`web/src/ds/test/theme.ts`).
- A part that must look the same in both themes is marked dark (`data-theme="dark"`), which sets the dark values on it: the About pages' app icon keeps the dark theme's clay field, as the mark's colors are the same in every theme.

### Color

- Set pages on `bg-app`. Put the sidebar and side panels on `bg-panel` with a `line-hairline` seam; the composer, menus and popovers on `bg-surface`; quiet fills on `bg-muted`; the active nav row, the segmented control thumb and the initials avatar on `bg-selected`.
- Set body text and everything Claude says in `text-primary`; captions, meta lines, helper text and receipts in `text-secondary`, except the state's words that lead an owner's decision receipt, in `text-primary`. Use `text-tertiary` only for placeholders and labels at 13 px and up.
- Separate regions by fill and a hairline, not by shadow. A card is `fill-card` with a 1 px `line-card` border. Chips, outlined pills and the whisper composer are outlined in `line-control`, `line-control-hover` on hover; the recorded-history link is underlined in it. Outline a text field in `line-field`: its outline is its boundary, so it reaches 3:1 against the ground.
- Make the primary button `button-primary` with `button-primary-text`, `button-primary-hover` on hover: an inverted neutral, at most one per view. Secondary buttons are `fill-secondary` (`fill-secondary-hover` on hover) with `text-primary`; ghost buttons are transparent with `fill-hover` on hover. Visitor bubbles are `fill-bubble`; count pills and the segmented track are `fill-count`.
- Give refusals ("Deny this time") and deletes that cannot be undone ("Delete this Desk", "Delete Desk") the red look. This owner decision of 2026-11-02 replaces the earlier neutral-delete rule: `danger` buttons are `button-danger-fill` (`button-danger-fill-hover` on hover) with `button-danger-text`, and `danger-ghost` buttons are transparent with `button-danger-text`. They are the only red controls and the only red words in the system, with the items of Deny's menu on a held request, which use `button-danger-text` on `bg-surface`. Their words say what is refused or deleted ("Deny this time", "Always" in Deny's menu, "Delete Desk"), and the red is never a status.
- Use `accent-blue` only for links and selection. Never put text on it, never use it as decoration and never for focus: the focus edge is `line-focus`, the warm secondary ink.
- Show status only as a `size-dot` dot or a thin bar in `status-handled` (handled or allowed), `status-held` (held, needs you), `status-refused` (refused or blocked) or `status-info` (a hollow dot), always beside words that say the same thing. Never a colored tile, a filled badge or colored text.
- Use `clay` only as the field behind the first-visit intro's illustration, and as the field of the Claude Desk app icon (`MarkAppIcon`), which counts as part of the mark (owner, 2026-10-30), and as the color of Claude's writing dots (`WritingIndicator`), at the owner's request (2026-10-31). The light theme's clay is a step darker for paper, and the clay guards in `web/src/ds/guards.test.ts` and `web/src/app/guards.test.ts` know it as clay too; the app icon keeps the dark theme's.
- The Claude Desk mark has its own fixed colors, the same in every theme: `mark-clay`, `mark-ink`, `mark-ink-light`, `mark-tile` and `mark-hairline`. Nothing else uses them. The bell has no tile: on the dark theme's grounds its ink is `mark-ink-light`, and on a light ground, the light theme's paper included, it keeps the drawing's dark ink, `mark-ink`. Its clay dome stays `mark-clay` in both themes. Only the app icon draws it on its white tile, `mark-tile`, with a `mark-hairline` edge.
- The About pages show the app icon at the top of the article, centred above "About this prototype" and the title: the tiled bell at two thirds of a clay field whose corners are a quarter of its size, 120 px on the desktop layout and 88 px on the phone layout. Their top bar is the app's lockup, as in the sidebar: the bell with no tile, "Claude Desk" and, from 1100 px up, the "Preview" badge (owner, 2026-10-30).
- The About pages keep their own paper (`web/src/about/paper.css`) in both themes: every color on them, their ground, top bar, figures, app icon and footer included, is the same in either, and `web/src/about/theme.browser.test.tsx` checks it on each page at both sizes.
- In the dark theme, the product has three light surfaces and no others: the intro illustration's cards, the QR code's sand tile on Share's printable card, and the mark's tile on the About pages, which is the app icon's white tile. The cards (`illustration-card`, with `illustration-ink`, `illustration-ink-secondary`, `illustration-avatar`, `illustration-line` and `illustration-handled`) are decorative and hidden from assistive tech, and nothing else uses these colors; the mark sits on them in its dark ink, with no tile. A QR code draws its own light quiet zone, which it needs to scan: on Share's card that ground is the tile's sand (`qr-tile`), with `qr-ink` modules, and the tile's inset edge is `qr-hairline`.
- A third-party connector (Stripe, Google Calendar) shows its own mark with no tile, in its brand's color, always beside its name and its Mock badge: Stripe's in white on the dark grounds (`connector-stripe`), as Stripe's guidelines allow, and in Stripe's own purple on the light theme's paper, with no outline and no tile, and Google Calendar's in its own blue (`connector-google-blue`) in both. The marks are decorative and hidden from assistive tech, nothing is read on them, and nothing else uses these colors. Built-in connectors keep their line icons on a `fill-secondary` tile.

### Brand colors on the public page

- The public page's header is set in the business's own colors, not in tokens: a field, two inks for the text on it and an accent. They arrive with the Desk (`PublicDesk.brand`), mapped to the header's `--brand-*` properties, and anything that isn't a plain hex color or a token falls back to the panel and the text tokens.
- Every colour an owner can pick is dark, so the text on it is paper ink in both themes: `text-on-brand` for the names and `text-on-brand-secondary` for the second line, which have one value for both themes. The open-status dot on it is `status-handled-on-brand`, the dark theme's green, in both themes: the light theme's would fall to 1.7 to 2.3:1 there. Profile's header-colour preview draws the same. Both inks keep 4.5:1 over the field, and a test checks them on every palette colour. A brand whose field can't carry them falls back to `bg-panel` with the theme's own `text-primary` and `text-secondary`, as does No colour.
- The accent is decorative only: a 2 px rule under the header. Never text, never a ground for text, and never the only sign that something is a control.
- Everything below the header is the design system's: the chat, the about column and the footer use tokens like any other surface.

### Type

- Use `serif` (Source Serif 4) for Claude's voice and page identity, `sans` (Hanken Grotesk) for the whole interface, and `mono` (JetBrains Mono) only inside an expanded full trace, for a connector's quoted tool definition, and for code a developer copies on the agents page (`CodeBlock`, `CopyField`). All three load from Google Fonts.
- Long-form reading pages (the About this prototype documents) set their body in Source Serif 4 (article-body); serif body text elsewhere stays Claude's voice only. The exception is these pages' `article-*` styles: their title, body and quotations in serif, their headings and captions in sans. Nowhere else does serif carry body text: not in conversations, cards or the public page.
- Apply a style with its class, `.cd-type-<style>`. Claude's voice: `greeting`, `page-title`, `intro-title`, `wordmark`, `summary`, `reply`, `illustration-reply`. Interface: `body` (already set on the page body), `control`, `section`, `message`, `meta`, `caption`, `pill`, `count`, `badge-caps` (the one style in capitals), `brand-name`, `amount`, `figure`, `figure-small`. Reading pages: `article-title`, `article-body` (also the summary under the title), `article-heading`, `article-quote` (italic) and `article-caption`; below the reading page's breakpoint, `article-body-phone` and `article-heading-phone` take the body's and the headings' places. Trace and code: `trace`, `quote` for a connector's quoted tool definition, and `code`.
- The reading pages' serif styles set no optical size, so the browser sizes Source Serif 4 to each style's px size, up to the font's 60; `article-caption` is weight 380. Both wait on a check against the signed reader boards.
- Set a summary's headline figure, such as Today's booked total, in `figure`, and a secondary one, such as Today's stopped count, in `figure-small`; both use tabular figures. `amount` stays the checkout's amount to pay.
- Set page titles in `page-title`, left-aligned. Claude's replies are `reply` paragraphs with no bubble and no avatar, like a document; a visitor's message is `message` in a `fill-bubble` bubble at `radius-card`, aligned right.

### Space, size and shape

- Space with the steps `space-2` to `space-40`. Pad cards with `space-16` to `space-20`; pad content with `space-40` at the sides on desktop and `space-16` on a phone.
- Lay out the owner app with a `size-sidebar` sidebar and content no wider than `size-content`. An owner’s open conversation is a centred `size-conversation` column (768 px) within its pane, with at least the page gutter on either side. Claude’s prose keeps the `size-reading` measure (640 px), with each message’s receipts attached under it.
- Make controls `size-control` tall and a screen's main action `size-control-main`. On a touch screen (`pointer: coarse`) a tap needs `size-touch` (44 px) each way: a smaller `Button`, `IconButton`, suggestion chip or `TextLink` reaches it with an unseen hit area centred on it, never by drawing itself bigger, and where its neighbours sit closer than that, its reach stops halfway to them, so two hit areas never overlap. A link in a reading page's running text keeps no hit area beyond its words. Nav rows are `size-nav-row`, icons `size-icon`, avatars `size-avatar`, and the public page's brand header `size-brand-header`. The first-visit intro dialog is `size-intro` wide, its illustration half `size-intro-illustration`. A reading page's text column is `size-article-measure` wide, with `size-article-side` for the column beside it. The Ask Claude panel beside a page is `size-side-panel` wide, and a section's `SubNav` beside its content, as on Settings, `size-sub-nav`. The agents page is one `size-agents-column` column. On the connector pages, the add flow's sign-in and review draw a connector's tile `size-connector-title-tile`, a connection's details put their terms in a `size-connection-term` column, and a tool's recent requests their times in a `size-recent-when` column.
- Round controls with `radius-control`; cards, dialogs and bubbles with `radius-card`; the composer with `radius-composer`; pills, chips, switches and avatars with `radius-full`.
- Use `shadow-composer` on the composer and nowhere else. The shadows and the scrim are lighter in the light theme. The first-visit intro dialog, the connector picker and the connector sign-in sit over `scrim` and lift with `shadow-dialog`, as do the popover menus (an approval's answers, `OutcomeMenu`, `PresetMenu`) over the page. `Dialog` sits over `scrim` with no shadow, as N-Run2-Settings-DeleteDesk draws it, and so does the Ask Claude panel as a tablet's sheet, docked at the window's right edge.

### Scrollbars

S1 applies to every app scroll area, on both axes: a 6 px thumb inset 3 px in a transparent 12 px track, at least 32 px long, with `radius-full` corners. Its token pair is `--line-control` at rest (decoration) and `--text-tertiary` while the scroll area is hovered or the thumb is dragged; its width never changes. Firefox uses its native thin bar with the resting and hover tokens, only where WebKit scrollbar selectors are unsupported. SubNav keeps its hidden bar, and the About pages' paper and standalone vision pages keep the browser's own scrollbar. Scrolling behaviour stays native.

### Motion

- Keep transitions between 60 and 200 ms: `motion-instant` for color, `motion-fast` for press feedback, `motion-base` for a check that draws once or a reveal. Ease with `motion-ease`, or `motion-ease-emphasis` for a screen's one small moment. Results that arrive one by one are `motion-stagger` apart. Each new word of Claude's reply settles in over `motion-settle` as it streams or is revealed (`ChatMarkdown`). After a revealed reply's words, its cards and then their receipts fade and rise in over `motion-base`, `motion-follow` apart (`ClaudeMessage`, `TranscriptRow`).
- A drawn check goes short arm first, as a hand writes one. The check icon's path starts at the long arm's tip, so its dash offset runs from minus its dash length to 0. `expectDrawsShortArmFirst` (`test/`) pins it in a story.
- The only loops are `motion-breathe` for presence glyphs, `motion-writing` for a person's typing dots and line and for the skeleton's sweep while a page loads, `motion-dots` for Claude's writing dots, and `motion-spin` for a busy button's spinner.
- Allow at most one small moment per screen. Motion explains a change; it never decorates.
- Under `prefers-reduced-motion: reduce` nothing animates or transitions; the base stylesheet enforces it on every element.

## The signature: receipts under each message

- Show checkpoint results as receipts attached under each message, at every width: each one (a `MarginReceipt`) sits right under the message it explains, like an editor's note, as a status dot and one line of `caption` in `text-secondary`. On owner screens, the receipt that reports what the kernel decided leads with its state's words in `text-primary`, then the decision's reason in `text-secondary` ("Stopped. Someone asked for another customer's invoice.").
- On visitor surfaces, show exactly the signed event's `visitor_plain` line, never rewritten and never with a clock time. On owner screens a receipt opens the full trace.
- Keep everything around the receipts quiet. They are the one bold element in the system.

## Typed cards

- Show prices, dates, times, discounts and bookings only in typed reply cards rendered from checked facts. Claude's own words can't state a price, date or discount, can't make a promise the cards don't back, and can confirm a booking only next to a booking card. A card shows exactly the fields it receives; nothing in the design system computes or formats money or dates.
- The one clock time a visitor reads outside a card is the public page's open status: "Open now, until 6:00 pm", the kernel's own words in the business's time zone, shown verbatim in the header. The page never works out a time itself.
- Give each card template fixed English and Spanish chrome with no amounts, dates or promises. Every card about money moving (a payment link, a paid link, a charge or a refund) and the checkout always say "Test payment, no money moves" / "Pago de prueba, no se mueve dinero".
- Draw a card as `fill-card` with a `line-card` border at `radius-card`, at most 520 px wide, and never put a card inside another card. The one exception is the agents page's "Send an agent" card, which holds the agent's run and so the Desk's reply cards: `Card`'s `holdsCards`, at the top level only, one level deep, and allowed in the web app only in its `SendAgentPanel` (the guard `only_the_send_agent_panel_holds_cards`).

## Iconography

- Use 20 px (`size-icon`) line icons with a 1.5 px effective stroke in the current text color. No filled icons, no emoji, no sparkles or other "AI" glyphs.
- The Claude Desk mark, a hand-drawn service bell (a clay dome under ink lines, with no tile), is the only mark, and its colors are used nowhere else. Never use a Claude or Anthropic logo.
- Render initials avatars and monograms `aria-hidden`, beside the name written out as text.

## Accessibility

- Every color pair a component uses is listed in `CONTRAST_PAIRS` (`contrast.ts`), and the token tests fail if any falls below its minimum, in each theme: 4.5:1 for text (3:1 at 24 px and up), and 3:1 for focus edges, status dots and the mark. The light theme reads a token's light value, or its dark one where it has none, as the CSS inherits it. Translucent grounds are measured over what they sit on, down to an opaque color (a button's fill over a card's fill over the app). A busy button is never faded: it steps to listed colors, so its label is a listed pair too.
- Only the mark's pairs differ by theme: its light ink is checked on the dark theme's grounds, and its dark ink on the light theme's (16.8 on `bg-app`, 15.6 on `bg-panel`, 17.6 on `bg-surface`). On the paper its clay dome reads 2.6 to 3.0 and its lone white tile 1.1; as parts of a logo they are exempt, named with their reasons in `LIGHT_THEME_EXEMPTIONS`, and the test fails if an exemption stops being needed. `text-on-brand`, `text-on-brand-secondary` and `status-handled-on-brand`, the open-status dot's green, sit on the owner's colour, not a token, so they are classified in `ON_BRAND_COLORS` and checked on every palette colour, the words at 4.5:1 and the dot at 3:1.
- The tables below give the dark theme's figures. In the light theme, `text-primary`, `text-secondary`, `text-tertiary` and `accent-blue` read 12.6, 5.7, 5.0 and 6.1 on `bg-app`, 11.9, 5.5, 4.8 and 5.7 on `bg-panel`, 13.2, 5.8, 5.1 and 6.5 on `bg-surface`, and 10.5, 5.2, 4.6 and 5.0 on `bg-selected`, the closest of the light pairs to its minimum; the status dots read 4.1 to 5.1 on those grounds, `line-focus` 5.5 to 5.8, `button-primary-text` 15.2 on `button-primary`, `clay` 3.6 on `bg-app`, `line-field` 3.9, and Stripe's purple 4.3 on `bg-app`.

Text and links, 4.5:1:

| Ground | `text-primary` | `text-secondary` | `text-tertiary` | `accent-blue` |
| --- | ---: | ---: | ---: | ---: |
| `bg-app` | 13.9 | 7.3 | 6.6 | 7.3 |
| `bg-panel` | 13.0 | 7.0 | 6.3 | 6.8 |
| `bg-surface` | 11.9 | 6.6 | 6.0 | 6.2 |
| `bg-muted` | 11.4 | 6.4 | 5.8 | 6.0 |
| `bg-selected` | 9.6 | 5.6 | 5.1 | 4.9 |
| `fill-card` over `bg-app` | 13.0 | 7.0 | 6.3 | 6.8 |
| `fill-bubble` over `bg-app` | 12.0 | 6.6 | 6.0 | 6.3 |
| `fill-count` over `bg-app` | 12.3 | 6.7 | 6.1 | 6.4 |
| `fill-hover` over `bg-app` | 12.0 | 6.6 | 6.0 | 6.3 |
| `fill-secondary` over `bg-app` | 10.7 | 6.0 | 5.5 | 5.5 |
| `fill-secondary-hover` over `bg-app` | 9.1 | 5.4 | not used | 4.7 |
| `fill-hover` over `bg-surface` | 10.0 | 5.8 | 5.3 | 5.2 |
| `fill-secondary` over `bg-surface` | 8.9 | 5.3 | 4.8 | 4.6 |
| `fill-secondary-hover` over `bg-surface` | 7.6 | 4.7 | not used | not used |
| `fill-card` over `bg-panel` | 12.0 | 6.6 | 6.0 | 6.3 |
| `fill-card` over `bg-surface` | 11.0 | not used | not used | 5.7 |
| `fill-card` over `fill-card` over `bg-app` | 12.0 | 6.6 | not used | not used |
| `fill-count` over `bg-panel` | not used | 6.3 | not used | not used |
| `fill-count` over `bg-selected` | not used | 5.0 | not used | not used |
| `fill-hover` over `bg-muted` | 9.7 | not used | not used | not used |

`button-primary-text` reads 14.6 on `button-primary` and 12.2 on `button-primary-hover`.

`button-danger-text` reads 6.1 on `button-danger-fill` and 5.3 on `button-danger-fill-hover` over `fill-card` (6.6 and 5.7 straight on `bg-app`), 7.9 on `fill-card` and 6.7 on `fill-hover` over `fill-card` (8.5 and 7.3 on `bg-app`). In a dialog on `bg-surface`, its danger button reads 5.5 at rest and 4.8 on hover or while busy (5.8 and 5.3 in the light theme).

Busy buttons step to listed colors instead of fading, and a spinner in the label's busy color takes the label's place. In a held request's card, the busy Allow's `text-secondary` label reads 5.7 on `fill-secondary`, and the busy Deny keeps its red words on `button-danger-fill-hover` at 5.3; a busy ghost or danger-ghost button there would read 7.0 on the card or 6.7 on `fill-hover`. A busy secondary button reads 6.0 on a page and 5.3 on a dialog's `bg-surface`, a busy ghost button 7.3 on a page, 7.0 in the sidebar and 6.4 on the reviewer bar's `bg-muted`, a busy danger or danger-ghost answer 5.7 or 7.3 straight on a page, a busy danger confirm 4.8 in a dialog, and the busy primary 12.2 on `button-primary-hover`. Those are the only grounds whose busy pairs are listed, and every Button in the design system sits on one of them. No Button sits on `bg-selected`: a busy secondary label would read 4.45 there and a busy danger one 3.98, so the guard `no_button_on_the_selected_ground` keeps Buttons off it.

The spinner's arc is a graphic, 3:1, drawn in the busy label color at full strength, so it reads at the pairs above: 12.2 on a busy primary; on a busy secondary 6.0 on a page, 5.7 in a card and 5.3 in a dialog; on a busy ghost 7.3 on a page, 7.0 in the sidebar or a card, 6.6 in a dialog and 6.4 on the reviewer bar; on a busy danger button 5.7 on a page, 5.3 in a card and 4.8 in a dialog; and on a busy danger-ghost 7.3 on a page, 6.7 in a card and 6.0 in a dialog. The ring behind the arc, the same color at 30%, is decoration: the arc carries it.

In Deny's menu on a held request, `button-danger-text` reads 7.2 on `bg-surface` and 6.0 on `fill-hover` over it (an item hovered or focused). Allow's items use `text-primary` and every item's line `text-secondary`, already listed on `bg-surface` and on `fill-hover` over it.

Focus edges, status dots and the scrollbar's hovered or dragged thumb, 3:1:

| Ground | `line-focus` | `accent-blue` | `status-handled` | `status-held` | `status-refused` | `status-info` | S1 hover `text-tertiary` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `bg-app` | 7.3 | 7.3 | 6.1 | 9.4 | 6.3 | 7.3 | 6.6 |
| `bg-panel` | 7.0 | 6.8 | 5.6 | 8.7 | 5.8 | 7.0 | 6.3 |
| `bg-surface` | 6.6 | 6.2 | 5.1 | 7.9 | 5.3 | 6.6 | 6.0 |
| `bg-muted` | 6.4 | not used | not used | not used | not used | not used | 5.8 |
| `bg-selected` | 5.6 | 4.9 | 4.1 | 6.3 | 4.2 | 5.6 | 5.1 |
| `fill-card` over `bg-app` | 7.0 | 6.8 | 5.6 | 8.7 | 5.8 | 7.0 | 6.3 |
| `fill-hover` over `bg-app` | 6.6 | 6.3 | 5.2 | 8.0 | 5.3 | 6.6 | 6.0 |
| `fill-card` over `bg-panel` | 6.6 | 6.3 | 5.2 | 8.0 | 5.3 | 6.6 | 6.0 |
| `fill-hover` over `bg-surface` | 5.8 | not used | not used | not used | not used | not used | 5.3 |

Inside a button, the focus edge lands on its fill: `line-focus` reads 6.0 on `fill-secondary` and 5.3 on `fill-secondary-hover` over `bg-app` (5.7 and 5.0 in a card, 5.3 on `fill-secondary` in a dialog), 6.2 on `button-danger-fill` and 5.5 on `button-danger-fill-hover` over `bg-app` (5.8 and 5.2 in a card, 5.4 and 4.9 in a dialog’s `bg-surface`; 5.4 and 5.2 in a light dialog), and 6.2 on `fill-hover` over `bg-panel`, a hovered sidebar row. The primary's 2 px edge of `bg-app` reads 14.6 on `button-primary` and 12.2 on `button-primary-hover`.

The mark is a logo beside its written name, and its ink outline carries it. With no tile, `mark-ink-light` reads 16.3 on `bg-app`, 15.1 on `bg-panel` and 13.8 on `bg-surface` (the intro dialog), and the `mark-clay` dome 5.5, 5.1 and 4.7. On the intro illustration's light card, `mark-ink` reads 17.5. Two parts of the drawing fall just under 3:1, and are recorded here rather than listed as pairs: the light ink where it crosses the dome reads 2.96, and the dome on the light card 2.96; in both places the ink's outline (13.8 and up, and 17.5) sets the bell off its ground. On its tile, `mark-ink` reads 18.4 and `mark-clay` 3.1, and the dark ink reads 5.9 where it crosses the clay; `mark-tile` reads 17.2 on `bg-app`, as the stories show it. In the app icon, the clay field is the icon's edge and reads 6.5 on `bg-app`; the white tile on the field reads 2.64, recorded here rather than listed as a pair, as the intro's light cards on the same clay are: the icon is decorative, its edge is the field's, and the drawing on the tile carries its own contrast.

Claude's writing dots carry the waiting status: `clay` on `bg-app` and `bg-panel` is listed at 3:1, in both themes.

`line-field`, a text field's outline, reads 3.1 on `bg-surface` and 3.2 on `bg-app` (3:1), and 3.2 on `fill-card` over `bg-app`, where it outlines an inline `CopyField`'s value in a card. A focused field's `line-focus` edge reads 6.6 on `bg-surface` and 7.33 on `bg-app` in dark, and 5.67 on `bg-app` in light. The retired `line-field-focus` token is removed; fields share the buttons' `line-focus`.

Field state-change pairs on `bg-app` (each edge composited against that ground separately; no 3:1 floor applies to a state-change pair):

| State-change pair | Light before | Light after | Dark before | Dark after |
| --- | ---: | ---: | ---: | ---: |
| Focused edge vs resting `line-field` | 1.29 | 1.46 | 2.04 | 2.27 |


On the intro illustration's light cards, `illustration-ink` reads 16.3 and `illustration-ink-secondary` 5.4 on `illustration-card`, and `illustration-ink` reads 13.1 on `illustration-avatar`. The check and the receipt dots in `illustration-handled` read 4.9 (3:1).

On Share's printable card, the QR code's `qr-ink` modules read 13.8 on its `qr-tile` sand (3:1).

- Don't put `text-tertiary` on `fill-secondary-hover`. Links use their usual grounds; an unread conversation row is the named exception, with primary words, a blue time and status dots checked on its hover fill.
- `line-hairline`, `line-card`, `line-control`, `line-control-hover`, `scrim`, `clay` (the intro illustration's field and the app icon's), `illustration-line`, `illustration-arc`, `qr-hairline`, `mark-hairline` and the connector brand colors (`connector-stripe`, `connector-google-blue`) are decorative (`DECORATIVE_COLORS`): they separate, dim or outline things that are identified otherwise, or carry nothing. `line-control` is flagged: it is 2.0:1 on `bg-app` in the dark theme and 1.6:1 in the light one, under the 3:1 for control borders, which is acceptable only because a chip or pill, or the recorded-history link it underlines, is identified by its own text. Never make an outline the only cue that something is a control.
- Show keyboard focus by changing the control's own edge, never with a ring outside it, and never with an outline or an outer shadow on focus or hover (owner, 2026-11-01; the guard `focus_and_hover_draw_no_ring_outside_a_control` holds every stylesheet to it). Focus shows only while the control matches `:focus-visible`, so a click shows none. The color is `line-focus`, `text-secondary`, a warm off-white, never blue. A control with no border of its own (a ghost, secondary or danger button, an icon button, a sidebar or menu row, a row that is a link, a checkbox, anything else focusable) shows a 1 px `line-focus` edge just inside its own box (`box-shadow: inset 0 0 0 1px`), so nothing moves; the base stylesheet sets it. A bordered control (a chip, the sidebar's Desk picker, a rule's outcome menu, a bordered card that takes focus) turns its own border `line-focus` instead, and hover on it is the fill alone, its border at rest. The primary button's cream fill hides the warm line, so its edge is 2 px of `bg-app`. A row whose link's overlay covers it draws the edge on the overlay, at the row's corners. A link in running text (a `TextLink`, or a link with no class, as a reply's are) shows focus in its words: they and a 2 px underline turn `text-primary`, as a grey line under a blue link reads like its resting state. On the About pages' paper `line-focus` points at the paper's secondary ink (`--va-ink-2`), which reads 6.3 on the paper, 6.8 on a figure's card and 5.7 on a band. Text entry is the exception to keyboard-only focus: a text field or text area, including a held field, shows a 2 px `line-focus` edge by pointer or keyboard. Its 1 px border turns `line-focus`, plus a 1 px inset shadow (`box-shadow: inset 0 0 0 1px`), so nothing resizes. The resting border stays `line-field`. Setup's borderless answer draws the same 2 px edge inside its row. The composer is unchanged: its text box shows its caret with no edge of its own, and its surrounding box's edge turns `line-field`. A button inside the composer shows its own edge, and the composer's edge goes back to rest.
- Never show status by color alone: a dot always sits beside words that say the same thing, and the dot is `aria-hidden`.
- A `ul` or `ol` drawn without markers says `role="list"`: Safari drops a list's semantics when its markers are removed, and a screen reader then gives no list navigation or count. `expectListsKeepTheirRole` (`test/expectListRoles.ts`) checks it in one story per component.
- Put replies and receipts inside the transcript's `role="log"` so screen readers announce them. Chat, approvals and take-over all work from the keyboard.
- A list whose markers are removed keeps `role="list"` so Safari still announces it as a list.

## Empty, waiting, error and refusal states

- Empty: say what will appear and what to do next. "No conversations yet. Share your Desk link to get the first one."
- Waiting: show it, don't say it, when Claude is writing: three clay dots that bounce gently where its reply will appear, with "Claude is writing" for screen readers only. Other waits say what is happening in plain words, "Sending your answer". Never show draft text.
- Loading: a page, or a part of one, whose first read is out draws its own shapes (`SkeletonScreen`). For 200 ms it shows nothing, so a fast load goes straight to the page; then its shapes sweep under one band of light while a visually hidden status says the existing loading words; then the page fades in over them on `motion-fast`, where they were. A skeleton draws no words and states nothing: no prices, dates, names, messages or statuses. A few loaders keep `LoadingLine` (its README lists them), and an action at work stays a busy `Button`.
- Error: say what happened and the next step, never a code. "We couldn't confirm your answer. Try again, or reload to see where it stands."
- Refusal: be kind and specific, and offer a way forward. "I can't share that here, but I can ask Mike to get back to you." Never scold or lecture.

## What not to do

- No glows, gradients, orbs, shimmer or gradient washes. The one exception is the skeleton's one synced sweep while a page loads (owner, 2026-10-31): a single band of `fill-secondary` light, transparent at its ends, moving in step across every shape (`Skeleton`).
- No all-caps eyebrows or labels, and no letter-spaced capitals. The one exception is the "Preview" badge in the Claude Desk lockup, which the `Wordmark` draws with `preview` (`Pill caps`, `.cd-type-badge-caps`): its word is written in sentence case and drawn in capitals, and the copy check allows capitals on that badge alone, for that word alone. It shows in the owner app's sidebar, the first-visit intro dialog's brand row, and the top bars of the About pages and the setup board from 1100 px up. A phone's top bar carries no badge (owner, 2026-10-30), so below 1100 px those bars show the bell and the name alone. Two guards keep it there: `caps_badge_only_in_the_lockup` (`web/src/ds/guards.test.ts`) allows the style and its marker only in the Pill, the Mark's folder, the token sources, the Foundations type specimens and the tests, and `caps_pill_only_in_the_wordmark` (`web/src/app/guards.test.ts`) allows a `Pill` with `caps` only in the Wordmark's file.
- No card on card (the agents page's "Send an agent" card, `holdsCards`, is the one exception), no colored tiles and no colored left borders on cards.
- No large areas of status color: dots and thin bars only.
- No staggered page-entrance cascades.
- No emoji, sparkles or "AI" icons, and no Claude or Anthropic logos.
- No mono outside the full trace, a connector's quoted tool definition and the agents page's code.
- No raw colors or durations in components: use the custom properties named after these tokens.

The owner sidebar lists Today, Conversations, Customers, Rules, Safety, Profile, Share, Knowledge and Settings. Connectors appears after Rules when its page is available. Profile holds Your business and Header colour; General keeps Claude acts for you and Delete this Desk.
