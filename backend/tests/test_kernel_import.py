"""The desk_kernel extension module, as the kernel service imports it."""

import json
from pathlib import Path

import desk_kernel
import pytest

FIXTURES = Path(__file__).resolve().parents[2] / "kernel" / "cedar" / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


def visitor_request(action: str, resource_type: str) -> dict:
    visitor = {"uid": {"type": "Visitor", "id": "session-v"},
               "attrs": {"verified": False, "assurance": "none", "copy": "copy-1"}, "parents": []}
    resource = {"uid": {"type": resource_type, "id": "r-1"}, "attrs": {"copy": "copy-1"}, "parents": []}
    return {"principal": visitor["uid"], "action": action, "resource": resource["uid"],
            "context": {"record_owner_match": False, "local_dow": 2, "local_minute": 600},
            "entities": [visitor, resource]}


def test_version():
    assert desk_kernel.version() == "0.1.0"


def test_policy_engine_decides_from_python():
    engine = desk_kernel.PolicyEngine(fixture("baseline.cedar"))
    sets = {"F": "", "A": fixture("auto.cedar"), "H": fixture("hold.cedar")}
    assert engine.load("desk-1:1", fixture("schema.cedarschema.json"), json.dumps(sets)) == []

    slots = json.loads(engine.decide("desk-1:1", json.dumps(visitor_request("native.find_slots", "Desk")), "pre"))
    assert slots == {"outcome": "allow", "policy_ids": ["A.find_slots"], "pending_policy_ids": [], "errors": []}
    quote = json.loads(engine.decide("desk-1:1", json.dumps(visitor_request("native.quote", "Desk")), "pre"))
    assert quote["outcome"] == "needs_review"
    assert quote["pending_policy_ids"] == ["A.quote_reviewed"]

    # Lint and validation errors come back as a list; the key stays unloaded and refuses.
    buggy = dict(sets, A=fixture("buggy_or_gate.cedar"))
    assert engine.load("desk-1:2", fixture("schema.cedarschema.json"), json.dumps(buggy)) != []
    refused = json.loads(engine.decide("desk-1:2", json.dumps(visitor_request("native.find_slots", "Desk")), "final"))
    assert refused["outcome"] == "refuse"


def test_review_contract_reaches_the_engine_as_is():
    # the kernel service passes the shared Review contract through unchanged; only "allow" can allow
    from desk.contracts import Review

    engine = desk_kernel.PolicyEngine(fixture("baseline.cedar"))
    sets = {"F": "", "A": fixture("auto.cedar"), "H": fixture("hold.cedar")}
    assert engine.load("desk-1:1", fixture("schema.cedarschema.json"), json.dumps(sets)) == []
    for recommendation, outcome in (("allow", "allow"), ("hold", "hold"), ("block", "hold")):
        quote = visitor_request("native.quote", "Desk")
        review = Review(within_charter_bp=9500, manipulation_bp=500, recommendation=recommendation)
        quote["context"]["review"] = review.model_dump()
        verdict = json.loads(engine.decide("desk-1:1", json.dumps(quote), "final"))
        assert verdict["outcome"] == outcome, (recommendation, verdict)


def test_signing_and_canonical_json_from_python(monkeypatch):
    assert desk_kernel.lint_policies(json.dumps({"F": "", "A": fixture("buggy_or_gate.cedar"), "H": ""}))
    assert desk_kernel.canonical_json('{"b": 1, "a": null}') == '{"a":null,"b":1}'
    with pytest.raises(ValueError):
        desk_kernel.canonical_json('{"amount_cents": 10.5}')
    assert desk_kernel.canonical_json_any('{"b": 1.0, "a": 1e21}') == '{"a":1e+21,"b":1}'

    monkeypatch.setenv("DESK_ENV", "production")
    monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)
    with pytest.raises(ValueError):
        desk_kernel.Signer.from_env()
    monkeypatch.setenv("DESK_SIGNING_SEED", "11" * 32)
    signer = desk_kernel.Signer.from_env()
    assert signer.dev_key is False
    assert desk_kernel.Signer.from_env_with({}).dev_key is True

    # A one-entry ledger, built and checked the way the kernel service will.
    envelope = {"copy_id": "copy-1", "desk_id": "desk-1", "seq": 1, "prev_hash": "0" * 64,
                "created_at": "2026-10-30T17:04:05.123456Z",
                "event": {"kind": "session", "origin": "kernel", "session_id": None, "ref_id": None, "summary": {}}}
    entry_hash = desk_kernel.ledger_hash(desk_kernel.canonical_json(json.dumps(envelope)))
    signature = signer.sign(b"desk-ledger-v1\0", bytes.fromhex(entry_hash))
    entry = dict(envelope, hash=entry_hash, signature=signature, key_id=signer.key_id())
    verdict = json.loads(desk_kernel.verify_chain(json.dumps([entry]), signer.public_key_hex()))
    assert verdict == {"ok": True, "first_bad_seq": None}
    with pytest.raises(ValueError):
        signer.sign(b"desk-ledger-v1", bytes(32))
