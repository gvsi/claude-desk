# FullTrace

`FullTrace` is one signed ledger entry in full, for the owner: what it records in plain words, then the record itself in mono and the state of the chain.

## When to use

- When an owner opens a receipt in a conversation, a stopped attempt on Safety, or a row of every entry.
- Owner screens only. Visitor surfaces have no ledger read and show no trace.
- It is the only place Claude Desk uses mono.

## What the consumer provides

- `entry`: the `LedgerEntry` with the receipt's `ledger_seq`, from the ledger page.
- `chain`: the page's `chain_ok` and `first_bad_seq`, or `null` before the ledger has been checked.
- `devKey`: `Health.dev_signing_key`.
- `onClose`, called by the close button and by Escape anywhere inside the trace. To move focus into the trace when it opens, focus the trace itself (it has `tabIndex={-1}`); return focus to the receipt when it closes.
- `tabIndex={0}` when the screen lets the trace scroll inside itself, as Safety's every-entry view does beside its list: Tab reaches it, so a keyboard can scroll it, and its border turns `line-focus` on keyboard focus.

## What it shows

1. "Full trace of entry {seq}", which also names the region, and the close button.
2. The plain line: what this kind of entry records, then who recorded it. Handoff entries read the owner's history row name as their sentence, using `handoffEntryOf` as the history rows do; an unknown handoff closing falls back to the kind's line. Entries from the kernel say "Recorded by the checkpoint."; entries the chat service reported say "Reported by the chat service, not checked by the checkpoint." (`traceLine.ts`, one line per `LedgerEvent.kind` and per `HandoffEntry`, a missing kind or handoff state is a compile error). A kind this build doesn't know reads "An entry in the record.", and an origin other than `kernel` reads as reported, never as checked.
3. The record, labels in a secondary caption and values in mono: the entry number, `created_at` exactly as given, the previous hash, hash, signature and signing key, each shortened in the middle when longer than 17 characters with the whole value in its `title`, then `event.summary` as indented JSON.
4. The chain (`traceChainLine` in `traceLine.ts`): "Chain verified through entry {seq}" (handled), "Chain broken at entry {first_bad_seq}" (refused; "Chain broken" when no well-formed entry number comes with it) or "Not verified yet" (info, also when there is no chain at all). It says verified only when `chain_ok` is exactly `true`.
5. "Signed with a development key" when `devKey`.

Nothing in the trace is computed or formatted: the kernel's values are shown as they arrive.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `entry` | `LedgerEntry` | Required. |
| `chain` | `Pick<LedgerPage, 'chain_ok' \| 'first_bad_seq'> \| null` | Required. |
| `devKey` | `boolean` | Required. |
| `onClose` | `() => void` | Required. |
| `tabIndex` | `0 \| -1` | `-1` by default; `0` for a trace that scrolls inside itself. |
