# PublicShell

`PublicShell` is the public page around a conversation: the business's brand header, the chat with the AI disclosure, the composer and the business's charter beside it.

## When to use

- On the public page of a Desk, around the visitor's `Transcript` and `Composer`.
- Inside an owner screen that shows the public page (Today's side panel, setup) with `footer={false}`.
- Not for owner pages: they use `AppShell`.

## What it shows

- **The brand header**, `size-brand-header` tall, in the business's colors:
  - The monogram (`aria-hidden`) in a square ringed in the secondary ink.
  - The name and the tagline, with `statusLine` at the right when given.
  - The `accent` only as the 2 px rule under the header: never text, never a ground for text, never the only sign of a control.
  - Colors are set as `--brand-field`, `--brand-ink`, `--brand-ink-secondary` and `--brand-accent`. Only a plain `#rrggbb` or a token (`var(--token)`) is used; anything else falls back to `bg-panel`, `text-primary`, `text-secondary` and `line-hairline` (`guards.ts`).
- **The chat** in a column at most 680 px wide:
  - "Chat with {name}" and, under it, the AI disclosure. It can't be turned off:
    - "You're chatting with Claude, an AI answering for {name}. Ask for {ownerName} anytime."
    - "Estás hablando con Claude, una IA que responde por {name}. Puedes pedir hablar con {ownerName} cuando quieras."
  - A secondary "Ask for {ownerName}" / "Pedir hablar con {ownerName}" button, which calls `onAskForOwner`.
  - The conversation (`children`), then the `composer` with `ConceptFooter poweredBy` under it. The composer and footer stay at the bottom of the window while the conversation scrolls.
- **The about column**, 300 px on the panel at the right, named "About {name}" / "Sobre {name}":
  - The `about` blocks in order: cards as `ReplyCard`s in the page's language, prose as text.
  - The `aboutLinks` under "For AI agents" / "Para agentes de IA". Only paths on this site become links (`/d/…`); a scheme or another host is left out.
  - With neither, there is no about column.

Names (the business's, the Desk's, the owner's) are shown as written. The page carries `lang` from `language`.

## Layout

The shell is an inline-size container, so it lays out by its own width, not the window's. Below 900 px the about column moves under the chat, full width. Below 640 px (a phone, or the owner's 420 px panel) the gutters are 16 px instead of 40.

## Standalone or embedded

- Standalone (the default), the shell is the page: the header is the `banner`, the chat is the `main` region, the about column is a `complementary` region, and the business's name is the page's `h1`.
- With `footer={false}` the shell sits inside an owner screen that has its own landmarks and footer. The footer is left out, the header and chat are plain blocks, the business's name is a paragraph, and the about column is a region named "About {name}".

## What the consumer provides

- `brand` from the kernel-served `PublicDesk`, through the screen's mapping:
  - `name` is `business_name`, `tagline` the Desk's name, `monogram` the first letter.
  - `field` and `accent` are the brand's colors.
  - `ink` and `inkSecondary` are `var(--text-primary)` and `var(--text-secondary)`.
  - The mapping keeps both inks at 4.5:1 over the field, falling back to `bg-panel` when they can't.
- `ownerName` (`owner_display_name`), `language`, `onAskForOwner`.
- `about`, the `PublicDesk.charter` blocks, and `aboutLinks` for people's agents.
- `composer`, a visitor `Composer` in the page's language, and `children`, the conversation.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `brand` | `PublicBrand` | Required. `{ name; tagline; monogram; field; ink; inkSecondary; accent }`. |
| `statusLine` | `string` | At the right of the header, in the secondary ink. |
| `ownerName` | `string` | Required. |
| `language` | `'en' \| 'es'` | Required. |
| `onAskForOwner` | `() => void` | Required. |
| `about` | `RenderedBlock[]` | The charter blocks. |
| `aboutLinks` | `{ label: string; href: string }[]` | Paths on this site only. |
| `footer` | `boolean` | `true` by default; `false` when embedded. |
| `composer` | `ReactNode` | Required. |
| `children` | `ReactNode` | Required. |

`PublicBrand` is exported with the component.
