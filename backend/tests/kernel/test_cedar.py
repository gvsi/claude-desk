"""The Cedar schema, the always-on baseline, the proof invariants and the reviewer thresholds.

Decisions go through `PolicyEngine(BASELINE)` with a test-only permit-all set loaded as `A` and
`H`, so whatever is refused here is refused by the baseline alone.
"""

import ast
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import get_args

import desk_kernel
import pytest

from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, Effect, ReviewThresholds, ToolName, ToolProfile
from desk.kernel_service import compiler

BACKEND = Path(__file__).resolve().parents[2]
REPO = BACKEND.parent

# A test-only set that permits everything, annotated so it lints; its @applies_to names every
# effect group, so the engine counts it as an owner card for money (decision step 5).
EVERY_EFFECT = ",".join(f"effect:{effect}" for effect in get_args(Effect))
PERMIT_ALL = {
    "F": "",
    "A": f'@id("test_permit_all") @card("test-permit-all") @tier("auto") @applies_to("{EVERY_EFFECT}")\n'
         "permit (principal, action, resource);",
    "H": f'@id("test_permit_all") @card("test-permit-all") @tier("hold") @applies_to("{EVERY_EFFECT}")\n'
         "permit (principal, action, resource);",
}

# The master plan's "Model-visible tools", native rows: effects, resource type, principal types.
TOOL_TABLE: dict[str, tuple[list[str], str, list[str]]] = {
    "native.quote": (["change"], "Desk", ["Visitor", "Agent"]),
    "native.find_slots": (["read"], "Desk", ["Visitor", "Agent"]),
    "native.book": (["change"], "Slot", ["Visitor", "Agent"]),
    "native.release_document": (["private_data", "send_message"], "Document", ["Visitor", "Agent"]),
    "native.payment_link": (["charge"], "Quote", ["Visitor", "Agent"]),
    "native.charge_mandate": (["charge"], "Quote", ["Agent"]),
    "native.capture_lead": (["change"], "Desk", ["Visitor", "Agent"]),
    "native.request_callback": (["change"], "Desk", ["Visitor", "Agent"]),
    "native.start_verification": (["send_message"], "Desk", ["Visitor", "Agent"]),
    "native.fetch_website": (["read"], "Desk", ["Owner"]),
    "native.read_memory": (["read"], "Desk", ["Owner"]),
}

# The master plan's "Cedar request shape": attribute -> (type, required).
PRINCIPAL_ATTRS = {"verified": ("Boolean", True), "person_id": ("String", False), "assurance": ("String", True),
                   "copy": ("String", True)}
AGENT_ATTRS = PRINCIPAL_ATTRS | {"agent_key_id": ("String", True), "mandate_remaining_cents": ("Long", False)}
RESOURCE_ATTRS = {"copy": ("String", True), "owner_person_id": ("String", False)}
CONTEXT_ATTRS = {"owner_approved": ("Boolean", True), "amount_cents": ("Long", False), "list_cents": ("Long", False),
                 "discount_bp": ("Long", False), "recipient": ("String", False),
                 "record_owner_match": ("Boolean", True), "local_dow": ("Long", True),
                 "local_minute": ("Long", True), "review": ("Record", False)}
REVIEW_ATTRS = {"within_charter_bp": ("Long", True), "manipulation_bp": ("Long", True)}


def shape(attributes: dict) -> dict[str, tuple[str, bool]]:
    return {name: (attr["type"], attr.get("required", True)) for name, attr in attributes.items()}


def test_schema_matches_the_tool_table():
    native_tools = {tool for tool in get_args(ToolName) if tool.startswith("native.")}
    assert set(TOOL_TABLE) == native_tools                      # the table names every native tool

    schema = compiler.desk_schema([])
    assert list(schema) == [""]                                 # no namespace
    base = schema[""]
    groups = {f"effect:{effect}" for effect in get_args(Effect)}
    actions = base["actions"]
    assert set(actions) == groups | native_tools                # no payments.* until Plan 01c connects them
    for group in groups:
        assert actions[group] == {}                             # declared, members or not
    for tool, (effects, resource, principals) in TOOL_TABLE.items():
        action = actions[tool]
        assert sorted(group["id"] for group in action["memberOf"]) == sorted(f"effect:{e}" for e in effects), tool
        assert action["appliesTo"] == {"principalTypes": principals, "resourceTypes": [resource],
                                       "context": {"type": "Ctx"}}, tool

    entity_types = base["entityTypes"]
    assert set(entity_types) == {"Visitor", "Agent", "Owner", "Quote", "Slot", "Booking", "Document", "Charge",
                                 "Desk"}
    principals = {"Visitor": PRINCIPAL_ATTRS, "Owner": PRINCIPAL_ATTRS, "Agent": AGENT_ATTRS}
    for name, entity in entity_types.items():
        expected = principals.get(name, RESOURCE_ATTRS)
        assert entity["shape"]["type"] == "Record"
        assert shape(entity["shape"]["attributes"]) == expected, name
        assert "memberOfTypes" not in entity, name

    assert list(base["commonTypes"]) == ["Ctx"]
    ctx = base["commonTypes"]["Ctx"]
    assert ctx["type"] == "Record"
    assert shape(ctx["attributes"]) == CONTEXT_ATTRS
    assert shape(ctx["attributes"]["review"]["attributes"]) == REVIEW_ATTRS

    assert compiler.desk_schema([]) is not compiler.BASE_SCHEMA  # a copy each time: callers may extend it
    assert compiler.desk_schema([]) == compiler.BASE_SCHEMA
    refund = ToolProfile(tool="payments.create_refund", source="mcp", effects=["pay_out", "private_data"],
                         reversible=False, adapter="mcp", resource_kind="charge", description_confirmed="Refunds",
                         input_schema={}, status="enabled")
    with pytest.raises(ValueError):
        compiler.desk_schema([refund])                          # refused, not silently left out of the schema


LOAD_OUTSIDE_THE_REPO = """
import json, sys
import desk_kernel
from desk.kernel_service import compiler

sets = sys.argv[1]
engine = desk_kernel.PolicyEngine(compiler.BASELINE)
errors = engine.load("desk-1:1", json.dumps(compiler.desk_schema([])), sets)
request = {"principal": {"type": "Visitor", "id": "session-1"}, "action": "native.find_slots",
           "resource": {"type": "Desk", "id": "desk-1"},
           "context": {"record_owner_match": False, "local_dow": 4, "local_minute": 600},
           "entities": [{"uid": {"type": "Visitor", "id": "session-1"},
                         "attrs": {"verified": False, "assurance": "none", "copy": "copy-1"}, "parents": []},
                        {"uid": {"type": "Desk", "id": "desk-1"}, "attrs": {"copy": "copy-1"}, "parents": []}]}
print(json.dumps({"cedar_dir": str(compiler.CEDAR_DIR), "errors": errors,
                  "verdict": json.loads(engine.decide("desk-1:1", json.dumps(request), "final")),
                  "baseline_sha256": compiler.baseline_sha256(),
                  "schema_sha256": compiler.schema_sha256(compiler.desk_schema([]))}))
"""


def test_baseline_and_schema_load(tmp_path):
    # a fresh interpreter in a directory outside the repo, as the image runs it (PYTHONPATH=backend)
    env = {**os.environ, "PYTHONPATH": str(BACKEND)}
    run = subprocess.run([sys.executable, "-c", LOAD_OUTSIDE_THE_REPO, json.dumps(PERMIT_ALL)], cwd=tmp_path,
                         env=env, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    loaded = json.loads(run.stdout)
    assert loaded["cedar_dir"] == str(REPO / "kernel" / "cedar")
    assert loaded["errors"] == []                               # strict validation passes, warnings aside
    assert loaded["verdict"]["outcome"] == "allow"

    baseline_bytes = (REPO / "kernel" / "cedar" / "baseline.cedar").read_bytes()
    assert compiler.BASELINE == baseline_bytes.decode("utf-8")
    assert loaded["baseline_sha256"] == compiler.baseline_sha256() == hashlib.sha256(baseline_bytes).hexdigest()
    schema_jcs = desk_kernel.canonical_json(json.dumps(compiler.BASE_SCHEMA))
    assert loaded["schema_sha256"] == compiler.schema_sha256(compiler.BASE_SCHEMA) \
        == hashlib.sha256(schema_jcs.encode()).hexdigest()
    widened = compiler.desk_schema([])
    widened[""]["actions"]["native.book"]["appliesTo"]["principalTypes"].append("Owner")
    assert compiler.schema_sha256(widened) != compiler.schema_sha256(compiler.BASE_SCHEMA)


KEY = "desk-test:1"


def load(baseline: str, schema: dict, key: str = KEY) -> desk_kernel.PolicyEngine:
    engine = desk_kernel.PolicyEngine(baseline)
    errors = engine.load(key, json.dumps(schema), json.dumps(PERMIT_ALL))
    assert errors == [], errors
    return engine


@pytest.fixture(scope="module")
def engine() -> desk_kernel.PolicyEngine:
    return load(compiler.BASELINE, compiler.desk_schema([]))


def request(tool: str, *, principal: str = "Visitor", verified: bool = False, person_id: str | None = None,
            copy: str = "copy-1", resource_type: str | None = None, resource_copy: str = "copy-1",
            mandate_remaining_cents: int | None = None, **context) -> dict:
    """A request_json in the master plan's shape; `context` adds to or overrides the required fields."""
    attrs = {"verified": verified, "assurance": "demo_code" if verified else "none", "copy": copy}
    if person_id is not None:
        attrs["person_id"] = person_id
    if principal == "Agent":
        attrs["agent_key_id"] = "agent-key-1"
        if mandate_remaining_cents is not None:
            attrs["mandate_remaining_cents"] = mandate_remaining_cents
    principal_uid = {"type": principal, "id": "session-1"}
    resource_uid = {"type": resource_type or TOOL_TABLE[tool][1], "id": "record-1"}
    return {"principal": principal_uid, "action": tool, "resource": resource_uid,
            "context": {"record_owner_match": False, "local_dow": 4, "local_minute": 600, **context},
            "entities": [{"uid": principal_uid, "attrs": attrs, "parents": []},
                         {"uid": resource_uid, "attrs": {"copy": resource_copy}, "parents": []}]}


def decide(engine: desk_kernel.PolicyEngine, req: dict, key: str = KEY) -> dict:
    verdict = json.loads(engine.decide(key, json.dumps(req), "final"))
    assert verdict["errors"] == [], verdict
    return verdict


def refused_by(verdict: dict) -> list[str]:
    assert verdict["outcome"] == "refuse", verdict
    return verdict["policy_ids"]


def test_other_copy_is_refused(engine):
    assert decide(engine, request("native.find_slots"))["outcome"] == "allow"
    assert "B.same_copy" in refused_by(decide(engine, request("native.find_slots", resource_copy="copy-2")))
    assert "B.same_copy" in refused_by(decide(engine, request("native.book", principal="Agent", copy="copy-2")))
    assert "B.same_copy" in refused_by(decide(engine, request("native.read_memory", principal="Owner",
                                                              verified=True, resource_copy="copy-2")))


def test_private_data_needs_the_verified_record_owner(engine):
    def release(**kwargs) -> dict:
        return decide(engine, request("native.release_document", recipient="verified_contact", **kwargs))

    for principal in ("Visitor", "Agent"):
        assert release(principal=principal, verified=True, person_id="p-dana", record_owner_match=True)["outcome"] \
            == "allow"
        for verified, match in ((False, False), (True, False), (False, True)):
            verdict = release(principal=principal, verified=verified, person_id="p-dana", record_owner_match=match)
            assert "B.private_data_record_owner" in refused_by(verdict), (principal, verified, match)


def with_test_refund() -> dict:
    """The base schema plus `test.refund`, a pay-out tool for visitors and agents."""
    schema = compiler.desk_schema([])
    schema[""]["actions"]["test.refund"] = {
        "memberOf": [{"id": "effect:pay_out"}],
        "appliesTo": {"principalTypes": ["Visitor", "Agent"], "resourceTypes": ["Charge"],
                      "context": {"type": "Ctx"}},
    }
    return schema


def test_agents_never_pay_out():
    engine = load(compiler.BASELINE, with_test_refund())

    def refund(**kwargs) -> dict:
        return decide(engine, request("test.refund", resource_type="Charge", amount_cents=4000, **kwargs))

    assert refund(verified=True, person_id="p-dana")["outcome"] == "allow"
    for mandate in (None, 1_000_000):
        verdict = refund(principal="Agent", verified=True, person_id="p-dana", mandate_remaining_cents=mandate)
        assert "B.no_agent_pay_out" in refused_by(verdict)


def test_agent_charges_need_mandate_room(engine):
    def charge(mandate: int | None, **context) -> dict:
        return decide(engine, request("native.charge_mandate", principal="Agent", mandate_remaining_cents=mandate,
                                      **context))

    assert "B.agent_charge_within_mandate" in refused_by(charge(None, amount_cents=2000))       # no mandate
    assert "B.agent_charge_within_mandate" in refused_by(charge(2000))                         # no amount
    assert charge(2000, amount_cents=2000)["outcome"] == "allow"
    assert "B.agent_charge_within_mandate" in refused_by(charge(2000, amount_cents=2001))
    # the mandate rule is the agent's: a visitor's payment link needs none
    assert decide(engine, request("native.payment_link", amount_cents=2000))["outcome"] == "allow"
    agent_link = request("native.payment_link", principal="Agent", amount_cents=2000)
    assert "B.agent_charge_within_mandate" in refused_by(decide(engine, agent_link))


def test_money_needs_an_amount_in_range():
    engine = load(compiler.BASELINE, with_test_refund())
    for tool, resource_type in (("native.payment_link", "Quote"), ("test.refund", "Charge")):
        def money(**context) -> dict:
            return decide(engine, request(tool, verified=True, person_id="p-dana", resource_type=resource_type,
                                          **context))

        for amount in ({}, {"amount_cents": 0}, {"amount_cents": 1_000_001}, {"amount_cents": -5}):
            assert "B.money_has_amount" in refused_by(money(**amount)), (tool, amount)
        assert money(amount_cents=1)["outcome"] == "allow"
        assert money(amount_cents=1_000_000)["outcome"] == "hold"     # in range, but over the auto cap


def test_auto_money_is_capped_at_the_hard_cap():
    engine = load(compiler.BASELINE, with_test_refund())
    cases = (request("native.payment_link", verified=True, person_id="p-dana"),
             request("test.refund", resource_type="Charge", verified=True, person_id="p-dana"),
             request("native.charge_mandate", principal="Agent", mandate_remaining_cents=1_000_000))
    for case in cases:
        def money(amount: int) -> dict:
            return decide(engine, {**case, "context": {**case["context"], "amount_cents": amount}})

        assert money(AUTO_MONEY_HARD_CAP_CENTS)["outcome"] == "allow", case["action"]
        held = money(AUTO_MONEY_HARD_CAP_CENTS + 1)
        assert held == {"outcome": "hold", "policy_ids": ["H.test_permit_all"], "pending_policy_ids": [],
                        "errors": []}, case["action"]


def test_invalid_recipient_is_refused(engine):
    for tool in ("native.start_verification", "native.capture_lead"):     # any action that names a recipient
        for recipient in ("owner", "verified_contact"):
            assert decide(engine, request(tool, recipient=recipient))["outcome"] == "allow", (tool, recipient)
        for recipient in ("visitor", "dana@example.com", "", "Owner"):
            verdict = decide(engine, request(tool, recipient=recipient))
            assert "B.recipient_owner_or_verified_contact" in refused_by(verdict), (tool, recipient)
    # the rule reads a recipient only when the action names one
    assert decide(engine, request("native.capture_lead"))["outcome"] == "allow"


# Each always-invariant file and the baseline forbid that enforces it.
ALWAYS = {"private_data": "private_data_record_owner", "recipients": "recipient_owner_or_verified_contact",
          "no_agent_pay_out": "no_agent_pay_out", "agent_mandate": "agent_charge_within_mandate"}
PERMIT_EVERYTHING = "permit (principal, action, resource)"


def statements(text: str) -> list[str]:
    """A Cedar file's statements, comments dropped and whitespace collapsed."""
    code = " ".join(line.split("//", 1)[0] for line in text.splitlines())
    return [" ".join(part.split()) for part in code.split(";") if part.strip()]


def without_annotations(statement: str) -> str:
    return re.sub(r'@\w+\("[^"]*"\)\s*', "", statement)


def test_invariant_files_state_the_baseline_properties():
    invariants_dir = compiler.CEDAR_DIR / "invariants"
    files = {kind: sorted(path.stem for path in (invariants_dir / kind).glob("*.cedar")) for kind in ("always", "auto")}
    assert files == {"always": sorted(ALWAYS), "auto": ["money_cap"]}
    assert {kind: sorted(texts) for kind, texts in compiler.INVARIANTS.items()} == files
    for kind, names in files.items():
        for name in names:
            assert compiler.INVARIANTS[kind][name] == (invariants_dir / kind / f"{name}.cedar").read_text()

    # A proof spec set: everything is allowed but a violation, so a policy set implies it exactly
    # when it never allows a violation. Each always-invariant is word for word a baseline forbid.
    baseline = {re.search(r'@id\("([^"]+)"\)', s).group(1): without_annotations(s)
                for s in statements(compiler.BASELINE)}
    for name, policy_id in ALWAYS.items():
        permit, forbid = statements(compiler.INVARIANTS["always"][name])
        assert permit == PERMIT_EVERYTHING
        assert forbid == baseline[policy_id], name

    # The auto-invariant: nothing auto-allowed moves more than the hard cap. It validates against
    # the schema, and wherever it refuses, the baseline's auto evaluation never allows.
    permit, forbid = statements(compiler.INVARIANTS["auto"]["money_cap"])
    assert permit == PERMIT_EVERYTHING
    invariant = load(f'@id("money_cap") {forbid};', with_test_refund())
    real = load(compiler.BASELINE, with_test_refund())
    for tool, resource_type in (("native.payment_link", "Quote"), ("test.refund", "Charge")):
        for amount in (None, 0, 1, AUTO_MONEY_HARD_CAP_CENTS, AUTO_MONEY_HARD_CAP_CENTS + 1, 1_000_000):
            case = request(tool, resource_type=resource_type, verified=True, person_id="p-dana")
            if amount is not None:
                case["context"]["amount_cents"] = amount
            stated = decide(invariant, case)["outcome"]
            assert stated == ("allow" if amount is not None and amount <= AUTO_MONEY_HARD_CAP_CENTS else "refuse")
            if stated == "refuse":
                assert decide(real, case)["outcome"] != "allow", (tool, amount)

    # The invariants hash covers every file's bytes, the check list and the prover's version.
    checks = ["baseline_auto", "baseline_approvable"]
    hashed = {f"{kind}/{name}.cedar": hashlib.sha256((invariants_dir / kind / f"{name}.cedar").read_bytes()).hexdigest()
              for kind, names in files.items() for name in names}
    expected = {"files": hashed, "checks": sorted(checks), "prove_version": desk_kernel.version()}
    assert compiler.invariants_sha256(checks) == compiler.invariants_sha256(list(reversed(checks))) \
        == hashlib.sha256(desk_kernel.canonical_json(json.dumps(expected)).encode()).hexdigest()
    assert compiler.invariants_sha256(checks + ["never_errors"]) != compiler.invariants_sha256(checks)
    with pytest.raises(ValueError):
        compiler.invariants_sha256(["never_errors", "never_errors"])


# The plan's initial thresholds: effect -> (min_within_charter_bp, max_manipulation_bp).
INITIAL = {"read": (7000, 3000), "change": (7500, 2500), "send_message": (8000, 2000), "private_data": (8500, 1500),
           "charge": (9000, 1000), "pay_out": (9500, 500)}


def test_thresholds_take_the_strictest_effect(monkeypatch):
    from desk.kernel_service import review_thresholds as rt

    table = {effect: ReviewThresholds(min_within_charter_bp=low, max_manipulation_bp=high)
             for effect, (low, high) in INITIAL.items()}
    assert set(INITIAL) == set(get_args(Effect))
    assert rt.INITIAL_THRESHOLDS == table
    assert rt.THRESHOLDS == table and rt.THRESHOLDS is not rt.INITIAL_THRESHOLDS
    assert rt.REVIEW_THRESHOLDS_VERSION == 1 and rt.CALIBRATION is None

    assert rt.thresholds_for(["private_data", "send_message"]) == rt.THRESHOLDS["private_data"]
    assert rt.thresholds_for(["send_message", "private_data"]) == rt.THRESHOLDS["private_data"]
    assert rt.thresholds_for(["change"]) == rt.THRESHOLDS["change"]

    # each bound is taken on its own: the highest charter floor, the lowest manipulation ceiling
    monkeypatch.setattr(rt, "THRESHOLDS", {
        **table,
        "read": ReviewThresholds(min_within_charter_bp=9000, max_manipulation_bp=3000),
        "change": ReviewThresholds(min_within_charter_bp=7000, max_manipulation_bp=1000),
    })
    assert rt.thresholds_for(["read", "change"]) == ReviewThresholds(min_within_charter_bp=9000,
                                                                     max_manipulation_bp=1000)
    with pytest.raises(ValueError):
        rt.thresholds_for([])                                   # no effect, no threshold: never a free pass


def test_thresholds_sit_between_calibration_markers():
    from desk.kernel_service import review_thresholds as rt

    source = Path(rt.__file__).read_text()
    lines = [line.strip() for line in source.splitlines()]
    assert lines.count("# calibration: begin") == 1 and lines.count("# calibration: end") == 1
    begin, end = lines.index("# calibration: begin") + 1, lines.index("# calibration: end") + 1   # 1-based
    assert begin < end

    inside, outside = [], []
    for statement in ast.parse(source).body:
        if begin < statement.lineno and statement.end_lineno < end:
            inside.append(statement)
        else:
            assert not (statement.lineno < end and statement.end_lineno > begin), "a statement spans a marker"
            outside.append(statement)

    def assigned(nodes: list[ast.stmt]) -> list[str]:
        names = []
        for node in nodes:
            if isinstance(node, ast.Assign):
                names += [target.id for target in node.targets if isinstance(target, ast.Name)]
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                names.append(node.target.id)
        return names

    # exactly the three calibrated names, each assigned alone, and nothing else between the markers
    calibrated = ["CALIBRATION", "REVIEW_THRESHOLDS_VERSION", "THRESHOLDS"]
    assert all(isinstance(statement, ast.Assign | ast.AnnAssign) for statement in inside)
    assert all(len(statement.targets) == 1 for statement in inside if isinstance(statement, ast.Assign))
    assert sorted(assigned(inside)) == calibrated
    assert "INITIAL_THRESHOLDS" in assigned(outside)
    assert not set(calibrated) & set(assigned(outside))
    assert not any(isinstance(node, ast.Global) for node in ast.walk(ast.parse(source)))
