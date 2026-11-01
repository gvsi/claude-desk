# ConnectorReview

`ConnectorReview` is the review before a connector turns on: each tool it would add, what already covers it, and the outcome it starts at.

## When to use

- In the add-a-connector flow, after the owner chooses a built-in connector, or after the mock sign-in for an app: the "Review tools" step.
- Nothing turns on here. "Turn it on" asks the screen to draft the change (one `POST /tools/confirm {tools, enable: true}` for the connector's tools), and the proved change shows in `ChangeReview` before anything runs.

## What it shows

For a business job, pass `job` instead of `connector`: `{ title, glyph, rows: { label, value, items? }[] }`. A row whose value is a list (an intake's questions) also carries its entries one by one in `items`, and the review draws them as a numbered list, one per line in their order, 16 px in and 4 px apart, in the row's meta type. The job tile and title replace the connector heading; the setup-question lead replaces both connector leads. A "How it’s set up" card shows the supplied rows above the existing tool card. Rows with empty values are omitted. At phone widths, each label sits above its value. Setup supplies the current starting outcome's rows and the kernel's confirmed description. The tool card, outcomes, waiting state, errors and turn-on controls are shared, so the job follows the same rules-draft review before it can run.

- The connector's `ConnectorIcon`, drawn 44 px here and centered on the title and its lead line, beside the page's `h1`, "Review what Claude could do with {name}" in serif `.cd-type-page-title`, with "Built in" or the Mock badge (`ConnectorName`). The title balances its lines when it wraps (see Long names).
- Under the title, in secondary body type: "A built-in connector, so there's nothing to sign in to. Nothing runs until you turn it on." for a built-in connector, or "Nothing runs until you turn it on." followed by `intro` (the connector's promise) for an app.
- A `Card` named "Tools" with a row per tool, separated by hairlines only between rows and padded 14 px above and below: its name at weight 520, its `description` in secondary meta, then a line per rule that covers it, in secondary meta:
  - the owner's rule: "Covered by your rule: {text} · {outcomePhrase(mode, limit)}" ("… · Automatic up to $300; over $300, ask me first");
  - an always-on rule: "Covered by your always-on rule: {text}";
  - none: "No rule of yours covers this yet, so it starts at Ask me first." (or "No rule of yours covers this yet." once the owner picked another outcome).
- Each tool's outcome at the right, an `OutcomeMenu` at `mode`. The screen starts every new tool at "Ask me first"; with `onChangeOutcome` each outcome is a menu, and without it, words and a dot. Each row lays out by its own width: under 640 px the outcome sits on its own line under its words.
- A primary "Turn it on", a secondary "Cancel", and "You'll see the change to your rules before anything runs." in secondary meta.

## An app connected on the same screen

Setup connects its one app (the mock payments server, Stripe) on this screen, with `connection`:

- `not_connected`: its tools can't be known until it is connected. The lead reads "Connect it first, so Claude Desk can read what {name} lets Claude do. Nothing runs until you turn it on." The Tools card holds one row, straight in the card with no padding of its own: "{name}'s tools", "They show here once {name} is connected, each with the rule it starts at." in secondary meta, and "Not connected" with the held dot where an outcome sits. The buttons are a primary "Connect {name}", which calls `onConnect` once per press and waits as "Turn it on" does, and "Cancel"; the hint reads "{name} asks you to sign in. Then you review its tools here."
- `connected`: the review as above, with the lead "Connected to {name}'s test account. Nothing runs until you turn it on."

Built-in connectors and jobs take no `connection`, and neither does the add flow on Connectors, where the app was signed in to first.
- `error`, in an error `Notice` under them.

## Long names

A title that wraps balances its lines (`text-wrap: balance`), as `PageHeader`'s does: the browser evens them out rather than filling each in turn, so a long connector name doesn't leave its last word, or its Mock badge, on a line of its own. "Review what Claude could do with Google Calendar for Bayview Heating & Plumbing" takes two even lines on a laptop and four on a phone, its badge on the last with the words before it. The title keeps the number of lines it would take anyway, so nothing under it moves. On a phone the tile stays at the title's top.

## States

- "Turn it on" calls `onTurnOn` once however often it is pressed (`useSendOnce`). It then waits until the screen's `pending` has come and gone or an error is delivered: it shows the busy spinner in place of its label, at the same width, Cancel waits beside it, the outcome menus are disabled and the review is `aria-busy`.
- `pending` from the screen alone (a draft already in flight) shows the same waiting state.
- An error releases the button, so the owner can try again.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required for a connector review; mutually exclusive with `job`. |
| `job` | `ReviewJobView` | Required for a business job review; mutually exclusive with `connector`. |
| `intro` | `string` | An app's promise, after "Nothing runs until you turn it on." |
| `tools` | `ReviewToolView[]` | Required. `{ key; name; description; mode: RuleMode; coveredBy: { text; mode: RuleMode \| 'always_on'; limit? }[] }`. |
| `onChangeOutcome` | `(key: string, mode: RuleMode) => void` | Makes each outcome a menu. |
| `connection` | `'not_connected' \| 'connected'` | An app connected on this screen (setup's Stripe). |
| `onConnect` | `() => void` | "Connect {name}", while `not_connected`. |
| `onTurnOn` | `() => void` | Required. |
| `onCancel` | `() => void` | Required. |
| `pending` | `boolean` | The screen is drafting the change. |
| `error` | `string` | The screen's message; "Turn it on" works again. |
