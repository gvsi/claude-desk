"""The session cases' ledger helpers, checked without a kernel: `assert_ledgered` and the checks
on the `auth` entries a refused call leaves."""

import hashlib
import secrets

import pytest

from desk.contracts import CopyCreated, LedgerEntry, LedgerEvent, SessionState
from evals.records import NoRecords
from evals.tier1.test_sessions import assert_ledgered, assert_only_auth, copy_secrets, ledgered_during

COPY, DESK, OTHER_DESK = "c-1", "d-1", "d-2"


def entry(seq: int, kind: str = "auth", *, desk_id: str = DESK, origin: str = "kernel", session_id: str | None = None,
          summary: dict | None = None) -> LedgerEntry:
    summary = {"route": "/decide", "reason": "bad_token"} if summary is None else summary
    return LedgerEntry(
        copy_id=COPY, desk_id=desk_id, seq=seq, prev_hash="0" * 64, created_at="2026-11-03T18:00:00.000000Z",
        event=LedgerEvent(kind=kind, origin=origin, session_id=session_id, summary=summary),
        hash=f"{seq:064x}", signature="00" * 64, key_id="k" * 16,
    )


class LedgerRecords:
    """Records holding only ledgers, which a case appends to as a kernel would."""

    def __init__(self, *entries: LedgerEntry) -> None:
        self.entries = list(entries)

    def append(self, *entries: LedgerEntry) -> None:
        self.entries.extend(entries)

    async def ledger_entries(self, copy_id: str, desk_id: str) -> list[LedgerEntry]:
        return [e for e in self.entries if (e.copy_id, e.desk_id) == (copy_id, desk_id)]


async def test_a_new_entry_of_the_kind_passes_and_is_yielded():
    records = LedgerRecords(entry(1, "desk_data"))
    async with assert_ledgered(records, COPY, DESK, "auth", session_id="s-1") as new:
        records.append(entry(2, "auth", session_id="s-1"), entry(3, "session", session_id="s-1"))
    assert [e.seq for e in new] == [2, 3]


async def test_an_entry_from_before_the_block_does_not_count():
    records = LedgerRecords(entry(1, "auth"))
    with pytest.raises(AssertionError, match="no new auth entry"):
        async with assert_ledgered(records, COPY, DESK, "auth"):
            pass


async def test_an_entry_of_another_kind_or_on_another_desk_does_not_count():
    records = LedgerRecords()
    with pytest.raises(AssertionError, match="no new auth entry"):
        async with assert_ledgered(records, COPY, DESK, "auth"):
            records.append(entry(1, "decide"), entry(1, "auth", desk_id=OTHER_DESK))


async def test_the_entry_names_the_session_or_none():
    records = LedgerRecords()
    async with assert_ledgered(records, COPY, DESK, "auth", session_id="s-1"):
        records.append(entry(1, "auth"))   # no session named: allowed
    with pytest.raises(AssertionError, match="another session"):
        async with assert_ledgered(records, COPY, DESK, "auth", session_id="s-1"):
            records.append(entry(2, "auth", session_id="s-2"))


async def test_a_copy_or_its_id_names_the_ledger():
    copy = CopyCreated(
        copy_id=COPY, desk_ids=[DESK], owner_token="owner-token",
        owner_session=SessionState(session_id="s-owner", kind="owner", verified=True, assurance="owner_session",
                                   mode="ai", generation=0),
    )
    records = LedgerRecords()
    async with assert_ledgered(records, copy, DESK, "auth"):
        records.append(entry(1, "auth"))


async def test_an_unknown_kind_is_refused():
    with pytest.raises(ValueError, match="not a ledger event kind"):
        async with assert_ledgered(LedgerRecords(), COPY, DESK, "auth_failure"):
            pass


async def test_the_stub_keeps_no_ledger_so_nothing_is_checked():
    async with assert_ledgered(NoRecords(), COPY, DESK, "auth") as new:
        pass
    assert new == []
    async with ledgered_during(NoRecords(), COPY, DESK) as new:
        pass
    assert new == []


async def test_ledgered_during_yields_every_new_entry():
    records = LedgerRecords(entry(1, "desk_data"))
    async with ledgered_during(records, COPY, DESK) as new:
        records.append(entry(2, "decide"), entry(1, "auth", desk_id=OTHER_DESK))
    assert [(e.seq, e.event.kind) for e in new] == [(2, "decide")]


OWNER_TOKEN = "b-owner-token-0123456789"
COPY_B = CopyCreated(
    copy_id="c-b", desk_ids=["d-b"], owner_token=OWNER_TOKEN,
    owner_session=SessionState(session_id="s-b-owner", kind="owner", verified=True, assurance="owner_session",
                               mode="ai", generation=0),
)


def test_copy_secrets_name_the_token_its_hash_and_the_ids():
    assert copy_secrets(COPY_B, "B's") == {
        "B's owner token": OWNER_TOKEN,
        "B's owner token hash": hashlib.sha256(OWNER_TOKEN.encode()).hexdigest(),
        "B's copy id": "c-b",
        "B's owner session id": "s-b-owner",
        "B's Desk id d-b": "d-b",
    }


def test_auth_entries_with_a_route_and_a_reason_pass():
    assert_only_auth([entry(1), entry(2, session_id="s-a")], copy_secrets(COPY_B, "B's"))
    assert_only_auth([], copy_secrets(COPY_B, "B's"))


@pytest.mark.parametrize("bad, message", [
    (entry(1, "decide"), "not an auth refusal"),
    (entry(1, "session", origin="api"), "not an auth refusal"),
    (entry(1, origin="api"), "not an auth refusal"),
    (entry(1, summary={"route": "/decide"}), "route and reason"),
    (entry(1, summary={"reason": "bad_token"}), "route and reason"),
    (entry(1, summary={"route": "/decide", "reason": "bad_token", "token": OWNER_TOKEN}), "B's owner token"),
    (entry(1, summary={"route": "/decide", "reason": "bad_token",
                       "hash": hashlib.sha256(OWNER_TOKEN.encode()).hexdigest()}), "B's owner token hash"),
    (entry(1, session_id="s-b-owner"), "B's owner session id"),
    (entry(1, summary={"route": "/policy/draft", "reason": "wrong_copy", "copy": "c-b"}), "B's copy id"),
])
def test_other_entries_fail_naming_what_leaked_never_its_value(bad, message):
    with pytest.raises(AssertionError, match=message) as failure:
        assert_only_auth([entry(1), bad], copy_secrets(COPY_B, "B's"))
    assert OWNER_TOKEN not in str(failure.value)


def test_an_auth_entry_missing_its_reason_never_shows_the_keys_it_chose():
    """A summary is a `dict`, so its keys are the kernel's own choice and may be a token spelled
    like a field name: the failure names only the route and reason it looks for, never another key."""
    token_key = "tok_" + secrets.token_hex(16)
    for summary in ({"route": "/decide", token_key: "x"}, {token_key: "/decide", "e" + secrets.token_hex(19): 1}):
        with pytest.raises(AssertionError, match="route and reason") as failure:
            assert_only_auth([entry(1, summary=summary)], copy_secrets(COPY_B, "B's"))
        assert not [key for key in summary if key not in ("route", "reason") and key in str(failure.value)], (
            str(failure.value))
