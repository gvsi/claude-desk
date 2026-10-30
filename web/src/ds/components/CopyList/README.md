# CopyList

`CopyList` is a card of ready-made words an owner copies, such as Share's words for a Google profile, an email signature and a voicemail, each with its own Copy button.

## When to use

- On Share and in the setup interview's live step, under "Ready-made words", beside the printable `ShareCard`.
- Not for one value a developer copies, which is a `CopyField`, and not for the owner's own link, which is the web app's `CopyLink`.

## What the consumer provides

- `label`: the list's name, the same as the heading over it ("Ready-made words").
- `items`: each block's `title` ("Google profile") and its `text`, exactly as it is copied. The words are the screen's, with the Desk's link and the AI disclosure in them.
- `onCopy`, which writes one block's words to the clipboard. The screen owns the clipboard; a throw or a rejected promise means it couldn't.

## What it shows

- One card (`fill-card`, a `line-card` border at `radius-card`), ruled in `line-hairline` between its rows.
- Each row padded 14 px by 16 px: the block's name in `control` type at weight 520, its words 4 px under it in `meta`, `text-secondary`, and a secondary "Copy" button at the top right, 16 px from the edge.
- After a press, a line under the words: "Copied.", or, when the copy fails, the block's words are selected and "Couldn’t copy. The text is selected, so you can copy it yourself." It takes no room until it has words. The words and the hook that runs the copy are `CopyField`'s (`COPY_RESULT_COPY`, `useCopyText`).

## Accessibility

- A list (`role="list"`, kept since its markers are removed) named by `label`, one item per block.
- Each button reads "Copy" and is named for its block: "Copy Google profile".
- The line after a press is a `status`, there from the start, so it is read out when its words come.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. The list's name. |
| `items` | `{ title: string; text: string }[]` | Required. |
| `onCopy` | `(text: string) => Promise<void> \| void` | Required. |
