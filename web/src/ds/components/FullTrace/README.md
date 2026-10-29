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

## What it shows

1. "Full trace of entry {seq}", which also names the region, and the close button.
2. The plain line: what this kind of entry records, then who recorded it. Entries from the kernel say "Recorded by the safety checks."; entries the chat service reported say "Reported by the chat service, and recorded as it was reported." (`traceLine.ts`, one line per `LedgerEvent.kind`, a missing kind is a compile error).
3. The record, labels in a secondary caption and values in mono: the entry number, `created_at` exactly as given, the previous hash, hash, signature and signing key, each shortened in the middle when longer than 17 characters with the whole value in its `title`, then `event.summary` as indented JSON.
4. The chain: "Chain verified through entry {seq}" (handled), "Chain broken at entry {first_bad_seq}" (refused) or "Not verified yet" (info). It says verified only when the kernel's check passed.
5. "Signed with a development key" when `devKey`.

Nothing in the trace is computed or formatted: the kernel's values are shown as they arrive.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `entry` | `LedgerEntry` | Required. |
| `chain` | `Pick<LedgerPage, 'chain_ok' \| 'first_bad_seq'> \| null` | Required. |
| `devKey` | `boolean` | Required. |
| `onClose` | `() => void` | Required. |
