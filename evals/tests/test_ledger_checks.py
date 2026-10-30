"""The ledger checks tier 1's restart and ledger cases run on the real kernel's ledger, run here on
entries built from the master plan's definitions, so they are known to work before Plan 01a lands.

The entries are signed with the kernel's own signer under a test seed (as in `test_oracles.py`),
and both the evals' oracle and the kernel's `verify_chain` judge them.
"""

import json
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from desk.contracts import LedgerEntry
from evals.tests.test_oracles import COPY, DESK, KEY, OTHER, ledger_chain, ledger_entry, ledger_page
from evals.tier1.test_restart_and_ledger import (
    assert_names,
    assert_saved_page_verifies,
    assert_tampering_is_caught,
    both_verdicts,
    checkpointed,
    dropped,
    edited,
    forged,
)


# The Desk the test chains belong to, as the checks read it off a `GoldenDesk`.
THIS_DESK = SimpleNamespace(copy=SimpleNamespace(copy_id=COPY), desk_id=DESK)
OTHER_DESK = SimpleNamespace(copy=SimpleNamespace(copy_id=COPY), desk_id="desk-2")


def page(n: int = 5) -> dict:
    return ledger_page(ledger_chain(n)).model_dump(mode="json")


def test_a_saved_page_verifies_from_its_file(tmp_path):
    saved = tmp_path / "ledger-page.json"
    saved.write_text(json.dumps(page()))
    assert [entry["seq"] for entry in assert_saved_page_verifies(saved, KEY, THIS_DESK)["entries"]] == [1, 2, 3, 4, 5]


def test_a_saved_page_that_claims_too_much_fails(tmp_path):
    """The page's own claim is checked too: a broken chain the page calls whole fails, a whole chain
    the page calls broken fails, and so does a whole chain checked against another key, or read
    for another Desk than its entries name."""
    saved = tmp_path / "ledger-page.json"
    saved.write_text(json.dumps({**page(), "chain_ok": False, "first_bad_seq": 2}))
    with pytest.raises(AssertionError, match=r"the page claims \(False, 2\), the evals' check says \(True, None\)"):
        assert_saved_page_verifies(saved, KEY, THIS_DESK)
    saved.write_text(json.dumps(edited(page(), 2)))   # still claims chain_ok
    with pytest.raises(AssertionError, match=r"the page claims \(True, None\), the evals' check says \(False, 3\)"):
        assert_saved_page_verifies(saved, KEY, THIS_DESK)
    saved.write_text(json.dumps(page()))
    with pytest.raises(AssertionError, match=r"\(False, 1\)"):
        assert_saved_page_verifies(saved, OTHER.public_key_hex(), THIS_DESK)
    with pytest.raises(AssertionError, match=r"the evals' check says \(False, 1\), the kernel's verify_chain \(True"):
        assert_saved_page_verifies(saved, KEY, OTHER_DESK)   # a whole chain, but another Desk's


@pytest.mark.parametrize("n", [3, 4, 7])
def test_tampering_is_caught_at_the_same_entry_by_both_checks(n: int):
    assert_tampering_is_caught(page(n), KEY, THIS_DESK)


def test_each_tampering_fails_where_the_case_says():
    original = page(5)
    assert both_verdicts(edited(original, 4), KEY, THIS_DESK) == ((False, 5), (False, 5))
    assert both_verdicts(dropped(original, 2), KEY, THIS_DESK) == ((False, 4), (False, 4))
    assert both_verdicts(dropped(original, 4), KEY, THIS_DESK)[1] == (True, None)   # verify_chain reads entries alone
    forgery = forged(original, 2, Ed25519PrivateKey.generate())
    assert forgery["entries"][2]["key_id"] != original["entries"][2]["key_id"]
    assert both_verdicts(forgery, KEY, THIS_DESK) == ((False, 3), (False, 3))
    assert both_verdicts(original, KEY, OTHER_DESK) == ((False, 1), (True, None))   # the binding is the oracle's
    assert original == page(5), "a tampering changed the page it was given"


def test_too_short_a_page_fails_the_tampering_check():
    with pytest.raises(AssertionError, match="2 entries, too few"):
        assert_tampering_is_caught(page(2), KEY, THIS_DESK)


def with_event(entry: dict, **event: object) -> LedgerEntry:
    """An entry of the chain with another event (its hash no longer matters here)."""
    return LedgerEntry.model_validate({**entry, "event": {**entry["event"], **event}})


def test_a_checkpoint_names_the_head_it_follows_or_holds():
    """A `head_checkpoint` entry names the entry its `prev_hash` links or whose hash its event
    holds, and the `checkpoint_seq` its summary gives; a summary naming another entry than the
    link adds it, so a misplaced checkpoint can't pass."""
    entries = ledger_chain(5)
    hashes = {entry["seq"]: entry["hash"] for entry in entries}
    after_3 = entries[3]   # seq 4, linked to entry 3
    assert checkpointed(with_event(after_3, kind="head_checkpoint", summary={"checkpoint_seq": 3}), hashes) == {3}
    assert checkpointed(with_event(after_3, kind="head_checkpoint", summary={"head": hashes[3]}), hashes) == {3}
    assert checkpointed(with_event(after_3, kind="head_checkpoint", summary={"checkpoint_seq": 2}), hashes) == {2, 3}
    assert checkpointed(with_event(after_3, kind="head_checkpoint", summary={"head": hashes[1]}), hashes) == {1, 3}
    assert checkpointed(with_event(after_3, summary={"checkpoint_seq": "2"}), hashes) == {3}   # a string isn't a seq
    genesis = LedgerEntry.model_validate(ledger_entry(1, "0" * 64))
    assert checkpointed(genesis, hashes) == set()


def test_assert_names_needs_the_kind_and_the_id():
    entries = {entry["seq"]: with_event(entry, kind="decide", ref_id=f"d-{entry['seq']}") for entry in ledger_chain(3)}
    assert_names(entries, 2, "decide", "d-2", "the decision")
    with pytest.raises(AssertionError, match="which is decide, not reply"):
        assert_names(entries, 2, "reply", "d-2", "the verdict")
    with pytest.raises(AssertionError, match="doesn't name it"):
        assert_names(entries, 2, "decide", "d-3", "the decision")
    with pytest.raises(AssertionError, match="which is no entry"):
        assert_names(entries, 9, "decide", "d-9", "the decision")
