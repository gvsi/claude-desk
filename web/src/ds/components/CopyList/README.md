# CopyList

`CopyList` is a card of ready-made words an owner copies, such as Share's words for a Google profile, an email signature and a voicemail, each with its own Copy button.

## When to use

- On Share and in the setup interview's live step, under "Ready-made words", beside the printable `ShareCard`.
- Not for one value a developer copies, which is a `CopyField`, and not for the owner's own link, which is the web app's `CopyLink`.

## What the consumer provides

- `label`: the list's name, the same as the heading over it ("Ready-made words").
- `items`: each block's `title` ("Google profile") and its `text`. The words are the screen's, with the Desk's link and the AI disclosure in them. A string is shown and copied exactly as it is. When the words hold a name someone chose (the business's, the owner's), pass `text` as a node with each name in its own `<bdi data-copy="user">`, which marks it and isolates it, so a direction mark in a name can't reorder the words around it. Copy then copies what is shown, as plain text, read from the rendered words: spaces as the browser collapses them, a line break for each `<br>`, and nothing from a `.cd-sr-only` element (words only a screen reader hears) or one that isn't displayed. The browser's `innerText` would keep the `.cd-sr-only` words, since clipped text is still rendered, so the copy skips that class itself.
- `onCopy`, which writes one block's words to the clipboard. The screen owns the clipboard; a throw or a rejected promise means it couldn't.

## What it shows

- One card (`fill-card`, a `line-card` border at `radius-card`), ruled in `line-hairline` between its rows.
- Each row padded 14 px by 16 px: the block's name in `control` type at weight 520, its words 4 px under it in `meta`, `text-secondary`, and a secondary "Copy" button at the top right, 16 px from the edge.
- Only the latest copy shows its line. A newer press anywhere clears the older result, whether it succeeded or failed; there is no timed clear.
- After a press, a line under the words: "Copied.", or, when the copy fails, the block's words are selected and "Copy didn’t work. The text is selected, so copy it yourself." It takes no room until it has words. The words, the line and the hook that runs the copy are `CopyField`'s (`COPY_RESULT_COPY`, `copyResultLine`, `useCopyText`).

## Accessibility

- A list (`role="list"`, kept since its markers are removed) named by `label`, one item per block.
- Each button reads "Copy" and is named for its block: "Copy Google profile".
- `CopyResult` keeps the line after a press as a `status`, there from the start, so it is read out when its words come. Each press gets a fresh `announcement` key so repeated results are announced again.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The list's name. |
| `items` | `{ title: string; text: ReactNode }[]` | Required. `text` is usually a string, copied as it is; as a node, what it shows is copied, line breaks included and screen-reader-only words left out. |
| `onCopy` | `(text: string) => Promise<void> \| void` | Required. |
