# CopyResult

`CopyResult` is a copy control's status line, kept in the page so assistive technology can announce its result.

## When to use

Use with `useCopyText` and `copyResultLine` in `CopyField`, `CopyList` and the web app's `CopyLink`.

## Behavior

The paragraph keeps `role="status"` even when empty. Its keyed span is replaced for each completed press, so repeated words are announced again. Only the latest copy shows its line; a newer press anywhere clears the older result, whether it succeeded or failed. There is no timed clear.

The consumer provides the line's type and spacing through `className`. Keep the empty paragraph rendered and in the accessibility tree while letting it take no room.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `result` | `string` | Required. The line from `copyResultLine`, or an empty string. |
| `announcement` | `number` | Required. The key from `useCopyText`. |
| `className` | `string` | The control's result-line styles. |
