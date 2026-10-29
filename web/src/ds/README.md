Claude Desk is a public, always-on Claude for a person or small business: strangers and their agents talk to it, and it answers, books, quotes and takes payments under the owner's rules. The interface is warm, dark and quiet, so that the one thing that stands out is what Claude did and why: the margin receipts. Build every surface (the owner app, the public page and setup) from these tokens and rules.

## Content

- Write in sentence case everywhere: page titles, buttons, labels and menus. Never set words in all caps; acronyms such as AI, PDF and SMS stay as they are.
- Be plain, literal and specific. No wordplay, no exclamation marks, and no "→" or other arrows on buttons.
- Make buttons say exactly what happens: "Allow this time", "Open payment page", "Download". Never "Continue" or "OK" when a verb can say more.
- Let Claude speak in the first person, in serif (`reply`, `summary`, `greeting`): "These times are open on Maria's calendar. Which of them works for you?" People speak in sans (`message`).
- Never let Claude's prose say that something is booked, paid, refunded, discounted or what it costs, or that Claude did something no receipt records. The typed card and its receipt say it; the prose only leads into them: "Here are the details."
- Separate facts with commas or separate lines, never with "A · B · C" strings.
- Write English and Spanish wherever a visitor reads.
- Call the product Claude Desk: one is "your Desk", several are "Desks". Every surface carries the footer "Concept prototype by Giovanni Alcantara, not an Anthropic product" in `caption`.
- Say on every visitor surface that Claude is an AI answering for the business: "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime." It can't be turned off.

## Visual foundations

### Color

- Set pages on `bg-app`. Put the sidebar and side panels on `bg-panel` with a `line-hairline` seam; the composer, menus and popovers on `bg-surface`; quiet fills on `bg-muted`; the active nav row, the segmented control thumb and the initials avatar on `bg-selected`.
- Set body text and everything Claude says in `text-primary`; captions, meta lines, helper text and receipts in `text-secondary`. Use `text-tertiary` only for placeholders and labels at 13 px and up.
- Separate regions by fill and a hairline, not by shadow. A card is `fill-card` with a 1 px `line-card` border. Chips, outlined pills and the whisper composer are outlined in `line-control`, `line-control-hover` on hover.
- Make the primary button `button-primary` with `button-primary-text`, `button-primary-hover` on hover: an inverted neutral, at most one per view. Secondary buttons are `fill-secondary` (`fill-secondary-hover` on hover) with `text-primary`; ghost buttons are transparent with `fill-hover` on hover. Visitor bubbles are `fill-bubble`; count pills and the segmented track are `fill-count`.
- Use `accent-blue` only for links, the focus ring and selection. Never put text on it and never use it as decoration.
- Show status only as a `size-dot` dot or a thin bar in `status-handled` (handled or allowed), `status-held` (held, needs you), `status-refused` (refused or blocked) or `status-info` (a hollow dot), always beside words that say the same thing. Never a colored tile, a filled badge or colored text.
- Use `clay` only inside the Claude Desk mark.

### Brand colors on the public page

- The public page's header is set in the business's own colors, not in tokens: a field, two inks for the text on it and an accent. They arrive with the Desk (`PublicDesk.brand`), mapped to the header's `--brand-*` properties, and anything that isn't a plain hex color or a token falls back to the panel and the text tokens.
- Both inks keep 4.5:1 over the field. A brand whose field can't carry them falls back to `bg-panel` with `text-primary` and `text-secondary`.
- The accent is decorative only: a 2 px rule under the header. Never text, never a ground for text, and never the only sign that something is a control.
- Everything below the header is the design system's: the chat, the about column and the footer use tokens like any other surface.

### Type

- Use `serif` (Source Serif 4) for Claude's voice and page identity, `sans` (Hanken Grotesk) for the whole interface, and `mono` (JetBrains Mono) only inside an expanded full trace. All three load from Google Fonts.
- Apply a style with its class, `.cd-type-<style>`. Claude's voice: `greeting`, `page-title`, `wordmark`, `summary`, `reply`. Interface: `body` (already set on the page body), `control`, `section`, `message`, `meta`, `caption`, `pill`, `count`, `beta`, `brand-name`. Trace: `trace`.
- Set page titles in `page-title`, left-aligned. Claude's replies are `reply` paragraphs with no bubble and no avatar, like a document; a visitor's message is `message` in a `fill-bubble` bubble at `radius-card`, aligned right.

### Space, size and shape

- Space with the steps `space-2` to `space-40`. Pad cards with `space-16` to `space-20`; pad content with `space-40` at the sides on desktop and `space-16` on a phone.
- Lay out the owner app with a `size-sidebar` sidebar and content no wider than `size-content`. A conversation is a `size-reading` column with the `size-margin` receipts column beside it.
- Make controls `size-control` tall and a screen's main action `size-control-main`; nav rows are `size-nav-row`, icons `size-icon`, avatars `size-avatar`, and the public page's brand header `size-brand-header`.
- Round controls with `radius-control`; cards, dialogs and bubbles with `radius-card`; the composer with `radius-composer`; pills, chips, switches and avatars with `radius-full`.
- Use `shadow-composer` on the composer and nowhere else.

### Motion

- Keep transitions between 60 and 200 ms: `motion-instant` for color, `motion-fast` for press feedback, `motion-base` for a check that draws once or a reveal. Ease with `motion-ease`, or `motion-ease-emphasis` for a screen's one small moment. Results that arrive one by one are `motion-stagger` apart.
- The only loops are `motion-breathe` for presence glyphs and `motion-writing` for the writing indicator.
- Allow at most one small moment per screen. Motion explains a change; it never decorates.
- Under `prefers-reduced-motion: reduce` nothing animates or transitions; the base stylesheet enforces it on every element.

## The signature: margin receipts

- Beside a conversation, put each checkpoint result in the `size-margin` column next to the message it explains, like an editor's note in the margin: a status dot and one line of `caption` in `text-secondary`.
- On visitor surfaces, show exactly the signed event's `visitor_plain` line, never rewritten and never with a clock time. On owner screens a receipt opens the full trace.
- Keep everything around the receipts quiet. They are the one bold element in the system.

## Typed cards

- Show prices, dates, times, discounts, bookings and policies only in typed reply cards rendered from checked facts, never in Claude's free prose. A card shows exactly the fields it receives; nothing in the design system computes or formats money or dates.
- Give each card template fixed English and Spanish chrome with no amounts, dates or promises. Payment cards and the checkout always say "Test payment, no money moves" / "Pago de prueba, no se mueve dinero".
- Draw a card as `fill-card` with a `line-card` border at `radius-card`, at most 520 px wide, and never put a card inside another card.

## Iconography

- Use 20 px (`size-icon`) line icons with a 1.5 px effective stroke in the current text color. No filled icons, no emoji, no sparkles or other "AI" glyphs.
- The Claude Desk mark, a rounded square with one horizontal line stroked in `clay`, is the only mark and the only use of `clay`. Never use a Claude or Anthropic logo.
- Render initials avatars and monograms `aria-hidden`, beside the name written out as text.

## Accessibility

- Every color pair a component uses is listed in `CONTRAST_PAIRS` (`contrast.ts`), and the token tests fail if any falls below its minimum: 4.5:1 for text (3:1 at 24 px and up), and 3:1 for focus rings, status dots and the mark. Translucent grounds are measured over the opaque color they sit on.

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
| `fill-secondary-hover` over `bg-app` | 9.1 | 5.4 | not used | not used |
| `fill-hover` over `bg-surface` | 10.0 | 5.8 | 5.3 | 5.2 |
| `fill-secondary` over `bg-surface` | 8.9 | 5.3 | 4.8 | 4.6 |
| `fill-secondary-hover` over `bg-surface` | 7.6 | 4.7 | not used | not used |
| `fill-card` over `bg-panel` | 12.0 | 6.6 | 6.0 | 6.3 |
| `fill-count` over `bg-panel` | not used | 6.3 | not used | not used |
| `fill-count` over `bg-selected` | not used | 5.0 | not used | not used |
| `fill-hover` over `bg-muted` | 9.7 | not used | not used | not used |

`button-primary-text` reads 14.6 on `button-primary` and 12.2 on `button-primary-hover`.

Focus rings and status dots, 3:1 (`ring-composer` is `accent-blue`):

| Ground | `accent-blue` | `status-handled` | `status-held` | `status-refused` | `status-info` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `bg-app` | 7.3 | 6.1 | 9.4 | 6.3 | 7.3 |
| `bg-panel` | 6.8 | 5.6 | 8.7 | 5.8 | 7.0 |
| `bg-surface` | 6.2 | 5.1 | 7.9 | 5.3 | 6.6 |
| `bg-selected` | 4.9 | 4.1 | 6.3 | 4.2 | 5.6 |
| `fill-card` over `bg-app` | 6.8 | 5.6 | 8.7 | 5.8 | 7.0 |
| `fill-hover` over `bg-app` | 6.3 | 5.2 | 8.0 | 5.3 | 6.6 |
| `fill-card` over `bg-panel` | 6.3 | 5.2 | 8.0 | 5.3 | 6.6 |

The mark in `clay` reads 6.5 on `bg-app` and 6.0 on `bg-panel`.

- Don't put `text-tertiary` or a link on `fill-secondary-hover`: those pairs aren't listed.
- `line-hairline`, `line-card`, `line-control` and `line-control-hover` are decorative (`DECORATIVE_COLORS`): they separate or outline things that are identified otherwise. `line-control` is flagged: it is 2.0:1 on `bg-app`, under the 3:1 for control borders, which is acceptable only because a chip or pill is identified by its own text. Never make an outline the only cue that something is a control.
- Show focus with a solid 2 px `accent-blue` outline at a 2 px offset on every focusable element; the base stylesheet sets it. The composer shows `ring-composer` when focus is inside it, solid too, because a translucent ring falls under 3:1.
- Never show status by color alone: a dot always sits beside words that say the same thing, and the dot is `aria-hidden`.
- Put replies and receipts inside the transcript's `role="log"` so screen readers announce them. Chat, approvals and take-over all work from the keyboard.

## Empty, waiting, error and refusal states

- Empty: say what will appear and what to do next. "No conversations yet. Share your Desk link to get the first one."
- Waiting: say what is happening in plain words, "Claude is writing" or "Sending your answer". Never show draft text.
- Error: say what happened and the next step, never a code. "We couldn't confirm your answer. Try again, or reload to see where it stands."
- Refusal: be kind and specific, and offer a way forward. "I can't share that here, but I can ask Maria to get back to you." Never scold or lecture.

## What not to do

- No glows, gradients, orbs, shimmer or gradient washes.
- No all-caps eyebrows or labels, and no letter-spaced capitals.
- No card on card, no colored tiles and no colored left borders on cards.
- No large areas of status color: dots and thin bars only.
- No staggered page-entrance cascades.
- No emoji, sparkles or "AI" icons, and no Claude or Anthropic logos.
- No mono outside the full trace.
- No raw colors or durations in components: use the custom properties named after these tokens.
