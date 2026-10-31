"""The kernel contract the API relies on, checked against FakeKernel and the real kernel.

Each test runs twice through the API's own typed client: `fake` always, `real` when `DESK_KERNEL_URL`
names a running kernel and `DESK_KERNEL_PLANS` lists the plan in its `kernel_plan` marker (`make
kernel-contract` sets both for the plans in `evals/tier1/landed.toml`). Arguments come from the kernel's
read-only views, never from the fake's internals, so both variants take the same path.
"""

import hashlib
import json
import re
import secrets
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest

from desk.api.kernel_client import CredentialView, KernelFailed, KernelHttp
from desk.api.owner_reads import refusal_cause
from desk.api.ro import KernelRO
from desk.contracts import (
    AgentAuth,
    ApprovalResult,
    BusinessSeed,
    CalendarSlot,
    Claim,
    Clause,
    CopyCreated,
    Decision,
    DemoAgentIssued,
    DemoInboxEntry,
    DeskSeed,
    ExecResult,
    HoursWindow,
    KnowledgeItem,
    Label,
    LedgerEvent,
    LedgerPage,
    NotificationDefaults,
    OwnerMessageResult,
    PolicyVersion,
    PriceItem,
    Probe,
    ProbeResult,
    ReplyDraft,
    ReplyVerdict,
    RuleCard,
    SeedDocument,
    SessionCreated,
    SessionState,
    ToolCall,
    ToolProfile,
)
from desk.kernel_api import (
    KERNEL_ROUTES,
    AnswerRequest,
    CancelRequest,
    CheckReplyRequest,
    CreateCopyRequest,
    CreateDeskRequest,
    CreateSessionRequest,
    DecideRequest,
    DemoAgentRequest,
    DeskAnsweringRequest,
    DeskBusinessRequest,
    DeskCalendarRequest,
    DeskCharterRequest,
    DeskCreated,
    DeskHoursRequest,
    DeskNotificationsRequest,
    DeskPeopleRequest,
    DeskPricesRequest,
    DeskUpdated,
    DocumentCreated,
    DocumentUploadRequest,
    ExecuteRequest,
    Health,
    KernelError,
    KnowledgeRequest,
    LedgerAppendRequest,
    ModeRequest,
    OwnerMessageRequest,
    PaymentLinkActionRequest,
    PersonUpsert,
    PolicyConfirmRequest,
    PolicyDraftRequest,
    PolicyProbeRequest,
    PublicDesk,
    SessionContext,
    ToolsConnectRequest,
    ToolsSimulateChangeRequest,
    TurnRequest,
    TurnStarted,
    VerifyCheckRequest,
    VerifyStarted,
    VerifyStartRequest,
    WhoAmI,
)
from desk.money_cap import lower_to_cap
from tests.kernel_contract import ro_tables
from tests.kernel_contract.fake_kernel import (
    FAKE_ROUTES,
    RecordedSession,
    RecordedStep,
    agent_signature,
    fake_kernel_app,
    fake_signature,
    signed_time,
)


async def new_copy(http: KernelHttp) -> CopyCreated:
    return await http.public().call("POST /copies", CreateCopyRequest())


def desk_slug(ro_read, ro_schema: str, copy: CopyCreated) -> str:
    rows = ro_read(ro_schema, copy.copy_id, "SELECT slug FROM {ro}.desks WHERE desk_id = %s", (copy.desk_ids[0],))
    return rows[0]["slug"]


async def new_visitor(http: KernelHttp, slug: str) -> SessionCreated:
    return await http.public().call("POST /sessions", CreateSessionRequest(desk_slug=slug, kind="visitor"))


def item_id(ro_read, ro_schema: str, copy: CopyCreated, title: str) -> str:
    rows = ro_read(ro_schema, copy.copy_id, "SELECT item_id FROM {ro}.price_items WHERE desk_id = %s AND title = %s",
                   (copy.desk_ids[0], title))
    return rows[0]["item_id"]


async def decide(view: CredentialView, session_id: str, generation: int, call_id: str, tool: str,
                 args: dict) -> Decision:
    call = ToolCall(call_id=call_id, tool=tool, args=args)
    return await view.call("POST /decide", DecideRequest(session_id=session_id, generation=generation, call=call))


async def execute(view: CredentialView, decision: Decision, generation: int) -> ExecResult:
    request = ExecuteRequest(decision_id=decision.decision_id, session_id=decision.session_id, generation=generation)
    return await view.call("POST /execute", request)


async def read_decision(view: CredentialView, decision_id: str) -> Decision:
    return await view.call("GET /decisions/{id}", path={"id": decision_id})


async def answer(owner: CredentialView, decision_id: str, choice: str) -> ApprovalResult:
    return await owner.call("POST /approvals/{decision_id}/answer", AnswerRequest(answer=choice),
                            path={"decision_id": decision_id})


async def check_reply(view: CredentialView, session_id: str, generation: int, prose: str) -> ReplyVerdict:
    draft = ReplyDraft(session_id=session_id, generation=generation, prose=prose)
    return await view.call("POST /check_reply", CheckReplyRequest(draft=draft))


async def context(view: CredentialView, session_id: str, desk_id: str | None = None) -> SessionContext:
    return await view.call("GET /context/{session_id}?desk_id=", path={"session_id": session_id},
                           query={"desk_id": desk_id})


def quote_args(item: str, discount_bp: int | None = None) -> dict:
    args: dict = {"items": [{"item_id": item, "qty": 1}]}
    if discount_bp is not None:
        args["requested_discount_bp"] = discount_bp
    return args


async def refused(call) -> tuple[int, str]:
    """The status and code a kernel call is refused with."""
    with pytest.raises(KernelFailed) as failure:
        await call
    return failure.value.status, failure.value.code


@pytest.mark.kernel_plan("01a")
async def test_copy_owner_token_authenticates(kernel):
    http, _, _ = kernel
    copy = await new_copy(http)
    assert len(copy.desk_ids) == 1
    assert copy.owner_session.kind == "owner" and copy.owner_session.generation == 0

    me = await http.owner(copy.owner_token).whoami()
    assert me.kind == "owner" and me.copy_id == copy.copy_id
    assert me.desk_id is None and me.desk_ids == copy.desk_ids
    assert me.session == copy.owner_session

    assert await refused(http.owner("not-" + copy.owner_token).whoami()) == (401, "auth")


@pytest.mark.kernel_plan("01a")
async def test_copy_returns_seeded_chat(kernel, ro_read):
    http, ro_schema, state = kernel
    copy = await new_copy(http)
    chat = copy.seeded_chat
    assert chat is not None
    decision = chat.decision
    assert chat.session_id == decision.session_id
    assert chat.visitor_line == "Could you do the drain clearing at 15% off?"
    assert (decision.outcome, decision.state, decision.visitor_plain) == (
        "hold", "held", "Waiting for Maria Rivera to approve")
    assert decision.action is not None
    assert (decision.action.tool, decision.action.discount_bp, decision.action.amount_cents) == (
        "native.quote", 1500, 15300)
    if state is not None:
        assert decision.signature == fake_signature(decision.model_dump(include={
            "decision_id", "session_id", "state", "visitor_plain", "ledger_seq"}))
    else:
        from tests.kernel.test_decide import verify_signature

        health = await http.public().call("GET /health")
        verify_signature(health.public_key_hex, decision)

    held = ro_read(ro_schema, copy.copy_id,
                   "SELECT decision_id, session_id FROM {ro}.decisions WHERE state = 'held'")
    assert held == [{"decision_id": decision.decision_id, "session_id": chat.session_id}]
    read = await read_decision(http.owner(copy.owner_token), decision.decision_id)
    assert read == decision.model_copy(update={"inbox": []})


NOT_FINAL = {"allowed", "held", "approved", "unknown"}
EVENT_FIELDS = {"visitor_message": (True, False, False), "reply": (False, True, False), "receipt": (False, False, True)}


@pytest.mark.kernel_plan("01d")
async def test_a_copy_replays_the_recorded_night_only_when_asked(kernel, ro_read):
    """A copy replays nothing unless it asks (`replay_night`), and its ledger carries no replayed entry. A copy that
    asks gets the recorded night when the kernel has one (FakeKernel: the night a test recorded; the real kernel: its
    shipped recording, else a live copy): each event names a closed session of the copy at generation 0 and carries
    the one record its kind does, a receipt's decision final and its own session's; events come in shown order, and
    the replayed ledger entries are marked `summary.replayed`, while a live copy has neither (Plan 01d)."""
    http, ro_schema, state = kernel
    if state is not None:
        night = state.now - timedelta(hours=15)
        state.record_night(RecordedSession(steps=(
            RecordedStep("said", night, "Hi, can someone look at my water heater?"),
            RecordedStep("replied", night + timedelta(seconds=20), "Yes, Maria can. Here's an open time."),
            RecordedStep("booked", night + timedelta(seconds=90)))))

    def marked(copy: CopyCreated) -> list[dict]:
        entries = ro_read(ro_schema, copy.copy_id, "SELECT event FROM {ro}.ledger_entries WHERE desk_id = %s",
                          (copy.desk_ids[0],))
        return [entry["event"]["summary"]["replayed"] for entry in entries if "replayed" in entry["event"]["summary"]]

    live = await new_copy(http)
    assert (live.replay_id, live.replayed_messages, marked(live)) == (None, [], [])

    asked = await http.public().call("POST /copies", CreateCopyRequest(replay_night=True))
    if state is not None:
        assert asked.replay_id is not None and [event.kind for event in asked.replayed_messages] == [
            "visitor_message", "reply", "receipt"]
    if asked.replay_id is None:
        assert (asked.replayed_messages, marked(asked)) == ([], [])
        return
    sessions = {row["session_id"]: row for row in ro_read(
        ro_schema, asked.copy_id, "SELECT session_id, desk_id, kind, generation, closed_at FROM {ro}.sessions")}
    for event in asked.replayed_messages:
        session = sessions[event.session_id]
        assert session["desk_id"] in asked.desk_ids and session["kind"] in ("visitor", "agent")
        assert session["generation"] == 0 and session["closed_at"] is not None
        has = (event.text is not None, event.verdict is not None, event.decision is not None)
        assert has == EVENT_FIELDS[event.kind]
        if event.verdict is not None:
            assert event.verdict.generation == 0
        if event.decision is not None:
            assert event.decision.session_id == event.session_id and event.decision.state not in NOT_FINAL
    shown = [event.shown_at for event in asked.replayed_messages]
    assert shown == sorted(shown)
    marks = marked(asked)
    assert marks and all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z", mark["at"]) for mark in marks)


@pytest.mark.kernel_plan("01a")
async def test_whoami_names_only_the_tokens_session(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    first, second = await new_visitor(http, slug), await new_visitor(http, slug)
    assert first.state.kind == "visitor" and first.state.mode == "ai" and first.state.generation == 0
    assert first.state.session_id != second.state.session_id

    for created in (first, second):
        me = await http.session(created.session_token).whoami()
        assert me.kind == "visitor" and me.copy_id == copy.copy_id
        assert me.desk_id == copy.desk_ids[0] and me.desk_ids == copy.desk_ids
        assert me.session == created.state

    # Naming another session never answers for it: refused, or the token's own session.
    for view, own in ((http.session(first.session_token), first.state.session_id),
                      (http.owner(copy.owner_token), copy.owner_session.session_id)):
        try:
            me = await view.whoami(session_id=second.state.session_id)
        except KernelFailed as failure:
            assert (failure.status, failure.code) == (401, "auth")
        else:
            assert me.session.session_id == own

    assert await refused(http.session("not-a-token").whoami()) == (401, "auth")
    # The owner token isn't a session token.
    assert await refused(http.session(copy.owner_token).whoami()) == (401, "auth")


@pytest.mark.kernel_plan("01a")
async def test_decide_is_idempotent_and_found_by_call(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")

    first = await decide(view, session_id, 0, "call-1", "native.quote", quote_args(drain))
    again = await decide(view, session_id, 0, "call-1", "native.quote", quote_args(drain))
    assert again.decision_id == first.decision_id and again.call_id == "call-1"
    heater = item_id(ro_read, ro_schema, copy, "Water heater flush")
    assert await refused(decide(view, session_id, 0, "call-1", "native.quote", quote_args(heater))) == (409, "conflict")

    query = {"session_id": session_id, "generation": 0, "call_id": "call-1"}
    found = await view.call("GET /decisions/by_call?session_id=&generation=&call_id=", query=query)
    assert found.decision_id == first.decision_id
    unknown = {**query, "call_id": "call-never-made"}
    assert await refused(view.call("GET /decisions/by_call?session_id=&generation=&call_id=", query=unknown)) == (
        404, "not_found")


@pytest.mark.kernel_plan("01a")
async def test_by_call_finds_a_call_made_before_a_take_over(kernel, ro_read, arrange):
    """The API recovers an interrupted turn's calls by the generation the turn ran at, even once a take-over or a
    hand-back moved the session on: `by_call` is keyed by the generation it names, not fenced by the current one."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    made = await decide(view, session_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing")))
    await arrange.take_over(http.owner(copy.owner_token), session_id, 0)

    query = {"session_id": session_id, "generation": 0, "call_id": "call-1"}
    found = await view.call("GET /decisions/by_call?session_id=&generation=&call_id=", query=query)
    assert found.decision_id == made.decision_id
    assert await refused(view.call("GET /decisions/by_call?session_id=&generation=&call_id=",
                                   query={**query, "generation": 1})) == (404, "not_found")


@pytest.mark.kernel_plan("01a")
async def test_unknown_tool_is_a_refused_decision(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    decision = await decide(view, session_id, 0, "call-1", "native.transfer_funds", {"to": "me"})
    assert (decision.outcome, decision.state, decision.action) == ("refuse", "refused", None)
    assert decision.call_id == "call-1" and decision.session_id == session_id
    stored = ro_read(ro_schema, copy.copy_id, "SELECT state, tool FROM {ro}.decisions WHERE decision_id = %s",
                     (decision.decision_id,))
    assert stored == [{"state": "refused", "tool": "native.transfer_funds"}]


@pytest.mark.kernel_plan("01a")
async def test_quote_holds_any_discount_like_the_seed(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    # The seed's own held request: drain clearing at 15% off, held for the owner.
    seeded = ro_read(ro_schema, copy.copy_id,
                     "SELECT d.tool, d.state, a.list_cents, a.discount_bp, a.amount_cents FROM {ro}.decisions d"
                     " JOIN {ro}.actions a ON a.session_id = d.session_id AND a.tool = d.tool WHERE d.desk_id = %s",
                     (copy.desk_ids[0],))
    assert seeded == [{"tool": "native.quote", "state": "held", "list_cents": 18000, "discount_bp": 1500,
                       "amount_cents": 15300}]

    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")
    at_list = await decide(view, session_id, 0, "call-1", "native.quote", quote_args(drain, 0))
    assert (at_list.outcome, at_list.state) == ("allow", "allowed")
    assert at_list.action.amount_cents == at_list.action.list_cents == 18000
    off = await decide(view, session_id, 0, "call-2", "native.quote", quote_args(drain, 500))
    assert (off.outcome, off.state) == ("hold", "held")
    assert off.action.discount_bp == 500 and off.action.amount_cents == 17100
    assert "allow_once" in off.answers and "deny_once" in off.answers


@pytest.mark.kernel_plan("01a")
async def test_decide_execute_and_repeat(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    decision = await decide(view, session_id, 0, "call-1", "native.quote",
                            quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing")))
    assert decision.state == "allowed"

    result = await execute(view, decision, 0)
    assert result.state == "succeeded" and result.action_id == decision.action.action_id
    [quote] = [fact for fact in result.facts if fact.kind == "quote"]
    assert f"session:{session_id}" in quote.label.readers
    assert {claim.key: claim.value for claim in quote.claims}["total"] == 18000
    assert await execute(view, decision, 0) == result       # a repeat returns the stored result

    executed = await read_decision(view, decision.decision_id)
    assert executed.state == "executed" and executed.ledger_seq > decision.ledger_seq
    assert executed.signature != decision.signature           # each state change is ledgered and re-signed
    stored = ro_read(ro_schema, copy.copy_id, "SELECT state FROM {ro}.decisions WHERE decision_id = %s",
                     (decision.decision_id,))
    assert stored == [{"state": "executed"}]
    facts = ro_read(ro_schema, copy.copy_id, "SELECT kind FROM {ro}.facts WHERE desk_id = %s AND fact_id = %s",
                    (copy.desk_ids[0], quote.fact_id))
    assert facts == [{"kind": "quote"}]


@pytest.mark.kernel_plan("01a")
async def test_a_repeat_of_an_execution_in_doubt_is_a_conflict(kernel, ro_read, arrange):
    """A repeated /execute returns the stored result only once the execution finished (`succeeded` or `failed`).
    While its outcome isn't known (still running, or `unknown`) it answers 409 `conflict` and changes nothing, so the
    API answers from the decision instead."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    decision = await decide(view, session_id, 0, "call-1", "native.quote",
                            quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing")))
    await arrange.execution_in_doubt(view, decision)
    before = await read_decision(view, decision.decision_id)

    assert await refused(execute(view, decision, 0)) == (409, "conflict")
    assert await read_decision(view, decision.decision_id) == before


@pytest.mark.kernel_plan("01a")
async def test_discounted_quote_holds_and_answers_once(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    held = await decide(view, session_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500))
    assert held.state == "held" and "allow_once" in held.answers

    owner = http.owner(copy.owner_token)
    approved = await answer(owner, held.decision_id, "allow_once")
    assert approved.decision.decision_id == held.decision_id and approved.decision.state == "executed"
    assert approved.execution.state == "succeeded" and approved.card_diff is None
    [quote] = [fact for fact in approved.execution.facts if fact.kind == "quote"]
    assert f"session:{session_id}" in quote.label.readers      # it ran as the held session, not the owner
    assert {claim.key: claim.value for claim in quote.claims}["total"] == 15300

    assert await refused(answer(owner, held.decision_id, "allow_once")) == (409, "conflict")
    assert await refused(answer(owner, held.decision_id, "deny_once")) == (409, "conflict")
    assert (await read_decision(view, held.decision_id)).state == "executed"


@pytest.mark.kernel_plan("01a")
async def test_limit_hold_offers_no_deny_always(kernel, ro_read, arrange):
    """"Deny always" is offered only on a hold an `ask` card decided (master "Decision lifecycle"). The seeded 15% quote
    is a limit hold, through `rv-quote`'s hold twin: its answers leave it out, and posting it is 422 `invalid` with
    nothing changed. A hold an ask card decided keeps it, and answering it drafts a `never` card."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    (seeded,) = ro_read(ro_schema, copy.copy_id, "SELECT decision_id FROM {ro}.decisions"
                                                 " WHERE desk_id = %s AND state = 'held'", (copy.desk_ids[0],))
    held = await read_decision(owner, seeded["decision_id"])
    assert held.state == "held" and {"allow_once", "deny_once"} <= set(held.answers)
    assert "deny_always" not in held.answers
    assert await refused(answer(owner, held.decision_id, "deny_always")) == (422, "invalid")
    assert await read_decision(owner, held.decision_id) == held                 # nothing changed

    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    await arrange.ask(owner, ro_read, ro_schema, copy, "native.find_slots")
    asked = await decide(view, session_id, 0, "call-1", "native.find_slots", {})
    assert asked.state == "held" and "deny_always" in asked.answers
    denied = await answer(owner, asked.decision_id, "deny_always")
    assert denied.decision.state == "denied" and denied.execution is None
    assert [(card.mode, card.applies_to) for card in denied.card_diff] == [("never", "native.find_slots")]


@pytest.mark.kernel_plan("01a")
async def test_owner_reads_its_copys_decisions(kernel, ro_read):
    """The API reads a held request with the owner's credential when an answer's own response was lost or refused:
    any decision of the owner's copy, with expiry applied as on every read, and no other copy's. Owner alerts
    travel once, on the `/decide` answer that created them: a session reads its own decisions through the same
    reads, so every read, the owner's included, carries `inbox == []`."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    call = ("call-1", "native.quote", quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500))
    held = await decide(view, session_id, 0, *call)
    assert held.state == "held" and held.inbox                    # the answer that created the alert carries it
    owner = http.owner(copy.owner_token)

    read = await read_decision(owner, held.decision_id)
    assert read == held.model_copy(update={"inbox": []})          # the signed record, as the session reads it
    by_call = {"session_id": session_id, "generation": 0, "call_id": "call-1"}
    for again in (await read_decision(view, held.decision_id), await decide(view, session_id, 0, *call),
                  await view.call("GET /decisions/by_call?session_id=&generation=&call_id=", query=by_call)):
        assert again == read                                      # a repeated /decide is a read too
    approved = await answer(owner, held.decision_id, "allow_once")
    assert approved.decision.inbox == []
    assert await read_decision(owner, held.decision_id) == approved.decision == await read_decision(
        view, held.decision_id)
    assert await refused(read_decision(http.owner(other.owner_token), held.decision_id)) == (404, "not_found")
    assert await refused(read_decision(owner, "dec-never-made")) == (404, "not_found")


@pytest.mark.kernel_plan("01a")
async def test_a_held_calls_free_text_is_claudes_note(kernel, ro_read):
    """The free text in a tool call (a quote's `note`) is Claude's wording, untrusted: it may repeat what the visitor
    said, or not. The owner reads it in the held request's `reason_plain` quoted after "Claude's note", never labelled
    as the visitor's words, in the decision the session gets, the owner's read and the API's read-only row alike."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    note = "Asked whether Maria can come before lunch."
    args = {**quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500), "note": note}
    held = await decide(view, session_id, 0, "call-1", "native.quote", args)
    assert held.state == "held"
    assert f"Claude's note: “{note}”" in held.reason_plain, held.reason_plain
    read = await read_decision(http.owner(copy.owner_token), held.decision_id)
    stored = ro_read(ro_schema, copy.copy_id, "SELECT reason_plain FROM {ro}.decisions WHERE decision_id = %s",
                     (held.decision_id,))
    assert read.reason_plain == held.reason_plain and stored == [{"reason_plain": held.reason_plain}]
    assert "From the visitor" not in held.reason_plain


@pytest.mark.kernel_plan("01a")
async def test_approving_after_the_rules_changed_runs_nothing(kernel, ro_read, arrange):
    """An approved hold is re-checked against the rules in force when the owner answers (step 6): once a `never`
    card covers the tool, approving it ends `refused_at_execution`, "rules changed", and nothing runs."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    held = await decide(view, session_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500))
    owner = http.owner(copy.owner_token)
    await arrange.never(owner, ro_read, ro_schema, copy, "native.quote")

    result = await answer(owner, held.decision_id, "allow_once")
    assert (result.decision.decision_id, result.decision.state) == (held.decision_id, "refused_at_execution")
    assert result.execution is None and result.card_diff is None
    assert result.decision.ledger_seq > held.ledger_seq and result.decision.answers == []
    assert await read_decision(view, held.decision_id) == result.decision
    assert ro_read(ro_schema, copy.copy_id, "SELECT count(*) AS n FROM {ro}.quotes WHERE session_id = %s",
                   (session_id,)) == [{"n": 0}]
    assert await refused(answer(owner, held.decision_id, "allow_once")) == (409, "conflict")


async def read_policy_ids(api_ro_conn, ro_schema: str, copy: CopyCreated, decision_id: str) -> list[str]:
    """A decision's deciding policies, as the API reads them: `policy_ids` of its kernel_ro row, in the copy."""
    row = await KernelRO(api_ro_conn, copy.copy_id, ro_schema).one("decisions", decision_id=decision_id)
    return row["policy_ids"]


async def read_refusal_cause(api_ro_conn, ro_schema: str, copy: CopyCreated, decision_id: str) -> str | None:
    """The Safety cause from the same decision and ledger views the API reads, on either kernel."""
    ro = KernelRO(api_ro_conn, copy.copy_id, ro_schema)
    row = await ro.one("decisions", decision_id=decision_id)
    entry = await ro.one("ledger_entries", desk_id=copy.desk_ids[0], seq=row["ledger_seq"])
    session = await ro.one("sessions", session_id=row["session_id"])
    return refusal_cause(row, entry, verified=session["verified"])


@pytest.mark.kernel_plan("01a")
async def test_a_never_cards_refusal_names_its_forbid(kernel, ro_read, arrange, api_ro_conn):
    """The owner's Safety entries say why a refusal happened from the decision's deciding policies, which the API reads
    in `kernel_ro.decisions.policy_ids` as the engine names them (`<set>.<@id>`). A `never` card's refusal names its
    forbid, `F.never.<card>`, alike in the decision the session gets, the kernel's record and the row the API reads."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    await arrange.never(http.owner(copy.owner_token), ro_read, ro_schema, copy, "native.quote")
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    refusal = await decide(view, session_id, 0, "call-1", "native.quote",
                           quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing")))
    assert (refusal.outcome, refusal.state, refusal.card_ids) == ("refuse", "refused", ["never-native.quote"])
    expected = ["F.never.never-native.quote"]
    assert refusal.policy_ids == arrange.recorded_policy_ids(refusal.decision_id) == expected
    assert await read_policy_ids(api_ro_conn, ro_schema, copy, refusal.decision_id) == expected
    assert await read_refusal_cause(api_ro_conn, ro_schema, copy, refusal.decision_id) == "owner_rule"


@pytest.mark.kernel_plan("01a")
async def test_an_allow_and_a_limit_hold_name_their_permits(kernel, ro_read, arrange, api_ro_conn):
    """Allows and holds name their deciding permits the same way: a quote at list price is allowed by its auto card's
    permit, `A.auto.<card>`, and one past the card's discount limit is held by that card's hold twin, `H.twin.<card>`,
    alike in the decision the session gets, the kernel's record and the row the API reads."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")
    at_list = await decide(view, session_id, 0, "call-1", "native.quote", quote_args(drain, 0))
    off = await decide(view, session_id, 0, "call-2", "native.quote", quote_args(drain, 500))
    for decision, outcome, expected in ((at_list, "allow", ["A.auto.rv-quote"]), (off, "hold", ["H.twin.rv-quote"])):
        assert (decision.outcome, decision.card_ids) == (outcome, ["rv-quote"])
        assert decision.policy_ids == arrange.recorded_policy_ids(decision.decision_id) == expected
        assert await read_policy_ids(api_ro_conn, ro_schema, copy, decision.decision_id) == expected


@pytest.mark.kernel_plan("01a")
async def test_cancel_held_decision(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    visitor, stranger = await new_visitor(http, slug), await new_visitor(http, slug)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    held = await decide(view, session_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Leak repair"), 2000))
    assert held.state == "held"

    def cancel(by: SessionCreated):
        return http.session(by.session_token).call("POST /decisions/{decision_id}/cancel",
                                                   CancelRequest(session_id=by.state.session_id),
                                                   path={"decision_id": held.decision_id})

    assert await refused(cancel(stranger)) == (404, "not_found")   # another session's decision
    cancelled = await cancel(visitor)
    assert cancelled.decision_id == held.decision_id and cancelled.state == "cancelled"
    assert cancelled.answers == [] and cancelled.ledger_seq > held.ledger_seq
    assert await refused(cancel(visitor)) == (409, "conflict")
    assert await refused(answer(http.owner(copy.owner_token), held.decision_id, "allow_once")) == (409, "conflict")


@pytest.mark.kernel_plan("01a")
async def test_check_reply_blocks_numbers_with_handoff(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    blocked = await check_reply(view, session_id, 0, "It comes to $89 for the visit.")
    assert not blocked.ok and "number_in_prose" in {violation.kind for violation in blocked.violations}
    assert [(block.kind, block.template) for block in blocked.blocks] == [("card", "handoff")]
    assert "Maria Rivera" in blocked.blocks[0].text and "89" not in blocked.blocks[0].text
    assert (blocked.generation, blocked.language) == (0, "en")

    clean = await check_reply(view, session_id, 0, "Happy to help with your drain.")
    assert clean.ok and clean.violations == []
    assert [(block.kind, block.text) for block in clean.blocks] == [("prose", "Happy to help with your drain.")]
    assert clean.message_id != blocked.message_id and clean.ledger_seq > blocked.ledger_seq


@pytest.mark.kernel_plan("01a")
async def test_check_reply_hands_off_other_languages(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    english, spanish = await new_visitor(http, slug), await new_visitor(http, slug)

    view, session_id = http.session(english.session_token), english.state.session_id
    french = await check_reply(view, session_id, 0, "Bonjour, je peux vous aider.")
    assert not french.ok and "unsupported_language" in {violation.kind for violation in french.violations}
    assert [block.template for block in french.blocks] == ["handoff"] and french.language == "en"

    # The handoff speaks the session's last language.
    view, session_id = http.session(spanish.session_token), spanish.state.session_id
    hola = await check_reply(view, session_id, 0, "Hola, puedo ayudarle con eso.")
    assert hola.ok and hola.language == "es"
    french = await check_reply(view, session_id, 0, "Bonjour, je peux vous aider.")
    assert not french.ok and french.language == "es" and [block.template for block in french.blocks] == ["handoff"]


@pytest.mark.kernel_plan("01a")
async def test_status_lines_are_the_kernels(kernel, ro_read):
    """A decision's and a reply's status line is the kernel's template for its state, naming the owner, in the
    session's last language: what the API shows a visitor as it is."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")
    owner = http.owner(copy.owner_token)
    visitor = await new_visitor(http, slug)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    allowed = await decide(view, session_id, 0, "call-allow", "native.quote", quote_args(drain))
    held = await decide(view, session_id, 0, "call-hold", "native.quote", quote_args(drain, 1500))
    to_deny = await decide(view, session_id, 0, "call-deny", "native.quote", quote_args(drain, 1500))
    unknown = await decide(view, session_id, 0, "call-unknown", "native.teleport", {})
    cancelled = await view.call("POST /decisions/{decision_id}/cancel", CancelRequest(session_id=session_id),
                                path={"decision_id": held.decision_id})
    denied = (await answer(owner, to_deny.decision_id, "deny_once")).decision
    assert [(decision.state, decision.visitor_plain) for decision in (allowed, held, unknown, cancelled, denied)] == [
        ("allowed", "Checked against Maria Rivera's rules"), ("held", "Waiting for Maria Rivera to approve"),
        ("refused", "Not something I can do here"), ("cancelled", "Cancelled"),
        ("denied", "Maria Rivera decided not to go ahead")]
    assert (await check_reply(view, session_id, 0, "Happy to help.")).visitor_plain == (
        "Reply checked against Maria Rivera's rules")
    assert (await check_reply(view, session_id, 0, "It costs 80 dollars.")).visitor_plain == (
        "Passed to Maria Rivera to answer")

    spanish = await new_visitor(http, slug)
    view, session_id = http.session(spanish.session_token), spanish.state.session_id
    assert (await check_reply(view, session_id, 0, "Hola, puedo ayudarle con eso.")).visitor_plain == (
        "Respuesta revisada con las reglas de Maria Rivera")
    assert (await decide(view, session_id, 0, "call-1", "native.quote", quote_args(drain))).visitor_plain == (
        "Revisado con las reglas de Maria Rivera")


@pytest.mark.kernel_plan("01b")
async def test_executed_lines_say_what_was_done(kernel, ro_read):
    """Once a visitor's action has run, its status line says what was done, by tool, naming the owner and no amount
    or time, in the session's last language."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    visitor = await new_visitor(http, slug)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    calls = {"native.quote": quote_args(item_id(ro_read, ro_schema, copy, "Service call deposit")),
             "native.find_slots": {},
             "native.request_callback": {"name": "Dana Wells", "contact": "(503) 555-0142", "reason": "Water heater"},
             "native.start_verification": {"contact": "nobody@example.com"}}
    lines = {}
    for n, (tool, args) in enumerate(calls.items()):
        allowed = await decide(view, session_id, 0, f"call-{n}", tool, args)
        assert (await execute(view, allowed, 0)).state == "succeeded", tool
        executed = await read_decision(view, allowed.decision_id)
        lines[tool] = (executed.state, executed.visitor_plain)
    assert lines == {"native.quote": ("executed", "Quoted from Maria Rivera's price list"),
                     "native.find_slots": ("executed", "Times read from Maria Rivera's calendar"),
                     "native.request_callback": ("executed", "Callback request saved for Maria Rivera"),
                     "native.start_verification": ("executed", "Verification started")}

    spanish = await new_visitor(http, slug)
    view, session_id = http.session(spanish.session_token), spanish.state.session_id
    assert (await check_reply(view, session_id, 0, "Hola, puedo ayudarle con eso.")).ok
    allowed = await decide(view, session_id, 0, "call-1", "native.find_slots", {})
    await execute(view, allowed, 0)
    assert (await read_decision(view, allowed.decision_id)).visitor_plain == (
        "Horarios tomados del calendario de Maria Rivera")


@pytest.mark.kernel_plan("01a")
async def test_session_state_responses(kernel, ro_read, arrange):
    """Every row of "Session state responses", in its order, for the four session routes."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")
    calls = iter(range(1000))

    async def visitor_with_an_allow() -> tuple[SessionCreated, CredentialView, Decision]:
        created = await new_visitor(http, slug)
        view = http.session(created.session_token)
        allow = await decide(view, created.state.session_id, 0, "call-allow", "native.quote", quote_args(drain))
        assert allow.state == "allowed"
        return created, view, allow

    def routes(view: CredentialView, session_id: str, generation: int, allow: Decision) -> dict:
        return {
            "decide": lambda: decide(view, session_id, generation, f"call-{next(calls)}", "native.quote",
                                     quote_args(drain)),
            "execute": lambda: execute(view, allow, generation),
            "check_reply": lambda: check_reply(view, session_id, generation, "Happy to help."),
            "context": lambda: context(view, session_id),
        }

    # Bad token or signature: 401 on all four, for a made-up token and for another session's own.
    first, _, allow = await visitor_with_an_allow()
    stranger = await new_visitor(http, slug)
    for token in ("not-a-token", stranger.session_token):
        for route, call in routes(http.session(token), first.state.session_id, 0, allow).items():
            assert await refused(call()) == (401, "auth"), route

    # Session in another copy or Desk: 404. A session token names its own session, so the 404s come from
    # another session's decision and from another copy's owner; a reply check names nothing else.
    assert await refused(execute(http.session(stranger.session_token),
                                 allow.model_copy(update={"session_id": stranger.state.session_id}), 0)) == (
        404, "not_found")
    other_owner = http.owner(other.owner_token)
    call = ToolCall(call_id="call-other", tool="native.quote", args=quote_args(drain))
    assert await refused(other_owner.call("POST /decide", DecideRequest(
        session_id=first.state.session_id, generation=0, call=call, desk_id=other.desk_ids[0]))) == (404, "not_found")
    assert await refused(context(other_owner, first.state.session_id, other.desk_ids[0])) == (404, "not_found")

    # Stale generation: 409 stale_generation on all three that carry one; the allow it named expires.
    created, view, allow = await visitor_with_an_allow()
    for route, call in routes(view, created.state.session_id, 1, allow).items():
        if route != "context":
            assert await refused(call()) == (409, "stale_generation"), route
    assert (await read_decision(view, allow.decision_id)).state == "expired"

    # Mode owner: 409 mode_owner, but /context answers. An allow made before the take-over is always at an older
    # generation, so its /execute answers stale_generation (the generation check comes first) and it expires.
    created, view, allow = await visitor_with_an_allow()
    await arrange.take_over(http.owner(copy.owner_token), created.state.session_id, 0)
    generation = (await view.whoami()).session.generation
    assert generation == 1
    for route, call in routes(view, created.state.session_id, generation, allow).items():
        if route == "context":
            assert isinstance(await call(), SessionContext)
        elif route == "execute":
            assert await refused(call()) == (409, "stale_generation"), route
        else:
            assert await refused(call()) == (409, "mode_owner"), route
    assert (await read_decision(view, allow.decision_id)).state == "expired"
    # A stale generation answers before the mode: the generation from before the take-over is refused as stale.
    for route, call in routes(view, created.state.session_id, generation - 1, allow).items():
        if route != "context":
            assert await refused(call()) == (409, "stale_generation"), route

    # Mode paused: /decide stores a refusal, /execute is 409, the reply check gives only the handoff.
    created, view, allow = await visitor_with_an_allow()
    arrange.pause(created.state.session_id)
    generation = (await view.whoami()).session.generation
    paused = routes(view, created.state.session_id, generation, allow)
    decision = await paused["decide"]()
    assert (decision.outcome, decision.state) == ("refuse", "refused")
    assert await refused(paused["execute"]()) == (409, "mode_paused")
    verdict = await paused["check_reply"]()
    assert not verdict.ok and [violation.kind for violation in verdict.violations] == ["session_paused"]
    assert [block.template for block in verdict.blocks] == ["handoff"]
    assert isinstance(await paused["context"](), SessionContext)
    for route, call in routes(view, created.state.session_id, generation + 1, allow).items():
        if route != "context":
            assert await refused(call()) == (409, "stale_generation"), route   # before the pause

    # Session closed: 409 closed on all four (last, since the fake's clock moves a day on). /whoami, which the
    # API calls first on every request and which decides whether a returning visitor resumes, refuses it too.
    created, view, allow = await visitor_with_an_allow()
    arrange.close_idle_sessions(created.state.session_id)
    assert await refused(view.whoami()) == (409, "closed")
    for stale in (False, True):                                     # closed answers before a stale generation
        for route, call in routes(view, created.state.session_id, int(stale), allow).items():
            assert await refused(call()) == (409, "closed"), route


@pytest.mark.kernel_plan("01a")
async def test_calls_on_a_closed_session_are_ledgered(kernel, ro_read, arrange):
    """Every attempt is logged: each call refused because its session is closed is an `auth` entry on the session's
    Desk, naming the session, the route and the reason, and never the token."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id, desk_id = http.session(visitor.session_token), visitor.state.session_id, copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    arrange.close_idle_sessions(session_id)
    start = (await ledger_page(owner, desk_id)).entries[-1].seq

    assert await refused(view.whoami()) == (409, "closed")
    assert await refused(context(view, session_id)) == (409, "closed")
    assert await refused(check_reply(view, session_id, 0, "Happy to help.")) == (409, "closed")
    entries = [entry.event for entry in (await ledger_page(owner, desk_id)).entries if entry.seq > start]
    assert [(event.kind, event.origin, event.session_id, event.summary) for event in entries] == [
        ("auth", "kernel", session_id, {"route": "GET /whoami", "reason": "closed"}),
        ("auth", "kernel", session_id, {"route": "GET /context/{session_id}", "reason": "closed"}),
        ("auth", "kernel", session_id, {"route": "POST /check_reply", "reason": "closed"})]
    assert visitor.session_token not in json.dumps([event.summary for event in entries])


@pytest.mark.kernel_plan("01a")
async def test_mode_change_bumps_generation(kernel, ro_read, arrange):
    """The owner's take-over, hand-back and resume (Plan 01a's mode table): each change bumps the generation and is
    ledgered, and a take-over or resume of a paused session resets its strikes. The current mode again changes
    nothing; a stale generation is 409, only the breaker pauses (422), a visitor's token is 401 and another copy's
    owner 404, none of them changing anything."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id, desk_id = http.session(visitor.session_token), visitor.state.session_id, copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    start = (await ledger_page(owner, desk_id)).entries[-1].seq

    async def mode(to: str, generation: int, caller: CredentialView = owner) -> SessionState:
        return await caller.call("POST /sessions/{id}/mode", ModeRequest(mode=to, generation=generation),
                                 path={"id": session_id})

    def row() -> tuple:
        (found,) = ro_read(ro_schema, copy.copy_id, "SELECT mode, generation, strikes FROM {ro}.sessions"
                                                    " WHERE session_id = %s", (session_id,))
        return found["mode"], found["generation"], found["strikes"]

    taken = await mode("owner", 0)
    assert (taken.session_id, taken.mode, taken.generation) == (session_id, "owner", 1)
    assert (await view.whoami()).session == taken and row() == ("owner", 1, 0)
    assert await mode("owner", 1) == taken                                  # the current mode: nothing changes
    for refusal, expected in ((lambda: mode("ai", 0), (409, "stale_generation")),
                              (lambda: mode("paused", 1), (422, "invalid")),
                              (lambda: mode("ai", 1, view), (401, "auth")),
                              (lambda: mode("ai", 1, http.owner(other.owner_token)), (404, "not_found"))):
        assert await refused(refusal()) == expected
    assert row() == ("owner", 1, 0)

    back = await mode("ai", 1)
    assert (back.mode, back.generation) == ("ai", 2) and row() == ("ai", 2, 0)
    arrange.pause(session_id)                                               # the breaker's third strike
    assert row() == ("paused", 2, 3)
    resumed = await mode("ai", 2)
    assert (resumed.mode, resumed.generation) == ("ai", 3) and row() == ("ai", 3, 0)
    arrange.pause(session_id)
    from_paused = await mode("owner", 3)
    assert (from_paused.mode, from_paused.generation) == ("owner", 4) and row() == ("owner", 4, 0)

    moves = [(entry.event.kind, {key: entry.event.summary.get(key) for key in ("from", "to", "generation", "resumed")})
             for entry in (await ledger_page(owner, desk_id)).entries
             if entry.seq > start and entry.event.session_id == session_id and (
                 entry.event.kind == "takeover" or entry.event.summary.get("resumed"))]
    assert moves == [
        ("takeover", {"from": "ai", "to": "owner", "generation": 1, "resumed": None}),
        ("takeover", {"from": "owner", "to": "ai", "generation": 2, "resumed": None}),
        ("breaker", {"from": None, "to": None, "generation": None, "resumed": True}),
        ("takeover", {"from": "paused", "to": "owner", "generation": 4, "resumed": None})]


@pytest.mark.kernel_plan("01a")
async def test_mode_change_names_a_session_of_the_owners_copy(kernel, ro_read):
    """`POST /sessions/{id}/mode` answers an owner session's two "Session state responses" rows: a token that isn't
    the owner's is 401, and a session the owner's copy doesn't have, another copy's or an ID that names none, is 404.
    The owner's own session is of the copy, so it passes them and the open and generation checks (a stale generation
    is 409 `stale_generation`), and then has no mode to set: 422 `invalid`. None of them changes anything."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    elsewhere = await new_visitor(http, desk_slug(ro_read, ro_schema, other))
    owner, guess = http.owner(copy.owner_token), http.owner("a-guess")
    own = copy.owner_session

    async def mode(caller: CredentialView, session_id: str, generation: int = 0) -> SessionState:
        return await caller.call("POST /sessions/{id}/mode", ModeRequest(mode="owner", generation=generation),
                                 path={"id": session_id})

    assert await refused(mode(owner, "no-such-session")) == (404, "not_found")
    assert await refused(mode(owner, elsewhere.state.session_id)) == (404, "not_found")
    assert await refused(mode(guess, "no-such-session")) == (401, "auth")
    assert await refused(mode(guess, elsewhere.state.session_id)) == (401, "auth")
    assert await refused(mode(owner, own.session_id, own.generation + 1)) == (409, "stale_generation")
    assert await refused(mode(owner, own.session_id, own.generation)) == (422, "invalid")
    (row,) = ro_read(ro_schema, other.copy_id, "SELECT mode, generation FROM {ro}.sessions WHERE session_id = %s",
                     (elsewhere.state.session_id,))
    assert row == {"mode": "ai", "generation": 0}
    (row,) = ro_read(ro_schema, copy.copy_id, "SELECT mode, generation FROM {ro}.sessions WHERE session_id = %s",
                     (own.session_id,))
    assert row == {"mode": own.mode, "generation": own.generation}


@pytest.mark.kernel_plan("01a")
async def test_ledger_append_allows_three_kinds(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id, desk_id = http.session(visitor.session_token), visitor.state.session_id, copy.desk_ids[0]

    def event(kind: str) -> LedgerEvent:
        return LedgerEvent(kind=kind, origin="api", session_id=session_id, summary={"route": "visitor_message"})

    for kind in ("session", "rate_limit", "agent_auth"):
        entry = await view.call("POST /ledger/append", LedgerAppendRequest(desk_id=desk_id, event=event(kind)))
        assert (entry.desk_id, entry.event.kind, entry.event.origin) == (desk_id, kind, "api")
    # The kernel refuses any other kind itself, past the client's own model check, and another Desk.
    forged = LedgerAppendRequest.model_construct(desk_id=desk_id, event=event("decide"))
    assert await refused(view.call("POST /ledger/append", forged)) == (422, "invalid")
    elsewhere = LedgerAppendRequest(desk_id=other.desk_ids[0], event=event("rate_limit"))
    assert await refused(view.call("POST /ledger/append", elsewhere)) == (404, "not_found")

    page: LedgerPage = await http.owner(copy.owner_token).call("GET /ledger/{desk_id}?verify=true",
                                                               path={"desk_id": desk_id})
    assert page.chain_ok and page.first_bad_seq is None and page.head == page.entries[-1].hash
    assert [entry.event.kind for entry in page.entries if entry.event.origin == "api"] == [
        "session", "rate_limit", "agent_auth"]
    assert [entry.seq for entry in page.entries] == sorted({entry.seq for entry in page.entries})
    assert await refused(http.owner(other.owner_token).call("GET /ledger/{desk_id}?verify=true",
                                                            path={"desk_id": desk_id})) == (404, "not_found")


@pytest.mark.kernel_plan("01a")
async def test_public_desk_shows_only_public_fields(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)

    public = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug})
    assert (public.business_name, public.desk_name, public.owner_display_name) == (
        "Rivera Plumbing", "Main line", "Maria Rivera")
    # the charter in the page's order: the hours, the contact, then the policies by their fact IDs
    assert public.brand and [block.template for block in public.charter] == [
        "hours", "contact", "policy", "policy", "policy"]
    policies = [block.fact_id for block in public.charter if block.template == "policy"]
    assert policies == sorted(policies) and all(fact_id.startswith("charter:policy:") for fact_id in policies)
    shown = public.model_dump_json()
    private = [
        *(row["display_name"] for row in ro_read(ro_schema, copy.copy_id, "SELECT display_name FROM {ro}.people")),
        *(row["masked_contact"] for row in ro_read(ro_schema, copy.copy_id, "SELECT masked_contact FROM {ro}.people")),
        *(row["title"] for row in ro_read(ro_schema, copy.copy_id, "SELECT title FROM {ro}.price_items")),
        *(row["title"] for row in ro_read(ro_schema, copy.copy_id, "SELECT title FROM {ro}.documents")),
    ]
    assert len(private) == 10 and not [value for value in private if value in shown]
    assert await refused(http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug + "-gone"})) == (
        404, "not_found")


RIVERA_TIME = ZoneInfo("America/Los_Angeles")
# The Rivera seed's hours, by weekday (Monday 0): weekdays 8:00 am to 6:00 pm, Saturday 9:00 am to 1:00 pm.
RIVERA_OPEN = {**{day: (time(8), time(18)) for day in range(5)}, 5: (time(9), time(13))}


def rivera_open_at(moment: datetime) -> bool:
    local = moment.astimezone(RIVERA_TIME)
    window = RIVERA_OPEN.get(local.weekday())
    return window is not None and window[0] <= local.time() < window[1]


async def public_page(http: KernelHttp, slug: str, lang: str) -> PublicDesk:
    return await http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug}, query={"lang": lang})


@pytest.mark.kernel_plan("01b")
async def test_public_desk_says_whether_it_is_open_now(kernel, ro_read):
    """The public page's open-now line, from the Desk's hours in its time zone on the kernel's clock: open until the
    window ends, or closed until the next one opens, in the language asked for, and asked for again by the boundary,
    the next local midnight or 25 hours on. A Desk without hours claims neither, and shows no hours card."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    english = (await public_page(http, slug, "en")).open_status
    spanish = (await public_page(http, slug, "es")).open_status

    assert english is not None and english.open == rivera_open_at(english.as_of)
    boundary = english.until if english.open else english.opens_at
    assert boundary is not None and (english.opens_at if english.open else english.until) is None
    assert rivera_open_at(boundary) != english.open and rivera_open_at(boundary - timedelta(minutes=1)) == english.open
    assert english.as_of < boundary <= english.as_of + timedelta(days=7)
    assert english.as_of < english.refresh_at <= min(boundary, english.as_of + timedelta(hours=25))
    local = boundary.astimezone(RIVERA_TIME)
    assert english.text.startswith("Open now, until " if english.open else "Closed now. Opens ")
    assert f"{local.hour % 12 or 12}:{local.minute:02d} {'am' if local.hour < 12 else 'pm'}" in english.text
    assert spanish is not None and spanish.open == english.open
    assert spanish.text.startswith("Abierto ahora, hasta " if english.open else "Cerrado ahora. Abre ")
    assert f" {local.hour}:{local.minute:02d}" in spanish.text

    created = await http.owner(copy.owner_token).call("POST /desks", a_new_desk())   # no hours, no charter
    unset = await public_page(http, created.slug, "en")
    assert unset.open_status is None and unset.charter == []


@pytest.mark.kernel_plan("01c")
async def test_public_desk_carries_the_agent_card(kernel, ro_read):
    """The public page's Agent Card: prose the kernel writes in the language asked for, saying that Claude, an AI,
    answers within the owner's rules, what an agent can do there (leaving details and asking for a callback alone while
    Answering is off), where to send each request and how to sign it."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)

    async def card(lang: str) -> list[str]:
        blocks = (await public_page(http, slug, lang)).agent_card
        assert all((block.kind, block.template, block.title) == ("prose", None, None) for block in blocks)
        return [block.text for block in blocks]

    english, spanish = await card("en"), await card("es")
    assert len(english) == len(spanish) == 6
    assert english[0] == ("Visiting agents can talk to Rivera Plumbing here too. Answers come from Claude, an AI, "
                          "working within Maria Rivera's rules, unless a message is marked as Maria Rivera's own.")
    assert english[1].startswith("What an agent can do here: get a quote from the price list, find open times, ")
    assert english[2] == f"Send each request to POST /api/a2a/{slug} on this site; {slug} is this Desk's slug."
    assert all(header in english[3] for header in ("X-Agent-Key-Id", "X-Agent-Ts", "X-Agent-Nonce", "X-Agent-Sig"))
    assert spanish[0].startswith("Los agentes también pueden hablar aquí con Rivera Plumbing. ")
    assert spanish[2] == (f"Envía cada solicitud a POST /api/a2a/{slug} en este sitio; {slug} es el identificador de "
                          "este Desk.")

    await http.owner(copy.owner_token).call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False),
                                            path={"id": copy.desk_ids[0]})
    assert (await card("en"))[1] == "What an agent can do here: leave contact details and ask for a callback."
    assert (await card("es"))[1] == ("Lo que un agente puede hacer aquí: dejar datos de contacto y pedir que te "
                                     "devuelvan la llamada.")


@pytest.mark.kernel_plan("01a")
async def test_context_starts_with_the_desks_catalog(kernel, ro_read):
    """A session's `/context` facts start with the public `catalog`: one text claim per price item, its item_id and
    title, in item_id order, and no price."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    items = ro_read(ro_schema, copy.copy_id, "SELECT item_id, title FROM {ro}.price_items WHERE desk_id = %s"
                    " ORDER BY item_id", (copy.desk_ids[0],))

    facts = (await context(http.session(visitor.session_token), visitor.state.session_id)).facts
    catalog = facts[0]
    assert (catalog.fact_id, catalog.kind, catalog.status, catalog.label.readers) == (
        "catalog", "charter", "available", ["public"])
    assert [(claim.key, claim.kind, claim.value) for claim in catalog.claims] == [
        (row["item_id"], "text", row["title"]) for row in items]
    assert len(items) == 4 and [fact.fact_id for fact in facts].count("catalog") == 1


@pytest.mark.kernel_plan("01a")
async def test_ro_columns_match_the_master(kernel, api_conn):
    _, ro_schema, _ = kernel

    def shape(schema: str) -> dict[str, dict[str, str]]:
        return {view: ro_tables.view_types(api_conn, schema, view) for view in ro_tables.KERNEL_RO_COLUMNS}

    served = shape(ro_schema)
    assert {view: tuple(columns) for view, columns in served.items()} == ro_tables.KERNEL_RO_COLUMNS
    assert served == shape("kernel_ro")      # the fake's columns have the real views' types


@pytest.mark.kernel_plan("01a")
async def test_responses_validate(kernel, ro_read):
    """Every route answers its `KERNEL_ROUTES` model (the typed client validates each answer), and every refusal,
    an identity field in a body included, is a `KernelError`."""
    http, ro_schema, state = kernel
    if state is not None:
        assert set(FAKE_ROUTES) <= set(KERNEL_ROUTES)
    health = await http.public().call("GET /health")
    assert isinstance(health, Health) and health.proof_mode in ("symcc", "bounded")
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    assert isinstance(await http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug}), PublicDesk)
    visitor = await new_visitor(http, slug)
    view, owner = http.session(visitor.session_token), http.owner(copy.owner_token)
    session_id = visitor.state.session_id
    assert isinstance(await view.whoami(), WhoAmI) and isinstance(await owner.whoami(), WhoAmI)
    assert isinstance(await context(view, session_id), SessionContext)

    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")
    allow = await decide(view, session_id, 0, "call-allow", "native.quote", quote_args(drain))
    query = {"session_id": session_id, "generation": 0, "call_id": "call-allow"}
    assert isinstance(await view.call("GET /decisions/by_call?session_id=&generation=&call_id=", query=query), Decision)
    assert isinstance(await execute(view, allow, 0), ExecResult)
    assert isinstance(await read_decision(view, allow.decision_id), Decision)
    to_cancel = await decide(view, session_id, 0, "call-cancel", "native.quote", quote_args(drain, 1000))
    cancelled = await view.call("POST /decisions/{decision_id}/cancel", CancelRequest(session_id=session_id),
                                path={"decision_id": to_cancel.decision_id})
    assert isinstance(cancelled, Decision)
    to_deny = await decide(view, session_id, 0, "call-deny", "native.quote", quote_args(drain, 1000))
    assert isinstance(await answer(owner, to_deny.decision_id, "deny_once"), ApprovalResult)
    assert isinstance(await check_reply(view, session_id, 0, "Happy to help."), ReplyVerdict)
    event = LedgerEvent(kind="rate_limit", origin="api", session_id=session_id, summary={"limit": "visitor_message"})
    appended = await view.call("POST /ledger/append", LedgerAppendRequest(desk_id=copy.desk_ids[0], event=event))
    page = await owner.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": copy.desk_ids[0]})
    assert isinstance(page, LedgerPage) and page.entries[-1] == appended

    # Refusals, read raw: each body is a KernelError with the table's code.
    transport = httpx.ASGITransport(app=fake_kernel_app(state)) if state is not None else None
    async with httpx.AsyncClient(base_url=http.base_url, transport=transport) as raw:
        token = {"X-Session-Token": visitor.session_token}
        decide_body = DecideRequest(session_id=session_id, generation=0,
                                    call=ToolCall(call_id="call-raw", tool="native.find_slots", args={}))
        with_identity = {**decide_body.model_dump(mode="json"), "principal": {"kind": "owner"}}
        other_args = {**decide_body.call.model_dump(), "call_id": "call-allow"}     # call-allow quoted a drain
        conflict = {**decide_body.model_dump(mode="json"), "call": other_args}
        cases = [
            (raw.get("/whoami", headers={"X-Session-Token": "not-a-token"}), 401, "auth"),
            (raw.get(f"/public/{slug}-gone"), 404, "not_found"),
            (raw.post("/decide", json=conflict, headers=token), 409, "conflict"),
            (raw.post("/decide", json=with_identity, headers=token), 422, "invalid"),
        ]
        for pending, status, code in cases:
            response = await pending
            assert response.status_code == status, (status, code)
            assert KernelError.model_validate_json(response.content).code == code


# The owner's Desk (Plan 01b) -------------------------------------------------------------------------------


async def ledger_page(owner: CredentialView, desk_id: str) -> LedgerPage:
    return await owner.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": desk_id})


def tools(seen: SessionContext) -> tuple[set[str], set[str]]:
    """The tools a session has now, and every tool its kind could be given."""
    return {tool.tool for tool in seen.tools}, {tool.tool for tool in seen.tools_declared}


@pytest.mark.kernel_plan("01b")
async def test_answering_switch_round_trips(kernel, ro_read):
    """Answering off leaves visitors only lead capture and a callback (their declared tools unchanged), on gives the
    rest back; each switch is the owner's, on its own copy's Desk, and ledgered `desk_data`."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    desk_id, owner = copy.desk_ids[0], http.owner(copy.owner_token)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    before = tools(await context(view, session_id))

    def answering() -> list[dict]:
        return ro_read(ro_schema, copy.copy_id, "SELECT answering FROM {ro}.desks WHERE desk_id = %s", (desk_id,))

    off = await owner.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False), path={"id": desk_id})
    assert isinstance(off, DeskUpdated) and off.desk_id == desk_id
    assert answering() == [{"answering": False}]
    now, declared = tools(await context(view, session_id))
    assert now == {"native.capture_lead", "native.request_callback"} and declared == before[1]

    on = await owner.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=True), path={"id": desk_id})
    assert on.desk_id == desk_id and on.updated_at >= off.updated_at
    assert answering() == [{"answering": True}] and tools(await context(view, session_id)) == before
    switches = [entry.event.summary for entry in (await ledger_page(owner, desk_id)).entries
                if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "answering"]
    assert len(switches) == 2
    elsewhere = http.owner(other.owner_token).call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False),
                                                   path={"id": desk_id})
    assert await refused(elsewhere) == (404, "not_found") and answering() == [{"answering": True}]



@pytest.mark.kernel_plan("01b")
async def test_handoff_done_closes_it_once(kernel, ro_read):
    """A visitor's callback request opens a handoff; the owner closes it once (`open` → `done`, ledgered `desk_data`
    naming it), a second time is 409 `conflict`, and another copy's owner or an unknown handoff gets 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    desk_id, owner = copy.desk_ids[0], http.owner(copy.owner_token)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    callback = await decide(view, session_id, 0, "call-1", "native.request_callback",
                            {"name": "Dana Wells", "contact": "(503) 555-0142", "reason": "Leaking water heater"})
    assert callback.state == "allowed" and (await execute(view, callback, 0)).state == "succeeded"

    def handoffs() -> list[dict]:
        return ro_read(ro_schema, copy.copy_id, "SELECT handoff_id, session_id, status FROM {ro}.handoffs"
                                                " WHERE desk_id = %s", (desk_id,))

    ((handoff_id, opened_by, status),) = [tuple(row.values()) for row in handoffs()]
    assert (opened_by, status) == (session_id, "open")
    path = {"id": handoff_id}
    assert await refused(http.owner(other.owner_token).call("POST /handoffs/{id}/done", path=path)) == (
        404, "not_found")
    done = await owner.call("POST /handoffs/{id}/done", path=path)
    assert isinstance(done, DeskUpdated) and done.desk_id == desk_id
    assert handoffs() == [{"handoff_id": handoff_id, "session_id": session_id, "status": "done"}]
    assert await refused(owner.call("POST /handoffs/{id}/done", path=path)) == (409, "conflict")
    assert await refused(owner.call("POST /handoffs/{id}/done", path={"id": "handoff-never-made"})) == (
        404, "not_found")
    closed = [entry.event.summary for entry in (await ledger_page(owner, desk_id)).entries
              if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "handoffs"]
    assert closed == [{"part": "handoffs", "refs": [handoff_id]}]


@pytest.mark.kernel_plan("01b")
async def test_owner_demo_inbox_is_the_copys(kernel, ro_read):
    """The owner's Demo inbox holds the copy's entries: a hold alerts the owner there, under the entry its notice
    names, and the alert names the held decision. Another copy's owner never reads them, and a visitor's token
    isn't the owner's."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    held = await decide(view, session_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500))
    assert held.state == "held" and held.inbox and {notice.to for notice in held.inbox} == {"owner"}

    mine = await http.owner(copy.owner_token).call("GET /demo_inbox")
    theirs = await http.owner(other.owner_token).call("GET /demo_inbox")
    assert all(isinstance(entry, DemoInboxEntry) for entry in mine)
    entries = {entry.entry_id: entry for entry in mine}
    for notice in held.inbox:
        assert (entries[notice.entry_id].to, entries[notice.entry_id].kind) == ("owner", "alert")
        assert entries[notice.entry_id].decision_id == held.decision_id
    assert not {entry.entry_id for entry in theirs} & set(entries)
    assert await refused(view.call("GET /demo_inbox")) == (401, "auth")


@pytest.mark.kernel_plan("01b")
async def test_owner_say_returns_a_signed_owner_said_verdict(kernel, ro_read, arrange):
    """The owner's say into a session of their copy, in any mode: a passing verdict signed at the session's
    generation, one `owner_said` card holding the text verbatim (the number rule doesn't apply to the owner's own
    words), an `owner_statement` fact only that session and the owner read, and a `reply` entry by the owner. A
    document's canary blocks a say: no card, no fact and no echo of it. A whisper has no verdict, makes no fact and is
    ledgered `whisper` without its text. Another copy's owner is 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    session_id, desk_id, owner = visitor.state.session_id, copy.desk_ids[0], http.owner(copy.owner_token)
    text = "A tank replacement usually runs $1,400 to $1,900."

    async def message(words: str, kind: str = "say", caller: CredentialView = owner) -> OwnerMessageResult:
        return await caller.call("POST /owner/messages", OwnerMessageRequest(session_id=session_id, text=words,
                                                                             kind=kind))

    def owner_facts() -> list[set[str]]:
        return [set(row["readers"]) for row in ro_read(
            ro_schema, copy.copy_id, "SELECT readers FROM {ro}.facts WHERE desk_id = %s AND kind = 'owner_statement'",
            (desk_id,))]

    async def entry_at(seq: int) -> LedgerEvent:
        (found,) = [entry.event for entry in (await ledger_page(owner, desk_id)).entries if entry.seq == seq]
        return found

    said = await message(text)
    verdict = said.verdict
    assert isinstance(said, OwnerMessageResult) and verdict is not None
    assert (verdict.ok, verdict.violations, verdict.generation) == (True, [], 0)
    assert [(block.kind, block.template, block.title, block.lines, block.text) for block in verdict.blocks] == [
        ("card", "owner_said", text, [], text)]                            # the title is the owner's text
    assert owner_facts() == [{"owner", f"session:{session_id}"}]
    said_entry = await entry_at(verdict.ledger_seq)
    assert (said_entry.kind, said_entry.session_id, said_entry.summary.get("author")) == ("reply", session_id, "owner")

    await arrange.take_over(owner, session_id, 0)                          # a say during a take-over, as the API's
    during = await message("I'm here now, give me a minute.")
    assert during.verdict is not None and (during.verdict.ok, during.verdict.generation) == (True, 1)

    canary = arrange.canary(copy.copy_id)
    blocked = await message(f"Your invoice reference is {canary}.")
    assert blocked.verdict is not None and not blocked.verdict.ok and blocked.verdict.blocks == []
    assert [violation.kind for violation in blocked.verdict.violations] == ["canary"]
    assert canary not in blocked.model_dump_json() and len(owner_facts()) == 2

    whisper = "She sounds worried about cost, so go gently."
    whispered = await message(whisper, "whisper")
    assert whispered.verdict is None and len(owner_facts()) == 2
    whisper_entry = await entry_at(whispered.ledger_seq)
    assert whisper_entry.kind == "whisper" and whisper_entry.session_id in (None, session_id)
    assert "worried" not in json.dumps(whisper_entry.summary)
    assert await refused(message("Hello", caller=http.owner(other.owner_token))) == (404, "not_found")


def holds_canary_text(text: str, canary: str, run: int = 6) -> bool:
    """Whether `text`, read on its ASCII letters and digits alone, holds `run` characters of `canary` in a row."""
    key, wanted = ("".join(char for char in value.lower() if char.isascii() and char.isalnum())
                   for value in (text, canary))
    return any(wanted[start:start + run] in key for start in range(len(wanted) - run + 1))


def disguises(canary: str) -> list[str]:
    """A canary as written, in upper case and spaced out letter by letter."""
    return [canary, canary.upper(), " ".join(canary)]


@pytest.mark.kernel_plan("01b")
async def test_check_reply_finds_a_disguised_canary(kernel, ro_read, arrange):
    """A document canary in Claude's prose is found however it is written: as it is, in upper case or spaced out letter
    by letter (the kernel matches canaries on their letters and digits alone), on any Desk of the copy. The check fails
    with one `canary` violation listed first and shows only the handoff, and no span or block repeats the canary."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    canary = arrange.canary(copy.copy_id)
    created = await http.owner(copy.owner_token).call("POST /desks", a_new_desk())   # a Desk with no documents
    for slug in (desk_slug(ro_read, ro_schema, copy), created.slug):
        visitor = await new_visitor(http, slug)
        view, session_id = http.session(visitor.session_token), visitor.state.session_id
        for written in disguises(canary):
            verdict = await check_reply(view, session_id, 0, f"Your reference is {written} for the invoice.")
            kinds = [violation.kind for violation in verdict.violations]
            assert not verdict.ok and kinds[0] == "canary" and kinds.count("canary") == 1, (slug, written)
            assert [block.template for block in verdict.blocks] == ["handoff"], (slug, written)
            shown = [violation.span for violation in verdict.violations] + [block.text for block in verdict.blocks]
            assert not holds_canary_text(" ".join(shown), canary), (slug, written)


# Verification and the session's Demo inbox (Plan 01b) ----------------------------------------------------------

DANA = "dana@example.com"               # a contact on record in the Rivera seed (master plan, "Rivera seed")
SIX_DIGITS = re.compile(r"[0-9]{6}")


async def verify_start(view: CredentialView, session_id: str, contact: str) -> VerifyStarted:
    return await view.call("POST /verify/start", VerifyStartRequest(session_id=session_id, contact=contact))


async def session_inbox(view: CredentialView, session_id: str) -> list[DemoInboxEntry]:
    return await view.call("GET /demo_inbox?session_id=", query={"session_id": session_id})


def code_in(entries: list[DemoInboxEntry], entry_id: str) -> str:
    """The code in the Demo inbox entry `entry_id`."""
    (body,) = [entry.body for entry in entries if entry.entry_id == entry_id]
    (code,) = SIX_DIGITS.findall(body)
    return code


@pytest.mark.kernel_plan("01b")
async def test_verify_start_is_uniform(kernel, ro_read):
    """A contact on record, one that isn't and "owner" get the same message. Only the contact on record gets a notice:
    code-free, to the masked contact, never the owner. Its code reaches the session's Demo inbox and nothing else: not
    the answer, its notice or a ledger summary."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    sessions = [await new_visitor(http, slug) for _ in range(3)]
    views = [http.session(created.session_token) for created in sessions]
    answers = [await verify_start(view, created.state.session_id, contact)
               for view, created, contact in zip(views, sessions, (DANA, "nobody@example.com", "owner"), strict=True)]

    on_record, stranger, owner_typed = answers
    assert on_record.message == stranger.message == owner_typed.message
    assert stranger.inbox == [] and owner_typed.inbox == []
    (notice,) = on_record.inbox
    assert notice.to != "owner" and DANA not in notice.to
    assert not SIX_DIGITS.search(on_record.message) and not SIX_DIGITS.search(notice.preview)
    (entry,) = await session_inbox(views[0], sessions[0].state.session_id)
    assert (entry.entry_id, entry.to, entry.kind) == (notice.entry_id, notice.to, "verification_code")
    (code,) = SIX_DIGITS.findall(entry.body)

    # Claude's tool works the same way: its execution carries the code notice for a contact on record and none for
    # another, and Claude's view of it says nothing either way.
    executed = []
    for contact in (DANA, "nobody@example.com"):
        created = await new_visitor(http, slug)
        view = http.session(created.session_token)
        allowed = await decide(view, created.state.session_id, 0, "call-1", "native.start_verification",
                               {"contact": contact})
        assert allowed.state == "allowed"
        executed.append(await execute(view, allowed, 0))
    (tool_notice,) = executed[0].inbox
    assert executed[1].inbox == [] and tool_notice.to == notice.to and tool_notice.preview == notice.preview
    assert executed[0].model_view.keys() == executed[1].model_view.keys()
    tool_code = code_in(await http.owner(copy.owner_token).call("GET /demo_inbox"), tool_notice.entry_id)

    page = await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])
    summaries = json.dumps([entry.event.summary for entry in page.entries])
    answers = (on_record.model_dump_json(), executed[0].model_dump_json(), summaries)
    assert [text for text in answers for sent in (code, tool_code) if sent in text] == []


@pytest.mark.kernel_plan("01b")
async def test_demo_inbox_is_scoped_to_the_session(kernel, ro_read):
    """A session reads only the code entries of the challenges it started: never another session's, even for the same
    person, never an owner alert, and nothing for typing "owner" or the business's own number. It names only its own
    session; the owner reads every entry of the copy."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    first, second = await new_visitor(http, slug), await new_visitor(http, slug)
    a, b = http.session(first.session_token), http.session(second.session_token)
    a_id, b_id = first.state.session_id, second.state.session_id
    held = await decide(a, a_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500))
    assert held.state == "held" and held.inbox                                   # an owner alert in the copy

    started = await verify_start(a, a_id, DANA)
    mine = await session_inbox(a, a_id)
    assert [entry.entry_id for entry in mine] == [notice.entry_id for notice in started.inbox]
    assert {entry.kind for entry in mine} == {"verification_code"}
    assert await session_inbox(b, b_id) == []
    assert await refused(b.call("GET /demo_inbox?session_id=", query={"session_id": a_id})) == (401, "auth")
    for typed in ("owner", "(510) 555-0142"):
        assert (await verify_start(b, b_id, typed)).inbox == []
    assert await session_inbox(b, b_id) == []

    again = await verify_start(b, b_id, DANA)
    theirs = await session_inbox(b, b_id)
    # each reads the code it asked for, though both went to Dana
    assert [entry.entry_id for entry in theirs] == [notice.entry_id for notice in again.inbox]
    assert [entry.entry_id for entry in await session_inbox(a, a_id)] == [entry.entry_id for entry in mine]
    assert {entry.kind for entry in theirs} == {"verification_code"}
    every = await http.owner(copy.owner_token).call("GET /demo_inbox")
    assert {entry.entry_id for entry in mine + theirs} | {notice.entry_id for notice in held.inbox} <= {
        entry.entry_id for entry in every}


async def verify_check(view: CredentialView, session_id: str, code: str) -> SessionState:
    return await view.call("POST /verify/check", VerifyCheckRequest(session_id=session_id, code=code))


@pytest.mark.kernel_plan("01b")
async def test_verify_check_takes_only_the_sessions_live_code(kernel, ro_read):
    """Only the code of the session's own live challenge verifies it, as the person on record (assurance `demo_code`,
    the generation unchanged), and the verified tools follow. A wrong code, or a code in a session with no challenge,
    is 422 `invalid` alike; a verified session checking again stays as it is. No ledger summary holds the code."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    first, second = await new_visitor(http, slug), await new_visitor(http, slug)
    a, b = http.session(first.session_token), http.session(second.session_token)
    a_id, b_id = first.state.session_id, second.state.session_id
    await verify_start(a, a_id, DANA)
    (entry,) = await session_inbox(a, a_id)
    (code,) = SIX_DIGITS.findall(entry.body)
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"

    assert await refused(verify_check(a, a_id, wrong)) == (422, "invalid")
    assert await refused(verify_check(b, b_id, code)) == (422, "invalid")         # B started no challenge
    assert "native.release_document" not in tools(await context(a, a_id))[0]
    verified = await verify_check(a, a_id, code)
    assert (verified.session_id, verified.verified, verified.assurance) == (a_id, True, "demo_code")
    assert verified.generation == first.state.generation and verified.mode == "ai"
    assert "native.release_document" in tools(await context(a, a_id))[0]
    assert await verify_check(a, a_id, code) == verified
    assert (await b.whoami()).session.verified is False
    page = await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])
    assert code not in json.dumps([entry.event.summary for entry in page.entries])


# Single-use links: documents (Plan 01b) ---------------------------------------------------------------------------


async def cite(view: CredentialView, session_id: str, generation: int, prose: str, template: str,
               fact_id: str) -> ReplyVerdict:
    """A reply citing one fact with `template`, checked by the kernel."""
    draft = ReplyDraft(session_id=session_id, generation=generation, prose=prose,
                       clauses=[Clause(template=template, fact_id=fact_id)])
    return await view.call("POST /check_reply", CheckReplyRequest(draft=draft))


def link_token(verdict: ReplyVerdict, prefix: str) -> str:
    """The token in the verdict's one link card, whose `href` is `prefix` + token."""
    (href,) = [block.href for block in verdict.blocks if block.href is not None]
    assert href.startswith(prefix) and len(href) > len(prefix)
    return href.removeprefix(prefix)


async def open_document(http: KernelHttp, token: str) -> tuple[str, bytes]:
    """The document a link token opens, as the API's proxy reads it: its content type and bytes."""
    async with http.public().stream("GET /document_links/{token}", {"token": token}) as response:
        return response.headers["content-type"], await response.aread()


@pytest.mark.kernel_plan("01b")
async def test_document_link_is_single_use(kernel, ro_read):
    """A session verified as a document's record owner gets a single-use link to it. The token is only in the signed
    card's `href`: never in the execution, its facts or a ledger summary. The link serves the document's bytes once,
    with its content type; then it, and a token that names no link, are 404 `not_found` alike, and the link's fact is
    stale."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    created = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(created.session_token), created.state.session_id
    started = await verify_start(view, session_id, DANA)
    await verify_check(view, session_id, code_in(await session_inbox(view, session_id), started.inbox[0].entry_id))
    ((person_id,),) = [tuple(row.values()) for row in ro_read(
        ro_schema, copy.copy_id, "SELECT person_id FROM {ro}.sessions WHERE session_id = %s", (session_id,))]
    (document,) = ro_read(ro_schema, copy.copy_id, "SELECT document_id, title FROM {ro}.documents"
                                                   " WHERE desk_id = %s AND record_owner_person_id = %s",
                          (copy.desk_ids[0], person_id))

    allowed = await decide(view, session_id, 0, "call-1", "native.release_document",
                           {"document_id": document["document_id"]})
    assert allowed.state == "allowed"
    executed = await execute(view, allowed, 0)
    (fact,) = executed.facts
    assert fact.kind == "document" and executed.model_view.get("link_ready") is True
    verdict = await cite(view, session_id, 0, "Here is your invoice.", "document_link", fact.fact_id)
    assert verdict.ok
    (card,) = [block for block in verdict.blocks if block.template == "document_link"]
    assert card.title == document["title"]
    token = link_token(verdict, "/api/d/")

    content_type, body = await open_document(http, token)
    assert content_type.startswith("text/plain") and body
    assert await refused(open_document(http, token)) == (404, "not_found")
    assert await refused(open_document(http, "no-such-link-" + token[:8])) == (404, "not_found")
    stale = await cite(view, session_id, 0, "Here it is again.", "document_link", fact.fact_id)
    assert not stale.ok and [violation.kind for violation in stale.violations] == ["stale_fact"]

    page = await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])
    seen = (executed.model_dump_json(), card.text, json.dumps([entry.event.summary for entry in page.entries]))
    assert [text for text in seen if token in text] == []


@pytest.mark.kernel_plan("01b")
async def test_a_baseline_refusal_names_its_forbid(kernel, ro_read, arrange, api_ro_conn):
    """A refusal by the always-on baseline names the baseline's forbid, `B.<@id>`, with no card behind it: a session
    verified as Dana asks for a document on someone else's record, and `B.private_data_record_owner` refuses it, alike
    in the decision the session gets, the kernel's record and the row the API reads."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    created = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(created.session_token), created.state.session_id
    started = await verify_start(view, session_id, DANA)
    await verify_check(view, session_id, code_in(await session_inbox(view, session_id), started.inbox[0].entry_id))
    ((person_id,),) = [tuple(row.values()) for row in ro_read(
        ro_schema, copy.copy_id, "SELECT person_id FROM {ro}.sessions WHERE session_id = %s", (session_id,))]
    (document,) = ro_read(ro_schema, copy.copy_id, "SELECT document_id FROM {ro}.documents WHERE desk_id = %s"
                                                   " AND record_owner_person_id <> %s ORDER BY document_id LIMIT 1",
                          (copy.desk_ids[0], person_id))

    refusal = await decide(view, session_id, 0, "call-1", "native.release_document",
                           {"document_id": document["document_id"]})
    assert (refusal.outcome, refusal.state, refusal.card_ids) == ("refuse", "refused", [])
    expected = ["B.private_data_record_owner"]
    assert refusal.policy_ids == arrange.recorded_policy_ids(refusal.decision_id) == expected
    assert await read_policy_ids(api_ro_conn, ro_schema, copy, refusal.decision_id) == expected
    assert await read_refusal_cause(api_ro_conn, ro_schema, copy, refusal.decision_id) == "not_their_record"


# Single-use links: payment links (Plan 01c) -------------------------------------------------------------------------

LINK_ROUTES = ("GET /payment_links/{token}", "POST /payment_links/{token}/complete",
               "POST /payment_links/{token}/cancel")


async def issue_payment_link(view: CredentialView, session_id: str, item: str, n: int, *,
                             owner: CredentialView | None = None) -> tuple[str, ExecResult]:
    """A payment link for the session's own quote of one `item`, under the Rivera seed's `rv-link` card, which allows
    a link only with the reviewer's pass: the token in its card's `href`, and the link's execution. The fake kernel
    has no reviewer and allows it. A kernel whose reviewer gives no review (the real kernel's offline reviewer, as
    `make kernel-contract` runs it) holds it instead, and `owner`, given for that kernel, approves it once, so the
    approved execution issues the link."""
    quoted = await execute(view, await decide(view, session_id, 0, f"call-quote-{n}", "native.quote",
                                              quote_args(item)), 0)
    linked = await decide(view, session_id, 0, f"call-link-{n}", "native.payment_link",
                          {"quote_id": quoted.model_view["quote_id"]})
    assert linked.state == ("held" if owner is not None else "allowed") and linked.action.amount_cents == 2000
    if owner is not None:
        approved = await answer(owner, linked.decision_id, "allow_once")
        assert approved.decision.state == "executed" and approved.execution is not None
        issued = approved.execution
    else:
        issued = await execute(view, linked, 0)
    (fact,) = issued.facts
    assert fact.kind == "payment_link" and set(issued.model_view) == {"fact_id", "title", "amount_cents"}
    verdict = await cite(view, session_id, 0, "Here is your payment link.", "payment_link", fact.fact_id)
    assert verdict.ok
    return link_token(verdict, "/pay/"), issued


async def checkout(http: KernelHttp, route: str, token: str):
    """One of the mock checkout's calls on the link `token` names, which needs no other credential."""
    body = None if route.startswith("GET ") else PaymentLinkActionRequest()
    return await http.public().call(route, body, path={"token": token})


@pytest.mark.kernel_plan("01c")
async def test_payment_link_completes_once(kernel, ro_read):
    """The checkout reads a link by its token alone, which only the card's `href` carries. Completing it pays it once
    and answers with the `payment_confirmed` verdict for the link's session, signed at its current generation; once
    paid, completing or cancelling it again is 409 `conflict` and it reads `paid`. A link cancelled at checkout pays
    nothing and has no verdict. A token that names no link is 404 `not_found` on every route."""
    http, ro_schema, state = kernel
    copy = await new_copy(http)
    created = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(created.session_token), created.state.session_id
    deposit = item_id(ro_read, ro_schema, copy, "Service call deposit")
    owner = http.owner(copy.owner_token) if state is None else None      # the real kernel holds it for the owner
    (paying, issued), (cancelling, _) = [await issue_payment_link(view, session_id, deposit, n, owner=owner)
                                         for n in (1, 2)]
    get, complete, cancel = LINK_ROUTES

    shown = await checkout(http, get, paying)
    assert (shown.state, shown.amount_cents, shown.language) == ("issued", 2000, "en")
    assert shown.title == issued.model_view["title"]
    # the business as its public page names it; a stranger's link names no customer and was cancelled by nothing
    assert (shown.business_name, shown.customer_name, shown.cancel_reason) == ("Rivera Plumbing", None, None)
    paid = await checkout(http, complete, paying)
    assert (paid.state, paid.session_id) == ("paid", session_id)
    assert paid.verdict is not None and paid.verdict.ok and paid.verdict.generation == created.state.generation
    assert [block.template for block in paid.verdict.blocks] == ["payment_confirmed"]
    for again in (complete, cancel):
        assert await refused(checkout(http, again, paying)) == (409, "conflict")
    assert (await checkout(http, get, paying)).state == "paid"

    cancelled = await checkout(http, cancel, cancelling)
    assert (cancelled.state, cancelled.session_id, cancelled.verdict) == ("cancelled", session_id, None)
    assert await refused(checkout(http, complete, cancelling)) == (409, "conflict")
    assert (await checkout(http, get, cancelling)).state == "cancelled"
    links = ro_read(ro_schema, copy.copy_id, "SELECT state, amount_cents, action_id FROM {ro}.payment_links"
                                             " WHERE session_id = %s ORDER BY state DESC", (session_id,))
    assert [{key: link[key] for key in ("state", "amount_cents")} for link in links] == [
        {"state": "paid", "amount_cents": 2000}, {"state": "cancelled", "amount_cents": 2000}]
    assert links[0]["action_id"] == issued.action_id      # the execution that issued the link

    for route in LINK_ROUTES:
        assert await refused(checkout(http, route, "no-such-link-" + paying[:8])) == (404, "not_found")
    page = await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])
    summaries = json.dumps([entry.event.summary for entry in page.entries])
    assert [token for token in (paying, cancelling) if token in summaries or token in issued.model_dump_json()] == []


@pytest.mark.kernel_plan("01c")
async def test_paid_link_is_ledgered_paid_once(kernel, ro_read):
    """The owner's reports time a link's payment by its ledger entries: completing a link writes one `payment` entry
    `{link_id, state: "paid"}` for it, and each refused retry after that (completing or cancelling the paid link again)
    is ledgered `payment` for the link marked `refused: true`, so no retry reads as another move to `paid`."""
    http, ro_schema, state = kernel
    copy = await new_copy(http)
    created = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(created.session_token), created.state.session_id
    owner = http.owner(copy.owner_token) if state is None else None      # the real kernel holds it for the owner
    token, _ = await issue_payment_link(view, session_id, item_id(ro_read, ro_schema, copy, "Service call deposit"), 1,
                                        owner=owner)
    _, complete, cancel = LINK_ROUTES
    assert (await checkout(http, complete, token)).state == "paid"
    for again in (complete, cancel):
        assert await refused(checkout(http, again, token)) == (409, "conflict")

    (link,) = ro_read(ro_schema, copy.copy_id, "SELECT link_id FROM {ro}.payment_links WHERE session_id = %s",
                      (session_id,))
    page = await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])
    entries = [entry.event.summary for entry in page.entries
               if entry.event.kind == "payment" and entry.event.summary.get("link_id") == link["link_id"]]
    (paid,) = [n for n, summary in enumerate(entries) if summary.get("state") == "paid" and not summary.get("refused")]
    assert [summary.get("refused") for summary in entries[paid + 1:]] == [True, True]


# Signed visiting agents and mandates (Plan 01c) ---------------------------------------------------------------------


async def demo_agent(http: KernelHttp, copy: CopyCreated) -> DemoAgentIssued:
    """A demo agent minted by the copy's owner for its first Desk: its key and a demo-wallet mandate."""
    return await http.owner(copy.owner_token).call("POST /agents/demo", DemoAgentRequest(desk_id=copy.desk_ids[0]))


def a2a_body(slug: str, message: str = "Hello, can you help?", session_id: str | None = None) -> bytes:
    """The raw bytes of an A2A request, whose sha256 the agent signs and the API forwards."""
    return json.dumps({"desk_slug": slug, "session_id": session_id, "message": message}).encode()


def agent_auth(issued: DemoAgentIssued, slug: str, body: bytes, *, nonce: str | None = None,
               ts: datetime | None = None, signed_slug: str | None = None,
               signer: DemoAgentIssued | None = None) -> tuple[AgentAuth, str]:
    """The `AgentAuth` headers of one A2A request in `issued`'s name, signed with the agent's key (or `signer`'s)
    over `{desk_slug, ts, nonce, body_sha256}`, and the body's sha256."""
    digest = hashlib.sha256(body).hexdigest()
    when = signed_time(ts or datetime.now(UTC))
    nonce = nonce or secrets.token_hex(16)
    sig = agent_signature((signer or issued).agent_private_key_hex, signed_slug or slug, when, nonce, digest)
    return AgentAuth(agent_key_id=issued.agent_key_id, ts=when, nonce=nonce, sig=sig), digest


def signed_view(http: KernelHttp, issued: DemoAgentIssued, slug: str, body: bytes, **options) -> CredentialView:
    """The agent's view for one A2A request (`agent_auth`)."""
    return http.agent(*agent_auth(issued, slug, body, **options))


async def open_agent_session(http: KernelHttp, issued: DemoAgentIssued, slug: str, *, mandate: bool = True,
                             nonce: str | None = None) -> tuple[SessionCreated, CredentialView]:
    """A signed agent `POST /sessions`, with the agent's mandate unless `mandate` is False, and the view it used."""
    view = signed_view(http, issued, slug, a2a_body(slug), nonce=nonce)
    created = await view.call("POST /sessions", CreateSessionRequest(
        desk_slug=slug, kind="agent", mandate=issued.mandate if mandate else None))
    return created, view


def turn_view(http: KernelHttp, issued: DemoAgentIssued, slug: str, session_id: str, message: str) -> CredentialView:
    """The view of a later A2A request in the agent's session: a new body and a new nonce."""
    return signed_view(http, issued, slug, a2a_body(slug, message, session_id))


@pytest.mark.kernel_plan("01c")
async def test_agent_session_needs_a_valid_signature(kernel, ro_read):
    """An agent session opens and is read by signature alone: no session token, the key bound to the session at
    creation, its mandate recorded. A signature by another key, over another slug or with a stale timestamp is 401,
    as is any agent call carrying no signature."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    assert issued.mandate.agent_key_id == issued.agent_key_id and issued.mandate.desk_id == copy.desk_ids[0]

    created, view = await open_agent_session(http, issued, slug)
    session_id = created.state.session_id
    assert created.session_token is None
    assert (created.state.kind, created.state.mode, created.state.verified) == ("agent", "ai", False)
    who = await view.whoami(session_id)
    assert (who.kind, who.copy_id, who.desk_id, who.desk_ids) == ("agent", copy.copy_id, copy.desk_ids[0],
                                                                  copy.desk_ids)
    assert who.session == created.state
    (row,) = ro_read(ro_schema, copy.copy_id, "SELECT kind, agent_key_id, mandate_id FROM {ro}.sessions"
                                              " WHERE session_id = %s", (session_id,))
    assert row == {"kind": "agent", "agent_key_id": issued.agent_key_id, "mandate_id": issued.mandate.mandate_id}

    other = await demo_agent(http, copy)
    body = a2a_body(slug, "Hi again", session_id)
    forged = signed_view(http, issued, slug, body, signer=other)     # another key's signature under this key's name
    assert await refused(forged.whoami(session_id)) == (401, "auth")
    stale = signed_view(http, issued, slug, body, ts=datetime.now(UTC) - timedelta(minutes=10))
    assert await refused(stale.whoami(session_id)) == (401, "auth")
    elsewhere = signed_view(http, issued, slug, body, signed_slug=slug + "-elsewhere")
    assert await refused(elsewhere.whoami(session_id)) == (401, "auth")
    assert await refused(http.public().call("POST /sessions", CreateSessionRequest(desk_slug=slug, kind="agent"))) == (
        401, "auth")
    assert await refused(context(http.public(), session_id)) == (401, "auth")
    assert await refused(decide(http.public(), session_id, 0, "call-unsigned", "native.find_slots", {})) == (
        401, "auth")
    assert (await turn_view(http, issued, slug, session_id, "Still there?").whoami(session_id)).session == created.state


@pytest.mark.kernel_plan("01c")
async def test_agent_nonce_is_bound_to_one_body(kernel, ro_read):
    """A nonce's first use binds it to its session and body hash: the same request may repeat it within its turn,
    while another body or another session under it is 401."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    created, _ = await open_agent_session(http, issued, slug)
    second, _ = await open_agent_session(http, issued, slug, mandate=False)    # a mandate opens one session
    session_id = created.state.session_id

    nonce = secrets.token_hex(16)
    body = a2a_body(slug, "What are your hours?", session_id)
    first = signed_view(http, issued, slug, body, nonce=nonce)
    assert (await first.whoami(session_id)).session.session_id == session_id
    assert (await signed_view(http, issued, slug, body, nonce=nonce).whoami(session_id)).session.session_id == (
        session_id)                                                    # the same request, again within its turn
    assert isinstance(await context(first, session_id), SessionContext)
    other_body = signed_view(http, issued, slug, a2a_body(slug, "Something else", session_id), nonce=nonce)
    assert await refused(other_body.whoami(session_id)) == (401, "auth")
    other_session = signed_view(http, issued, slug, body, nonce=nonce)
    assert await refused(other_session.whoami(second.state.session_id)) == (401, "auth")


@pytest.mark.kernel_plan("01c")
async def test_signed_request_for_another_agents_session_is_refused(kernel, ro_read):
    """Agent B's valid signature naming agent A's session reads and decides nothing there: 401, ledgered
    `agent_auth`."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    agent_a, agent_b = await demo_agent(http, copy), await demo_agent(http, copy)
    created, _ = await open_agent_session(http, agent_a, slug)
    session_id = created.state.session_id
    owner = http.owner(copy.owner_token)
    before = len((await ledger_page(owner, copy.desk_ids[0])).entries)

    b_view = turn_view(http, agent_b, slug, session_id, "Let me see A's chat")
    assert await refused(b_view.whoami(session_id)) == (401, "auth")
    assert await refused(context(b_view, session_id)) == (401, "auth")
    assert await refused(decide(b_view, session_id, 0, "call-b", "native.find_slots", {})) == (401, "auth")
    assert await refused(check_reply(b_view, session_id, 0, "Happy to help.")) == (401, "auth")
    assert await refused(turn(b_view, session_id, 0, "Let me see A's chat")) == (401, "auth")
    entries = (await ledger_page(owner, copy.desk_ids[0])).entries[before:]
    assert entries and {entry.event.kind for entry in entries} == {"agent_auth"}
    assert agent_b.agent_private_key_hex not in json.dumps([entry.event.summary for entry in entries])


@pytest.mark.kernel_plan("01c")
async def test_refused_agent_signatures_are_ledgered(kernel, ro_read):
    """Each refused agent call is an `agent_auth` entry on the Desk of the session it names: the route, why it was
    refused and the key it named, never a signature, nonce or key."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    agent_a, agent_b = await demo_agent(http, copy), await demo_agent(http, copy)
    created, _ = await open_agent_session(http, agent_a, slug)
    session_id = created.state.session_id
    owner = http.owner(copy.owner_token)
    start = (await ledger_page(owner, copy.desk_ids[0])).entries[-1].seq

    body = a2a_body(slug, "Hello again", session_id)
    short_nonce = signed_view(http, agent_a, slug, body, nonce="too-short")   # a nonce takes 16 to 128 characters
    forged = signed_view(http, agent_a, slug, body, signer=agent_b)    # B's signature under A's key
    stale = signed_view(http, agent_a, slug, body, ts=datetime.now(UTC) - timedelta(minutes=10))
    for view in (short_nonce, forged, stale, turn_view(http, agent_b, slug, session_id, "Let me see A's chat")):
        assert await refused(view.whoami(session_id)) == (401, "auth")
    assert await refused(context(turn_view(http, agent_b, slug, session_id, "And its facts"), session_id)) == (
        401, "auth")
    entries = [entry.event for entry in (await ledger_page(owner, copy.desk_ids[0])).entries if entry.seq > start]
    assert [(event.kind, event.session_id, event.summary) for event in entries] == [
        ("agent_auth", session_id, {"route": "GET /whoami", "reason": "malformed",
                                    "agent_key_id": agent_a.agent_key_id}),
        ("agent_auth", session_id, {"route": "GET /whoami", "reason": "bad_signature",
                                    "agent_key_id": agent_a.agent_key_id}),
        ("agent_auth", session_id, {"route": "GET /whoami", "reason": "stale_timestamp",
                                    "agent_key_id": agent_a.agent_key_id}),
        ("agent_auth", session_id, {"route": "GET /whoami", "reason": "wrong_key",
                                    "agent_key_id": agent_b.agent_key_id}),
        ("agent_auth", session_id, {"route": "GET /context/{session_id}", "reason": "wrong_key",
                                    "agent_key_id": agent_b.agent_key_id})]


@pytest.mark.kernel_plan("01c")
async def test_nonce_reuse_after_the_turn_is_replayed(kernel, ro_read):
    """A nonce's turn ends at a passing verdict, an immediate handoff or the second reply check; after that the same
    request is 409 `replayed`, and any other reuse 401."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    created, _ = await open_agent_session(http, issued, slug)
    session_id = created.state.session_id

    async def turn(message: str, *drafts: str) -> CredentialView:
        view = turn_view(http, issued, slug, session_id, message)
        assert (await view.whoami(session_id)).session.session_id == session_id
        for draft in drafts:
            await check_reply(view, session_id, 0, draft)
        return view

    passed = await turn("When are you open?", "We're open on weekdays.")
    assert await refused(passed.whoami(session_id)) == (409, "replayed")
    assert await refused(context(passed, session_id)) == (409, "replayed")
    assert await refused(passed.call("POST /sessions/{session_id}/turn", TurnRequest(
        generation=0, text="When are you open?"), path={"session_id": session_id})) == (409, "replayed")
    handed_off = await turn("Parlez-vous français ?", "Bonjour, je peux vous aider.")   # unsupported_language
    assert await refused(handed_off.whoami(session_id)) == (409, "replayed")
    twice = await turn("How much is it?", "It costs 50 dollars.")
    assert (await twice.whoami(session_id)).session.session_id == session_id      # one blocked check: still its turn
    await check_reply(twice, session_id, 0, "It costs 60 dollars.")
    assert await refused(twice.whoami(session_id)) == (409, "replayed")
    assert await refused(passed.whoami(created.state.session_id + "x")) == (401, "auth")


@pytest.mark.kernel_plan("01c")
async def test_demo_inbox_shows_the_codes_a_sessions_own_agent_asked_for(kernel, ro_read):
    """A visitor session's Demo inbox shows the codes a demo agent it minted asked for, as if it had asked itself (the
    built-in agent acts for the visitor who sent it), and never the codes of an agent another session or the owner
    minted."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    minter, bystander = await new_visitor(http, slug), await new_visitor(http, slug)
    minter_view, minter_id = http.session(minter.session_token), minter.state.session_id
    issued = await minter_view.call("POST /agents/demo", DemoAgentRequest(desk_id=copy.desk_ids[0]))
    created, _ = await open_agent_session(http, issued, slug)
    agent_id = created.state.session_id
    started = await verify_start(turn_view(http, issued, slug, agent_id, "Please verify Dana"), agent_id, DANA)
    (notice,) = started.inbox

    owners_agent = await demo_agent(http, copy)
    owners_session, _ = await open_agent_session(http, owners_agent, slug)
    owners_id = owners_session.state.session_id
    bob = await verify_start(turn_view(http, owners_agent, slug, owners_id, "Please verify Bob"), owners_id,
                             "bob@example.com")
    assert len(bob.inbox) == 1

    mine = await session_inbox(minter_view, minter_id)
    assert [(entry.entry_id, entry.kind) for entry in mine] == [(notice.entry_id, "verification_code")]
    assert await session_inbox(http.session(bystander.session_token), bystander.state.session_id) == []


@pytest.mark.kernel_plan("01c")
async def test_a_disguised_canary_ends_an_agents_turn(kernel, ro_read, arrange):
    """A document canary in an agent session's reply is an immediate handoff however it is written, so its first reply
    check ends the turn: the same request is 409 `replayed` after it."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    created, _ = await open_agent_session(http, issued, slug)
    session_id = created.state.session_id
    canary = arrange.canary(copy.copy_id)
    for n, written in enumerate(disguises(canary)):
        view = turn_view(http, issued, slug, session_id, f"What is my reference? ({n})")
        assert (await view.whoami(session_id)).session.session_id == session_id
        verdict = await check_reply(view, session_id, 0, f"Your reference is {written} for the invoice.")
        assert not verdict.ok and verdict.violations[0].kind == "canary", written
        assert await refused(view.whoami(session_id)) == (409, "replayed"), written


@pytest.mark.kernel_plan("01c")
async def test_resent_opening_request_returns_the_bound_session(kernel, ro_read):
    """An opening request sent again with the same key, nonce and body gets the session its first try opened, during
    its turn and after it, and opens no other; under another body the nonce is 401."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    nonce = secrets.token_hex(16)
    created, view = await open_agent_session(http, issued, slug, nonce=nonce)
    session_id = created.state.session_id

    during, _ = await open_agent_session(http, issued, slug, nonce=nonce)
    assert during == created
    verdict = await check_reply(view, session_id, 0, "Happy to help.")
    assert verdict.ok
    after, _ = await open_agent_session(http, issued, slug, nonce=nonce)
    assert after.state.session_id == session_id and after.session_token is None
    assert await refused(view.whoami(session_id)) == (409, "replayed")
    rows = ro_read(ro_schema, copy.copy_id, "SELECT session_id FROM {ro}.sessions WHERE desk_id = %s AND kind = 'agent'",
                   (copy.desk_ids[0],))
    assert rows == [{"session_id": session_id}]
    other_body = signed_view(http, issued, slug, a2a_body(slug, "Another opening"), nonce=nonce)
    assert await refused(other_body.call("POST /sessions", CreateSessionRequest(desk_slug=slug, kind="agent"))) == (
        401, "auth")


@pytest.mark.kernel_plan("01c")
async def test_agent_tools_follow_the_mandate(kernel, ro_read):
    """An agent is never given refunds; it is given the mandate charge and payment links only with a verified
    mandate, and without one the kernel refuses both before anything is normalized."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    deposit = item_id(ro_read, ro_schema, copy, "Service call deposit")

    bare, _ = await open_agent_session(http, issued, slug, mandate=False)
    bare_id = bare.state.session_id
    view = turn_view(http, issued, slug, bare_id, "I'd like to pay the deposit")
    given, declared = tools(await context(view, bare_id))
    assert not given & {"native.payment_link", "native.charge_mandate", "payments.create_refund"}
    assert {"native.quote", "native.find_slots", "native.book"} <= given
    assert {"native.payment_link", "native.charge_mandate"} <= declared and "payments.create_refund" not in declared
    quoted = await execute(view, await decide(view, bare_id, 0, "call-quote", "native.quote", quote_args(deposit)), 0)
    for n, tool in enumerate(("native.charge_mandate", "native.payment_link")):
        refusal = await decide(view, bare_id, 0, f"call-money-{n}", tool, {"quote_id": quoted.model_view["quote_id"]})
        assert (refusal.outcome, refusal.state, refusal.action) == ("refuse", "refused", None)

    with_mandate, _ = await open_agent_session(http, issued, slug)
    session_id = with_mandate.state.session_id
    given, declared = tools(await context(turn_view(http, issued, slug, session_id, "Hello"), session_id))
    assert {"native.payment_link", "native.charge_mandate"} <= given and "payments.create_refund" not in given
    assert "payments.create_refund" not in declared


@pytest.mark.kernel_plan("01c")
async def test_charge_mandate_bounds_and_commits(kernel, ro_read):
    """A mandate charge is allowed only within the mandate's remaining amount, reserved and committed at execution,
    with a `charge` fact rendered as `charge_confirmed`. The demo mandate ($20 a charge, $100 in all) takes five
    deposits; a charge above $20, and a sixth, are refused at `/decide`."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    created, _ = await open_agent_session(http, issued, slug)
    session_id = created.state.session_id
    deposit = item_id(ro_read, ro_schema, copy, "Service call deposit")
    leak = item_id(ro_read, ro_schema, copy, "Leak repair")

    async def charge(n: int, item: str) -> tuple[CredentialView, Decision]:
        view = turn_view(http, issued, slug, session_id, f"Charge number {n}")
        quoted = await execute(view, await decide(view, session_id, 0, f"call-quote-{n}", "native.quote",
                                                  quote_args(item)), 0)
        return view, await decide(view, session_id, 0, f"call-charge-{n}", "native.charge_mandate",
                                  {"quote_id": quoted.model_view["quote_id"]})

    view, first = await charge(1, deposit)
    assert (first.outcome, first.action.amount_cents) == ("allow", 2000)
    charged = await execute(view, first, 0)
    (fact,) = charged.facts
    assert charged.state == "succeeded" and fact.kind == "charge"
    verdict = await cite(view, session_id, 0, "The deposit is paid.", "charge_confirmed", fact.fact_id)
    assert verdict.ok and [block.template for block in verdict.blocks] == [None, "charge_confirmed"]

    _, too_much = await charge(2, leak)
    assert (too_much.outcome, too_much.state) == ("refuse", "refused")
    for n in range(3, 7):
        view, allowed = await charge(n, deposit)
        assert (await execute(view, allowed, 0)).state == "succeeded"
    _, sixth = await charge(7, deposit)
    assert (sixth.outcome, sixth.state) == ("refuse", "refused")
    (mandate,) = ro_read(ro_schema, copy.copy_id, "SELECT committed_cents, reserved_cents FROM {ro}.mandates"
                                                  " WHERE mandate_id = %s", (issued.mandate.mandate_id,))
    assert mandate == {"committed_cents": 10_000, "reserved_cents": 0}


# Setup: a new Desk and the owner's setup tools (Plans 01b and 01c) ---------------------------------------------------

SETUP_TOOLS = {"native.fetch_website", "native.read_memory"}
# `PRESETS["ask_first"]`: auto for anyone on these, everything else asks (Plan 01a).
ASK_FIRST_AUTO = {"native.find_slots", "native.capture_lead", "native.request_callback", "native.start_verification",
                  *SETUP_TOOLS}


def a_new_desk(**business) -> CreateDeskRequest:
    """A Desk as setup first makes it: the business, and every other part of the seed empty."""
    seed = DeskSeed(name="Main line", charter=[], hours=[], price_items=[], calendar_slots=[], people=[], documents=[],
                    notifications=NotificationDefaults(now=["approval", "breaker", "lockout"],
                                                       briefing=["lead", "callback", "booking"]))
    fields = {"name": "Okafor Electric", "owner_display_name": "Bob Okafor", "timezone": "America/New_York",
              **business}
    return CreateDeskRequest(business=BusinessSeed(**fields), desk=seed)


@pytest.mark.kernel_plan("01b")
async def test_owner_creates_a_desk_with_the_starter_preset(kernel, ro_read):
    """`POST /desks` adds a Desk to the owner's own copy, with its business, native tools only and the `ask_first`
    preset active (auto for the utility and setup tools; the setup tools' own rows come with Plan 01c, which
    `test_owner_setup_tool_runs_on_the_owners_desk` checks); a `connections` list, an owner name outside the pattern
    or an unknown time zone is 422 `invalid`, and another copy's business 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    assert isinstance(created, DeskCreated) and created.desk_id not in copy.desk_ids
    assert created.desk_id in (await owner.whoami()).desk_ids
    assert created.desk_id not in (await http.owner(other.owner_token).whoami()).desk_ids

    def rows(query: str) -> list[dict]:
        return ro_read(ro_schema, copy.copy_id, query, (created.desk_id,))

    (desk,) = rows("SELECT slug, business_id, name FROM {ro}.desks WHERE desk_id = %s")
    assert desk["slug"] == created.slug and created.slug.startswith("okafor-electric-") and desk["name"] == "Main line"
    (business,) = ro_read(ro_schema, copy.copy_id, "SELECT name, owner_display_name, timezone FROM {ro}.businesses"
                                                   " WHERE business_id = %s", (desk["business_id"],))
    assert business == {"name": "Okafor Electric", "owner_display_name": "Bob Okafor", "timezone": "America/New_York"}
    tools_rows = rows("SELECT tool, source, status FROM {ro}.tools WHERE desk_id = %s")
    assert {row["source"] for row in tools_rows} == {"native"}
    (active,) = rows("SELECT version, cards FROM {ro}.policy_versions WHERE desk_id = %s AND status = 'active'")
    owner_cards = [card for card in active["cards"] if not card["is_default"]]
    assert {card["applies_to"] for card in owner_cards} == ASK_FIRST_AUTO
    assert all(card["mode"] == "auto" and card["who"] == "anyone" and card["card_id"].startswith("preset-")
               for card in owner_cards)

    connected = a_new_desk()
    connected.desk.connections = ["mock_payments"]
    for request in (connected, a_new_desk(owner_display_name="Bob Okafor 2nd"), a_new_desk(timezone="Mars/Olympus")):
        assert await refused(owner.call("POST /desks", request)) == (422, "invalid")
    elsewhere = a_new_desk(existing_business_id=desk["business_id"])
    assert await refused(http.owner(other.owner_token).call("POST /desks", elsewhere)) == (404, "not_found")
    assert len((await owner.whoami()).desk_ids) == 2


@pytest.mark.kernel_plan("01b")
async def test_owner_renames_the_business(kernel, ro_read):
    """`PUT /desks/{id}/business` replaces the business's name, owner name and time zone (the public page names
    the new owner), ledgered `desk_data`; a bad owner name is 422, another copy's Desk 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk(owner_display_name="Okafor Electric"))
    renamed = DeskBusinessRequest(name="Okafor Electric", owner_display_name="Bob Okafor", timezone="America/Chicago")
    updated = await owner.call("PUT /desks/{id}/business", renamed, path={"id": created.desk_id})
    assert isinstance(updated, DeskUpdated) and updated.desk_id == created.desk_id
    (business,) = ro_read(ro_schema, copy.copy_id, "SELECT b.owner_display_name, b.timezone FROM {ro}.businesses b"
                                                   " JOIN {ro}.desks d USING (business_id) WHERE d.desk_id = %s",
                          (created.desk_id,))
    assert business == {"owner_display_name": "Bob Okafor", "timezone": "America/Chicago"}
    public = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": created.slug})
    assert public.owner_display_name == "Bob Okafor"
    parts = [entry.event.summary.get("part") for entry in (await ledger_page(owner, created.desk_id)).entries
             if entry.event.kind == "desk_data"]
    assert "business" in parts

    bad = renamed.model_copy(update={"owner_display_name": "Bob <Okafor>"})
    assert await refused(owner.call("PUT /desks/{id}/business", bad, path={"id": created.desk_id})) == (422, "invalid")
    elsewhere = http.owner(other.owner_token).call("PUT /desks/{id}/business", renamed, path={"id": created.desk_id})
    assert await refused(elsewhere) == (404, "not_found")


@pytest.mark.kernel_plan("01b")
async def test_deleted_desk_closes_sessions(kernel, ro_read):
    """`DELETE /desks/{id}`, by the owner of its copy (another copy's owner gets 404), answers 204: the Desk's sessions
    close (409 `closed`), its public page is gone (404, as for a slug that names no Desk), a new session on it is 409
    `closed`, the owner's routes naming it answer 409 `closed`, and its ledger stays, with the deletion's `desk_data`
    entry once, followed by an `auth` entry for each call refused after it."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    visitor = await new_visitor(http, created.slug)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    path = {"id": created.desk_id}

    assert await refused(http.owner(other.owner_token).call("DELETE /desks/{id}", path=path)) == (404, "not_found")
    assert created.desk_id in (await owner.whoami()).desk_ids
    assert await owner.call("DELETE /desks/{id}", path=path) is None
    assert (await owner.whoami()).desk_ids == copy.desk_ids          # the copy's live Desks only (Plan 01a)
    assert await refused(decide(view, session_id, 0, "call-after", "native.find_slots", {})) == (409, "closed")
    (closed,) = ro_read(ro_schema, copy.copy_id, "SELECT closed_at FROM {ro}.sessions WHERE session_id = %s",
                        (session_id,))
    assert closed["closed_at"] is not None
    gone = http.public().call("GET /public/{desk_slug}", path={"desk_slug": created.slug})
    assert await refused(gone) == (404, "not_found")
    assert await refused(new_visitor(http, created.slug)) == (409, "closed")
    assert await refused(new_visitor(http, created.slug + "-unknown")) == (404, "not_found")
    answering = owner.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False), path=path)
    assert await refused(answering) == (409, "closed")
    assert await refused(owner.call("DELETE /desks/{id}", path=path)) == (409, "closed")
    page = await ledger_page(owner, created.desk_id)
    (deletion,) = [n for n, entry in enumerate(page.entries)
                   if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "desk"
                   and entry.event.summary.get("deleted")]
    assert page.chain_ok and page.entries[deletion].event.summary == {"part": "desk", "deleted": True}
    # every call refused after it is ledgered on the Desk, as `auth` with the route and the reason, and the session
    # it named; the slug that names no Desk has no ledger to go on
    assert [(entry.event.kind, entry.event.origin, entry.event.session_id, entry.event.summary)
            for entry in page.entries[deletion + 1:]] == [
        ("auth", "kernel", session_id, {"route": "POST /decide", "reason": "closed"}),
        ("auth", "kernel", None, {"route": "POST /sessions", "reason": "closed"}),
        ("auth", "kernel", None, {"route": "PUT /desks/{id}/answering", "reason": "closed"}),
        ("auth", "kernel", None, {"route": "DELETE /desks/{id}", "reason": "closed"})]
    # the copy's other Desk is untouched
    rivera = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    assert (await context(http.session(rivera.session_token), rivera.state.session_id)).tools


@pytest.mark.kernel_plan("01c")
async def test_deleted_desk_refuses_agent_sessions(kernel):
    """An agent's signed `POST /sessions` on a deleted Desk is 409 `closed`, whether it opens a session or resends
    an opening whose nonce is bound to one; an unsigned one is still 401 `auth`."""
    http, _, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    issued = await owner.call("POST /agents/demo", DemoAgentRequest(desk_id=created.desk_id))
    nonce = secrets.token_hex(16)
    await open_agent_session(http, issued, created.slug, mandate=False, nonce=nonce)

    assert await owner.call("DELETE /desks/{id}", path={"id": created.desk_id}) is None
    assert await refused(open_agent_session(http, issued, created.slug, mandate=False)) == (409, "closed")
    resent = open_agent_session(http, issued, created.slug, mandate=False, nonce=nonce)
    assert await refused(resent) == (409, "closed")
    unsigned = http.public().call("POST /sessions", CreateSessionRequest(desk_slug=created.slug, kind="agent"))
    assert await refused(unsigned) == (401, "auth")


@pytest.mark.kernel_plan("01c")
async def test_no_demo_agent_for_a_deleted_desk(kernel):
    """No demo agent is minted for a deleted Desk: its owner gets 409 `closed`, and so does a visitor session that
    was open on it when it was deleted, each ledgered `auth` on the Desk."""
    http, _, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    visitor = await new_visitor(http, created.slug)
    assert await owner.call("DELETE /desks/{id}", path={"id": created.desk_id}) is None
    start = (await ledger_page(owner, created.desk_id)).entries[-1].seq

    request = DemoAgentRequest(desk_id=created.desk_id)
    assert await refused(owner.call("POST /agents/demo", request)) == (409, "closed")
    assert await refused(http.session(visitor.session_token).call("POST /agents/demo", request)) == (409, "closed")
    assert [(entry.event.kind, entry.event.session_id, entry.event.summary)
            for entry in (await ledger_page(owner, created.desk_id)).entries if entry.seq > start] == [
        ("auth", None, {"route": "POST /agents/demo", "reason": "closed"}),
        ("auth", visitor.state.session_id, {"route": "POST /agents/demo", "reason": "closed"})]


@pytest.mark.kernel_plan("01c")
async def test_owner_setup_tool_runs_on_the_owners_desk(kernel, ro_read):
    """A Desk `POST /desks` makes has the setup tools among its native tools, and the owner session has them, and
    only them, on its own Desks: a memory read is decided and executed as the owner on the Desk it names, storing
    owner-only knowledge. A visitor tool asked by the owner, a setup tool asked by a visitor, or the owner of another
    copy naming this Desk is refused."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    tools_rows = ro_read(ro_schema, copy.copy_id, "SELECT tool, source FROM {ro}.tools WHERE desk_id = %s",
                         (created.desk_id,))
    assert {row["source"] for row in tools_rows} == {"native"} and SETUP_TOOLS <= {row["tool"] for row in tools_rows}
    session = (await owner.whoami()).session
    assert tools(await context(owner, session.session_id, created.desk_id)) == (SETUP_TOOLS, SETUP_TOOLS)

    call = ToolCall(call_id="setup-memory", tool="native.read_memory", args={"query": "business hours"})
    decision = await owner.call("POST /decide", DecideRequest(session_id=session.session_id,
                                                              generation=session.generation, call=call,
                                                              desk_id=created.desk_id))
    assert decision.outcome == "allow" and decision.session_id == session.session_id
    assert decision.action.desk_id == created.desk_id and decision.action.resource.kind == "desk"
    result = await execute(owner, decision, session.generation)
    assert result.state == "succeeded" and result.model_view["simulated"] is True and result.model_view["items"]
    knowledge = ro_read(ro_schema, copy.copy_id, "SELECT source, readers FROM {ro}.knowledge_items"
                                                 " WHERE desk_id = %s", (created.desk_id,))
    assert knowledge and all(row == {"source": "memory_import", "readers": ["owner"]} for row in knowledge)
    assert (await read_decision(owner, decision.decision_id)).state == "executed"

    slots = await owner.call("POST /decide", DecideRequest(
        session_id=session.session_id, generation=session.generation, desk_id=created.desk_id,
        call=ToolCall(call_id="setup-slots", tool="native.find_slots", args={})))
    assert slots.outcome == "refuse" and slots.action is None
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    fetch = await decide(http.session(visitor.session_token), visitor.state.session_id, 0, "visitor-fetch",
                         "native.fetch_website", {"url": "https://rivera-plumbing.example"})
    assert fetch.outcome == "refuse" and fetch.action is None
    stranger = http.owner(other.owner_token)
    theirs = (await stranger.whoami()).session
    elsewhere = stranger.call("POST /decide", DecideRequest(session_id=theirs.session_id, generation=theirs.generation,
                                                            call=call, desk_id=created.desk_id))
    assert await refused(elsewhere) == (404, "not_found")


# Setup: a new Desk's parts, rules drafts, probes and connected tools (Plans 01a, 01b and 01c) -------------------------

HOURS = [HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(8), end=time(17))]


def active_version(ro_read, ro_schema: str, copy_id: str, desk_id: str) -> dict:
    (active,) = ro_read(ro_schema, copy_id, "SELECT version, cards FROM {ro}.policy_versions"
                                            " WHERE desk_id = %s AND status = 'active'", (desk_id,))
    return active


def owner_cards(version: dict) -> list[RuleCard]:
    return [RuleCard.model_validate(card) for card in version["cards"] if not card["is_default"]]


def quote_card(**limits) -> RuleCard:
    return RuleCard(card_id="card-quote", applies_to="native.quote", mode="auto", who="anyone",
                    reason="Quotes from the price list, at list price.", **limits)


async def draft(owner: CredentialView, desk_id: str, cards: list[RuleCard], parent: int):
    return await owner.call("POST /policy/draft", PolicyDraftRequest(desk_id=desk_id, cards=cards,
                                                                     expected_parent=parent))


def proved_or_skip(version: PolicyVersion) -> None:
    """A draft the kernel proved; the real kernel in bounded mode proves none, so the test can't go on there."""
    if version.proof is not None and version.proof.method == "bounded":
        pytest.skip("the kernel is in bounded mode: no owner draft is proved")
    assert version.status == "proved", version.status


@pytest.mark.kernel_plan("01b")
async def test_owner_puts_a_new_desks_parts(kernel, ro_read):
    """Setup fills a new Desk part by part: `PUT /desks/{id}/charter`, `hours`, `prices`, `calendar` and
    `notifications` each replace that part (a price item or slot left out is gone), each answer `DeskUpdated` and is
    ledgered `desk_data` naming its part; the charter's claims are public charter facts and the hours rewrite
    `charter:hours`. Another copy's owner gets 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    path = {"id": created.desk_id}
    tz = ZoneInfo("America/New_York")
    slots = [CalendarSlot(slot_id=f"S-2026110{day}-0900", starts_at=datetime(2026, 11, day, 9, tzinfo=tz), minutes=60)
             for day in (2, 3)]
    parts = (("PUT /desks/{id}/charter", DeskCharterRequest(charter=[
                 Claim(key="contact", kind="text", value="(212) 555-0199"),
                 Claim(key="policy:service_area", kind="text", value="We work across Brooklyn.")])),
             ("PUT /desks/{id}/hours", DeskHoursRequest(hours=HOURS)),
             ("PUT /desks/{id}/prices", DeskPricesRequest(price_items=[
                 PriceItem(item_id="outlet", title="Outlet repair", unit_cents=9_000),
                 PriceItem(item_id="panel", title="Panel check", unit_cents=25_000)])),
             ("PUT /desks/{id}/calendar", DeskCalendarRequest(calendar_slots=slots)),
             ("PUT /desks/{id}/notifications", DeskNotificationsRequest(notifications=NotificationDefaults(
                 now=["approval", "breaker"], briefing=["lead"]))))
    for route, body in parts:
        updated = await owner.call(route, body, path=path)
        assert isinstance(updated, DeskUpdated) and updated.desk_id == created.desk_id, route

    def rows(query: str) -> list[dict]:
        return ro_read(ro_schema, copy.copy_id, query, (created.desk_id,))

    facts = {row["fact_id"]: row for row in rows("SELECT fact_id, kind, status, claims, readers FROM {ro}.facts"
                                                 " WHERE desk_id = %s AND kind = 'charter'")}
    assert {"charter:contact", "charter:policy:service_area", "charter:hours"} <= set(facts)
    assert all(row["readers"] == ["public"] and row["status"] == "available" for row in facts.values())
    assert facts["charter:contact"]["claims"][0]["value"] == "(212) 555-0199"
    assert {row["item_id"]: row["unit_cents"] for row in rows("SELECT item_id, unit_cents FROM {ro}.price_items"
                                                              " WHERE desk_id = %s")} == {"outlet": 9_000,
                                                                                          "panel": 25_000}
    assert sorted(row["slot_id"] for row in rows("SELECT slot_id FROM {ro}.calendar_slots WHERE desk_id = %s")) == [
        "S-20261102-0900", "S-20261103-0900"]
    (prefs,) = rows("SELECT now, briefing FROM {ro}.notification_prefs WHERE desk_id = %s")
    assert prefs == {"now": ["approval", "breaker"], "briefing": ["lead"]}

    fewer = DeskPricesRequest(price_items=[PriceItem(item_id="panel", title="Panel check", unit_cents=26_000)])
    await owner.call("PUT /desks/{id}/prices", fewer, path=path)
    assert {row["item_id"]: row["unit_cents"] for row in rows("SELECT item_id, unit_cents FROM {ro}.price_items"
                                                              " WHERE desk_id = %s")} == {"panel": 26_000}
    logged = [entry.event.summary.get("part") for entry in (await ledger_page(owner, created.desk_id)).entries
              if entry.event.kind == "desk_data"]
    assert {"charter", "hours", "prices", "calendar", "notifications"} <= set(logged)
    stranger = http.owner(other.owner_token).call("PUT /desks/{id}/hours", DeskHoursRequest(hours=HOURS), path=path)
    assert await refused(stranger) == (404, "not_found")


@pytest.mark.kernel_plan("01b")
async def test_masked_contact_is_rejected(kernel, ro_read):
    """`PUT /desks/{id}/people` upserts people by `ref`. A contact that looks masked (with `•` or `*`, as the masked
    contacts the owner is shown do) is 422 `invalid` with nothing written, a batch with one included, so a masked
    contact never replaces the one codes go to; a new person without a contact, or a ref with `@` (refs are ledgered,
    contacts never), is 422 too. `contact: None` keeps the contact on record (codes still go there); `remove` takes a
    person off the record, so their contact gets no code. A write answers `DeskUpdated`, ledgered `desk_data` naming
    `people`; another copy's owner gets 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    path = {"id": desk_id}

    def people() -> dict[str, dict]:
        rows = ro_read(ro_schema, copy.copy_id, "SELECT display_name, masked_contact, notes FROM {ro}.people"
                                                " WHERE desk_id = %s", (desk_id,))
        return {row["display_name"]: row for row in rows}

    def put(*upsert: PersonUpsert, remove: tuple[str, ...] = ()):
        return owner.call("PUT /desks/{id}/people", DeskPeopleRequest(upsert=list(upsert), remove=list(remove)),
                          path=path)

    before = people()
    dana_masked = before["Dana Whitfield"]["masked_contact"]
    lee = PersonUpsert(ref="lee", display_name="Lee Park", contact="lee@example.com")
    for masked in (dana_masked, "d***@example.com"):
        assert await refused(put(PersonUpsert(ref="dana", display_name="Dana Whitfield", contact=masked))) == (
            422, "invalid")
    batch = put(lee, PersonUpsert(ref="bob", display_name="Bob Okafor", contact="b•••@example.com"))
    assert await refused(batch) == (422, "invalid")
    assert await refused(put(lee.model_copy(update={"contact": None}))) == (422, "invalid")
    assert await refused(put(lee.model_copy(update={"ref": "lee@example.com"}))) == (422, "invalid")  # ledgered
    assert people() == before

    updated = await put(PersonUpsert(ref="dana", display_name="Dana W.", contact=None, notes="Prefers mornings."), lee,
                        remove=("bob",))
    assert isinstance(updated, DeskUpdated) and updated.desk_id == desk_id
    after = people()
    assert set(after) == {"Dana W.", "Lee Park"}
    assert (after["Dana W."]["masked_contact"], after["Dana W."]["notes"]) == (dana_masked, "Prefers mornings.")
    assert after["Lee Park"]["masked_contact"] not in ("", "lee@example.com")

    slug = desk_slug(ro_read, ro_schema, copy)
    started = []
    for contact in (DANA, "bob@example.com", "lee@example.com"):
        visitor = await new_visitor(http, slug)
        started.append(await verify_start(http.session(visitor.session_token), visitor.state.session_id, contact))
    assert [notice.to for notice in started[0].inbox] == [dana_masked]
    assert started[1].inbox == []
    assert [notice.to for notice in started[2].inbox] == [after["Lee Park"]["masked_contact"]]
    logged = [entry.event.summary.get("part") for entry in (await ledger_page(owner, desk_id)).entries
              if entry.event.kind == "desk_data"]
    assert logged[-1] == "people" and logged.count("people") == 1
    stranger = http.owner(other.owner_token).call("PUT /desks/{id}/people", DeskPeopleRequest(remove=["dana"]),
                                                  path=path)
    assert await refused(stranger) == (404, "not_found")


@pytest.mark.kernel_plan("01b")
async def test_preview_session_needs_the_owner(kernel, ro_read):
    """`POST /sessions` with `preview: true` opens a visitor session only with `X-Owner-Session` for the slug's copy:
    with no credential, a visitor's token or another copy's owner it is 401 `auth` and opens nothing, and a preview
    `kind: "agent"` is 422 `invalid`. The preview is marked in `kernel_ro.sessions.preview` and ledgered `session` with
    `preview: true`; with Answering off it keeps the visitor tools, while an ordinary visitor gets only lead capture
    and a callback."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    slug = desk_slug(ro_read, ro_schema, copy)
    visitor = await new_visitor(http, slug)
    preview = CreateSessionRequest(desk_slug=slug, kind="visitor", preview=True)

    def previews() -> dict[str, bool]:
        rows = ro_read(ro_schema, copy.copy_id, "SELECT session_id, preview FROM {ro}.sessions"
                                                " WHERE desk_id = %s AND kind = 'visitor'", (desk_id,))
        return {row["session_id"]: row["preview"] for row in rows}

    before = previews()
    for view in (http.public(), http.session(visitor.session_token), http.owner(other.owner_token)):
        assert await refused(view.call("POST /sessions", preview)) == (401, "auth")
    agent = CreateSessionRequest.model_construct(desk_slug=slug, kind="agent", mandate=None, preview=True)
    assert await refused(owner.call("POST /sessions", agent)) == (422, "invalid")
    assert previews() == before and before[visitor.state.session_id] is False

    await owner.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False), path={"id": desk_id})
    created = await owner.call("POST /sessions", preview)
    assert isinstance(created, SessionCreated) and created.session_token
    assert (created.state.kind, created.state.mode, created.state.generation) == ("visitor", "ai", 0)
    assert previews() == {**before, created.state.session_id: True}
    preview_view = http.session(created.session_token)
    assert (await preview_view.whoami()).session == created.state
    given, _ = tools(await context(preview_view, created.state.session_id))
    assert {"native.quote", "native.find_slots", "native.book"} <= given
    assert tools(await context(http.session(visitor.session_token), visitor.state.session_id))[0] == {
        "native.capture_lead", "native.request_callback"}
    opened = [entry.event for entry in (await ledger_page(owner, desk_id)).entries
              if entry.event.kind == "session" and entry.event.session_id == created.state.session_id]
    assert [event.summary.get("preview") for event in opened] == [True]


@pytest.mark.kernel_plan("01b")   # its Desk comes from `POST /desks`, Plan 01b's
async def test_policy_draft_returns_a_version(kernel, ro_read):
    """`POST /policy/draft` compiles and proves the owner's cards against the active version: a new version, its
    parent the active one, carrying the owner's cards and the compiler's default asks for the tools no card for
    anyone covers. The same cards and parent again return that version; a parent that isn't active is 409, another
    copy's owner 404. Nothing activates."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    cards = [*owner_cards(active), quote_card()]

    version = await draft(owner, created.desk_id, cards, active["version"])
    assert isinstance(version, PolicyVersion) and version.desk_id == created.desk_id
    proved_or_skip(version)
    assert version.version > active["version"] and version.parent_version == active["version"]
    assert version.proof.ok and version.proof.method == "symcc"
    drafted = {card.card_id: card for card in version.cards}
    assert all(drafted[card.card_id] == card for card in cards)
    defaults = {card.applies_to for card in version.cards if card.is_default}
    assert "native.book" in defaults and "native.quote" not in defaults
    assert all(card.mode == "ask" and card.who == "anyone" for card in version.cards if card.is_default)
    assert (await draft(owner, created.desk_id, cards, active["version"])).version == version.version
    assert active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)["version"] == active["version"]

    stale = draft(owner, created.desk_id, cards, active["version"] + 100)
    assert await refused(stale) == (409, "conflict")
    elsewhere = draft(http.owner(other.owner_token), created.desk_id, cards, active["version"])
    assert await refused(elsewhere) == (404, "not_found")


@pytest.mark.kernel_plan("01b")   # its Desk comes from `POST /desks`, Plan 01b's
async def test_confirm_needs_a_proved_version(kernel, ro_read):
    """`POST /policy/confirm` activates a proved draft whose parent is still active, superseding it; a sibling
    drafted from the same parent is then 409 (its parent is no longer active), and a version that doesn't exist is
    404."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    first = await draft(owner, created.desk_id, [*owner_cards(active), quote_card()], active["version"])
    sibling = await draft(owner, created.desk_id, [*owner_cards(active), quote_card(max_discount_bp=500)],
                          active["version"])
    proved_or_skip(first)
    assert sibling.version != first.version

    confirmed = await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=created.desk_id,
                                                                              version=first.version))
    assert isinstance(confirmed, PolicyVersion) and (confirmed.version, confirmed.status) == (first.version, "active")
    now_active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    assert now_active["version"] == first.version
    (old,) = ro_read(ro_schema, copy.copy_id, "SELECT status FROM {ro}.policy_versions WHERE desk_id = %s"
                                              " AND version = %s", (created.desk_id, active["version"]))
    assert old["status"] == "superseded"
    late = owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=created.desk_id, version=sibling.version))
    assert await refused(late) == (409, "conflict")
    missing = owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=created.desk_id, version=10_000))
    assert await refused(missing) == (404, "not_found")


@pytest.mark.kernel_plan("01b")   # the money cap on each rules version, Plan 01b's
async def test_a_draft_holds_its_auto_money_cards_to_its_cap(kernel, ro_read):
    """Each rules version has a money cap, and its auto money cards fit it. A Desk that `POST /desks` makes starts
    at 0, and a seed naming another cap is 422 `invalid`. A draft keeps its parent's cap unless it names one: an auto
    `effect:charge` card for $20 is 422 `invalid` at the cap of 0 it keeps and at a named $19.99, drafting nothing,
    and proved at a named $20, which the version carries and, once confirmed, the Desk's active version too."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    capped = a_new_desk()
    capped.desk.auto_money_cap_cents = 2_000
    assert await refused(owner.call("POST /desks", capped)) == (422, "invalid")
    created = await owner.call("POST /desks", a_new_desk())

    def versions() -> list[dict]:
        return ro_read(ro_schema, copy.copy_id, "SELECT version, status, auto_money_cap_cents FROM {ro}.policy_versions"
                                                " WHERE desk_id = %s ORDER BY version", (created.desk_id,))

    active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    assert versions() == [{"version": active["version"], "status": "active", "auto_money_cap_cents": 0}]
    charge = RuleCard(card_id="card-charge", applies_to="effect:charge", mode="auto", who="anyone",
                      max_amount_cents=2_000, reason="Payments up to $20 go through without asking.")
    cards = [*owner_cards(active), charge]

    def at(cap: int | None):
        return owner.call("POST /policy/draft", PolicyDraftRequest(desk_id=created.desk_id, cards=cards,
                                                                   expected_parent=active["version"],
                                                                   auto_money_cap_cents=cap))

    assert await refused(at(None)) == (422, "invalid")
    assert await refused(at(1_999)) == (422, "invalid")
    assert [row["version"] for row in versions()] == [active["version"]]
    version = await at(2_000)
    proved_or_skip(version)
    assert version.auto_money_cap_cents == 2_000
    confirmed = await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=created.desk_id,
                                                                              version=version.version))
    assert (confirmed.status, confirmed.auto_money_cap_cents) == ("active", 2_000)
    assert versions() == [{"version": active["version"], "status": "superseded", "auto_money_cap_cents": 0},
                          {"version": version.version, "status": "active", "auto_money_cap_cents": 2_000}]


def policy_rows(ro_read, ro_schema: str, copy: CopyCreated) -> list[dict]:
    return ro_read(ro_schema, copy.copy_id, "SELECT version, status, auto_money_cap_cents FROM {ro}.policy_versions"
                                            " WHERE desk_id = %s ORDER BY version", (copy.desk_ids[0],))


def charge_card(cents: int) -> RuleCard:
    return RuleCard(card_id="card-charge", applies_to="effect:charge", mode="auto", who="anyone",
                    max_amount_cents=cents, reason="Payments up to $300 go through without asking.")


@pytest.mark.kernel_plan("01b")   # the money cap on each rules version, Plan 01b's
async def test_card_above_the_draft_cap_is_422(kernel, ro_read):
    """The kernel holds a draft's cards to the draft's own money cap, whatever the API sends: lowering the Rivera cap
    from $500 to $100 with an active $300 auto `effect:charge` card carried as it is, as an API that skipped the
    lowering would send it, is 422 `invalid` with nothing drafted. The same cards lowered by
    `desk.money_cap.lower_to_cap` draft at $100, the card at $100 and saying so."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    desk_id = copy.desk_ids[0]
    seeded = active_version(ro_read, ro_schema, copy.copy_id, desk_id)
    first = await draft(owner, desk_id, [*owner_cards(seeded), charge_card(30_000)], seeded["version"])
    proved_or_skip(first)
    assert first.auto_money_cap_cents == 50_000
    await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=first.version))
    active = active_version(ro_read, ro_schema, copy.copy_id, desk_id)
    kept, before = owner_cards(active), policy_rows(ro_read, ro_schema, copy)

    def at_100(cards: list[RuleCard]):
        return owner.call("POST /policy/draft", PolicyDraftRequest(desk_id=desk_id, cards=cards,
                                                                   expected_parent=active["version"],
                                                                   auto_money_cap_cents=10_000))

    assert await refused(at_100(kept)) == (422, "invalid")
    assert policy_rows(ro_read, ro_schema, copy) == before
    lowered = await at_100(lower_to_cap(kept, kept, 10_000, "en"))
    proved_or_skip(lowered)
    (charge,) = [card for card in lowered.cards if card.card_id == "card-charge"]
    assert (lowered.auto_money_cap_cents, charge.max_amount_cents, charge.reason) == (
        10_000, 10_000, "Up to $100, your payment limit.")


@pytest.mark.kernel_plan("01b")   # the money cap on each rules version, Plan 01b's
async def test_cap_changes_only_at_confirm(kernel, ro_read):
    """A draft at a new money cap carries it, and the Desk's cap stays its active version's until the owner confirms
    the draft: raising the Rivera cap from $500 to $800 drafts a version at $800 while the active one stays at $500;
    confirming it supersedes the $500 version, and the Desk's cap is $800."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    desk_id = copy.desk_ids[0]
    active = active_version(ro_read, ro_schema, copy.copy_id, desk_id)
    raised = await owner.call("POST /policy/draft", PolicyDraftRequest(desk_id=desk_id, cards=owner_cards(active),
                                                                       expected_parent=active["version"],
                                                                       auto_money_cap_cents=80_000))
    proved_or_skip(raised)
    assert raised.auto_money_cap_cents == 80_000
    assert policy_rows(ro_read, ro_schema, copy) == [
        {"version": active["version"], "status": "active", "auto_money_cap_cents": 50_000},
        {"version": raised.version, "status": "proved", "auto_money_cap_cents": 80_000}]
    confirmed = await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id,
                                                                              version=raised.version))
    assert (confirmed.status, confirmed.auto_money_cap_cents) == ("active", 80_000)
    assert policy_rows(ro_read, ro_schema, copy) == [
        {"version": active["version"], "status": "superseded", "auto_money_cap_cents": 50_000},
        {"version": raised.version, "status": "active", "auto_money_cap_cents": 80_000}]


def verification_card(ro_read, ro_schema: str, copy: CopyCreated) -> tuple[dict, list[RuleCard], RuleCard]:
    """The Rivera Desk's active version, its owner cards, and the presets' own card for starting a verification
    among them (auto, for anyone, on the tool), which every preset and the Rivera seed carry."""
    active = active_version(ro_read, ro_schema, copy.copy_id, copy.desk_ids[0])
    kept = owner_cards(active)
    (shipped,) = [card for card in kept if card.applies_to == "native.start_verification"]
    assert shipped == RuleCard(card_id="preset-start-verification", applies_to="native.start_verification",
                               mode="auto", who="anyone", reason=shipped.reason)
    return active, kept, shipped


def send_card(mode: str, **scope) -> RuleCard:
    """A card on `effect:send_message`, the one effect of `native.start_verification`, so it covers that tool too."""
    return RuleCard(card_id="card-send", applies_to="effect:send_message", mode=mode, who=scope.pop("who", "anyone"),
                    reason="Messages to customers.", **scope)


def draft_versions(ro_read, ro_schema: str, copy: CopyCreated) -> list[dict]:
    return ro_read(ro_schema, copy.copy_id, "SELECT version, status FROM {ro}.policy_versions WHERE desk_id = %s"
                                            " ORDER BY version", (copy.desk_ids[0],))


@pytest.mark.kernel_plan("01b")
async def test_a_draft_that_would_change_starting_a_verification_is_422(kernel, ro_read):
    """Verification is always on: `POST /policy/draft` refuses whole, 422 `invalid` with nothing drafted, a set holding
    a card on `native.start_verification` other than the presets' own (every field but its reason the same), an
    `ask` or `never` card on its effect `effect:send_message`, or an `auto` one for a person, which outranks the
    presets' card (`(who is a person or an agent, applies_to is a tool)`, compared in that order). The presets' own
    card drafts, reworded or not, and so does an `auto` effect card for anyone, which ranks below it."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    active, kept, shipped = verification_card(ro_read, ro_schema, copy)
    others = [card for card in kept if card != shipped]
    (dana,) = ro_read(ro_schema, copy.copy_id, "SELECT person_id FROM {ro}.people WHERE desk_id = %s"
                                               " AND display_name = 'Dana Whitfield'", (desk_id,))
    for_dana = {"who": "person", "person_id": dana["person_id"]}

    def verify(**changes) -> RuleCard:          # the presets' card, changed, in its place
        return RuleCard.model_validate({**shipped.model_dump(), **changes})

    refusals = {"asks": [*others, verify(mode="ask")],
                "never for dana": [*others, verify(mode="never", **for_dana)],
                "auto for verified people": [*others, verify(who="verified")],
                "behind the reviewer": [*others, verify(review=True)],
                "under another id": [*others, verify(card_id="card-verify")],
                "effect asks": [*kept, send_card("ask")],
                "effect never for dana": [*kept, send_card("never", **for_dana)],
                "effect auto for dana": [*kept, send_card("auto", **for_dana)]}
    before = draft_versions(ro_read, ro_schema, copy)
    for shape, cards in refusals.items():
        assert await refused(draft(owner, desk_id, cards, active["version"])) == (422, "invalid"), shape
    assert draft_versions(ro_read, ro_schema, copy) == before

    reworded = shipped.model_copy(update={"reason": "Anyone can ask for a code, sent to the contact on record."})
    for cards in ([*others, reworded], [*kept, send_card("auto")]):
        version = await draft(owner, desk_id, cards, active["version"])
        assert isinstance(version, PolicyVersion) and version.parent_version == active["version"]
        # by card_id: the kernel returns a draft's cards sorted by it, not in the order they were sent
        assert {card.card_id: card for card in version.cards if not card.is_default} == {
            card.card_id: card for card in cards}


@pytest.mark.kernel_plan("01c")
async def test_an_auto_effect_card_for_one_agent_over_verification_is_422(kernel, ro_read):
    """An `auto` card on `effect:send_message` for one agent outranks the presets' card for starting a verification,
    as one for a person does, so `POST /policy/draft` refuses it (422 `invalid`) with nothing drafted."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    active, kept, _ = verification_card(ro_read, ro_schema, copy)
    agent = await demo_agent(http, copy)
    before = draft_versions(ro_read, ro_schema, copy)
    cards = [*kept, send_card("auto", who="agent", agent_key_id=agent.agent_key_id)]
    assert await refused(draft(owner, copy.desk_ids[0], cards, active["version"])) == (422, "invalid")
    assert draft_versions(ro_read, ro_schema, copy) == before


@pytest.mark.kernel_plan("01c")
async def test_probes_decide_a_draft_without_activating_it(kernel, ro_read):
    """`POST /policy/{version}/probe` decides hypothetical callers against a draft, one result per probe, and
    changes nothing: a stranger asking for someone else's document is refused, an 80% discount past an auto quote
    card at list price asks the owner, and a tool the Desk doesn't have is refused with no card."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    version = await draft(owner, created.desk_id, [*owner_cards(active), quote_card()], active["version"])
    probes = [
        Probe(actor="visitor", who="anyone", resource_kind="document", resource_owner="other",
              call=ToolCall(call_id="probe-1", tool="native.release_document", args={"document_id": "probe"})),
        Probe(actor="visitor", who="anyone", resource_kind="desk", amount_cents=25_000,
              call=ToolCall(call_id="probe-2", tool="native.quote", args=quote_args("panel", 8_000))),
        Probe(actor="visitor", who="anyone", resource_kind="desk",
              call=ToolCall(call_id="probe-3", tool="admin.export_customers", args={})),
    ]
    results = await owner.call("POST /policy/{version}/probe", PolicyProbeRequest(desk_id=created.desk_id,
                                                                                    probes=probes),
                               path={"version": version.version})
    assert [result.probe for result in results] == probes
    assert [result.outcome for result in results] == ["refuse", "hold", "refuse"]
    assert all(isinstance(result, ProbeResult) and result.reason_plain for result in results)
    assert "card-quote" in results[1].card_ids and not results[1].depends_on_review
    assert results[2].card_ids == []
    assert active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)["version"] == active["version"]


@pytest.mark.kernel_plan("01c")
async def test_connecting_payments_pins_its_tools_for_review(kernel, ro_read):
    """`POST /tools/connect {server: "mock_payments"}` lists the payments tools and pins each by its definition's
    hash, `needs_review` until the owner confirms them, so no visitor is given them yet."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    profiles = await owner.call("POST /tools/connect", ToolsConnectRequest(desk_id=created.desk_id,
                                                                           server="mock_payments"))
    assert {profile.tool for profile in profiles} == {"payments.list_charges", "payments.create_refund"}
    assert all(isinstance(profile, ToolProfile) and profile.source == "mcp" and profile.status == "needs_review"
               and profile.review_reason == "new"
               and re.fullmatch(r"[0-9a-f]{64}", profile.definition_sha256 or "") for profile in profiles)
    rows = ro_read(ro_schema, copy.copy_id, "SELECT tool, status, review_reason FROM {ro}.tools WHERE desk_id = %s"
                                            " AND source = 'mcp'", (created.desk_id,))
    assert {row["tool"]: (row["status"], row["review_reason"]) for row in rows} == {
        "payments.list_charges": ("needs_review", "new"), "payments.create_refund": ("needs_review", "new")}
    visitor = await new_visitor(http, created.slug)
    given, declared = tools(await context(http.session(visitor.session_token), visitor.state.session_id))
    assert not {"payments.list_charges", "payments.create_refund"} & given


# The owner's knowledge, documents and tool changes (Plans 01b and 01c) ---------------------------------------


@pytest.mark.kernel_plan("01b")
async def test_copy_starts_with_public_website_and_price_list_knowledge(kernel, ro_read):
    """Real and fake copies expose the same two amount-free seed items through context and the API view,
    with one normal knowledge write ledgered for each."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    expected = [
        KnowledgeItem(item_id="kn-price-list", source="setup", title="Price list, from your answers in setup",
                      text="The price list Maria gave in setup covers the service call deposit, drain clearing, a "
                           "water heater flush and leak repair. Each price is given in a quote from this list.",
                      label=Label(readers=["public"])),
        KnowledgeItem(item_id="kn-website", source="website",
                      title="Your website, rivera-plumbing.example, read during setup",
                      text="Rivera Plumbing is Maria Rivera's home plumbing business: drain clearing, leak repair and "
                           "water heater flushes. We work in Oakland, Berkeley, Alameda and Emeryville.",
                      label=Label(readers=["public"])),
    ]
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    seen = await context(http.session(visitor.session_token), visitor.state.session_id)
    assert sorted(seen.knowledge, key=lambda item: item.item_id) == expected
    assert ro_read(ro_schema, copy.copy_id,
                   "SELECT item_id, source, title, text, readers FROM {ro}.knowledge_items"
                   " WHERE desk_id = %s ORDER BY item_id", (desk_id,)) == [
        {"item_id": item.item_id, "source": item.source, "title": item.title,
         "text": item.text, "readers": ["public"]} for item in expected]
    written = [entry.event.summary for entry in (await ledger_page(http.owner(copy.owner_token), desk_id)).entries
               if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "knowledge"]
    assert written == [{"part": "knowledge", "item_id": item_id, "owner_only_forced": False}
                       for item_id in ("kn-website", "kn-price-list")]


def knowledge_item(readers: list[str], text: str = "Street parking is free after 6 pm.") -> KnowledgeItem:
    return KnowledgeItem(item_id="upload-parking", source="upload", title="Parking", text=text,
                         label=Label(readers=readers))


@pytest.mark.kernel_plan("01b")
async def test_knowledge_round_trips(kernel, ro_read):
    """`POST /knowledge` stores the owner's item as given, owner-only until the owner marks it public: re-posting the
    same `item_id` with `["public"]` updates it in place, and visitors' `/context` then carries it. Readers other than
    `["owner"]` or `["public"]`, or text over 100 KiB, are 422 `invalid`; another copy's owner gets 404. Each write is
    ledgered `desk_data` naming the item."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view = http.session(visitor.session_token)

    def stored() -> list[dict]:
        return ro_read(ro_schema, copy.copy_id, "SELECT item_id, source, title, text, readers FROM {ro}.knowledge_items"
                                                " WHERE desk_id = %s AND item_id = %s", (desk_id, "upload-parking"))

    private = knowledge_item(["owner"])
    assert await owner.call("POST /knowledge", KnowledgeRequest(desk_id=desk_id, item=private)) == private
    assert stored() == [{"item_id": "upload-parking", "source": "upload", "title": "Parking", "text": private.text,
                         "readers": ["owner"]}]
    assert "upload-parking" not in {item.item_id for item in (await context(view, visitor.state.session_id)).knowledge}

    public = knowledge_item(["public"])
    assert await owner.call("POST /knowledge", KnowledgeRequest(desk_id=desk_id, item=public)) == public
    assert [row["readers"] for row in stored()] == [["public"]]
    seen = {item.item_id: item for item in (await context(view, visitor.state.session_id)).knowledge}
    assert seen["upload-parking"] == public

    for item in (knowledge_item(["person:someone"]), knowledge_item(["owner", "public"]),
                 knowledge_item(["owner"], text="x" * (100 * 1024 + 1))):
        assert await refused(owner.call("POST /knowledge", KnowledgeRequest(desk_id=desk_id, item=item))) == (
            422, "invalid")
    assert [row["readers"] for row in stored()] == [["public"]]
    elsewhere = http.owner(other.owner_token).call("POST /knowledge", KnowledgeRequest(desk_id=desk_id, item=private))
    assert await refused(elsewhere) == (404, "not_found")
    written = [entry.event.summary for entry in (await ledger_page(owner, desk_id)).entries
               if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "knowledge"]
    assert [summary["item_id"] for summary in written] == [
        "kn-website", "kn-price-list", "upload-parking", "upload-parking"]


@pytest.mark.kernel_plan("01b")
async def test_uploaded_document_gets_a_title_only_fact(kernel, ro_read):
    """`POST /documents` adds the owner's document through the seed path's writer: a `documents` row and a
    `document:<id>` fact naming only its title, readable by the owner and the person on record it belongs to (the
    owner alone without one); the body stays in the kernel. Ledgered `desk_data {part: "documents", refs: [id]}`. A
    `record_owner_ref` naming no one on record, or a body over 200 KiB, is 422 `invalid`; another copy's owner 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    body = "Rivera Plumbing\nEstimate, leak repair\nFor Dana Whitfield\n"
    estimate = SeedDocument(ref="dana-estimate", title="Estimate, leak repair", body=body, record_owner_ref="dana")

    created = await owner.call("POST /documents", DocumentUploadRequest(desk_id=desk_id, document=estimate))
    assert isinstance(created, DocumentCreated)
    (dana,) = ro_read(ro_schema, copy.copy_id, "SELECT person_id FROM {ro}.people WHERE desk_id = %s"
                                               " AND display_name = 'Dana Whitfield'", (desk_id,))
    (row,) = ro_read(ro_schema, copy.copy_id, "SELECT title, record_owner_person_id FROM {ro}.documents"
                                              " WHERE document_id = %s", (created.document_id,))
    assert row == {"title": "Estimate, leak repair", "record_owner_person_id": dana["person_id"]}
    (fact,) = ro_read(ro_schema, copy.copy_id, "SELECT kind, claims, readers FROM {ro}.facts WHERE desk_id = %s"
                                               " AND fact_id = %s", (desk_id, f"document:{created.document_id}"))
    assert fact["kind"] == "document" and fact["claims"] == [{"key": "title", "kind": "text",
                                                              "value": "Estimate, leak repair"}]
    assert sorted(fact["readers"]) == sorted(["owner", f"person:{dana['person_id']}"])

    private = await owner.call("POST /documents", DocumentUploadRequest(desk_id=desk_id, document=SeedDocument(
        ref="supplier-terms", title="Supplier terms", body="Net 30.")))
    (fact,) = ro_read(ro_schema, copy.copy_id, "SELECT readers FROM {ro}.facts WHERE desk_id = %s AND fact_id = %s",
                      (desk_id, f"document:{private.document_id}"))
    assert fact["readers"] == ["owner"]
    written = [entry.event.summary for entry in (await ledger_page(owner, desk_id)).entries
               if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "documents"]
    assert [summary["refs"] for summary in written] == [[created.document_id], [private.document_id]]
    assert not any(body in json.dumps(summary) for summary in written)

    for bad in (estimate.model_copy(update={"ref": "nobodys", "record_owner_ref": "nobody"}),
                estimate.model_copy(update={"ref": "too-long", "body": "x" * (200 * 1024 + 1)})):
        assert await refused(owner.call("POST /documents", DocumentUploadRequest(desk_id=desk_id, document=bad))) == (
            422, "invalid")
    elsewhere = http.owner(other.owner_token).call("POST /documents", DocumentUploadRequest(desk_id=desk_id,
                                                                                             document=estimate))
    assert await refused(elsewhere) == (404, "not_found")


@pytest.mark.kernel_plan("01c")
async def test_simulated_change_needs_review(kernel, ro_read):
    """`POST /tools/simulate_change` (the owner's demo action) changes a connected tool's definition on the server and
    re-lists it at once: the tool is `needs_review` straight away, the changed definition waiting as
    `pending_definition_text` under its own `pending_sha256`, and the pinned hash unchanged until the owner reviews
    it; other tools are untouched. Ledgered `tool_pin`; another copy's owner gets 404."""
    http, ro_schema, _ = kernel
    copy, other = await new_copy(http), await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]

    def pins() -> dict[str, dict]:
        rows = ro_read(ro_schema, copy.copy_id, "SELECT tool, status, definition_sha256, pending_sha256 FROM"
                                                " {ro}.tools WHERE desk_id = %s AND source = 'mcp'", (desk_id,))
        return {row["tool"]: row for row in rows}

    before = pins()
    assert {tool: row["status"] for tool, row in before.items()} == {"payments.list_charges": "enabled",
                                                                     "payments.create_refund": "enabled"}
    changed = await owner.call("POST /tools/simulate_change", ToolsSimulateChangeRequest(
        desk_id=desk_id, tool="payments.create_refund"))
    assert isinstance(changed, ToolProfile) and changed.tool == "payments.create_refund"
    assert changed.status == "needs_review" and changed.review_reason == "changed" and changed.pending_definition_text
    assert re.fullmatch(r"[0-9a-f]{64}", changed.pending_sha256 or "")
    assert changed.pending_sha256 != changed.definition_sha256
    assert changed.definition_sha256 == before["payments.create_refund"]["definition_sha256"]
    after = pins()
    assert after["payments.create_refund"] == {**before["payments.create_refund"], "status": "needs_review",
                                               "pending_sha256": changed.pending_sha256}
    assert after["payments.list_charges"] == before["payments.list_charges"]
    assert "tool_pin" in [entry.event.kind for entry in (await ledger_page(owner, desk_id)).entries]
    elsewhere = http.owner(other.owner_token).call("POST /tools/simulate_change", ToolsSimulateChangeRequest(
        desk_id=desk_id, tool="payments.create_refund"))
    assert await refused(elsewhere) == (404, "not_found")


# The turn's language (GitHub issue #121) --------------------------------------------------------------------------


async def turn(view: CredentialView, session_id: str, generation: int, said: str) -> TurnStarted:
    return await view.call("POST /sessions/{session_id}/turn", TurnRequest(generation=generation, text=said),
                           path={"session_id": session_id})


@pytest.mark.kernel_plan("01b")
async def test_a_turn_speaks_the_language_of_the_message_that_started_it(kernel, ro_read):
    """The API sends each turn's newest visitor or agent message as the turn starts, and the kernel keeps the
    language it detects as the session's, so the turn's receipts speak it, not the last reply's. A message in neither
    English nor Spanish keeps the language on record. The text is read for that alone: the session is otherwise as it
    was, a repeat changes nothing, and no ledger entry holds the text."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug, desk_id = desk_slug(ro_read, ro_schema, copy), copy.desk_ids[0]
    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")
    owner = http.owner(copy.owner_token)
    visitor = await new_visitor(http, slug)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    start = (await ledger_page(owner, desk_id)).entries[-1].seq

    assert (await check_reply(view, session_id, 0, "Happy to help with your drain.")).language == "en"
    spanish = "Hola, ¿pueden venir mañana a revisar el desagüe?"
    assert await turn(view, session_id, 0, spanish) == TurnStarted(language="es")
    assert (await decide(view, session_id, 0, "call-1", "native.quote", quote_args(drain))).visitor_plain == (
        "Revisado con las reglas de Maria Rivera")
    neither = ("\U0001F44D", "Bonjour, je voudrais un rendez-vous.", "\U0001F44D")
    for said in neither:
        assert await turn(view, session_id, 0, said) == TurnStarted(language="es"), said
    english = "Can someone look at my water heater tomorrow?"
    assert await turn(view, session_id, 0, english) == TurnStarted(language="en")
    assert (await decide(view, session_id, 0, "call-2", "native.quote", quote_args(drain))).visitor_plain == (
        "Checked against Maria Rivera's rules")

    assert (await view.whoami()).session == visitor.state           # mode, generation and verification untouched
    ledgered = json.dumps([entry.model_dump(mode="json") for entry in (await ledger_page(owner, desk_id)).entries
                           if entry.seq > start], ensure_ascii=False)
    for said in (spanish, *neither, english):
        assert said not in ledgered


@pytest.mark.kernel_plan("01b")
async def test_a_turn_starts_in_a_paused_session_and_after_a_take_over(kernel, ro_read, arrange):
    """"Session state responses": `/turn` answers in mode `paused`, so a paused turn's handoff speaks the visitor's
    language, and in mode `owner` at the generation the take-over set; the generation from before it is stale."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    paused, taken = await new_visitor(http, slug), await new_visitor(http, slug)

    view, session_id = http.session(paused.session_token), paused.state.session_id
    arrange.pause(session_id)
    generation = (await view.whoami()).session.generation
    assert await turn(view, session_id, generation, "Hola, ¿siguen ahí?") == TurnStarted(language="es")

    view, session_id = http.session(taken.session_token), taken.state.session_id
    await arrange.take_over(http.owner(copy.owner_token), session_id, 0)
    assert (await view.whoami()).session.generation == 1
    assert await turn(view, session_id, 1, "Can someone call me back today?") == TurnStarted(language="en")
    assert await refused(turn(view, session_id, 0, "Can someone call me back today?")) == (409, "stale_generation")


@pytest.mark.kernel_plan("01b")
async def test_a_turn_is_refused_like_the_other_turn_routes(kernel, ro_read, arrange):
    """Up to 2,000 characters, else 422 `invalid`; a token for another session 401; a stale generation 409
    `stale_generation`; a closed session 409 `closed`, before a stale generation."""
    http, ro_schema, state = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    visitor, stranger = await new_visitor(http, slug), await new_visitor(http, slug)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    assert await turn(view, session_id, 0, ("Hello " * 400)[:2000]) == TurnStarted(language="en")
    # read raw, since a request model that bounds the text couldn't even be built over the limit
    transport = httpx.ASGITransport(app=fake_kernel_app(state)) if state is not None else None
    async with httpx.AsyncClient(base_url=http.base_url, transport=transport) as raw:
        too_long = await raw.post(f"/sessions/{session_id}/turn", json={"generation": 0, "text": "Hola " * 401},
                                  headers={"X-Session-Token": visitor.session_token})
    assert (too_long.status_code, KernelError.model_validate_json(too_long.content).code) == (422, "invalid")
    assert await refused(turn(http.session(stranger.session_token), session_id, 0, "Hola")) == (401, "auth")
    assert await refused(turn(view, session_id, 1, "Hola")) == (409, "stale_generation")
    arrange.close_idle_sessions(session_id)
    for generation in (0, 1):
        assert await refused(turn(view, session_id, generation, "Hola")) == (409, "closed")
