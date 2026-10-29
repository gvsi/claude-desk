# IconButton

`IconButton` is a 32 px button that shows one icon and is named by its label.

## When to use

- Compact controls whose icon is familiar: the composer's attach, speak and send buttons, copy a link, close a panel.
- The round `primary` variant is the composer's send button, the inverted neutral of claude.ai.
- If the action needs words to be understood, use a `Button` instead.

## What the consumer provides

- `label`, the button's whole accessible name, in words that say what happens ("Send", "Add a photo or file", "Copy your Claude Desk link"). The icon itself is `aria-hidden`.
- `disabled` when the action can't be taken yet, such as send while the composer is empty.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required; the `aria-label`. |
| `icon` | `IconName` | Required; one of the design system's icons (`icons/index.tsx`). |
| `variant` | `'ghost' \| 'primary'` | `ghost` by default. |
| `shape` | `'square' \| 'round'` | `square` (`radius-control`) by default. The icon is 18 px in a square button and 16 px in a round one, as on the canvas. |
| `onClick` | `(event) => void` | |
| `disabled` | `boolean` | Dimmed and out of the tab order. |

## Icons

`IconName` lists the line icons: `today`, `conversations`, `people`, `rules`, `safety`, `share`, `settings`, `chevrons`, `plus`, `mic`, `send`, `copy`, `check`, `lock`, `pin`, `translate`, `whisper`, `agent`, `person`, `document`, `calendar`, `card`, `clock`, `close`, `menu`. `Icon({ name, size? })` draws one at 20 px by default (14, 16 and 18 for compact places), always `aria-hidden`, in `currentColor`, with a 1.5 px effective stroke at every size. Most shapes come from Lucide (ISC license, credited in `icons/index.tsx`).
