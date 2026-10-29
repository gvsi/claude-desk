"""The safety ledger: one signed, hash-chained log per Desk, appended in the caller's transaction.

`append` writes an entry in the same transaction as the record it describes, so the two commit
together or not at all; it never commits. Appends to one Desk are serialized by a `FOR UPDATE`
lock on its `ledger_heads` row. Each entry stores the exact text that was hashed
(`envelope_jcs = canonical_json({copy_id, desk_id, seq, prev_hash, created_at, event})`, nulls
explicit), its hash and the kernel's Ed25519 signature over `b"desk-ledger-v1\\0" + hash`.

Summaries hold only kernel-built values. `check_summary` is the backstop that refuses secrets
before anything is written, and `safe_ref` turns an untrusted identifier into something that can
always be logged, so a hostile string can't make an append fail and drop the attempt.
"""

import hashlib
import json
import re
from typing import Any

import desk_kernel
from sqlalchemy import insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from desk.contracts import LedgerEntry, LedgerEvent
from desk.db.models import LedgerEntry as LedgerEntryRow
from desk.db.models import LedgerHead
from desk.kernel_service.clock import signed_time
from desk.kernel_service.repo import KernelCtx

DOMAIN = b"desk-ledger-v1\0"
GENESIS = "0" * 64

SECRET_KEYS = frozenset({
    "code", "codes", "contact", "email", "phone", "body", "text", "prose", "token", "session_token",
    "owner_token", "secret", "secret_hash", "code_hash", "canary", "nonce",
})
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
SAFE_REF = re.compile(r"[A-Za-z0-9._:-]{1,64}")


class UnsafeSummary(ValueError):
    """A ledger summary carries a key or value that may be a secret, code, contact or body."""


def check_summary(summary: Any) -> None:
    """Raise `UnsafeSummary` if any key at any depth is a secret's name (any case) or any string,
    key or value, looks like an email address. The message names the key, never the value."""
    pending: list[tuple[str, Any]] = [("summary", summary)]
    while pending:
        path, value = pending.pop()
        if isinstance(value, dict):
            for key, item in value.items():
                if isinstance(key, str) and (key.lower() in SECRET_KEYS or EMAIL.search(key)):
                    raise UnsafeSummary(f"a ledger summary can't carry {path}.{key if key.lower() in SECRET_KEYS else '<email>'}")
                pending.append((f"{path}.{key}", item))
        elif isinstance(value, (list, tuple)):
            pending.extend((f"{path}[{i}]", item) for i, item in enumerate(value))
        elif isinstance(value, str) and EMAIL.search(value):
            raise UnsafeSummary(f"a ledger summary value at {path} looks like an email address")


def safe_ref(value: object) -> str | dict[str, Any]:
    """`value` when it is a plain identifier (`^[A-Za-z0-9._:-]{1,64}$`); otherwise a marker with
    the first 16 hex characters of its sha256, so the attempt is logged without the text."""
    if isinstance(value, str) and SAFE_REF.fullmatch(value):
        return value
    text = value if isinstance(value, str) else repr(value)
    return {"invalid": True, "sha256": hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:16]}


async def append(ctx: KernelCtx, *, copy_id: str, desk_id: str, event: LedgerEvent) -> LedgerEntry:
    """Append `event` to the Desk's chain in the caller's transaction (binding it to `copy_id` if
    nothing has run in it yet) and return the signed entry. Never commits."""
    check_summary(event.summary)
    repo = ctx.bind(copy_id)
    await ctx.db.execute(
        pg_insert(LedgerHead).values(desk_id=desk_id, copy_id=copy_id, seq=0, head=GENESIS)
        .on_conflict_do_nothing(index_elements=[LedgerHead.desk_id])
    )
    locked = select(LedgerHead.seq, LedgerHead.head).where(LedgerHead.desk_id == desk_id).with_for_update()
    last_seq, prev_hash = (await ctx.db.execute(repo.scoped(locked))).one()
    envelope = {
        "copy_id": copy_id,
        "desk_id": desk_id,
        "seq": last_seq + 1,
        "prev_hash": prev_hash,
        "created_at": signed_time(ctx.clock.now()),
        "event": event.model_dump(mode="json"),
    }
    envelope_jcs = desk_kernel.canonical_json(json.dumps(envelope))
    entry_hash = desk_kernel.ledger_hash(envelope_jcs)
    entry = LedgerEntry(**envelope, hash=entry_hash, signature=ctx.signer.sign(DOMAIN, bytes.fromhex(entry_hash)),
                        key_id=ctx.signer.key_id())
    await ctx.db.execute(insert(LedgerEntryRow).values(**entry.model_dump(), envelope_jcs=envelope_jcs))
    await ctx.db.execute(
        update(LedgerHead).where(LedgerHead.desk_id == desk_id, LedgerHead.copy_id == copy_id)
        .values(seq=entry.seq, head=entry.hash).execution_options(synchronize_session=False)
    )
    return entry
