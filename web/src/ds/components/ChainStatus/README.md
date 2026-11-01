# ChainStatus

`ChainStatus` is the one line over the Safety ledger: whether every signed entry still matches the chain, and how many entries there are.

## When to use

- At the top of Safety's list of every entry, from the ledger page the screen read.
- Not inside a single entry's trace, which says the same for its entry (`FullTrace`).

## What the consumer provides

- `chainOk` and `firstBadSeq` from `LedgerPage` (`chain_ok`, `first_bad_seq`), or `chainOk: null` before the ledger has been read.
- `entries`: how many entries the page holds.
- `devKey`: `Health.dev_signing_key`.

## What it shows

| State | Dot | Line |
| --- | --- | --- |
| `chainOk: true` | handled | "Every entry matches the chain" |
| `chainOk: false`, or anything but `true` or `null` | refused | "Entry {firstBadSeq} doesn't match the chain" ("An entry doesn't match the chain" without a well-formed number) |
| `chainOk: null` | info | "Not checked yet" |

Beside the line, the count as a `CountPill` read as "{n} entries"; at the end, "Signed with a development key" when `devKey`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `chainOk` | `boolean \| null` | Required. |
| `firstBadSeq` | `number \| null` | Required. |
| `entries` | `number` | Required. |
| `devKey` | `boolean` | Required. |
