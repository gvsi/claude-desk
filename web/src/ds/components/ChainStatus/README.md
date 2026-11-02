# ChainStatus

`ChainStatus` is the one line over the Safety ledger: whether any signed entry has changed since it was written, and how many entries there are.

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
| `chainOk: true` | handled | "No entry has been changed since it was written" |
| `chainOk: false`, or anything but `true` or `null` | refused | "Something in this record changed at entry {firstBadSeq}" ("Something in this record has changed since it was written" without a well-formed number) |
| `chainOk: null` | info | "Not checked yet" |

Beside the line, the count in words, "{n} entries" ("1 entry"), in caption type and the secondary text color (`entriesLabel`); at the end, "Signed with a development key" when `devKey`.

The words claim no more than the kernel's check shows. A pass means every entry still hashes and verifies as signed, in an unbroken run that ends at the head the kernel last wrote. A failure at an entry is the first place the record stops checking out, which may be a removed or added entry rather than that entry changing, so the line names where the record changed, not that the entry itself did. The full trace (`FullTrace`) keeps the chain's own terms.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `chainOk` | `boolean \| null` | Required. |
| `firstBadSeq` | `number \| null` | Required. |
| `entries` | `number` | Required. |
| `devKey` | `boolean` | Required. |
