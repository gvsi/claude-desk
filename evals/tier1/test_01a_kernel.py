"""Plan 01a's own tier 1 cases: the kernel core's boundary rows the shared suites leave out.

The shared suites hold most of the kernel core's rows: sessions and forged credentials, the golden
`/decide` and reply tables, approvals, restart races and ledger verification. These cases add the
rest Plan 01a's merge gate names (its Task 18): `/whoami` with a bad token; the seeded held quote,
signed and ledgered; seeds that activate only from cached proofs, in either proof mode; owner drafts
proved before confirm, and a rule set wider than its cards rejected in plain words; the public Desk
with no private field; a document's canary in a reply; hostile tool names and fact ids, each still
ledgered; and an owner take-over between an execution's intent and its side effect. Two more come
from the PR review: a first reply with no marker of any language gets one checked rewrite.
Positive evidence of another language still hands off at once, including French or German whose
only English markers are words that language writes too.

Three cases run kernel code in-process (`white_box`): one breaks the compiler to see the proof
catch it, one hides the shipped proof reports or the prover and restarts the kernel, and one takes
the session over from inside an execution. The stub skips them.
"""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from desk.contracts import LedgerEntry, RuleCard
from evals.oracles import card_amounts, find_markers, scan_visible, verify_decision_sig
from evals.tier1.args import quote_args
from evals.tier1.golden_desk import (
    GoldenDesk,
    P,
    active_version,
    decide,
    desk_of,
    draft_cards,
    golden_desk,
    open_caller,
    session_row,
)
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.targets import CALL_TIMEOUT_S, KernelTarget, restart_kernel
from evals.tier1.test_approvals import ALLOWED, CONFLICT, execute, quotes_of, read, verified_ledger
from evals.tier1.test_labels_and_injection import LANGUAGES, block_text, dumped, private_values, public_desk, shown_of
from evals.tier1.test_reply_golden import (
    CLEAN_EN,
    HANDED_OFF,
    OFFER,
    OFFERED,
    STAND_IN_CANARY,
    check_reply,
    handed_off,
    ledger_head,
    ledgered_since,
    shown_blocks,
    signing_key,
)
from evals.tier1.test_sessions import NOT_FOUND, UNAUTHENTICATED, assert_ledgered, ledgered_during, session_token

SEEDED_CALL_ID = "seed-held-quote"   # the call id of the request a new copy holds for its owner (Plan 01a Task 12)
SEEDED_DISCOUNT_BP = 1_500           # it asks for the drain clearing at 15% off, which the seed's cards hold
STAND_IN_SEEDED = "stub-decision-seeded-hold"
UNPROVED = Expect(status=503, fields={"code": "seed_unproved"})
NO_PROVER = "/nonexistent/desk-prove"   # where no prover is: the startup selftest fails, so the kernel runs bounded
UNMARKED_PROSE = "O técnico chega às dez, combinado?"   # no marker of any language, and a time in its own words
# One marker of its own beside an English marker the language writes too ("on", "am"), and a time
# or a day in its own words
SHARED_MARKER_PROSE = ["On vient à dix heures.", "Ich komme am Montag."]
PROOF_HASHES = ("cedar_sha256", "schema_sha256", "baseline_sha256", "profiles_sha256", "invariants_sha256",
                "review_thresholds_version")

# Untrusted names a call or a reply may carry, none of them a plain identifier: each must still be
# decided or checked, and ledgered, with nothing of it written verbatim on the ledger.
HOSTILE = {
    "an email address": "dana@example.com",
    "a name of two hundred letters": "native." + "x" * 200,
    "SQL that sets the copy": "native.quote'); SELECT set_config('desk.copy_id', 'copy-x', true); --",
    "a NUL character": "native.\x00quote",
    "a right-to-left override": "native.\u202equote",
    "a line break and a forged entry": 'native.quote\n{"kind": "approval", "origin": "kernel"}',
}


# Steps a case takes

def entry_at(entries: list[LedgerEntry], seq: int) -> LedgerEntry:
    found = [entry for entry in entries if entry.seq == seq]
    assert len(found) == 1, f"the ledger has {len(found)} entries at seq {seq}"
    return found[0]


def names(entry: LedgerEntry, value: str) -> bool:
    """Whether a ledger entry names `value`, by its ref or anywhere in its event."""
    return value in json.dumps(entry.event.model_dump(mode="json"))


def verbatim_on(entries: list[LedgerEntry], values: dict[str, str]) -> list[str]:
    """The labels of the values some entry holds as written, read from its keys and values as they
    are (a NUL or a line break unescaped); a failure names labels, never values."""
    texts = [dumped(entry) for entry in entries]
    return [label for label, value in values.items() if any(value in text for text in texts)]


async def seeded_hold_id(k: KernelHarness, records: Any, desk: GoldenDesk) -> str:
    """The id of the request a new copy holds for its owner (`kernel_ro.decisions`); on the stub, a stand-in."""
    if not k.is_real:
        return STAND_IN_SEEDED
    held = [row for row in await records.decisions(desk.copy.copy_id)
            if row["desk_id"] == desk.desk_id and row["state"] == "held"]
    assert len(held) == 1, f"a new copy holds {len(held)} requests for its owner, not one"
    return held[0]["decision_id"]


async def policy_rows(records: Any, desk: GoldenDesk) -> dict[int, dict[str, Any]]:
    """The Desk's policy versions by number (`kernel_ro.policy_versions`; real kernel only)."""
    return {row["version"]: row for row in await records.policy_versions(desk.copy.copy_id)
            if row["desk_id"] == desk.desk_id}


# Credentials

@pytest.mark.requires("01a")
async def test_whoami_with_a_bad_token_is_401(k: KernelHarness, records):
    """`GET /whoami` finds its session by the token alone. No token, an empty one, a guess, the
    owner's token sent as a session's, a session's sent as the owner's, or both at once is 401
    `auth`; the session's own token still finds it. None of these names a session, so on the real
    kernel nothing goes on the Desk's ledger, and nothing there holds a token."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    token, owner_token = session_token(visitor), desk.copy.owner_token
    guess = token[:-1] + ("B" if token.endswith("A") else "A")
    bad = (
        Auth.none(), Auth.raw({"X-Session-Token": ""}), Auth.raw({"X-Session-Token": guess}),
        Auth.raw({"X-Session-Token": owner_token}), Auth.raw({"X-Owner-Session": token}),
        Auth.raw({"X-Session-Token": token, "X-Owner-Session": owner_token}),
    )
    async with ledgered_during(records, desk.copy, desk.desk_id) as new:
        for auth in bad:
            await k.call("GET /whoami", auth=auth, expect=UNAUTHENTICATED)
    if k.is_real:
        assert new == [], f"refusals naming no session went on the Desk's ledger: {[e.event.kind for e in new]}"
        assert not verbatim_on(await records.ledger_entries(desk.copy.copy_id, desk.desk_id),
                               {"the session token": token, "the owner token": owner_token, "the guess": guess})
    await k.call("GET /whoami", auth=visitor.auth, expect=Expect(fields={
        "kind": "visitor", "copy_id": desk.copy.copy_id, "session.session_id": visitor.state.session_id}))


# The seeded held quote

@pytest.mark.requires("01a")
async def test_the_seeded_held_quote_is_signed_and_ledgered(k: KernelHarness, records):
    """A new copy holds one request for its owner's Today: a visitor's drain clearing at 15% off,
    priced from the price list, which the seed's cards hold. The owner reads it held, offered
    `allow_once`; its signature verifies with `/health`'s key; the `decide` entry at its
    `ledger_seq` names it; what the visitor would read of it carries no amount or date; and the
    Desk's ledger verifies with the evals' own check."""
    desk = await golden_desk(k)
    decision_id = await seeded_hold_id(k, records, desk)
    seeded = await k.call("GET /decisions/{id}", path={"id": decision_id}, auth=desk.owner, expect=Expect(fields={
        "decision_id": decision_id, "call_id": SEEDED_CALL_ID, "outcome": "hold", "state": "held",
        "answers": {"$has": "allow_once"}, "action.tool": "native.quote", "action.list_cents": P,
        "action.discount_bp": SEEDED_DISCOUNT_BP, "action.amount_cents": P - P * SEEDED_DISCOUNT_BP // 10_000,
    }))
    page = await verified_ledger(k, desk)
    if k.is_real:
        assert verify_decision_sig(seeded.session_id, seeded, await signing_key(k)), "the seeded hold's signature"
        entry = entry_at(page.entries, seeded.ledger_seq)
        assert entry.event.kind == "decide" and names(entry, decision_id), (
            f"the seeded hold points at ledger entry {seeded.ledger_seq}, a {entry.event.kind} entry not naming it")
        assert entry.event.session_id == seeded.session_id, "the seeded hold's entry names another session"
        hits = [(hit.kind, hit.span) for hit in scan_visible(seeded.visitor_plain)]
        assert hits == [], f"the seeded hold's visitor text carries amounts or dates: {hits}"


# Proofs and activation

@pytest.mark.requires("01a")
async def test_seeded_copies_share_one_proof_and_stale_drafts_never_confirm(k: KernelHarness, records):
    """Two copies of the seed activate the same compiled rules on the same cached SymCC proof:
    their version 1 rows match hash for hash and report for report. An owner draft is proved
    before it can be confirmed, and two drafts made on version 1 can't both go live: confirming
    the second once the first is active is 409 `conflict`, and the first stays active."""
    a = await golden_desk(k)
    b = await desk_of(k, await k.new_copy())
    if k.is_real:
        [a_seed], [b_seed] = [[row for row in (await policy_rows(records, desk)).values() if row["status"] == "active"]
                              for desk in (a, b)]
        assert (a_seed["version"], b_seed["version"]) == (1, 1), (a_seed["version"], b_seed["version"])
        assert [a_seed[field] for field in PROOF_HASHES] == [b_seed[field] for field in PROOF_HASHES], (
            "two copies of the seed compiled to different hashes")
        assert a_seed["proof"] == b_seed["proof"], "two copies of the seed activated on different proofs"
        proof = a_seed["proof"]
        assert proof["method"] == "symcc" and proof["ok"] and all(check["ok"] for check in proof["checks"]), proof
    find_slots = RuleCard(card_id="t18-auto-find-slots", applies_to="native.find_slots", mode="auto", who="anyone",
                          reason="Anyone can see open times.")
    ask_quote = RuleCard(card_id="t18-ask-quote", applies_to="native.quote", mode="ask", who="anyone",
                         reason="Mike checks every quote.")
    first = await draft_cards(k, a, [find_slots])
    second = await draft_cards(k, a, [find_slots, ask_quote])
    await k.call("POST /policy/confirm", body={"desk_id": a.desk_id, "version": first.version}, auth=a.owner,
                 expect=Expect(fields={"version": first.version, "status": "active"}))
    await k.call("POST /policy/confirm", body={"desk_id": a.desk_id, "version": second.version}, auth=a.owner,
                 expect=CONFLICT)
    assert await active_version(k, a) == (first.version if k.is_real else 1)


@pytest.mark.requires("01a")
@pytest.mark.white_box
async def test_a_rule_set_wider_than_its_cards_is_rejected_and_never_confirmed(k: KernelHarness, records):
    """With a compiler broken to drop a person card's person condition, the owner's card "Dana
    books without asking" compiles to rules that let anyone book: the draft is rejected by proof,
    its failing obligation says in plain words who could do what without asking, confirming it is
    409 `conflict`, and the seed's version 1 stays active."""
    desk = await golden_desk(k)
    dana_books = RuleCard(card_id="t18-dana-books", applies_to="native.book", mode="auto", who="person",
                          person_id=desk.people["dana"], reason="Dana books without asking.")
    from desk.kernel_service import compiler   # Plan 01a: the fault the proof must catch

    who = compiler._who
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(compiler, "_who", lambda card: "principal has person_id" if card.who == "person" else who(card))
        rejected = await k.call(
            "POST /policy/draft",
            body={"desk_id": desk.desk_id, "cards": [dana_books.model_dump(mode="json")],
                  "expected_parent": await active_version(k, desk)},
            auth=desk.owner,
            expect=Expect(fields={"status": "rejected", "proof.ok": False, "proof.method": "symcc"}),
        )
    failing = {check.name: check.counterexample_plain or "" for check in rejected.proof.checks if not check.ok}
    assert "auto_within_cards" in failing, sorted(failing)
    assert all(plain and "{" not in plain for plain in failing.values()), failing   # words, not a raw request
    assert failing["auto_within_cards"].endswith("could book a visit without asking you."), failing
    await k.call("POST /policy/confirm", body={"desk_id": desk.desk_id, "version": rejected.version}, auth=desk.owner,
                 expect=CONFLICT)
    assert await active_version(k, desk) == 1
    assert (await policy_rows(records, desk))[rejected.version]["status"] == "rejected"


@pytest.mark.requires("01a")
@pytest.mark.white_box
async def test_seeds_activate_only_from_cached_proofs_in_either_mode(k: KernelHarness, tmp_path: Path):
    """The seed activates only from a shipped proof report, never proved inline. With no report
    to read, a new copy is 503 `seed_unproved` and `/health` lists the seed, whether the startup
    selftest passed (`symcc`) or failed (`bounded`). With the reports back and no prover, the
    cached seed still activates in `bounded` mode, while an owner draft is only checked ("checked
    on N cases") and can't be confirmed (409 `conflict`)."""
    assert isinstance(k, KernelTarget)
    from desk.kernel_service import activation   # Plan 01a: where the kernel reads the shipped reports

    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(activation, "PROOFS_DIR", tmp_path)   # an empty directory: no report
            for mode, prover in (("symcc", None), ("bounded", NO_PROVER)):
                if prover is not None:
                    patch.setenv("DESK_PROVE", prover)
                await restart_kernel(k)
                await k.call("GET /health", auth=Auth.none(), expect=Expect(fields={"proof_mode": mode}))
                await k.call("POST /copies", body={}, auth=Auth.none(), expect=UNPROVED)
                await k.call("GET /health", auth=Auth.none(), expect=Expect(fields={
                    "proof_mode": mode, "unproved_seeds": ["rivera"]}))
            patch.undo()
            patch.setenv("DESK_PROVE", NO_PROVER)
            await restart_kernel(k)
            await k.call("GET /health", auth=Auth.none(), expect=Expect(fields={"proof_mode": "bounded",
                                                                               "unproved_seeds": []}))
            desk = await golden_desk(k)   # the cached seed activates in bounded mode
            assert await active_version(k, desk) == 1
            checked = await k.call(
                "POST /policy/draft",
                body={"desk_id": desk.desk_id, "expected_parent": 1, "cards": [RuleCard(
                    card_id="t18-auto-find-slots", applies_to="native.find_slots", mode="auto", who="anyone",
                    reason="Anyone can see open times.").model_dump(mode="json")]},
                auth=desk.owner, expect=Expect(fields={"status": "draft", "proof.method": "bounded"}),
            )
            assert (checked.proof.cases or 0) > 0, f"a bounded check ran on {checked.proof.cases} cases"
            await k.call("POST /policy/confirm", body={"desk_id": desk.desk_id, "version": checked.version},
                         auth=desk.owner, expect=CONFLICT)
            assert await active_version(k, desk) == 1
    finally:
        await restart_kernel(k)   # the reports and the prover back, as the target started, even after a failure
    await k.call("GET /health", auth=Auth.none(), expect=Expect(fields={"proof_mode": "symcc"}))


# The public Desk

@pytest.mark.requires("01a")
async def test_the_public_desk_shows_no_private_field(k: KernelHarness, records):
    """The public Desk, read with no credential in English and Spanish, shows the business, its
    owner's name and its public charter, and nothing private: no person's name, contact or notes,
    no document's title or id, no owner token or session, no amount from the price list or
    anywhere else, and no copy, Desk or session id. An unknown slug is 404."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    pages = {lang: await public_desk(k, desk.slug, lang) for lang in LANGUAGES}
    await k.call("GET /public/{desk_slug}", path={"desk_slug": "turner-plumbing-nosuch"}, query={"lang": "en"},
                 auth=Auth.none(), expect=NOT_FOUND)
    if k.is_real:
        texts, ids = await private_values(records, desk)
        ids.update({"the copy id": desk.copy.copy_id, "the Desk id": desk.desk_id,
                    "the visitor's session id": visitor.state.session_id,
                    "the visitor's token": session_token(visitor)})
        for lang, page in pages.items():
            assert (page.business_name, page.owner_display_name) == ("Turner Plumbing", "Mike Turner"), lang
            assert page.charter, f"the {lang} public page shows no charter"
            shown = shown_of(page, texts, ids)
            assert shown == [], f"the {lang} public page shows {shown}"
            amounts = [(block.template, card_amounts(block_text(block))) for block in page.charter]
            assert all(not found for _, found in amounts), f"the {lang} public page shows amounts: {amounts}"


# Replies

@pytest.mark.requires("01a")
async def test_a_documents_canary_in_a_reply_is_blocked(k: KernelHarness, records):
    """A draft quoting the canary the kernel planted in Dana's invoice is a `canary` violation: only
    the handoff is shown, the verdict doesn't echo the canary, and no ledger entry holds it."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    if k.is_real:
        canary = await records.document_canary(desk.copy.copy_id, desk.documents["dana-invoice"])
        since = await ledger_head(records, desk)
    else:
        canary = STAND_IN_CANARY
    verdict = await check_reply(k, visitor, f"Your invoice reference is {canary}.", expect=Expect(fields={
        "ok": False, "generation": visitor.state.generation, **shown_blocks(HANDED_OFF)}))
    if k.is_real:
        kinds = {violation.kind for violation in verdict.violations}
        assert "canary" in kinds, f"a draft quoting a document's canary is blocked for {sorted(kinds)}"
        assert find_markers(dumped(verdict), [canary]) == [], "the verdict echoes the canary"
        echoed = [entry.seq for entry in await ledgered_since(records, desk, since)
                  if find_markers(dumped(entry), [canary])]
        assert echoed == [], f"ledger entries {echoed} hold the canary"


@pytest.mark.requires("01a")
@pytest.mark.parametrize("final", [True, False], ids=["final", "rewrite"])
async def test_an_unmarked_first_reply_gets_one_rewrite(k: KernelHarness, records, final: bool):
    """Unmarked prose never shows; the first check rewrites and the final one asks with the call-back offer,
    which the golden Desk has, so no owner handoff opens (the owner's decision of 2026-11-01)."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    verdict = await check_reply(k, visitor, UNMARKED_PROSE, final=final, expect=Expect(fields={
        "ok": False, "violations": {"$len": 1}, "violations.0.kind": "uncertain_language",
        "violations.0.rule_id": "language_uncertain", "language": "en",
        **shown_blocks(OFFERED if final else []), **({"blocks.0.text": OFFER["en"]} if final else {})}))
    if k.is_real:
        events = [entry.event for entry in await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
                  if entry.event.session_id == visitor.state.session_id]
        hands = [e for e in events if e.kind == "desk_data" and e.summary.get("part") == "handoffs"]
        assert hands == []
        assert [(block.kind, block.text) for block in verdict.blocks] == ([("prose", OFFER["en"])] if final else [])


@pytest.mark.requires("01a")
@pytest.mark.parametrize("prose", SHARED_MARKER_PROSE)
async def test_a_first_reply_with_english_markers_its_language_writes_hands_off(k: KernelHarness, prose: str):
    """English markers that French, German or Italian write as their own words ("on", "am") don't
    count against that language, so a session's first reply with one marker of its own beside one
    of them is another language: `unsupported_language` alone and only the handoff, in English, so
    a time or a day in words neither lexicon reads ("dix heures", "Montag") never rests on the
    model check alone."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    await check_reply(k, visitor, prose, expect=Expect(fields={
        **handed_off(visitor, "unsupported_language").fields, "violations": {"$len": 1}, "language": "en"}))


# Hostile names, still ledgered

@pytest.mark.requires("01a")
async def test_hostile_tool_names_are_refused_and_ledgered(k: KernelHarness, records):
    """A tool name no adapter has, however it is written, is refused before it is normalized
    (`action` null) and the turn can go on. Each refusal is a `decide` entry at the decision's
    `ledger_seq` naming it, on a ledger that still verifies, and no entry holds the name verbatim."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    refused = {label: await decide(k, visitor, name, {"to": "acct-9"}, expect=Expect(fields={
        "outcome": "refuse", "state": "refused", "action": None, "session_id": visitor.state.session_id}))
        for label, name in HOSTILE.items()}
    page = await verified_ledger(k, desk)
    if k.is_real:
        for label, decision in refused.items():
            entry = entry_at(page.entries, decision.ledger_seq)
            assert entry.event.kind == "decide" and names(entry, decision.decision_id), (
                f"the refusal of {label} points at ledger entry {decision.ledger_seq}, which doesn't name it")
        assert not (found := verbatim_on(page.entries, HOSTILE)), f"the ledger holds {found} verbatim"


@pytest.mark.requires("01a")
async def test_hostile_fact_ids_are_handed_off_and_ledgered(k: KernelHarness, records):
    """A reply citing a fact id no fact has, however it is written, is an `unknown_fact` violation
    and shows only the handoff. Each verdict points at a `reply` entry naming its message, on a
    ledger that still verifies, and no entry holds the fact id verbatim."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    fact_ids = {label: name.replace("native.", "quote:", 1) for label, name in HOSTILE.items()}
    verdicts = {label: await check_reply(k, visitor, CLEAN_EN, [{"template": "quote", "fact_id": fact_id}],
                                         expect=handed_off(visitor, "unknown_fact"))
                for label, fact_id in fact_ids.items()}
    page = await verified_ledger(k, desk)
    if k.is_real:
        for label, verdict in verdicts.items():
            entry = entry_at(page.entries, verdict.ledger_seq)
            assert entry.event.kind == "reply" and names(entry, verdict.message_id), (
                f"the verdict on {label} points at ledger entry {verdict.ledger_seq}, which doesn't name it")
        assert not (found := verbatim_on(page.entries, fact_ids)), f"the ledger holds {found} verbatim"


# A take-over between an execution's intent and its side effect

@pytest.mark.requires("01a")
@pytest.mark.white_box
async def test_a_take_over_after_the_intent_stops_the_allow(k: KernelHarness, records):
    """The owner takes the session over just after an allowed quote's intent row commits and
    before the quote runs: the execution is 409 `stale_generation`, ledgered as `auth` on the
    session, nothing runs, the allow reads `expired`, and the session stays the owner's."""
    assert isinstance(k, KernelTarget)
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    session_id = visitor.state.session_id
    allowed = await decide(k, visitor, "native.quote", quote_args("drain"), expect=ALLOWED)   # at list price
    taken: list[int] = []

    async def take_over() -> None:
        """Runs inside the kernel, between the intent's commit and the side effect: the owner's
        take-over, sent to the kernel over HTTP as the API would send it."""
        async with httpx.AsyncClient(base_url=k.url, timeout=CALL_TIMEOUT_S, trust_env=False) as client:
            response = await client.post(f"/sessions/{session_id}/mode", headers=desk.owner.headers(),
                                         json={"mode": "owner", "generation": visitor.state.generation})
        taken.append(response.status_code)

    from desk.kernel_service import execute as kernel_execute   # Plan 01a's hook between T1 and T2

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(kernel_execute, "_after_intent", take_over)
        async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=session_id):
            await execute(k, visitor, allowed, expect=Expect(status=409, fields={"code": "stale_generation"}))
    assert taken == [200], f"the take-over inside the execution answered {taken}"
    await read(k, desk.owner, allowed, "expired")
    assert await quotes_of(records, desk, visitor) == [], "an allow ran after the owner took the session over"
    row = await session_row(records, desk, visitor)
    assert (row["mode"], row["generation"]) == ("owner", visitor.state.generation + 1), (row["mode"], row["generation"])
