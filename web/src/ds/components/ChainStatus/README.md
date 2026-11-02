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
| `chainOk: false`, or anything but `true` or `null` | refused | "The record check failed at entry {firstBadSeq}" ("The record check failed" without a well-formed number) |
| `chainOk: null` | info | "Not checked yet" |

Beside the line, the count in words, "{n} entries" ("1 entry"), in caption type and the secondary text color (`entriesLabel`); at the end, "Signed with a development key" when `devKey`.

The words claim no more than the kernel's check shows. A pass means every entry still hashes and verifies as signed, in an unbroken run that ends at the head the kernel last wrote. A failure at an entry names the first check that failed, not a changed entry: an untouched record checked against another key fails at entry 1, a removed entry fails at the unchanged one after it, and entries cut off the end fail at the first missing one, past the last entry shown. So a failed check says where it failed, never that the record changed. The full trace (`FullTrace`) keeps the chain's own terms.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `chainOk` | `boolean \| null` | Required. |
| `firstBadSeq` | `number \| null` | Required. |
| `entries` | `number` | Required. |
| `devKey` | `boolean` | Required. |
