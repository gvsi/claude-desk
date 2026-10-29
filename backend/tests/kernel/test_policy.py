"""Owner rule drafts: `POST /policy/draft` proves them, `POST /policy/confirm` activates them.

A draft is compiled, loaded (lint and validation) and, in `symcc` mode, proved with `desk-prove`
before it can be confirmed; in `bounded` mode it is only checked, and never activates. Confirm
activates a proved draft only while its parent is still active and everything it was proved
against is still current. Each failing check reads in the owner's words.
"""

import asyncio
import dataclasses
import json
import time
from dataclasses import dataclass
from pathlib import Path

import desk_kernel
import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import LedgerEvent, PolicyVersion, RuleCard, ToolProfile
from desk.db.models import LedgerEntry, Person, Tool
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_service import activation, compiler, desks, ledger
from desk.kernel_service.repo import new_id

from .helpers import CopyRows, draft_and_confirm, kernel_ctx, make_copy_rows, rows_of
from .test_compiler import NATIVE, card, req

STUBS = Path(__file__).parent / "stubs"

@dataclass(frozen=True)
class DeskRows:
    """A copy whose Desk enables `profiles`, knows Dana, and has version 1 active."""

    rows: CopyRows
    dana: str                             # Dana's person_id

    @property
    def desk_id(self) -> str:
        return self.rows.desk_id


STARTER = [card("slots", "native.find_slots")]   # version 1: open times for anyone, everything else asks


async def desk_with_tools(app: FastAPI, profiles: list[ToolProfile] = NATIVE) -> DeskRows:
    """A Desk with the tools in `profiles` enabled, a person named Dana, and version 1 compiled
    from `STARTER` and active, ledgered as a new Desk's first version is."""
    rows = await make_copy_rows(app)
    dana = new_id("person")
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        now = ctx.clock.now()
        ctx.db.add(Person(person_id=dana, copy_id=rows.copy_id, desk_id=rows.desk_id, ref="dana", display_name="Dana",
                          contact="dana@example.com", contact_norm="dana@example.com",
                          masked_contact=desks.mask_contact("dana@example.com"), created_at=now))
        ctx.db.add_all(desks.tool_row(rows.copy_id, rows.desk_id, profile) for profile in profiles)
        schema = compiler.desk_schema(profiles)
        compiled = compiler.compile_cards(STARTER, profiles)
        ctx.db.add(activation.version_row(
            copy_id=rows.copy_id, desk_id=rows.desk_id, version=1, parent_version=None, compiled=compiled,
            a0=compiler.compile_cards(STARTER, profiles, review=False).A, schema=schema,
            hashes=activation.version_hashes(compiled, schema, profiles, cards=STARTER), status="active", proof=None,
            created_at=now))
        await ctx.db.flush()
        await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=LedgerEvent(
            kind="policy", origin="kernel", summary={"version": 1, "status": "active"}))
    return DeskRows(rows=rows, dana=dana)


def dumped(cards: list[RuleCard]) -> list[dict]:
    return [c.model_dump(mode="json") for c in cards]


async def post_draft(client: httpx.AsyncClient, desk: DeskRows, cards: list[RuleCard],
                     expected_parent: int | None = 1, owner: dict[str, str] | None = None) -> httpx.Response:
    return await client.post("/policy/draft", headers=owner or desk.rows.owner,
                             json={"desk_id": desk.desk_id, "cards": dumped(cards), "expected_parent": expected_parent})


async def drafted(client: httpx.AsyncClient, desk: DeskRows, cards: list[RuleCard], **kwargs) -> PolicyVersion:
    response = await post_draft(client, desk, cards, **kwargs)
    assert response.status_code == 200, response.text
    return PolicyVersion.model_validate(response.json())


async def versions(app: FastAPI, desk: DeskRows) -> list[PolicyVersionRow]:
    return await rows_of(app, desk.rows.copy_id, select(PolicyVersionRow).where(
        PolicyVersionRow.desk_id == desk.desk_id).order_by(PolicyVersionRow.version))


async def policy_entries(app: FastAPI, desk: DeskRows) -> list[dict]:
    entries = await rows_of(app, desk.rows.copy_id, select(LedgerEntry).where(
        LedgerEntry.desk_id == desk.desk_id).order_by(LedgerEntry.seq))
    return [entry.event.summary for entry in entries if entry.event.kind == "policy"]


def hashes_of(row: PolicyVersionRow) -> activation.VersionHashes:
    return activation.VersionHashes(*(getattr(row, field) for field in activation.VersionHashes._fields))


BOOK_AND_ASK_CHARGES = [card("book", "native.book"), card("charges", "effect:charge", mode="ask")]


@pytest.mark.solver
async def test_draft_is_proved_with_every_obligation(desk_prove, app, client):
    desk = await desk_with_tools(app)
    version = await drafted(client, desk, BOOK_AND_ASK_CHARGES)
    assert (version.desk_id, version.version, version.parent_version, version.status) == (desk.desk_id, 2, 1, "proved")
    proof = version.proof
    assert proof.ok and proof.method == "symcc" and not proof.timed_out, proof
    assert [(c.name, c.ok, c.counterexample_plain) for c in proof.checks] == [
        (name, True, None) for name in activation.PROOF_CHECKS]
    # what was stored: the cards with their default asks, the Cedar and what it was proved against
    [_, row] = await versions(app, desk)
    compiled = compiler.compile_cards(BOOK_AND_ASK_CHARGES, NATIVE)
    assert row.cards == version.cards == compiled.cards
    assert any(c.is_default for c in row.cards)
    assert row.cedar == {**compiled.sets(), "A0": compiler.compile_cards(BOOK_AND_ASK_CHARGES, NATIVE, review=False).A}
    schema = compiler.desk_schema(NATIVE)
    assert hashes_of(row) == activation.version_hashes(compiled, schema, NATIVE, cards=BOOK_AND_ASK_CHARGES)
    assert row.draft_key_sha256 is not None and row.proof == proof and row.status == "proved"
    assert await policy_entries(app, desk) == [{"version": 1, "status": "active"},
                                                {"version": 2, "status": "proved", "method": "symcc"}]
    # the live proof answers the same cards from now on
    assert app.state.kernel.policies.cache.get(hashes_of(row)) == proof


def use_prover(monkeypatch: pytest.MonkeyPatch, stub: str, *, sleep: float = 0) -> None:
    """Prove with a stand-in for desk-prove in `stubs/`, as a kernel in `symcc` mode would."""
    monkeypatch.setattr(activation, "_proof_mode", "symcc")
    monkeypatch.setenv("DESK_PROVE", str(STUBS / stub))
    monkeypatch.setenv("DESK_PROVE_STUB_SLEEP", str(sleep))


def count_prover_runs(monkeypatch: pytest.MonkeyPatch) -> list[activation.ProofInputs]:
    """Every desk-prove run from here on, as the inputs it proved."""
    runs: list[activation.ProofInputs] = []
    prove = activation.prove

    async def counted(inputs: activation.ProofInputs):
        runs.append(inputs)
        return await prove(inputs)

    monkeypatch.setattr(activation, "prove", counted)
    return runs


async def set_tool_status(app: FastAPI, desk: DeskRows, tool: str, status: str) -> None:
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(desk.rows.copy_id)
        row = (await ctx.db.scalars(repo.scoped(select(Tool).where(Tool.desk_id == desk.desk_id,
                                                                     Tool.tool == tool)))).one()
        row.status = status


async def test_draft_is_idempotent(app, client, monkeypatch):
    desk = await desk_with_tools(app)
    runs = count_prover_runs(monkeypatch)
    use_prover(monkeypatch, "desk_prove_slow_ok.sh")
    first = await drafted(client, desk, BOOK_AND_ASK_CHARGES)
    assert (first.version, first.status) == (2, "proved")
    # the same cards on the same parent, in any order: the same version, proved once
    assert await drafted(client, desk, BOOK_AND_ASK_CHARGES[::-1]) == first
    assert len(runs) == 1 and [row.version for row in await versions(app, desk)] == [1, 2]

    # a draft that timed out proves again on the next post, in place
    verified_book = [card("book", "native.book", who="verified")]
    use_prover(monkeypatch, "desk_prove_exit2.sh")
    timed_out = await drafted(client, desk, verified_book)
    assert (timed_out.version, timed_out.status, timed_out.proof.timed_out) == (3, "rejected", True)
    assert all(c.counterexample_plain is None for c in timed_out.proof.checks)   # it found nothing to say
    use_prover(monkeypatch, "desk_prove_slow_ok.sh")
    # what was proved is what is stored, even when the compiler changed in between (a new kernel)
    compile_cards = compiler.compile_cards
    monkeypatch.setattr(compiler, "compile_cards", lambda *a, **k: dataclasses.replace(
        compile_cards(*a, **k), A=compile_cards(*a, **k).A + "\n"))
    retried = await drafted(client, desk, verified_book)
    assert (retried.version, retried.status, retried.proof.timed_out) == (3, "proved", False)
    [stored] = [row for row in await versions(app, desk) if row.version == 3]
    assert stored.cedar["A"].endswith("\n") and stored.cedar_sha256 == retried.cedar_sha256
    assert app.state.kernel.policies.cache.get(hashes_of(stored)) == retried.proof
    monkeypatch.setattr(compiler, "compile_cards", compile_cards)
    assert await drafted(client, desk, verified_book) == retried                 # and then it stays proved
    assert len(runs) == 3 and [row.version for row in await versions(app, desk)] == [1, 2, 3]

    # the same cards once a tool is disabled: a new version, proved against the profiles enabled now
    await set_tool_status(app, desk, "native.find_slots", "disabled")
    narrower = await drafted(client, desk, BOOK_AND_ASK_CHARGES)
    enabled = [profile for profile in NATIVE if profile.tool != "native.find_slots"]
    assert (narrower.version, narrower.parent_version, narrower.status) == (4, 1, "proved")
    assert narrower.profiles_sha256 == activation.profiles_sha256(enabled) != first.profiles_sha256
    assert "native.find_slots" not in {c.applies_to for c in narrower.cards}
    assert len(runs) == 4
    assert await policy_entries(app, desk) == [
        {"version": 1, "status": "active"}, {"version": 2, "status": "proved", "method": "symcc"},
        {"version": 3, "status": "rejected", "method": "symcc"}, {"version": 3, "status": "proved", "method": "symcc"},
        {"version": 4, "status": "proved", "method": "symcc"}]


async def test_draft_reposted_while_proving_returns_one_version(app, client, monkeypatch):
    """The API answers 202 once a proof passes 25 s and then posts the same draft again: the
    re-post waits for the running proof and gets its version, with no second run."""
    desk = await desk_with_tools(app)
    runs = count_prover_runs(monkeypatch)
    use_prover(monkeypatch, "desk_prove_slow_ok.sh", sleep=2)
    started = time.monotonic()
    first, second = await asyncio.gather(drafted(client, desk, BOOK_AND_ASK_CHARGES),
                                         drafted(client, desk, BOOK_AND_ASK_CHARGES))
    assert first == second and (first.version, first.status) == (2, "proved")
    assert len(runs) == 1 and time.monotonic() - started < 6
    assert [row.version for row in await versions(app, desk)] == [1, 2]
    assert await policy_entries(app, desk) == [{"version": 1, "status": "active"},
                                                {"version": 2, "status": "proved", "method": "symcc"}]


async def test_draft_needs_the_active_parent(app, client, monkeypatch):
    desk = await desk_with_tools(app)
    runs = count_prover_runs(monkeypatch)
    use_prover(monkeypatch, "desk_prove_slow_ok.sh")
    for parent in (None, 0, 2, 99):                                   # version 1 is the active one
        response = await post_draft(client, desk, BOOK_AND_ASK_CHARGES, expected_parent=parent)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"}), parent
    # another copy's owner can't draft on this Desk, nor tell it exists
    other = await desk_with_tools(app)
    response = await post_draft(client, desk, BOOK_AND_ASK_CHARGES, owner=other.rows.owner)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    response = await post_draft(client, desk, BOOK_AND_ASK_CHARGES, owner={"X-Owner-Session": "not-a-token"})
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert runs == [] and [row.version for row in await versions(app, desk)] == [1]
    # on the active parent it drafts
    assert (await drafted(client, desk, BOOK_AND_ASK_CHARGES, expected_parent=1)).version == 2


async def test_invalid_cards_are_422(app, client, monkeypatch):
    desk = await desk_with_tools(app)
    other = await desk_with_tools(app)
    runs = count_prover_runs(monkeypatch)
    use_prover(monkeypatch, "desk_prove_slow_ok.sh")
    invalid = {
        "two cards with one ID": [card("book", "native.book"), card("book", "native.quote")],
        "an ID the compiler keeps": [card("default:native.book", "native.book")],
        "a person the Desk doesn't know": [card("dana", "native.book", who="person", person_id="person-nobody")],
        "another Desk's person": [card("dana", "native.book", who="person", person_id=other.dana)],
        "an agent key the copy doesn't know": [card("agent", "native.book", who="agent", agent_key_id="key-nobody")],
        "an ID with Cedar in it": [card('book") permit', "native.book")],
    }
    for case, cards in invalid.items():
        response = await post_draft(client, desk, cards)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), case
    # a card the contract refuses never reaches the kernel's own checks
    unlimited = {**card("pay", "native.payment_link", mode="ask").model_dump(mode="json"), "mode": "auto"}
    response = await client.post("/policy/draft", headers=desk.rows.owner,
                                 json={"desk_id": desk.desk_id, "cards": [unlimited], "expected_parent": 1})
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert runs == [] and [row.version for row in await versions(app, desk)] == [1]
    # Dana, a person of this Desk, can have a card of her own
    assert (await drafted(client, desk, [card("dana", "native.book", who="person", person_id=desk.dana)])).version == 2


async def post_confirm(client: httpx.AsyncClient, desk: DeskRows, version: int) -> httpx.Response:
    return await client.post("/policy/confirm", headers=desk.rows.owner,
                             json={"desk_id": desk.desk_id, "version": version})


async def decides(app: FastAPI, desk: DeskRows, request: dict) -> str:
    """The outcome of `request` on the Desk's active version, loaded as deciding loads it."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(desk.rows.copy_id)
        row = await activation.active_version(ctx, desk.desk_id)
    assert app.state.loaded_versions.use(row) == []
    verdict = json.loads(app.state.engine.decide(f"{desk.desk_id}:{row.version}", json.dumps(request), "final"))
    assert verdict["errors"] == [], verdict
    return verdict["outcome"]


@pytest.mark.solver
async def test_confirm_activates_and_supersedes(desk_prove, app, client):
    desk = await desk_with_tools(app)
    assert await decides(app, desk, req("native.book")) == "hold"                # version 1 asks for bookings
    draft = await drafted(client, desk, BOOK_AND_ASK_CHARGES)
    response = await post_confirm(client, desk, draft.version)
    assert response.status_code == 200, response.text
    assert PolicyVersion.model_validate(response.json()) == draft.model_copy(update={"status": "active"})
    assert [(row.version, row.status) for row in await versions(app, desk)] == [(1, "superseded"), (2, "active")]
    assert (await policy_entries(app, desk))[-1] == {"version": 2, "activated": True, "from": 1}
    assert await decides(app, desk, req("native.book")) == "allow"               # version 2 books without asking
    # confirming it again changes nothing
    response = await post_confirm(client, desk, draft.version)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await policy_entries(app, desk))[-1] == {"version": 2, "refused": "not_proved"}
    # a version the Desk doesn't have isn't there to confirm
    response = await post_confirm(client, desk, 99)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})

    # the helper other tests use drafts on whatever is active and confirms
    third = await draft_and_confirm(client, desk.rows.owner_token, desk.desk_id, [card("book", "native.book")])
    assert (third.version, third.parent_version, third.status) == (3, 2, "active")
    assert [(row.version, row.status) for row in await versions(app, desk)] == [
        (1, "superseded"), (2, "superseded"), (3, "active")]


async def assert_still_active(app: FastAPI, desk: DeskRows, version: int) -> None:
    rows = await versions(app, desk)
    assert [row.version for row in rows if row.status == "active"] == [version], [(r.version, r.status) for r in rows]


@pytest.mark.solver
async def test_wider_set_is_rejected_and_cannot_be_confirmed(desk_prove, app, client, monkeypatch):
    desk = await desk_with_tools(app)
    # a compiler that drops a card's person condition, in a shape that still lints: anyone with a
    # person_id would book without asking, where the owner's card says only Dana
    who = compiler._who
    monkeypatch.setattr(compiler, "_who", lambda c: "principal has person_id" if c.who == "person" else who(c))
    cards = [card("dana-books", "native.book", who="person", person_id=desk.dana)]
    assert "principal.person_id ==" not in compiler.compile_cards(cards, NATIVE).A
    version = await drafted(client, desk, cards)
    assert (version.status, version.proof.ok, version.proof.method, version.proof.timed_out) == (
        "rejected", False, "symcc", False)
    failing = {c.name: c for c in version.proof.checks if not c.ok}
    wider = failing["auto_within_cards"]
    assert wider.counterexample_raw["action"] == "native.book"
    assert wider.counterexample_plain.endswith(" could book a visit without asking you."), wider.counterexample_plain
    assert not wider.counterexample_plain.startswith("Dana")                      # Dana may; whoever this is may not
    assert all(c.counterexample_plain for c in failing.values())
    assert (await policy_entries(app, desk))[-1] == {"version": 2, "status": "rejected", "method": "symcc"}
    response = await post_confirm(client, desk, version.version)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await policy_entries(app, desk))[-1] == {"version": 2, "refused": "not_proved"}
    await assert_still_active(app, desk, 1)


def or_the_review_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """A compiler that ORs an auto card's review gate with the rest of its conditions instead of
    ANDing it: a high enough score lets anyone through, whoever the card is for."""
    policy = compiler._policy

    def or_gated(policy_id, cards, tier, scope, conditions):
        whens = [body for kind, body in conditions if kind == "when" and body != "true"]
        if tier == "auto" and len(whens) == 2:
            conditions = [("when", f"({whens[0]}) || ({whens[1]})"), *[(k, b) for k, b in conditions if k != "when"]]
        return policy(policy_id, cards, tier, scope, conditions)

    monkeypatch.setattr(compiler, "_policy", or_gated)


@pytest.mark.solver
async def test_or_gate_past_a_broken_lint_is_rejected_by_proof(desk_prove, app, client, monkeypatch):
    desk = await desk_with_tools(app)
    cards = [card("verified-books", "native.book", who="verified", review=True)]
    or_the_review_gate(monkeypatch)
    compiled = compiler.compile_cards(cards, NATIVE)
    assert ") || (context has review" in compiled.A
    assert desk_kernel.lint_policies(json.dumps(compiled.sets()))              # the lint refuses this shape,
    linted = await drafted(client, desk, [card("verified-books-too", "native.book", who="verified", review=True)])
    assert (linted.version, linted.status, linted.proof.method) == (2, "rejected", "symcc")
    assert [(c.name, c.ok, c.counterexample_plain) for c in linted.proof.checks] == [
        ("lint", False, "Your rules couldn't be checked, so nothing changed.")]
    assert app.state.kernel.policies.cache.get(hashes_of((await versions(app, desk))[1])) is None
    monkeypatch.setattr(activation, "load_draft", lambda *args, **kwargs: [])  # so take the lint away
    version = await drafted(client, desk, cards)
    assert version.version == 3
    assert (version.status, version.proof.method, version.proof.timed_out) == ("rejected", "symcc", False)
    failing = {c.name: c for c in version.proof.checks if not c.ok}
    narrows = failing["review_only_narrows"]
    assert narrows.counterexample_raw["action"] == "native.book" and "review" in narrows.counterexample_raw["context"]
    assert narrows.counterexample_plain.endswith(
        " could book a visit without asking you, just because the reviewer's scores were high."), narrows
    response = await post_confirm(client, desk, version.version)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await policy_entries(app, desk))[-1] == {"version": 3, "refused": "not_proved"}
    await assert_still_active(app, desk, 1)


@pytest.mark.solver
async def test_confirm_refuses_a_draft_whose_never_card_was_dropped(desk_prove, app, client, monkeypatch):
    desk = await desk_with_tools(app)
    cards = [card("no-changes", "effect:change", mode="never"), card("book", "native.book")]
    # a compiler that emits no forbid for the never card: the booking it should stop is auto-allowed
    compile_cards = compiler.compile_cards
    monkeypatch.setattr(compiler, "compile_cards", lambda *a, **k: dataclasses.replace(compile_cards(*a, **k), F=""))
    version = await drafted(client, desk, cards)
    assert (version.status, version.proof.method) == ("rejected", "symcc")
    failing = {c.name: c for c in version.proof.checks if not c.ok}
    assert {"auto_within_cards", "hold_within_cards"} <= set(failing), version.proof
    assert failing["auto_within_cards"].counterexample_plain.endswith(" could book a visit without asking you.")
    assert failing["hold_within_cards"].counterexample_plain.endswith(
        " could book a visit with your approval, even though your rules say never.")
    response = await post_confirm(client, desk, version.version)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await policy_entries(app, desk))[-1] == {"version": 2, "refused": "not_proved"}
    await assert_still_active(app, desk, 1)


async def change_schema(monkeypatch: pytest.MonkeyPatch, app: FastAPI, desk: DeskRows) -> None:
    desk_schema = compiler.desk_schema
    monkeypatch.setattr(compiler, "desk_schema",
                        lambda profiles: {**desk_schema(profiles), "Other": {"entityTypes": {}, "actions": {}}})


async def change_baseline(monkeypatch: pytest.MonkeyPatch, app: FastAPI, desk: DeskRows) -> None:
    monkeypatch.setattr(compiler, "_BASELINE_BYTES", compiler._BASELINE_BYTES + b"\n// another baseline\n")


async def change_invariants(monkeypatch: pytest.MonkeyPatch, app: FastAPI, desk: DeskRows) -> None:
    changed = {kind: dict(files) for kind, files in compiler._INVARIANT_BYTES.items()}
    name = next(iter(changed["auto"]))
    changed["auto"][name] += b"\n// another invariant\n"
    monkeypatch.setattr(compiler, "_INVARIANT_BYTES", changed)


async def disable_a_tool(monkeypatch: pytest.MonkeyPatch, app: FastAPI, desk: DeskRows) -> None:
    await set_tool_status(app, desk, "native.find_slots", "disabled")


CHANGES = {"schema": change_schema, "baseline": change_baseline, "invariants": change_invariants,
           "profiles": disable_a_tool}


@pytest.mark.parametrize("case", ["rejected draft", "sibling confirmed first", *CHANGES])
async def test_confirm_conflicts(case, app, client, monkeypatch):
    desk = await desk_with_tools(app)
    use_prover(monkeypatch, "desk_prove_exit2.sh" if case == "rejected draft" else "desk_prove_slow_ok.sh")
    version = await drafted(client, desk, BOOK_AND_ASK_CHARGES)
    active, refused = 1, "hash_changed"
    if case == "rejected draft":
        assert version.status == "rejected"
        refused = "not_proved"
    elif case == "sibling confirmed first":
        sibling = await drafted(client, desk, [card("book", "native.book", who="verified")])
        assert (await post_confirm(client, desk, sibling.version)).status_code == 200
        active, refused = sibling.version, "parent_changed"
    else:
        assert version.status == "proved"
        await CHANGES[case](monkeypatch, app, desk)
    response = await post_confirm(client, desk, version.version)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await policy_entries(app, desk))[-1] == {"version": version.version, "refused": refused}
    await assert_still_active(app, desk, active)
    [row] = [row for row in await versions(app, desk) if row.version == version.version]
    assert row.status == version.status                                          # the draft is left as it was


async def test_bounded_mode_never_activates_owner_drafts(app, client, monkeypatch):
    """Without a working desk-prove the kernel runs `bounded`: a draft is checked on generated
    cases, which tells the owner what a proof would most likely find, but it never activates."""
    desk = await desk_with_tools(app)
    runs = count_prover_runs(monkeypatch)
    assert activation.proof_mode() == "bounded"
    version = await drafted(client, desk, BOOK_AND_ASK_CHARGES)
    proof = version.proof
    assert (version.version, version.status, proof.method, proof.ok) == (2, "draft", "bounded", True)
    assert proof.cases > 0 and runs == []
    assert await policy_entries(app, desk) == [{"version": 1, "status": "active"},
                                                {"version": 2, "status": "draft", "method": "bounded"}]
    response = await post_confirm(client, desk, version.version)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await policy_entries(app, desk))[-1] == {"version": 2, "refused": "not_proved"}
    await assert_still_active(app, desk, 1)
    # a row marked proved by mistake still holds only a bounded report, so it doesn't activate either
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(desk.rows.copy_id)
        row = (await ctx.db.scalars(repo.scoped(select(PolicyVersionRow).where(
            PolicyVersionRow.desk_id == desk.desk_id, PolicyVersionRow.version == 2)))).one()
        row.status = "proved"
    assert (await post_confirm(client, desk, 2)).status_code == 409
    await assert_still_active(app, desk, 1)

    # a bounded check the draft fails is a rejection, in the owner's words, and still never activates
    who = compiler._who
    monkeypatch.setattr(compiler, "_who", lambda c: "principal has person_id" if c.who == "person" else who(c))
    wider = await drafted(client, desk, [card("dana-books", "native.book", who="person", person_id=desk.dana)])
    assert (wider.version, wider.status, wider.proof.method, wider.proof.ok) == (3, "rejected", "bounded", False)
    failing = {c.name: c for c in wider.proof.checks if not c.ok}
    assert failing["auto_within_cards"].counterexample_plain.endswith(" could book a visit without asking you.")
    monkeypatch.setattr(compiler, "_who", who)

    # posted again once desk-prove can run, a checked draft is proved in place
    use_prover(monkeypatch, "desk_prove_slow_ok.sh")
    reproved = await drafted(client, desk, [card("dana-books", "native.book", who="person", person_id=desk.dana)])
    assert (reproved.version, reproved.status, reproved.proof.method) == (3, "proved", "symcc") and len(runs) == 1
