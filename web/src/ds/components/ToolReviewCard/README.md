# ToolReviewCard

`ToolReviewCard` is the review of a connected tool that a changed definition switched off: what changed, what the owner confirmed before, and the connector's new words, quoted as text.

## When to use

- On a tool's page while its profile `needs_review`, under its `ToolPageHeader`. Today's `ToolChangedItem` leads here.
- "Turn back on" sends `POST /tools/confirm {tools: [{tool, definition_sha256: pending_sha256}], enable: true}`. The kernel drafts a rules version to prove, which the screen shows in a `ChangeReview`; the tool stays `needs_review` until that version is confirmed. "Keep off" sends the same hash with `enable: false`.
- After the owner confirms, the screen shows `ToolPageHeader` with "Definition reviewed today" and an info `Notice` ("Refund is back on. Your rules were checked against its new definition, and refunds still wait for your answer.") in place of this card.

## What it shows

- A `Card` (`section`, named "Needs your review", 20 px padding), its parts 16 px apart:
  - "Needs your review" (an `h2` in meta type) with a held dot, and `noticed` at the right in secondary meta.
  - In serif `.cd-type-summary`: "{connector name} changed “{title}”, so it's turned off until you review it. Until you decide, it can't run at all."
  - "What you confirmed before" (an `h3` in secondary caption type), then `description_confirmed`, the text Claude sees, and `describeEffects(effects, reversible)` in secondary meta.
  - "What the connector says now", then a `blockquote` on `bg-app` with a hairline border at `radius-control` and 10 px 12 px of padding, named by its label "Quoted from the connector. Claude never sees this text; it sees only the description you confirmed.". It holds `pending_definition_text` exactly as sent, as literal text: mono `.cd-type-trace`, `pre-wrap`, `overflow-wrap: anywhere`, `data-copy="user"`. It is never parsed: markup in it shows as written, and nothing in it runs.
  - "Turning it back on trusts the new definition and checks your rules again before it runs." in secondary meta.
  - A primary "Turn back on" and a secondary "Keep off", main size.
  - `error`, in an error `Notice` under them (for `conflict`: "The tool changed again while you were reviewing. Review the newest version.").

## Fails closed

- Both answers call back with `profile.pending_sha256`, the hash of the definition the owner is looking at, never `definition_sha256`.
- Without `pending_sha256`, or without `pending_definition_text` to review (missing, empty, or only spaces and line breaks), both answers are disabled under an info `Notice`: "This change can't be reviewed right now. Reload the page." The quote shows only when there is text, and then exactly as sent, blank space included.
- One answer at a time (`useSendOnce`): a press calls back once, its button shows the busy spinner and the other waits, until the screen's `pending` has come and gone or an error is delivered. `pending` from the screen alone makes both wait. The card is `aria-busy` while it waits.

## Types

`ToolRowView = Pick<ToolProfile, 'tool' | 'source' | 'effects' | 'reversible' | 'status' | 'description_confirmed' | 'definition_sha256' | 'pending_definition_text' | 'pending_sha256'>`, so a `ToolProfile` and the API's `ToolRow` both fit.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Required. The tool's name. |
| `connector` | `ConnectorView` | Required. |
| `profile` | `ToolRowView` | Required. |
| `noticed` | `string` | Required. The screen's words for when the change was noticed. |
| `onTurnBackOn` | `(definitionSha256: string) => void` | Required. Called with `pending_sha256`. |
| `onKeepOff` | `(definitionSha256: string) => void` | Required. Called with `pending_sha256`. |
| `pending` | `boolean` | The screen is sending the answer. |
| `error` | `string` | The screen's message; the answers work again. |
