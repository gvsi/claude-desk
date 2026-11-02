# SetupToolsList

`SetupToolsList` is setup's tools step: the Desk's own jobs, the connectors built into Claude Desk and the apps the owner can connect, each with where it stands on the new Desk or what to do next.

Drawn on N-R2-Setup-05-Tools, signed on 2026-10-30.

## When to use

- On the setup interview's tools step ("What Claude can use"), under its `PageHeader` and above "Continue".
- Not on the Connectors page, whose rows are links to each connector's page (`ConnectorDirectory`), and not for adding a connector to a live Desk, which is a dialog with its own words (`ConnectorPicker`).

It is its own component rather than a mode of `ConnectorDirectory`: that list's rows are links with tool counts and connection lines, while these rows say where each connector stands or hold its one button, and nothing in them is a link. A mode would mean two row shapes and two sets of words behind a flag.

Its rows start as `ConnectorPicker`'s do, with `ConnectorSummary` (the tile, the name and its badge, the line). The rest of the row isn't shared: the picker, a dialog sized from the window, drops a row's end under its words below a 720 px window, while this list does so below 480 px of its own width, and the two ends say different things ("Added", "Coming soon in this demo" there; "On", "Always on" here).

## What it shows

With `jobs`, a "Your Desk’s jobs" card comes first. Each `SetupJobRow` has a `key`, `title`, formatted `line` and `glyph`. An `on` job reads "On" beside a handled dot; a `needs_review` job has a held dot, "Needs review" and a secondary "Review" button named "Review {title}" that calls `onReview`. No card appears when jobs are empty or absent. The tile and words follow the same row layout and phone breakpoint as the connector rows; the first job has no heading hairline, as on the signed D4 boards.

- Two cards, 20 px apart, each padded 16 px and named by its `h2` in `.cd-type-control`: "Built in" (`builtIn`) and "Connect your own" (`external`). A group with no rows is left out.
- 10 px under the heading, a row per connector under a hairline, 12 px above and below:
  - `ConnectorSummary`: the connector's 36 px `ConnectorIcon`, 14 px before its words;
  - its `ConnectorName`, weight 520, with no "Built in" (the group says so) and, for an app, the Mock badge 8 px from the name;
  - its description in secondary meta.
- At the right of the row, by its `state`:
  - `on`: "On" beside a handled dot, 6 px apart, in primary meta. An app reads "On" too once its tools are turned on.
  - `always_on`: "Always on" beside a handled dot, in secondary meta (Verification, on every Desk).
  - `off`: a secondary button, "Add" in "Built in" or "Connect" in "Connect your own", named "Add Documents" or "Connect Stripe" so each says which connector it is for. When the row gives `tools`, "{n} tools" ("1 tool") sits 14 px before the button in secondary meta, as the board draws it for an app.
  - `needs_review`: an app already connected, its tools listed and none of them on (Stripe once the setup chat has connected it). As a job does, "Needs review" beside a held dot in secondary meta, then a secondary "Review" button named "Review Stripe" that calls `onReview`; the screen opens the review of its tools, and nothing connects again. When the row gives `tools`, "{n} tools" comes first, each part 14 px from the next, on one line at any width. Drawn on N-Live-REV-560 (1512 and 390), signed on 2026-11-01.
- A state this build doesn't know shows nothing at the right, never a status it can't vouch for.
- Rows are not links. A button calls the row's `onChoose` (or `onReview`); the screen opens the connector's review (or an app's sign-in) from it, and a tool reads "On" only after the owner confirms its change. Nothing turns on from here.
- It lays out by its own width: under 480 px, as on a phone, where a row stands or its button goes under its words, 8 px down, from the same edge. The signed D4 phone board draws the jobs in this layout.

The screen passes every connector and where it stands; nothing here decides what is on.

## Types

- `SetupToolsRow`: `{ connector: ConnectorView; state: 'on' | 'always_on' }`, `{ connector: ConnectorView; state: 'off'; tools?: number; onChoose: () => void }`, or `{ connector: ConnectorView; state: 'needs_review'; tools?: number; onReview: () => void }`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `jobs` | `readonly SetupJobRow[]` | Optional. The Desk's jobs, already validated and formatted by the screen. |
| `rowRef` | `(key: string, row: HTMLLIElement \| null) => void` | Optional. Receives each row by connector or job key for returning focus after review; the keyed row survives its button becoming "On". |
| `builtIn` | `SetupToolsRow[]` | Required. The connectors that are part of Claude Desk, Verification among them, under "Built in"; an `off` row's button says "Add". |
| `external` | `SetupToolsRow[]` | Required. The apps to connect from outside, under "Connect your own"; an `off` row's button says "Connect", a `needs_review` row's "Review". |

The cards are `Card` (`fill-card`, a `line-card` border, `radius-card`); the rows' hairlines are `line-hairline`.
