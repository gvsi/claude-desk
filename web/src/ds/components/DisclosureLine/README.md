# DisclosureLine

`DisclosureLine` is the one quiet line that tells a visitor, on a page that isn't the chat itself, that the page answers with Claude, an AI.

## When to use

- On every visitor page outside the chat: the Agent Card page, with the business's name, and the mock checkout (`MockCheckout` draws it), without one, since the checkout can be opened on its own from a link.
- Not in the public chat. `PublicShell` carries its own disclosure under the chat's title, with the owner's name.

## What it does

- Shows fixed copy in the page's language, never the model's words. With `businessName`: "{businessName} answers with Claude, an AI." / "{businessName} responde con Claude, una IA." Without it: "This page is part of a chat with Claude, an AI." / "Esta página es parte de un chat con Claude, una IA."
- A blank or all-space name counts as no name, so the line never starts with nothing before "answers with Claude".
- The business's name is the owner's own words, marked `data-copy="user"`.
- It is never hidden and never dismissable: there is no prop to turn it off, and it holds nothing to press.

## What the consumer provides

- `language`: the page's language. The line sets `lang` to it.
- `businessName`: `PublicDesk.business_name` where the page has one. Leave it out on the checkout.

## Copy

| | English | Spanish |
| --- | --- | --- |
| With a name | {businessName} answers with Claude, an AI. | {businessName} responde con Claude, una IA. |
| Without a name | This page is part of a chat with Claude, an AI. | Esta página es parte de un chat con Claude, una IA. |

## Layout

- One `<p>` in `meta` type in `text-secondary`, with no margin, no icon and no dot: a statement, not a status. It wraps on a narrow screen, breaking a long name if it must.
- Nothing moves or changes color.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `language` | `'en' \| 'es'` | Required. |
| `businessName` | `string` | The business's name; blank counts as none. |
