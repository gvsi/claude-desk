"""Ledger verification from a page alone, without the kernel or the database.

`verify_ledger_page` recomputes every entry as `LedgerEntry` defines it: the hash is the sha256 of
the canonical JSON of the six envelope fields as the page carries them (nulls explicit), and the
signature is Ed25519 over `b"desk-ledger-v1\\0"` and that 32-byte hash. The page's own `chain_ok`
and `first_bad_seq` are the kernel's claim and never part of the verdict.
"""

import hashlib
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from evals.oracles.canonical import canonical
from evals.oracles.signatures import LEDGER_DOMAIN, key_id_of, signed

ENVELOPE = ("copy_id", "desk_id", "seq", "prev_hash", "created_at", "event")
GENESIS = "0" * 64   # the genesis entry's prev_hash
FIRST_SEQ = 1        # the genesis entry's seq (Plan 01a); a page is the whole chain from genesis


@dataclass(frozen=True)
class LedgerCheck:
    ok: bool
    first_bad_seq: int | None = None   # the first entry, in page order, that fails a check
    reason: str | None = None          # plain words for a failed check; None when ok


def verify_ledger_page(
    page: BaseModel | dict, public_key_hex: str, *, copy_id: str | None = None, desk_id: str | None = None
) -> LedgerCheck:
    """Checks a `LedgerPage` (the model or its JSON) against the kernel's public key: from the
    genesis entry (seq 1, prev_hash 64 zeros), consecutive seqs, each prev_hash the previous hash,
    each hash and signature recomputed, each key_id the key's, then the page's head, public key and
    key_id. With `copy_id` or `desk_id`, the copy and Desk the page was read for, an entry naming
    another fails at its seq: a valid chain is still a leak when it is another Desk's. An empty
    page fails, since a Desk's ledger is checked only where it should hold entries. A malformed
    key raises ValueError."""
    data = page.model_dump(mode="json") if isinstance(page, BaseModel) else page
    key_id = key_id_of(public_key_hex)
    entries = data["entries"]
    if not entries:
        return LedgerCheck(False, None, "the page has no entries, so nothing verifies from genesis")
    prev_hash, prev_seq = GENESIS, None
    for entry in entries:
        failure = _entry_failure(entry, public_key_hex, key_id, prev_hash, prev_seq, copy_id, desk_id)
        if failure:
            return LedgerCheck(False, _seq(entry), failure)
        prev_hash, prev_seq = entry["hash"], entry["seq"]
    if data.get("head") != prev_hash:
        return LedgerCheck(False, None, "the page's head isn't its last entry's hash")
    if data.get("public_key_hex") != public_key_hex:
        return LedgerCheck(False, None, "the page's public_key_hex isn't the key it is checked against")
    if data.get("key_id") != key_id:
        return LedgerCheck(False, None, "the page's key_id isn't the key it is checked against")
    return LedgerCheck(True)


def _seq(entry: dict[str, Any]) -> int | None:
    seq = entry.get("seq")
    return seq if isinstance(seq, int) and not isinstance(seq, bool) else None


def _entry_failure(
    entry: dict[str, Any], public_key_hex: str, key_id: str, prev_hash: str, prev_seq: int | None,
    copy_id: str | None, desk_id: str | None,
) -> str | None:
    seq = _seq(entry)
    if seq is None:
        return f"an entry has no integer seq ({entry.get('seq')!r})"
    if prev_seq is None and seq != FIRST_SEQ:
        return f"the page starts at entry {seq}, not at the genesis entry {FIRST_SEQ}"
    if prev_seq is not None and seq != prev_seq + 1:
        return f"entry {seq} follows entry {prev_seq}; sequence numbers must be consecutive"
    if copy_id is not None and entry.get("copy_id") != copy_id:
        return f"entry {seq} is another copy's, not the one the page was read for"
    if desk_id is not None and entry.get("desk_id") != desk_id:
        return f"entry {seq} is another Desk's, not the one the page was read for"
    if entry.get("prev_hash") != prev_hash:
        return f"entry {seq}'s prev_hash isn't the previous entry's hash"
    try:
        digest = hashlib.sha256(canonical({field: entry[field] for field in ENVELOPE})).digest()
    except (KeyError, ValueError) as e:
        return f"entry {seq} has no canonical envelope ({e})"
    if entry.get("hash") != digest.hex():
        return f"entry {seq}'s hash doesn't match its envelope"
    if entry.get("key_id") != key_id:
        return f"entry {seq}'s key_id isn't the key it is checked against"
    if not signed(public_key_hex, LEDGER_DOMAIN, digest, entry.get("signature")):
        return f"entry {seq}'s signature doesn't verify with the key"
    return None
