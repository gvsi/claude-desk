# ConnectorSignIn

`ConnectorSignIn` is the mock sign-in for an app connected from outside: it says no real account is used, shows the connector's promise, and asks one question with a choice of accounts.

## When to use

- In the add-a-connector flow, after the owner chooses an app in `ConnectorPicker` and before `ConnectorReview`: the "Sign in" step.
- Not for built-in connectors, which have nothing to sign in to.

## What it shows

- A native modal `<dialog>` like the picker's: 600 px wide, 48 px from the top of the window, over `scrim` with `shadow-dialog`, 28 px of padding, 20 px between its parts.
- `Steps` at the top.
- The connector's `ConnectorIcon` at `page` size beside its title, "Connect {name}" in serif `.cd-type-page-title` with the Mock badge (`ConnectorName`), which names the dialog ("Connect Google Calendar Mock").
- Under the title, in secondary meta: "A mock sign-in. No {provider} account is used, and nothing is read from or sent to {provider}."
- The connector's promise as a `ConnectorPromise` card.
- A radio group named by `question`: a bordered box per choice (`line-control` at `radius-control`, the checked one on `accent-blue`), its native radio in the accent color, `label` in body type and `detail` in secondary meta.
- At the right, a secondary "Cancel" → `onCancel()` and a primary "Continue" → `onContinue(value)`, disabled until `value` is one of the choices.
- It asks for no account details: no text field and no password.
- Under 720 px it sits 16 px from the window's edges with 20 px of padding.

## Keyboard and focus

- Focus starts on the checked choice, or the first one. The arrow keys move between choices, as native radios do.
- Tab and Shift+Tab stay inside: the radio group is one stop, then Cancel, then Continue.
- Escape and the browser's own close request call `onCancel`. When the screen removes it, focus returns to whatever opened it.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. An app connected from outside. |
| `provider` | `string` | Required. "Google". |
| `promise` | `{ title: string; detail?: string }` | Required. |
| `question` | `string` | Required. Names the radio group. |
| `choices` | `{ id: string; label: string; detail: string }[]` | Required. |
| `value` | `string` | Required. The screen's choice; "" before one is made. |
| `onChange` | `(id: string) => void` | Required. |
| `onContinue` | `(id: string) => void` | Required. |
| `onCancel` | `() => void` | Required. |
| `steps` | `StepsProps` | Required. |
