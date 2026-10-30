# ConnectionPanel

`ConnectionPanel` is the end of a connector's page: an app's connection details, and what turning the connector off or disconnecting it stops, behind a plain confirm.

## When to use

- At the end of every connector's page under Connectors (`connectors/:connector`), after its tools.
- Turning a connector off only narrows what Claude can do, so it applies at once after this confirm, with no proved review. Turning one on goes through `ConnectorReview` and `ChangeReview` instead.

## What it shows

- **A built-in connector** (`off.kind: 'turn_off'`): the heading "Turn off {name}", then "{consequence} You'll see the change before it applies. Your rules are kept, so you can add it back." in secondary body type, and a secondary main-size "Turn off {name}" at the right.
- **An app connected from outside**: the heading "Connection", then `details` as a description list: each row of 10 px under a hairline (none under the last), its term in a 200 px column of secondary meta and its value 16 px after it in body type (stacked under 480 px). Then "{consequence} You'll see the change before it applies. Your rules for them are kept in case you connect again." and a secondary "Disconnect".
- **Verification** (`off.kind: 'always_on'`): "Always on. {reason}" and no button, since the kernel refuses to turn it off.
- On a narrow line the button drops under the words.

## The confirm

The button opens Plan 03a's `Dialog`, a plain question rather than a proved diff:

- Title: "Turn off {name}?", or "Disconnect {name}?" with the Mock badge after it, so a mock is never named without saying so (its name reads "Disconnect Stripe? Mock").
- Body: "These tools stop at once:" with `stops.tools` as a list; then "These rules stop applying:" with `stops.rules`, or "None of your rules stop applying." when there are none; then what is kept, as in the panel.
- Buttons: "Keep it on" or "Keep it connected", focused first, and "Turn off {name}" or "Disconnect".
- Cancel and Escape close it with no call. Confirm calls `onTurnOff` once, however often it is pressed; the dialog then waits (`aria-busy`, a spinner on the pressed button only, the other waiting) until the screen's `pending` has come and gone, and then closes. The screen says how it went with a `Notice`. While it waits, the panel's own button waits too.

## What the consumer provides

- `consequence`: the screen's sentence ("Claude stops offering payment links and charges.", "Disconnecting removes its tools from your Desk.").
- `stops`: the names of the connector's tools, and the reasons of the rules that stop applying, read from the Desk's rules.
- `details`: the screen's words for each line, any date already formatted.
- `pending` from the confirm until the change is done, then one `POST /tools/confirm {tools, enable: false}`'s result.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `connector` | `ConnectorView` | Required. Its source decides "Turn off" or "Disconnect". |
| `details` | `{ label: string; value: string }[]` | An app's connection details. |
| `off` | `ConnectionTurnOff \| ConnectionAlwaysOn` | Required. `{ kind: 'turn_off'; consequence; stops: { tools; rules }; onTurnOff; pending? }` or `{ kind: 'always_on'; reason }`. |
