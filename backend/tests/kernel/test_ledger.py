"""The signed, hash-chained ledger append and its summary backstop."""

import asyncio
import json
import re

import desk_kernel
import pytest
from sqlalchemy import select

from desk.contracts import LedgerEntry, LedgerEvent
from desk.db.models import LedgerHead, PriceItem
from desk.kernel_service import ledger
from desk.kernel_service.clock import signed_time

from .helpers import kernel_ctx, ledger_rows, make_copy_rows, rows_of

GENESIS = "0" * 64


def event(**summary) -> LedgerEvent:
    return LedgerEvent(kind="auth", origin="kernel", summary=summary or {"route": "POST /decide", "reason": "bad_token"})


async def test_first_entry_is_genesis(app):
    rows = await make_copy_rows(app)
    async with kernel_ctx(app) as ctx:
        entry = await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=event())
    assert (entry.seq, entry.prev_hash) == (1, GENESIS)
    assert (entry.copy_id, entry.desk_id, entry.event) == (rows.copy_id, rows.desk_id, event())
    assert entry.key_id == app.state.kernel.signer.key_id()
    [stored] = await ledger_rows(app, rows)
    assert (stored.seq, stored.prev_hash, stored.hash, stored.signature) == (1, GENESIS, entry.hash, entry.signature)
    [head] = await rows_of(app, rows.copy_id, select(LedgerHead))
    assert (head.desk_id, head.seq, head.head) == (rows.desk_id, 1, entry.hash)


def chain_json(entries) -> str:
    return json.dumps([LedgerEntry.model_validate(entry, from_attributes=True).model_dump(mode="json")
                       for entry in entries])


async def test_entries_chain_and_verify(app, frozen_clock):
    rows = await make_copy_rows(app)
    appended = []
    for n in range(3):
        async with kernel_ctx(app) as ctx:
            appended.append(await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id,
                                                event=event(route="POST /decide", attempt=n)))
        frozen_clock.advance(1)
    assert [e.seq for e in appended] == [1, 2, 3]
    assert [e.prev_hash for e in appended] == [GENESIS, appended[0].hash, appended[1].hash]
    stored = await ledger_rows(app, rows)
    public_key = app.state.kernel.signer.public_key_hex()
    assert json.loads(desk_kernel.verify_chain(chain_json(stored), public_key)) == {"ok": True, "first_bad_seq": None}
    # each entry is bound to its place: reordering or dropping one breaks the chain
    for broken in ([stored[0], stored[2]], [stored[1], stored[0], stored[2]]):
        assert json.loads(desk_kernel.verify_chain(chain_json(broken), public_key))["ok"] is False


async def test_envelope_text_is_stored_exactly(app, frozen_clock):
    rows = await make_copy_rows(app)
    sent = LedgerEvent(kind="decide", origin="kernel", session_id="session-1", ref_id=None,
                       summary={"tool": "native.quote", "outcome": "hold", "note": "café", "cents": 18_000})
    async with kernel_ctx(app) as ctx:
        await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=sent)
    [stored] = await ledger_rows(app, rows)
    envelope = {"copy_id": rows.copy_id, "desk_id": rows.desk_id, "seq": 1, "prev_hash": GENESIS,
                "created_at": stored.created_at,
                "event": {"kind": "decide", "origin": "kernel", "session_id": "session-1", "ref_id": None,
                          "summary": {"tool": "native.quote", "outcome": "hold", "note": "café", "cents": 18_000}}}
    assert stored.envelope_jcs == desk_kernel.canonical_json(json.dumps(envelope))
    assert '"ref_id":null' in stored.envelope_jcs                            # nulls are explicit
    assert stored.hash == desk_kernel.ledger_hash(stored.envelope_jcs)
    assert re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z", stored.created_at)
    assert stored.created_at == "2026-10-30T17:04:05.123456Z" == signed_time(frozen_clock.now())
    assert stored.event == sent


async def test_concurrent_appends_serialize(app):
    rows = await make_copy_rows(app)

    async def append_one(n: int) -> int:
        async with kernel_ctx(app) as ctx:   # each in its own transaction, racing for the Desk's head
            return (await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=event(attempt=n))).seq

    seqs = await asyncio.gather(*(append_one(n) for n in range(20)))
    assert sorted(seqs) == list(range(1, 21))
    stored = await ledger_rows(app, rows)
    assert [entry.seq for entry in stored] == list(range(1, 21))
    assert sorted(entry.event.summary["attempt"] for entry in stored) == list(range(20))
    public_key = app.state.kernel.signer.public_key_hex()
    assert json.loads(desk_kernel.verify_chain(chain_json(stored), public_key)) == {"ok": True, "first_bad_seq": None}


def upper_cased(value):
    """The same summary with every key and string upper-cased."""
    if isinstance(value, dict):
        return {key.upper(): upper_cased(item) for key, item in value.items()}
    return value.upper() if isinstance(value, str) else value


@pytest.mark.parametrize("summary", [
    {"code": "482913"},
    {"contact": "(510) 555-0177"},
    {"body": "Invoice, drain clearing"},
    {"session_token": "tok"},
    {"nested": {"canary": "cdk-0123456789abcdef"}},
    {"note": "dana@example.com"},
])
async def test_summary_rejects_secrets(app, summary):
    rows = await make_copy_rows(app)
    for variant in (summary, upper_cased(summary), {"items": [summary]}):   # any case, any depth
        with pytest.raises(ledger.UnsafeSummary) as refused:
            ledger.check_summary(variant)
        assert "482913" not in str(refused.value) and "dana@" not in str(refused.value)   # never echoes the value
        # append refuses it too, before writing anything
        with pytest.raises(ledger.UnsafeSummary):
            async with kernel_ctx(app) as ctx:
                await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id,
                                    event=LedgerEvent(kind="verify", origin="kernel", summary=variant))
    assert await ledger_rows(app, rows) == []
    ledger.check_summary({"route": "POST /verify/start", "reason": "locked_out", "attempts": 10})   # ordinary values pass
    # an untrusted identifier goes in through safe_ref, which always yields a loggable value
    assert ledger.safe_ref("native.quote") == "native.quote"
    for hostile in ("dana@example.com", "native.quote\n", "x" * 65, "", "naïve", None):
        ref = ledger.safe_ref(hostile)
        assert set(ref) == {"invalid", "sha256"} and re.fullmatch(r"[0-9a-f]{16}", ref["sha256"]), hostile
        ledger.check_summary({"tool": ref})


async def test_failed_append_rolls_back_the_record(app):
    rows = await make_copy_rows(app)
    unsafe = LedgerEvent(kind="desk_data", origin="kernel", summary={"part": "prices", "contact": "bob@example.com"})
    with pytest.raises(ledger.UnsafeSummary):
        async with kernel_ctx(app) as ctx:
            ctx.bind(rows.copy_id)
            ctx.db.add(PriceItem(desk_id=rows.desk_id, item_id="drain", copy_id=rows.copy_id, title="Drain clearing",
                                 unit_cents=18_000))
            await ctx.db.flush()   # the record is written in this transaction before its entry fails
            await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=unsafe)
    assert await rows_of(app, rows.copy_id, select(PriceItem)) == []
    assert await ledger_rows(app, rows) == []
    # an entry that can't be hashed (money is integer cents, never a float) rolls back the same way
    with pytest.raises(ValueError):
        async with kernel_ctx(app) as ctx:
            ctx.bind(rows.copy_id)
            ctx.db.add(PriceItem(desk_id=rows.desk_id, item_id="drain", copy_id=rows.copy_id, title="Drain clearing",
                                 unit_cents=18_000))
            await ctx.db.flush()
            await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id,
                                event=LedgerEvent(kind="desk_data", origin="kernel", summary={"cents": 180.5}))
    assert await rows_of(app, rows.copy_id, select(PriceItem)) == []
    assert await rows_of(app, rows.copy_id, select(LedgerHead)) == []
