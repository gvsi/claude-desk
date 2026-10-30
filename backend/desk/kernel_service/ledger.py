"""The safety ledger: one signed, hash-chained log per Desk, appended in the caller's transaction.

`append` writes an entry in the same transaction as the record it describes, so the two commit
together or not at all; it never commits. Appends to one Desk are serialized by a `FOR UPDATE`
lock on its `ledger_heads` row. Each entry stores the exact text that was hashed
(`envelope_jcs = canonical_json({copy_id, desk_id, seq, prev_hash, created_at, event})`, nulls
explicit), its hash and the kernel's Ed25519 signature over `b"desk-ledger-v1\\0" + hash`.

Every 50th entry is a checkpoint: in the same transaction, its signed hash goes to the owner's
Demo inbox and the next entry records that it went (`head_checkpoint`).

Summaries hold only kernel-built values. `check_summary` is the backstop that refuses secrets
before anything is written, and `safe_ref` turns an untrusted identifier into something that can
always be logged, so a hostile string can't make an append fail and drop the attempt.
"""

import hashlib
import json
import re
from collections.abc import Iterator
from typing import Any

import desk_kernel
from sqlalchemy import insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from desk.contracts import LedgerEntry, LedgerEvent, LedgerPage
from desk.db.models import LedgerEntry as LedgerEntryRow
from desk.db.models import LedgerHead
from desk.kernel_service import demo_inbox
from desk.kernel_service.clock import signed_time
from desk.kernel_service.repo import KernelCtx

DOMAIN = b"desk-ledger-v1\0"
GENESIS = "0" * 64
CHECKPOINT_EVERY = 50
CHECKPOINT_PREVIEW = "Ledger checkpoint"   # owner-only

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


def check_reported(event: LedgerEvent) -> None:
    """The API's own entries (`POST /ledger/append`) are recorded as reported, so the kernel checks
    that what it is handed can be kept: a summary `check_summary` passes, a plain `ref_id`, no NUL
    character (Postgres can't store one) and nothing canonical JSON refuses (a float). Raises
    `UnsafeSummary`, before anything is written."""
    check_summary(event.summary)
    if event.ref_id is not None and not SAFE_REF.fullmatch(event.ref_id):
        raise UnsafeSummary("an API entry's ref_id is a plain identifier")
    dumped = event.model_dump(mode="json")
    if any("\0" in text for text in _strings(dumped)):
        raise UnsafeSummary("an API entry can't carry a NUL character")
    try:
        desk_kernel.canonical_json(json.dumps(dumped))
    except ValueError as refused:
        raise UnsafeSummary("an API entry must be canonical JSON, with no floats") from refused


def _strings(value: Any) -> Iterator[str]:
    """Every string in a JSON value, keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _strings(key)
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


async def append(ctx: KernelCtx, *, copy_id: str, desk_id: str, event: LedgerEvent) -> LedgerEntry:
    """Append `event` to the Desk's chain in the caller's transaction (binding it to `copy_id` if
    nothing has run in it yet) and return the signed entry, after writing the head checkpoint when
    the entry is a 50th. Never commits."""
    entry = await _append_one(ctx, copy_id=copy_id, desk_id=desk_id, event=event)
    if entry.seq % CHECKPOINT_EVERY == 0:
        await _checkpoint(ctx, entry)
    return entry


async def _append_one(ctx: KernelCtx, *, copy_id: str, desk_id: str, event: LedgerEvent) -> LedgerEntry:
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


async def _checkpoint(ctx: KernelCtx, head: LedgerEntry) -> None:
    """Send the owner the signed head `head` (its hash, signature and key id, which check against the
    kernel's public key alone), then record that it went. The record lands one past a multiple of
    50, so it never calls for a checkpoint itself."""
    body = {"desk_id": head.desk_id, "seq": head.seq, "head": head.hash, "signature": head.signature,
            "key_id": head.key_id}
    notice = await demo_inbox.deliver(ctx, copy_id=head.copy_id, desk_id=head.desk_id, to="owner", person_id=None,
                                      kind="head_checkpoint", body=desk_kernel.canonical_json(json.dumps(body)),
                                      preview=CHECKPOINT_PREVIEW)
    await _append_one(ctx, copy_id=head.copy_id, desk_id=head.desk_id,
                      event=LedgerEvent(kind="head_checkpoint", origin="kernel",
                                        summary={"checkpoint_seq": head.seq, "entry_id": notice.entry_id}))


async def page(ctx: KernelCtx, desk_id: str) -> LedgerPage:
    """The Desk's whole chain from genesis, verified with the kernel's key, in the caller's
    transaction (bound to the Desk's copy).

    `verify_chain` checks each entry's hash, signature, key and link to the one before it. A chain
    cut short still links, so the Desk's `ledger_heads` row, written with every append, must also
    name the last entry: the first entry past where the two part ways is the first bad one.
    `head` is that row's hash (genesis before the first entry). The row is read first and held
    `FOR SHARE`, so no append lands between the two reads and the page is one consistent snapshot."""
    head_seq, head = (await ctx.db.execute(ctx.repo.scoped(
        select(LedgerHead.seq, LedgerHead.head).where(LedgerHead.desk_id == desk_id).with_for_update(read=True)
    ))).one_or_none() or (0, GENESIS)
    rows = await ctx.db.scalars(ctx.repo.scoped(
        select(LedgerEntryRow).where(LedgerEntryRow.desk_id == desk_id).order_by(LedgerEntryRow.seq)))
    entries = [LedgerEntry.model_validate(row, from_attributes=True) for row in rows]
    public_key_hex = ctx.signer.public_key_hex()
    checked = json.loads(desk_kernel.verify_chain(json.dumps([entry.model_dump(mode="json") for entry in entries]),
                                                  public_key_hex))
    bad = [] if checked["ok"] else [checked["first_bad_seq"]]
    last_seq, last_hash = (entries[-1].seq, entries[-1].hash) if entries else (0, GENESIS)
    if (head_seq, head) != (last_seq, last_hash):
        bad.append(min(head_seq, last_seq) + 1 if head_seq != last_seq else last_seq)
    known = [seq for seq in bad if seq is not None]
    return LedgerPage(entries=entries, head=head, chain_ok=not bad, first_bad_seq=min(known) if known else None,
                      public_key_hex=public_key_hex, key_id=ctx.signer.key_id())
