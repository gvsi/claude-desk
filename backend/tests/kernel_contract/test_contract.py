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

from tests import public_policy_cases as policy_cases

from desk.api.deliver import Reply
from desk.api.kernel_client import CredentialView, KernelFailed, KernelHttp
from desk.api.owner_reads import refusal_cause
from desk.api.ro import KernelRO
from desk.contracts import (
    BRAND_PALETTE,
    AgentAuth,
    ApprovalResult,
    BusinessSeed,
    BusinessTool,
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
    RenderedBlock,
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
    BusinessToolsRequest,
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
    ToolsConfirmRequest,
    ToolPin,
    ToolsSimulateChangeRequest,
    TurnRequest,
    TurnStarted,
    VerifyCheckRequest,
    VerifyStarted,
    VerifyStartRequest,
    WhoAmI,
)
from desk.money_cap import lower_to_cap
from desk.next_steps import NEXT_STEPS, next_steps
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


async def check_reply(view: CredentialView, session_id: str, generation: int, prose: str, *,
                      final: bool = True) -> ReplyVerdict:
    draft = ReplyDraft(session_id=session_id, generation=generation, prose=prose)
    return await view.call("POST /check_reply", CheckReplyRequest(draft=draft, final=final))


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
        "hold", "held", "Waiting for Mike Turner to approve")
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
            RecordedStep("replied", night + timedelta(seconds=20), "Yes, Mike can. Here's an open time."),
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
@pytest.mark.parametrize("choice", ["allow_once", "deny_once"])
async def test_answer_includes_the_approved_snapshot_only_for_an_allow(kernel, ro_read, choice):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    held = await decide(view, session_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500))
    assert held.state == "held"
    result = await answer(http.owner(copy.owner_token), held.decision_id, choice)
    assert "approved" in result.model_dump(mode="json")
    if choice == "deny_once":
        assert result.approved is None and result.decision.state == "denied"
        assert result.execution is None
        return

    assert result.approved is not None
    assert (result.approved.decision_id, result.approved.state, result.approved.visitor_plain) == (
        held.decision_id, "approved", "Mike Turner approved this")
    assert result.approved.signature and result.approved.signature != result.decision.signature
    assert result.approved.owner_plain is None
    assert result.approved.ledger_seq < result.decision.ledger_seq
    assert result.decision.state == "executed" and result.execution.state == "succeeded"


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
    note = "Asked whether Mike can come before lunch."
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
    assert result.execution is None and result.card_diff is None and result.approved is None
    assert result.decision.ledger_seq > held.ledger_seq and result.decision.answers == []
    owner_line = "Your rules changed before this ran, so it wasn't done."
    assert result.decision.owner_plain == owner_line
    assert await read_decision(owner, held.decision_id) == result.decision
    # the session reads the owner's answer without the owner's line (`owner_plain`), which only the owner's reads carry
    read = await read_decision(view, held.decision_id)
    assert read.owner_plain is None
    assert read.model_copy(update={"owner_plain": owner_line}) == result.decision
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
    # the visitor withdrew it themselves: the owner's read has no owner line, so the owner's card keeps its own
    assert (await read_decision(http.owner(copy.owner_token), held.decision_id)).owner_plain is None


@pytest.mark.kernel_plan("01a")
async def test_check_reply_blocks_numbers_and_asks_first(kernel, ro_read):
    """A number in Claude's prose is blocked, and with no card to keep the visitor sees only the call-back offer,
    which Turner's Desk has (the owner's decision of 2026-11-01), never the number."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    blocked = await check_reply(view, session_id, 0, "It comes to $89 for the visit.")
    assert not blocked.ok and "number_in_prose" in {violation.kind for violation in blocked.violations}
    assert blocked.blocks == [RenderedBlock(kind="prose", text=OFFER["en"])]
    assert (blocked.generation, blocked.language) == (0, "en")

    clean = await check_reply(view, session_id, 0, "Happy to help with your drain.")
    assert clean.ok and clean.violations == []
    assert [(block.kind, block.text) for block in clean.blocks] == [("prose", "Happy to help with your drain.")]
    assert clean.message_id != blocked.message_id and clean.ledger_seq > blocked.ledger_seq


# The kernel's call-back offer, the API's signed `STATUS_LINES["offer_callback"]` (the owner's decision of 2026-11-01).
OFFER = {"en": "Would you like me to arrange a callback?", "es": "¿Quiere que solicite una llamada?"}


async def without_call_backs(http: KernelHttp, ro_read, ro_schema: str, copy: CopyCreated, view: CredentialView,
                             session_id: str) -> None:
    """The owner turns off (`POST /tools/confirm`) each tool the session is given that offers a call back
    (`desk.next_steps`): the call-back tool Turner's seed enables, and any business tool for urgent requests. Each is
    pinned at the definition its `tools` row holds."""
    offering = [profile.tool for profile in (await context(view, session_id)).tools
                if NEXT_STEPS["native.request_callback"] in next_steps([profile])]
    assert "native.request_callback" in offering
    rows = ro_read(ro_schema, copy.copy_id, "SELECT tool, definition_sha256 FROM {ro}.tools WHERE desk_id = %s",
                   (copy.desk_ids[0],))
    disabled = await http.owner(copy.owner_token).call("POST /tools/confirm", ToolsConfirmRequest(
        desk_id=copy.desk_ids[0], enable=False, tools=[
            ToolPin(tool=row["tool"], definition_sha256=row["definition_sha256"]) for row in rows
            if row["tool"] in offering]))
    assert sorted(profile.tool for profile in disabled.profiles if profile.status == "disabled") == sorted(offering)


@pytest.mark.kernel_plan("01c")
async def test_a_prose_only_block_with_nothing_to_keep_asks_before_handing_off(kernel, ro_read):
    """Self-serve first (the owner's decision of 2026-11-01): a draft blocked only for its prose, with no checked card
    to keep and none drafted, on a Desk that offers call backs (Turner's seed does), shows the kernel's call-back offer
    as prose in the reply's language, in place of the handoff card, with the reply receipt, and opens no owner
    handoff. A handoff clause Claude drafted is honoured, and once the session has an open handoff the same draft
    shows the handoff card again, opening nothing new; so does the same draft once the Desk offers no call back."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    english, spanish = await new_visitor(http, slug), await new_visitor(http, slug)

    view, session_id = http.session(english.session_token), english.state.session_id
    offered = await check_reply(view, session_id, 0, "It comes to $89 for the visit.")
    assert not offered.ok and {violation.kind for violation in offered.violations} == {"number_in_prose"}
    assert offered.blocks == [RenderedBlock(kind="prose", text=OFFER["en"])]
    assert (offered.language, offered.visitor_plain) == ("en", "Reply checked against Mike Turner's rules")
    assert session_handoffs(ro_read, ro_schema, copy, session_id) == []
    drafted = await view.call("POST /check_reply", CheckReplyRequest(draft=ReplyDraft(
        session_id=session_id, generation=0, prose="It comes to $89 for the visit.",
        clauses=[Clause(template="handoff")])))
    assert [block.template for block in drafted.blocks] == ["handoff"]      # a drafted handoff is honoured
    assert [kind for _, kind, _ in session_handoffs(ro_read, ro_schema, copy, session_id)] == ["card"]
    again = await check_reply(view, session_id, 0, "It comes to $89 for the visit.")
    assert [block.template for block in again.blocks] == ["handoff"]        # the open handoff keeps the card
    assert len(session_handoffs(ro_read, ro_schema, copy, session_id)) == 1

    view, session_id = http.session(spanish.session_token), spanish.state.session_id
    assert (await check_reply(view, session_id, 0, "Hola, puedo ayudarle con eso.")).language == "es"
    offered = await check_reply(view, session_id, 0, "$89.")
    assert (offered.language, offered.blocks, offered.visitor_plain) == (
        "es", [RenderedBlock(kind="prose", text=OFFER["es"])], "Respuesta revisada con las reglas de Mike Turner")
    assert session_handoffs(ro_read, ro_schema, copy, session_id) == []

    await without_call_backs(http, ro_read, ro_schema, copy, view, session_id)
    handed = await check_reply(view, session_id, 0, "$89.")
    assert [block.template for block in handed.blocks] == ["handoff"]
    assert handed.visitor_plain == "Pasado a Mike Turner para responder"
    assert [kind for _, kind, _ in session_handoffs(ro_read, ro_schema, copy, session_id)] == ["card"]


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


@pytest.mark.kernel_plan("01c")
async def test_payment_caption_rewrites_and_prose_failure_keeps_its_card(kernel, ro_read):
    """One unchanged payment action, one checked correction; final prose failures keep the checked link alone."""
    http, ro_schema, state = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    _, issued = await issue_payment_link(view, session_id,
        item_id(ro_read, ro_schema, copy, "Service call deposit"), 1,
        owner=http.owner(copy.owner_token) if state is None else None)
    clause = Clause(template="payment_link", fact_id=issued.facts[0].fact_id)

    async def caption(prose: str, final: bool):
        return await view.call("POST /check_reply", CheckReplyRequest(draft=ReplyDraft(
            session_id=session_id, generation=0, prose=prose, clauses=[clause]), final=final))

    blocked = await caption("Absolutely. Payment link below.", False)
    assert not blocked.ok and blocked.blocks == []
    assert [(v.kind, v.rule_id) for v in blocked.violations] == [("uncertain_language", "language_uncertain")]
    corrected = await caption("Here is the link to pay.", True)
    assert corrected.ok and [b.template for b in corrected.blocks] == [None, "payment_link"]
    for prose in ("Absolutely. Payment link below.", "Here is $20."):
        kept = await caption(prose, True)
        assert not kept.ok and [b.template for b in kept.blocks] == ["payment_link"]
        assert kept.blocks[0].href == corrected.blocks[1].href
    french = await caption("Bonjour, je peux vous aider.", False)
    assert not french.ok and [b.template for b in french.blocks] == ["handoff"]


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
        ("allowed", "Checked against Mike Turner's rules"), ("held", "Waiting for Mike Turner to approve"),
        ("refused", "Not something I can do here"), ("cancelled", "Cancelled"),
        ("denied", "Mike Turner decided not to go ahead")]
    assert (await check_reply(view, session_id, 0, "Happy to help.")).visitor_plain == (
        "Reply checked against Mike Turner's rules")
    assert (await check_reply(view, session_id, 0, "It costs 80 dollars.")).visitor_plain == (
        "Reply checked against Mike Turner's rules")       # blocked for its prose alone: the call-back offer shows
    assert (await check_reply(view, session_id, 0, "Bonjour, je peux vous aider.")).visitor_plain == (
        "Passed to Mike Turner to answer")

    spanish = await new_visitor(http, slug)
    view, session_id = http.session(spanish.session_token), spanish.state.session_id
    assert (await check_reply(view, session_id, 0, "Hola, puedo ayudarle con eso.")).visitor_plain == (
        "Respuesta revisada con las reglas de Mike Turner")
    assert (await decide(view, session_id, 0, "call-1", "native.quote", quote_args(drain))).visitor_plain == (
        "Revisado con las reglas de Mike Turner")


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
    assert lines == {"native.quote": ("executed", "Quoted from Mike Turner's price list"),
                     "native.find_slots": ("executed", "Times read from Mike Turner's calendar"),
                     "native.request_callback": ("executed", "Callback request saved for Mike Turner"),
                     "native.start_verification": ("executed", "Verification started")}

    spanish = await new_visitor(http, slug)
    view, session_id = http.session(spanish.session_token), spanish.state.session_id
    assert (await check_reply(view, session_id, 0, "Hola, puedo ayudarle con eso.")).ok
    allowed = await decide(view, session_id, 0, "call-1", "native.find_slots", {})
    await execute(view, allowed, 0)
    assert (await read_decision(view, allowed.decision_id)).visitor_plain == (
        "Horarios tomados del calendario de Mike Turner")


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
        "Turner Plumbing", "Main line", "Mike Turner")
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
    assert len(private) == 12 and not [value for value in private if value in shown]
    assert await refused(http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug + "-gone"})) == (
        404, "not_found")


# The Turner seed's starter questions, in the order the public chat's chips show them.
RIVERA_STARTERS = {
    "en": ["How much is drain clearing?", "Can someone come Tuesday?", "Do you work in Alameda?"],
    "es": ["¿Cuánto cuesta destapar un desagüe?", "¿Puede venir alguien el martes?", "¿Trabajan en Alameda?"],
}


@pytest.mark.kernel_plan("01b")
async def test_public_desk_serves_the_seeds_starters_in_its_language(kernel, ro_read):
    """Turner's three seed-only starter questions, in the language asked for and never in a session's context; a Desk
    the owner makes has none."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    for lang, starters in RIVERA_STARTERS.items():
        assert (await public_page(http, slug, lang)).starters == starters, lang
    visitor = await new_visitor(http, slug)
    facts = (await context(http.session(visitor.session_token), visitor.state.session_id)).facts
    assert "charter:contact" in [fact.fact_id for fact in facts]
    assert not [fact for fact in facts if fact.fact_id.startswith("charter:starter:")]
    created = await http.owner(copy.owner_token).call("POST /desks", a_new_desk())
    assert (await public_page(http, created.slug, "es")).starters == []


@pytest.mark.kernel_plan("01b")
async def test_owner_charter_write_naming_a_starter_is_refused(kernel, ro_read):
    """Only the seed writes starters: an owner's charter write naming one is 422 `invalid`, naming the key, and changes
    nothing; a write without one keeps the seed's starters, as it keeps the hours."""
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    slug, path = desk_slug(ro_read, schema, copy), {"id": desk_id}
    contact = Claim(key="contact", kind="text", value="(510) 555-0199")
    query = "SELECT fact_id, claims FROM {ro}.facts WHERE desk_id = %s AND kind = 'charter' ORDER BY fact_id"
    before = ro_read(schema, copy.copy_id, query, (desk_id,))
    with pytest.raises(KernelFailed) as failure:
        await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[
            contact, Claim(key="starter:1", kind="text", value="Is the first visit free today?")]), path=path)
    assert (failure.value.status, failure.value.code, failure.value.detail) == (
        422, "invalid", {"starter:1": ["starter_seed_only"]})
    assert ro_read(schema, copy.copy_id, query, (desk_id,)) == before
    assert (await public_page(http, slug, "en")).starters == RIVERA_STARTERS["en"]
    await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[contact]), path=path)
    assert (await public_page(http, slug, "es")).starters == RIVERA_STARTERS["es"]


@pytest.mark.kernel_plan("01b")
async def test_new_desk_naming_a_starter_is_refused(kernel, ro_read):
    """A new Desk's charter can't name a starter either: `POST /desks` with one is 422 `invalid`, naming the key, and
    makes no Desk."""
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    query = "SELECT desk_id FROM {ro}.desks ORDER BY desk_id"
    before = ro_read(schema, copy.copy_id, query)
    body = a_new_desk()
    body.desk.charter = [Claim(key="contact", kind="text", value="(212) 555-0187"),
                         Claim(key="starter:1", kind="text", value="Is the first visit free today?")]
    with pytest.raises(KernelFailed) as failure:
        await owner.call("POST /desks", body)
    assert (failure.value.status, failure.value.code, failure.value.detail) == (
        422, "invalid", {"starter:1": ["starter_seed_only"]})
    assert ro_read(schema, copy.copy_id, query) == before
    assert (await owner.whoami()).desk_ids == copy.desk_ids


RIVERA_TIME = ZoneInfo("America/Los_Angeles")
# The Turner seed's hours, by weekday (Monday 0): weekdays 8:00 am to 6:00 pm, Saturday 9:00 am to 1:00 pm.
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
    """The public page's Agent Card: one prose block for each thing an agent can do on the Desk now, by its plain label
    in sentence case and the language asked for (leaving details and asking for a callback alone while Answering is
    off), and nothing else. The page says who answers, and the API's own card where to send requests and how to sign
    them, so the kernel's card names no endpoint, header or business."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)

    async def card(lang: str) -> list[str]:
        blocks = (await public_page(http, slug, lang)).agent_card
        assert all((block.kind, block.template, block.title) == ("prose", None, None) for block in blocks)
        return [block.text for block in blocks]

    assert await card("en") == [
        "Get a quote from the price list", "Find open times", "Book a visit", "Get a payment link for a quote",
        "Pay for a quote within a signed limit", "Leave contact details", "Ask for a callback",
        "Verify a customer with a code sent to their contact on record", "Receive a verified customer's own documents",
        "List a verified customer's own charges"]
    assert await card("es") == [
        "Pedir una cotización de la lista de precios", "Buscar horarios libres", "Reservar una visita",
        "Pedir un enlace de pago para una cotización", "Pagar una cotización dentro de un límite firmado",
        "Dejar datos de contacto", "Pedir que te devuelvan la llamada",
        "Verificar a un cliente con un código enviado a su contacto registrado",
        "Recibir los documentos propios de un cliente verificado", "Ver los cargos propios de un cliente verificado"]

    await http.owner(copy.owner_token).call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False),
                                            path={"id": copy.desk_ids[0]})
    assert await card("en") == ["Leave contact details", "Ask for a callback"]
    assert await card("es") == ["Dejar datos de contacto", "Pedir que te devuelvan la llamada"]


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
    assert len(items) == 6 and [fact.fact_id for fact in facts].count("catalog") == 1


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
    """Answering off leaves visitors only lead capture and a callback, urgent or not (their declared tools unchanged),
    on gives the rest back; each switch is the owner's, on its own copy's Desk, and ledgered `desk_data`."""
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
    assert now == {"desk.emergency-callback", "native.capture_lead", "native.request_callback"}
    assert declared == before[1]

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


CARD_HANDOFF_REASON = "The Desk handed this to you."
HANDED_TO_YOU = "A visitor is waiting in a conversation the Desk handed to you."


@pytest.mark.kernel_plan("01b")
async def test_the_handoff_card_opens_one_owner_handoff_per_session(kernel, ro_read):
    """The handoff card opens a handoff the owner sees (#96). A reply the check blocks for what no rewrite fixes
    (another language) shows the visitor the handoff card and opens one handoff on the session, which the owner's Needs you lists from `kernel_ro.handoffs`: kind
    `card`, no call-back window and the kernel's reason, never the draft's words. The owner gets one alert naming no
    decision and nothing of the draft. A second blocked reply in the same session shows the card again but opens none
    and alerts nothing. Claude's own draft citing the card opens one too. The alert follows the Desk's notification
    preferences, as every alert does: with `handoff` taken out of "now", a card still opens a handoff but alerts
    nothing."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    desk_id, owner, slug = copy.desk_ids[0], http.owner(copy.owner_token), desk_slug(ro_read, ro_schema, copy)
    seeded = {entry.entry_id for entry in await owner.call("GET /demo_inbox")}

    def open_handoffs() -> list[tuple]:
        """The Desk's open handoffs as Needs you reads them: (session, kind, call-back window, reason)."""
        rows = ro_read(ro_schema, copy.copy_id, "SELECT session_id, kind, callback_window, reason FROM {ro}.handoffs"
                                                " WHERE desk_id = %s AND status = 'open'", (desk_id,))
        return sorted(tuple(row.values()) for row in rows)

    async def alerts() -> list[DemoInboxEntry]:
        return [entry for entry in await owner.call("GET /demo_inbox") if entry.entry_id not in seeded]

    blocked = await new_visitor(http, slug)
    for _ in range(2):
        verdict = await check_reply(http.session(blocked.session_token), blocked.state.session_id, 0,
                                    OTHER_LANGUAGE)
        assert not verdict.ok and [block.template for block in verdict.blocks] == ["handoff"]
        assert open_handoffs() == [(blocked.state.session_id, "card", None, CARD_HANDOFF_REASON)]
        (alert,) = await alerts()
        assert (alert.to, alert.kind, alert.decision_id, alert.body) == ("owner", "alert", None, HANDED_TO_YOU)

    cited = await new_visitor(http, slug)
    draft = ReplyDraft(session_id=cited.state.session_id, generation=0, prose="",
                       clauses=[Clause(template="handoff")])
    verdict = await http.session(cited.session_token).call("POST /check_reply", CheckReplyRequest(draft=draft))
    assert verdict.ok and [block.template for block in verdict.blocks] == ["handoff"]
    assert open_handoffs() == sorted([(blocked.state.session_id, "card", None, CARD_HANDOFF_REASON),
                                      (cited.state.session_id, "card", None, CARD_HANDOFF_REASON)])
    assert [entry.body for entry in await alerts()] == [HANDED_TO_YOU] * 2

    quiet = NotificationDefaults(now=["approval", "emergency", "breaker", "lockout"],
                                 briefing=["lead", "callback", "booking"])
    await owner.call("PUT /desks/{id}/notifications", DeskNotificationsRequest(notifications=quiet),
                     path={"id": desk_id})
    unalerted = await new_visitor(http, slug)
    verdict = await check_reply(http.session(unalerted.session_token), unalerted.state.session_id, 0,
                                OTHER_LANGUAGE)
    assert not verdict.ok and len(open_handoffs()) == 3
    assert (unalerted.state.session_id, "card", None, CARD_HANDOFF_REASON) in open_handoffs()
    assert len(await alerts()) == 2


BLOCKED_PROSE = "It comes to $89 for the visit."           # a number in prose: a kind a rewrite fixes
OTHER_LANGUAGE = "Bonjour, je peux vous aider."             # unsupported_language: no rewrite fixes it


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("prose", "clauses", "final", "ok", "templates", "receipt"), [
    ("", [Clause(template="handoff")], True, True, ["handoff"], "Passed to Mike Turner to answer"),
    (OTHER_LANGUAGE, [], True, False, ["handoff"], "Passed to Mike Turner to answer"),
    (BLOCKED_PROSE, [], True, False, [None], "Reply checked against Mike Turner's rules"),   # the call-back offer
    (BLOCKED_PROSE, [Clause(template="hours", fact_id="charter:hours")], True, False, ["hours"],
     "Reply checked against Mike Turner's rules"),
    (BLOCKED_PROSE, [], False, False, [], "Passed to Mike Turner to answer"),
], ids=["passing-handoff", "final-handoff", "final-offer", "final-kept-card", "unshown-first-attempt"])
async def test_check_reply_receipt_follows_the_shown_handoff_clause(kernel, ro_read, prose, clauses, final, ok,
                                                                  templates, receipt):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    draft = ReplyDraft(session_id=visitor.state.session_id, generation=0, prose=prose, clauses=clauses)
    verdict = await http.session(visitor.session_token).call("POST /check_reply",
                                                            CheckReplyRequest(draft=draft, final=final))
    assert verdict.ok is ok
    assert [block.template for block in verdict.blocks] == templates
    assert verdict.visitor_plain == receipt


HOURS_CLAUSE = Clause(template="hours", fact_id="charter:hours")


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("prose", "clauses", "templates"), [
    ("", [Clause(template="handoff")], ["handoff"]),
    (OTHER_LANGUAGE, [], ["handoff"]),
    (BLOCKED_PROSE, [], [None]),                                            # the call-back offer, as prose
    (BLOCKED_PROSE, [Clause(template="handoff")], ["handoff"]),             # a drafted handoff is honoured
    (BLOCKED_PROSE, [HOURS_CLAUSE], ["hours"]),
    (BLOCKED_PROSE, [HOURS_CLAUSE, Clause(template="handoff")], ["hours", "handoff"]),
    ("Here are our opening hours.", [HOURS_CLAUSE], [None, "hours"]),
], ids=["passing-handoff", "final-handoff", "final-offer", "final-drafted-handoff", "final-kept-card",
        "final-kept-card-then-drafted-handoff", "passing-checked"])
async def test_delivered_handoff_flag_matches_the_reply_receipt(kernel, ro_read, prose, clauses, templates):
    """The visitor's delivered event flag and the kernel's signed reply receipt can't disagree about a handoff, and a
    shown handoff clause opens the owner's handoff: Claude's cited one, the kernel's in a blocked draft's place, or
    Claude's drafted one kept after the cards a prose-only failure keeps."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, ro_schema, copy))
    session_id = visitor.state.session_id
    draft = ReplyDraft(session_id=session_id, generation=0, prose=prose, clauses=clauses)
    verdict = await http.session(visitor.session_token).call("POST /check_reply",
                                                            CheckReplyRequest(draft=draft, final=True))
    reply = Reply(verdict, "claude", "api")
    assert [block.template for block in verdict.blocks] == templates
    assert reply.handoff is ("handoff" in templates)
    assert reply.handoff is (verdict.visitor_plain == "Passed to Mike Turner to answer")
    assert verdict.visitor_plain in ("Passed to Mike Turner to answer", "Reply checked against Mike Turner's rules")
    assert [(kind, status) for _, kind, status in session_handoffs(ro_read, ro_schema, copy, session_id)] == (
        [("card", "open")] if reply.handoff else [])
    (entry,) = [entry for entry in (await ledger_page(http.owner(copy.owner_token), copy.desk_ids[0])).entries
                if entry.event.kind == "reply" and entry.event.session_id == session_id]
    assert entry.event.summary["dropped"] == []                 # no card was refused at signing


async def checked(http: KernelHttp, created: SessionCreated, prose: str, *, final: bool) -> ReplyVerdict:
    draft = ReplyDraft(session_id=created.state.session_id, generation=0, prose=prose)
    return await http.session(created.session_token).call("POST /check_reply",
                                                          CheckReplyRequest(draft=draft, final=final))


def session_handoffs(ro_read, ro_schema: str, copy: CopyCreated, session_id: str) -> list[tuple]:
    """The session's handoffs as the owner's reads see them: (handoff ID, kind, status)."""
    return [tuple(row.values()) for row in ro_read(
        ro_schema, copy.copy_id, "SELECT handoff_id, kind, status FROM {ro}.handoffs WHERE session_id = %s"
                                 " ORDER BY handoff_id", (session_id,))]


@pytest.mark.kernel_plan("01b")
async def test_only_a_handoff_card_the_session_sees_opens_an_owner_handoff(kernel, ro_read):
    """The API checks a first draft it could still rewrite with `final` false (`CheckReplyRequest.final`). Blocked only
    for kinds a rewrite fixes (`desk.rewrites`), it is never shown, so the kernel opens no owner handoff and alerts
    nothing; the same draft checked as final is shown as the call-back offer, which opens none either, and a
    non-final draft blocked for a kind no rewrite fixes shows the handoff card and opens one. Each reply entry
    records `final`. While the session has a held request awaiting the owner, whose own alert and item the owner
    has, a handoff card opens none; once the owner has answered it, the next one does."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    desk_id, owner, slug = copy.desk_ids[0], http.owner(copy.owner_token), desk_slug(ro_read, ro_schema, copy)
    seeded = {entry.entry_id for entry in await owner.call("GET /demo_inbox")}

    async def handed_to_you() -> int:
        return sum(entry.body == HANDED_TO_YOU for entry in await owner.call("GET /demo_inbox")
                   if entry.entry_id not in seeded)

    async def recorded_final(verdict: ReplyVerdict) -> bool:
        (entry,) = [entry for entry in (await ledger_page(owner, desk_id)).entries if entry.seq == verdict.ledger_seq]
        assert entry.event.kind == "reply"
        return entry.event.summary["final"]

    visitor = await new_visitor(http, slug)
    rewritable = await checked(http, visitor, BLOCKED_PROSE, final=False)
    assert not rewritable.ok and {violation.kind for violation in rewritable.violations} == {"number_in_prose"}
    assert rewritable.blocks == []                          # never shown, so no handoff card is signed for it
    assert session_handoffs(ro_read, ro_schema, copy, visitor.state.session_id) == []
    assert await handed_to_you() == 0 and await recorded_final(rewritable) is False
    shown = await checked(http, visitor, BLOCKED_PROSE, final=True)
    assert not shown.ok and await recorded_final(shown) is True
    assert shown.blocks == [RenderedBlock(kind="prose", text=OFFER["en"])]
    assert session_handoffs(ro_read, ro_schema, copy, visitor.state.session_id) == []
    assert await handed_to_you() == 0

    stranger = await new_visitor(http, slug)
    french = await checked(http, stranger, OTHER_LANGUAGE, final=False)
    assert "unsupported_language" in {violation.kind for violation in french.violations}
    assert [block.template for block in french.blocks] == ["handoff"]
    assert [kind for _, kind, _ in session_handoffs(ro_read, ro_schema, copy, stranger.state.session_id)] == ["card"]
    assert await handed_to_you() == 1

    asking = await new_visitor(http, slug)
    held = await decide(http.session(asking.session_token), asking.state.session_id, 0, "call-1", "native.quote",
                        quote_args(item_id(ro_read, ro_schema, copy, "Drain clearing"), 1500))
    assert held.state == "held"
    assert not (await checked(http, asking, OTHER_LANGUAGE, final=True)).ok
    assert session_handoffs(ro_read, ro_schema, copy, asking.state.session_id) == []
    assert await handed_to_you() == 1                          # the owner has the held request's alert and item
    await answer(owner, held.decision_id, "deny_once")
    assert not (await checked(http, asking, OTHER_LANGUAGE, final=True)).ok
    assert [kind for _, kind, _ in session_handoffs(ro_read, ro_schema, copy, asking.state.session_id)] == ["card"]
    assert await handed_to_you() == 2


@pytest.mark.kernel_plan("01b")
async def test_a_call_back_request_closes_the_card_handoff_and_opens_its_own(kernel, ro_read):
    """A session holds one open handoff: a call-back request after the handoff card closes the card's handoff, as
    the owner's mark of done closes one, and opens its own of kind `callback` under a new ID, so the owner keeps one
    open item for the conversation. The closing is ledgered `desk_data` naming the card's handoff and, as
    `replaced_by`, the call-back's, so the owner's history reads it as replaced rather than marked done. A row's kind
    never changes, so the owner's stale mark of done on the card answers 409 and leaves the call-back open. The
    owner's own preview of the Desk opens none."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    visitor = await new_visitor(http, slug)
    assert not (await checked(http, visitor, OTHER_LANGUAGE, final=True)).ok
    ((card_id, kind, status),) = session_handoffs(ro_read, ro_schema, copy, visitor.state.session_id)
    assert (kind, status) == ("card", "open")

    view = http.session(visitor.session_token)
    callback = await decide(view, visitor.state.session_id, 0, "call-1", "native.request_callback",
                            {"name": "Dana Wells", "contact": "(503) 555-0142", "reason": "Leaking water heater"})
    assert callback.state == "allowed" and (await execute(view, callback, 0)).state == "succeeded"
    handoffs = {handoff_id: (kind, status)
                for handoff_id, kind, status in session_handoffs(ro_read, ro_schema, copy, visitor.state.session_id)}
    (callback_id,) = set(handoffs) - {card_id}
    assert handoffs == {card_id: ("card", "done"), callback_id: ("callback", "open")}
    (row,) = ro_read(ro_schema, copy.copy_id, "SELECT reason FROM {ro}.handoffs WHERE handoff_id = %s",
                     (callback_id,))
    assert row["reason"] == "Dana Wells · (503) 555-0142 · Leaking water heater"
    owner = http.owner(copy.owner_token)
    closed = [entry.event.summary for entry in (await ledger_page(owner, copy.desk_ids[0])).entries
              if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "handoffs"
              and entry.event.summary.get("refs") == [card_id] and "kind" not in entry.event.summary]
    assert closed == [{"part": "handoffs", "refs": [card_id], "replaced_by": callback_id}]   # replaced, not marked
    assert await refused(owner.call("POST /handoffs/{id}/done", path={"id": card_id})) == (409, "conflict")
    assert {handoff_id: (kind, status) for handoff_id, kind, status in session_handoffs(
        ro_read, ro_schema, copy, visitor.state.session_id)} == handoffs           # the call-back is still open

    previewing = await http.owner(copy.owner_token).call(
        "POST /sessions", CreateSessionRequest(desk_slug=slug, kind="visitor", preview=True))
    assert not (await checked(http, previewing, OTHER_LANGUAGE, final=True)).ok        # shows the handoff card
    assert session_handoffs(ro_read, ro_schema, copy, previewing.state.session_id) == []


async def booking_tool(owner: CredentialView, ro_read, ro_schema: str, copy: CopyCreated, booking: str) -> str:
    """The tool a `native` or `typed` booking books with: `native.book`, or a typed booking business tool the owner
    adds and confirms on the copy's first Desk (it skips when the kernel can't prove drafts)."""
    if booking == "native":
        return "native.book"
    desk_id, tool = copy.desk_ids[0], "desk.consult"
    consult = BusinessTool(tool=tool, title="Book a consult", description="Book an introduction.",
                           config={"block": "typed_booking", "appointment_type": "Consult", "minutes": 20})
    await owner.call("PUT /desks/{id}/business_tools", BusinessToolsRequest(tools=[consult]), path={"id": desk_id})
    (row,) = ro_read(ro_schema, copy.copy_id, "SELECT definition_sha256 FROM {ro}.tools WHERE desk_id = %s"
                                              " AND tool = %s", (desk_id, tool))
    confirmed = await owner.call("POST /tools/confirm", ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool, definition_sha256=row["definition_sha256"])], enable=True))
    proved_or_skip(confirmed.draft)
    await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=confirmed.draft.version))
    return tool


async def bookable_outright(owner: CredentialView, ro_read, ro_schema: str, copy: CopyCreated,
                            tool: str = "native.book") -> dict:
    """The copy's first calendar slot, which `tool` now books with no one asked: an owner card allows it in the slot's
    window with no review, in place of the cards that covered the tool, drafted, proved and confirmed (it skips when
    the kernel can't prove drafts)."""
    desk_id = copy.desk_ids[0]
    (slot, *_) = ro_read(ro_schema, copy.copy_id, "SELECT slot_id, starts_at, minutes FROM {ro}.calendar_slots"
                                                  " WHERE desk_id = %s ORDER BY starts_at", (desk_id,))
    local = slot["starts_at"].astimezone(ZoneInfo("America/Los_Angeles"))
    window = HoursWindow(days=[local.strftime("%a").lower()], start=local.time().replace(tzinfo=None),
                         end=(local + timedelta(minutes=slot["minutes"])).time().replace(tzinfo=None))
    active = active_version(ro_read, ro_schema, copy.copy_id, desk_id)
    cards = [card for card in owner_cards(active) if card.applies_to != tool] + [RuleCard(
        card_id="booking-auto", applies_to=tool, mode="auto", who="anyone", hours=window,
        reason="Book visits in this window.")]
    draft = await owner.call("POST /policy/draft", PolicyDraftRequest(desk_id=desk_id, cards=cards,
                                                                      expected_parent=active["version"]))
    proved_or_skip(draft)
    await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    return slot


@pytest.mark.kernel_plan("01c")
@pytest.mark.parametrize("booking", ["native", "typed"])
async def test_a_booking_closes_the_sessions_card_handoff(kernel, ro_read, booking):
    """A booking in a conversation the handoff card handed to the owner closes the card's handoff, as the owner's mark
    of done closes one, so the owner's Needs you stops listing the conversation. The closing is ledgered `desk_data`
    naming the card's handoff with `closed_by: "booking"`. Another session's card handoff stays open. A typed booking
    books through the native booking's execution, so it closes the card's handoff the same way. Both bookings are
    allowed outright by an owner card for the slot's window, with no review."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    desk_id, owner, slug = copy.desk_ids[0], http.owner(copy.owner_token), desk_slug(ro_read, ro_schema, copy)
    tool = await booking_tool(owner, ro_read, ro_schema, copy, booking)
    slot = await bookable_outright(owner, ro_read, ro_schema, copy, tool)

    visitor, other = await new_visitor(http, slug), await new_visitor(http, slug)
    for created in (visitor, other):              # another language: the handoff card, which opens a card handoff
        assert not (await checked(http, created, OTHER_LANGUAGE, final=True)).ok
    ((card_id, kind, status),) = session_handoffs(ro_read, ro_schema, copy, visitor.state.session_id)
    assert (kind, status) == ("card", "open")
    view = http.session(visitor.session_token)
    allowed = await decide(view, visitor.state.session_id, 0, "book-1", tool, {"slot_id": slot["slot_id"]})
    assert allowed.outcome == "allow", allowed.reason_plain
    assert (await execute(view, allowed, 0)).state == "succeeded"
    assert session_handoffs(ro_read, ro_schema, copy, visitor.state.session_id) == [(card_id, "card", "done")]
    others = session_handoffs(ro_read, ro_schema, copy, other.state.session_id)
    assert [(kind, status) for _, kind, status in others] == [("card", "open")]
    closed = [entry.event.summary for entry in (await ledger_page(owner, desk_id)).entries
              if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "handoffs"
              and "kind" not in entry.event.summary]
    assert closed == [{"part": "handoffs", "refs": [card_id], "closed_by": "booking"}]


@pytest.mark.kernel_plan("01c")
@pytest.mark.parametrize("booking", ["native", "typed"])
async def test_a_booking_cancels_the_sessions_earlier_held_discount_quote(kernel, ro_read, booking):
    """A visitor whose discount quote is held and who then books, at list price, no longer waits on the discount: the
    next read of the held quote, through the API's own client, finds it `cancelled` with the state's own line, ledgered
    `decide` naming the booking and the rules version in force with its money cap, and the owner's answer to it is 409
    with nothing run. A typed booking writes the same booking, so it counts the same way. Another session's held
    discount quote, with no booking, stays held. The owner alone reads that a booking closed it (`owner_plain`, the
    owner's line, unsigned); the visitor's reads, and its cancel, now refused, carry none of it."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    desk_id, owner, slug = copy.desk_ids[0], http.owner(copy.owner_token), desk_slug(ro_read, ro_schema, copy)
    tool = await booking_tool(owner, ro_read, ro_schema, copy, booking)
    slot = await bookable_outright(owner, ro_read, ro_schema, copy, tool)
    drain = item_id(ro_read, ro_schema, copy, "Drain clearing")
    visitor, other = await new_visitor(http, slug), await new_visitor(http, slug)
    view = http.session(visitor.session_token)
    held = await decide(view, visitor.state.session_id, 0, "quote-1", "native.quote", quote_args(drain, 5000))
    kept = await decide(http.session(other.session_token), other.state.session_id, 0, "quote-1", "native.quote",
                        quote_args(drain, 5000))
    assert held.state == kept.state == "held"
    booked = await decide(view, visitor.state.session_id, 0, "book-1", tool, {"slot_id": slot["slot_id"]})
    assert booked.outcome == "allow", booked.reason_plain
    assert (await execute(view, booked, 0)).state == "succeeded"

    cancelled = await read_decision(view, held.decision_id)
    assert (cancelled.state, cancelled.visitor_plain, cancelled.answers) == ("cancelled", "Cancelled", [])
    assert cancelled.ledger_seq > held.ledger_seq and cancelled.signature != held.signature
    assert cancelled.owner_plain is None
    assert await refused(answer(owner, held.decision_id, "allow_once")) == (409, "conflict")
    assert await read_decision(owner, held.decision_id) == cancelled.model_copy(update={"owner_plain": BOOKED_LINE})
    assert await read_decision(view, held.decision_id) == cancelled
    assert (await read_decision(owner, kept.decision_id)).state == "held"
    stored = ro_read(ro_schema, copy.copy_id, "SELECT state FROM {ro}.decisions WHERE decision_id = %s",
                     (held.decision_id,))
    assert stored == [{"state": "cancelled"}]
    (row,) = ro_read(ro_schema, copy.copy_id, "SELECT booking_id FROM {ro}.bookings WHERE desk_id = %s", (desk_id,))
    active = active_version(ro_read, ro_schema, copy.copy_id, desk_id)
    entries = [entry.event.summary for entry in (await ledger_page(owner, desk_id)).entries
               if entry.event.kind == "decide" and entry.event.ref_id == held.decision_id]
    assert entries[1:] == [{"decision_id": held.decision_id, "action_id": held.action.action_id, "state": "cancelled",
                            "cancelled_by": "booking", "booking_id": row["booking_id"],
                            "policy_version": active["version"],
                            "auto_money_cap_cents": active["auto_money_cap_cents"]}]
    assert await refused(view.call("POST /decisions/{decision_id}/cancel",
                                   CancelRequest(session_id=visitor.state.session_id),
                                   path={"decision_id": held.decision_id})) == (409, "conflict")


# The owner's line for a held request a booking closed (the kernel's `render.owner_line("cancelled_by_booking")`).
BOOKED_LINE = "The visitor booked before you answered, so this request closed."


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

DANA = "dana@example.com"               # a contact on record in the Turner seed (master plan, "Turner seed")
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
async def test_a_document_named_by_its_fact_id_is_released_as_by_its_id(kernel, ro_read):
    """Claude's context shows a document by its fact ID (`document:<id>`), and that whole ID names the same document
    as the bare one: the record owner's call is allowed, resolved to the document's own ID, and executes to a link card
    for it. Another kind's prefix names no document, so that call is refused before any action exists."""
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
                           {"document_id": f"document:{document['document_id']}"})
    assert allowed.state == "allowed"
    assert (allowed.action.resource.kind, allowed.action.resource.id, allowed.action.resource.owner_person_id) == (
        "document", document["document_id"], person_id)
    executed = await execute(view, allowed, 0)
    (fact,) = executed.facts
    verdict = await cite(view, session_id, 0, "Here is your invoice.", "document_link", fact.fact_id)
    assert verdict.ok
    (card,) = [block for block in verdict.blocks if block.template == "document_link"]
    assert card.title == document["title"]

    refused = await decide(view, session_id, 0, "call-2", "native.release_document",
                           {"document_id": f"quote:{document['document_id']}"})
    assert (refused.outcome, refused.state, refused.action) == ("refuse", "refused", None)


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
    """A payment link for the session's own quote of one `item`, under the Turner seed's `rv-link` card, which allows
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
    assert (shown.business_name, shown.customer_name, shown.cancel_reason) == ("Turner Plumbing", None, None)
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
    """A nonce's turn ends at a passing verdict, an immediate handoff, a blocked check the API sent as final
    (`CheckReplyRequest.final`) or the second reply check; after that the same request is 409 `replayed`, and any
    other reuse 401. A first attempt sent with `final` false and blocked only for kinds a rewrite fixes leaves the
    turn open for the rewrite."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    created, _ = await open_agent_session(http, issued, slug)
    session_id = created.state.session_id

    async def turn(message: str, *drafts: str) -> CredentialView:
        view = turn_view(http, issued, slug, session_id, message)
        assert (await view.whoami(session_id)).session.session_id == session_id
        for draft in drafts:                    # a first attempt, as the API sends one a rewrite may follow
            await check_reply(view, session_id, 0, draft, final=False)
        return view

    passed = await turn("When are you open?", "We're open on weekdays.")
    assert await refused(passed.whoami(session_id)) == (409, "replayed")
    assert await refused(context(passed, session_id)) == (409, "replayed")
    assert await refused(passed.call("POST /sessions/{session_id}/turn", TurnRequest(
        generation=0, text="When are you open?"), path={"session_id": session_id})) == (409, "replayed")
    handed_off = await turn("Parlez-vous français ?", "Bonjour, je peux vous aider.")   # unsupported_language
    assert await refused(handed_off.whoami(session_id)) == (409, "replayed")
    final_block = await turn("What does it cost?")
    await check_reply(final_block, session_id, 0, "It costs 40 dollars.", final=True)    # blocked, sent as final
    assert await refused(final_block.whoami(session_id)) == (409, "replayed")
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


@pytest.mark.kernel_plan("01c")
@pytest.mark.parametrize("path", ["allow", "approval"])
async def test_expired_mandate_at_execution_names_no_rule_change(kernel, ro_read, arrange, path):
    """Expiry changes the mandate's authority, not the owner's rules: both kernels ledger `conditions`,
    charge nothing and give the owner the fallback, on allow and `allow_once` paths alike."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    if path == "approval":
        await arrange.ask(owner, ro_read, ro_schema, copy, "native.charge_mandate")
    slug = desk_slug(ro_read, ro_schema, copy)
    issued = await demo_agent(http, copy)
    created, _ = await open_agent_session(http, issued, slug)
    session_id = created.state.session_id
    view = turn_view(http, issued, slug, session_id, "Please charge the deposit")
    deposit = item_id(ro_read, ro_schema, copy, "Service call deposit")
    quoted = await execute(view, await decide(view, session_id, 0, "call-quote", "native.quote",
                                              quote_args(deposit)), 0)
    decision = await decide(view, session_id, 0, "call-charge", "native.charge_mandate",
                            {"quote_id": quoted.model_view["quote_id"]})
    assert decision.outcome == ("allow" if path == "allow" else "hold")
    arrange.expire_mandate(issued.mandate.mandate_id)

    if path == "allow":
        assert await refused(execute(view, decision, 0)) == (409, "conflict")
    else:
        result = await answer(owner, decision.decision_id, "allow_once")
        assert result.execution is None

    read = await read_decision(owner, decision.decision_id)
    assert read.state == "refused_at_execution"
    page = await ledger_page(owner, copy.desk_ids[0])
    entries = [entry.event.summary for entry in page.entries
               if entry.event.ref_id == decision.decision_id
               and entry.event.kind == ("execute" if path == "allow" else "approval")]
    assert entries[-1]["check"] == "conditions"
    assert read.owner_plain == "This couldn't run, so it wasn't done."
    assert (await read_decision(view, decision.decision_id)).owner_plain is None
    (mandate,) = ro_read(ro_schema, copy.copy_id, "SELECT committed_cents, reserved_cents FROM {ro}.mandates"
                                                  " WHERE mandate_id = %s", (issued.mandate.mandate_id,))
    assert mandate == {"committed_cents": 0, "reserved_cents": 0}


# Setup: a new Desk and the owner's setup tools (Plans 01b and 01c) ---------------------------------------------------


SETUP_TOOLS = {"native.fetch_website", "native.read_memory", "native.web_search"}
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
async def test_a_brand_palette_pick_stores_the_tables_colours(kernel, ro_read):
    """`PUT /desks/{id}/business` with `brand_palette` stores the key and `BRAND_PALETTE`'s colours as the brand, and
    a brand passed back with a pick takes the table's colours, never its own; the API's view holds the brand as
    stored, the public page serves it as `effective_brand` reads it, and the ledger names the key. "none" is the pick
    of no colours; no pick and an empty brand store nothing, which reads as teal."""
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    path = {"id": created.desk_id}
    names = {"name": "Okafor Electric", "owner_display_name": "Bob Okafor", "timezone": "America/New_York"}

    async def brand_read() -> tuple[dict, dict]:
        (row,) = ro_read(ro_schema, copy.copy_id, "SELECT b.brand FROM {ro}.businesses b"
                                                  " JOIN {ro}.desks d USING (business_id) WHERE d.desk_id = %s",
                         (created.desk_id,))
        public = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": created.slug})
        return row["brand"], public.brand

    await owner.call("PUT /desks/{id}/business", DeskBusinessRequest(**names, brand_palette="rust"), path=path)
    rust = {"palette": "rust", **BRAND_PALETTE["rust"]}
    assert await brand_read() == (rust, rust)
    business = [entry.event.summary for entry in (await ledger_page(owner, created.desk_id)).entries
                if entry.event.kind == "desk_data" and entry.event.summary.get("part") == "business"]
    assert business[-1]["palette"] == "rust"
    passed_back = DeskBusinessRequest(**names, brand={"palette": "slate", "primary": "#000000"})
    await owner.call("PUT /desks/{id}/business", passed_back, path=path)
    slate = {"palette": "slate", **BRAND_PALETTE["slate"]}
    assert await brand_read() == (slate, slate)
    await owner.call("PUT /desks/{id}/business", DeskBusinessRequest(**names, brand_palette="none"), path=path)
    assert await brand_read() == ({"palette": "none"}, {"palette": "none"})
    await owner.call("PUT /desks/{id}/business", DeskBusinessRequest(**names), path=path)
    assert await brand_read() == ({}, {"palette": "teal", **BRAND_PALETTE["teal"]})


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

    from desk.kernel_api import DeskMemoryRequest

    empty = await owner.call("POST /decide", DecideRequest(
        session_id=session.session_id, generation=session.generation, desk_id=created.desk_id,
        call=ToolCall(call_id="empty-memory", tool="native.read_memory", args={"query": "business hours"})))
    assert (await execute(owner, empty, session.generation)).model_view == {"simulated": True, "items": []}

    memory = DeskMemoryRequest.model_validate({"about": "Simulated CPA notes.", "items": [
        {"id": "business", "title": "Chen CPA", "topics": ["business"], "text": "Chen CPA prepares tax returns."}]})
    updated = await owner.call("PUT /desks/{id}/memory", memory, path={"id": created.desk_id})
    assert isinstance(updated, DeskUpdated) and updated.desk_id == created.desk_id

    call = ToolCall(call_id="setup-memory", tool="native.read_memory", args={"query": "business hours"})
    decision = await owner.call("POST /decide", DecideRequest(session_id=session.session_id,
                                                              generation=session.generation, call=call,
                                                              desk_id=created.desk_id))
    assert decision.outcome == "allow" and decision.session_id == session.session_id
    assert decision.action.desk_id == created.desk_id and decision.action.resource.kind == "desk"
    result = await execute(owner, decision, session.generation)
    assert result.state == "succeeded" and result.model_view == {"simulated": True, "items": [
        {"title": "Chen CPA", "text": "Chen CPA prepares tax returns."}]}
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
                         "native.fetch_website", {"url": "https://turner-plumbing.example"})
    assert fetch.outcome == "refuse" and fetch.action is None
    stranger = http.owner(other.owner_token)
    theirs = (await stranger.whoami()).session
    elsewhere = stranger.call("POST /decide", DecideRequest(session_id=theirs.session_id, generation=theirs.generation,
                                                            call=call, desk_id=created.desk_id))
    assert await refused(elsewhere) == (404, "not_found")


@pytest.mark.kernel_plan("01c")
async def test_memory_nul_item_is_refused(kernel):
    from desk.kernel_api import DeskMemoryRequest

    http, _, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    memory = DeskMemoryRequest.model_validate({"about": "Simulated CPA notes.", "items": [
        {"id": "business", "title": "Chen CPA", "topics": ["business"], "text": "before\0after"}]})
    start = (await ledger_page(owner, created.desk_id)).entries[-1].seq
    assert await refused(owner.call("PUT /desks/{id}/memory", memory, path={"id": created.desk_id})) == (
        422, "invalid")
    assert [(entry.event.kind, entry.event.summary)
            for entry in (await ledger_page(owner, created.desk_id)).entries if entry.seq > start] == [
        ("desk_data", {"part": "memory", "refused": "invalid"})]
    session = (await owner.whoami()).session
    decision = await owner.call("POST /decide", DecideRequest(
        session_id=session.session_id, generation=session.generation, desk_id=created.desk_id,
        call=ToolCall(call_id="refused-memory", tool="native.read_memory", args={"query": "business"})))
    assert (await execute(owner, decision, session.generation)).model_view == {"simulated": True, "items": []}


# Setup: a new Desk's parts, rules drafts, probes and connected tools (Plans 01a, 01b and 01c) -------------------------

HOURS = [HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(8), end=time(17))]


def active_version(ro_read, ro_schema: str, copy_id: str, desk_id: str) -> dict:
    (active,) = ro_read(ro_schema, copy_id, "SELECT version, cards, auto_money_cap_cents FROM {ro}.policy_versions"
                                            " WHERE desk_id = %s AND status = 'active'", (desk_id,))
    return active


def owner_cards(version: dict) -> list[RuleCard]:
    return [RuleCard.model_validate(card) for card in version["cards"] if not card["is_default"]]


def quote_card(**limits) -> RuleCard:
    return RuleCard(card_id="card-quote", applies_to="native.quote", mode="auto", who="anyone",
                    reason="Quotes from the price list, at list price.", **limits)


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("count", "length", "reason"), [
    (41, 40, "policy_count_limit"), (40, 201, "policy_text_limit"), (400, 1, "policy_count_limit"),
])
async def test_charter_policy_caps_keep_a_refusal_record(kernel, count, length, reason):
    http, _, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    seq = (await ledger_page(owner, desk_id)).entries[-1].seq
    claims = [Claim(key=f"policy:{index:02d}", kind="text", value="x" * length) for index in range(count)]
    with pytest.raises(KernelFailed) as refused:
        await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims), path={"id": desk_id})
    assert (refused.value.status, refused.value.detail) == (422, {"charter": [reason]})
    page = await ledger_page(owner, desk_id)
    [entry] = [entry for entry in page.entries if entry.seq > seq]
    assert page.chain_ok
    assert entry.event.summary == {
        "part": "charter", "refused": "promise", "fields": {"charter": [reason]},
        "keys": sorted(claim.key for claim in claims)[:40], "policy_count": count,
        "total_characters": count * length, "reason": reason,
    }
    assert "x" * length not in entry.event.model_dump_json()


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("text", "rule"), [
    *policy_cases.COST_SERVICE_REFUSALS,
    *policy_cases.AI_DENIAL_REFUSALS,
    *policy_cases.AMENITY_REFUSALS,
    ("You are chatting with a human receptionist.", "policy.ai_denial"),
    ("Está hablando con una persona.", "policy.ai_denial"),
    ("Consultations cost nothing.", "policy.free_price"),
    ("La consulta no le cuesta nada.", "policy.free_price"),
    ("Las consultas no cuestan nada.", "policy.free_price"),
    ("No te cuesta nada.", "policy.free_price"),
    ("No les cuesta nada.", "policy.free_price"),
    ("No cobramos nada por la visita.", "policy.free_price"),
    ("Estás hablando con una persona.", "policy.ai_denial"),
    ("You are chatting with a human.", "policy.ai_denial"),
    ("I'm not a bot.", "policy.ai_denial"),
    ("This is not an AI.", "policy.ai_denial"),
    ("Soy una persona real.", "policy.ai_denial"),
    ("No soy un bot.", "policy.ai_denial"),
    ("Consultations are complimentary.", "lex.en.promise"),
    ("The first visit is complimentary.", "lex.en.promise"),
    ("Free estimates.", "lex.en.promise"),
    ("Consulta gratis.", "lex.es.promise"),
])
async def test_charter_refusal_detail_names_only_the_refused_policy_line(kernel, ro_read, arrange, text, rule):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    claims = [Claim(key=key, kind="text", value=value) for key, value in (
        ("policy:about", "Human resources consulting"),
        ("policy:custom", text),
        ("policy:parking", "Complimentary parking"),
        ("contact", "(510) 555-0199"),
    )]
    with pytest.raises(KernelFailed) as refused:
        await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims), path={"id": desk_id})
    assert (refused.value.status, refused.value.code, refused.value.detail) == (
        422, "invalid", {"policy:custom": [rule]})
    # Historical facts face the same check on public reads and policy-only replies.
    arrange.stored_policy(copy, "arrival", text)
    slug = desk_slug(ro_read, schema, copy)
    page = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug})
    assert "charter:policy:arrival" not in [block.fact_id for block in page.charter]
    visitor = await new_visitor(http, slug)
    verdict = await http.session(visitor.session_token).call("POST /check_reply", CheckReplyRequest(draft=ReplyDraft(
        session_id=visitor.state.session_id, generation=visitor.state.generation, prose="",
        clauses=[Clause(template="policy", fact_id="charter:policy:arrival")])))
    assert not verdict.ok and verdict.signature
    assert [(v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("policy_combined", ["charter:policy:arrival"])]
    # This is the setup pre-filter's contract: drop only named keys and keep all other lines.
    kept = [claim for claim in claims if claim.key not in refused.value.detail]
    await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=kept), path={"id": desk_id})


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("text", "rules"), [
    ("20% off for first-time clients", ["digit", "percent_sign"]),
    ("free consultation", ["lex.en.promise"]),
    ("The East Bay, seven days a week.", ["lex.en.number"]),
    ("Monday to Friday.", ["lex.en.date"]),
    ("a few miles past Oakland.", ["lex.es.number"]),
    *[(f"Consulta {word}.", ["lex.es.promise"]) for word in
      ("gratis", "gratuito", "gratuita", "gratuitos", "gratuitas")],
    ("Feel free to all clients.", ["lex.en.promise"]),
    ("Nous garantissons des consultations gratuites pour tous les clients.", ["language"]),
    ("Consultations gratuites pour tous les clients.", ["language"]),
    ("Consultas sem custo para todos os clientes.", ["language"]),
    ("Garantimos o serviço.", ["language"]),
    ("Services sans frais pour tous les clients.", ["language"]),
    ("Livraison offerte pour tous", ["language"]),
    ("Remise de 20% sans frais", ["digit", "language", "percent_sign"]),
    ("Привет мир.", ["language"]),
    ("Portland Beaverton Hillsboro free", ["lex.en.promise"]),
    ("20 % de descuento", ["digit", "lex.es.promise", "percent_sign"]),
    ("We offer \u202eeerf\u202c consultations.", ["format_control"]),
    ("Ofrecemos consultas \u202esitarg\u202c.", ["format_control"]),
])
async def test_charter_public_promise_refusal_keeps_fields_and_rules(kernel, ro_read, text, rules):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    path = {"id": desk_id}
    honest = "We work with small businesses and families."
    await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[
        Claim(key="policy:about", kind="text", value=honest)]), path=path)
    query = "SELECT fact_id, claims FROM {ro}.facts WHERE desk_id = %s AND kind = 'charter' ORDER BY fact_id"
    before = ro_read(schema, copy.copy_id, query, (desk_id,))
    seq = (await ledger_page(owner, desk_id)).entries[-1].seq
    fields = {"policy:about": rules, "policy:pricing": rules}
    with pytest.raises(KernelFailed) as refused:
        await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[
            Claim(key=key, kind="text", value=text) for key in fields]), path=path)
    assert (refused.value.status, refused.value.code, refused.value.detail) == (422, "invalid", fields)
    assert ro_read(schema, copy.copy_id, query, (desk_id,)) == before
    page = await ledger_page(owner, desk_id)
    [entry] = [entry for entry in page.entries if entry.seq > seq]
    assert entry.event.kind == "desk_data"
    assert entry.event.summary == {"part": "charter", "refused": "promise", "fields": fields}
    [desk] = ro_read(schema, copy.copy_id, "SELECT slug FROM {ro}.desks WHERE desk_id = %s", (desk_id,))
    public = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": desk["slug"]})
    [policy] = [block for block in public.charter if block.template == "policy"]
    assert policy.text == honest
    assert text not in public.model_dump_json()


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("unsafe", "honest", "rules"), [
    ("20% off for first-time clients", "We work with small businesses and families.", ["digit", "percent_sign"]),
    ("20 % de descuento", "Trabajamos con pequeños negocios y familias.",
     ["digit", "lex.es.promise", "percent_sign"]),
    ("free consultation", "Ask about our services.", ["lex.en.promise"]),
    ("Nous garantissons des consultations gratuites pour tous les clients.",
     "Ask about our services.", ["language"]),
    ("garantizamos", "Pregunte por nuestros servicios aquí.", ["lex.es.promise"]),
    ("We offer \u202eeerf\u202c consultations.", "Ask about our services.", ["format_control"]),
    ("Ofrecemos consultas \u202esitarg\u202c.", "Pregunte por nuestros servicios aquí.", ["format_control"]),
])
async def test_creation_public_promise_refusal_keeps_rows_and_audits(kernel, ro_read, unsafe, honest, rules):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    query = "SELECT desk_id FROM {ro}.desks ORDER BY desk_id"
    before = ro_read(schema, copy.copy_id, query)
    seq = (await ledger_page(owner, copy.desk_ids[0])).entries[-1].seq
    body = a_new_desk()
    body.desk.charter = [Claim(key="policy:about", kind="text", value=unsafe)]
    fields = {"policy:about": rules}
    with pytest.raises(KernelFailed) as refused:
        await owner.call("POST /desks", body)
    assert (refused.value.status, refused.value.code, refused.value.detail) == (422, "invalid", fields)
    assert ro_read(schema, copy.copy_id, query) == before
    [entry] = [entry for entry in (await ledger_page(owner, copy.desk_ids[0])).entries if entry.seq > seq]
    assert entry.event.summary == {"part": "desk", "refused": "promise", "fields": fields}
    assert unsafe not in entry.event.model_dump_json()
    body.desk.charter[0].value = honest
    created = await owner.call("POST /desks", body)
    page = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": created.slug})
    [policy] = [block for block in page.charter if block.template == "policy"]
    assert policy.text == honest


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize("create", [False, True], ids=["replace", "create"])
@pytest.mark.parametrize(("unsafe", "honest", "rule"), [
    (("No", "charge for consultations."), ("Ask about", "our services."), "lex.en.promise"),
    (("Sin", "costo para consultas aquí."), ("Pregunte por", "nuestros servicios."), "lex.es.promise"),
    (("Your appointment is", "confirmed."), ("Tell us", "what you need."), "lex.en.booking"),
    (("Tu cita está", "confirmada."), ("Cuéntenos", "qué necesita."), "lex.es.booking"),
])
async def test_split_public_promise_refusal_keeps_contributing_keys(kernel, ro_read, create, unsafe, honest, rule):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    seq = (await ledger_page(owner, desk_id)).entries[-1].seq
    query = "SELECT desk_id, fact_id, claims FROM {ro}.facts WHERE kind = 'charter' ORDER BY desk_id, fact_id"
    before = ro_read(schema, copy.copy_id, query)

    async def write(parts):
        claims = [Claim(key=key, kind="text", value=value) for key, value in (
            ("policy:z", "Ask about our services."), ("policy:c", parts[1]),
            ("contact", "(510) 555-0199"), ("policy:b", parts[0]), ("policy:a", "Pregunte por nuestros servicios aquí."))]
        if create:
            body = a_new_desk()
            body.desk.charter = claims
            return await owner.call("POST /desks", body)
        return await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims), path={"id": desk_id})

    with pytest.raises(KernelFailed) as refused:
        await write(unsafe)
    fields = {"policy:b": [rule], "policy:c": [rule]}
    assert (refused.value.status, refused.value.code, refused.value.detail) == (422, "invalid", fields)
    assert ro_read(schema, copy.copy_id, query) == before
    [entry] = [entry for entry in (await ledger_page(owner, desk_id)).entries if entry.seq > seq]
    assert entry.event.summary == {"part": "desk" if create else "charter", "refused": "promise", "fields": fields}
    updated = await write(honest)
    [desk] = ro_read(schema, copy.copy_id, "SELECT slug FROM {ro}.desks WHERE desk_id = %s", (updated.desk_id,))
    public = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": desk["slug"]})
    assert [block.text for block in public.charter if block.template == "policy"] == [
        "Pregunte por nuestros servicios aquí.", *honest, "Ask about our services."]


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize("source", ["cards", "prose"])
@pytest.mark.parametrize("parts", [
    ("No", "charge for consultations."),
    ("Sin", "costo para consultas aquí."),
    ("Your appointment is", "confirmed."),
    ("Tu cita está", "confirmada."),
])
async def test_reply_policy_order_refuses_reassembled_promises(kernel, ro_read, source, parts):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    claims = [Claim(key="policy:a", kind="text", value=parts[1]),
              Claim(key="policy:z", kind="text", value="Ask about our services.")]
    if source == "cards":
        claims.append(Claim(key="policy:b", kind="text", value=parts[0]))
    await http.owner(copy.owner_token).call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims),
                                           path={"id": desk_id})
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    ids = ["charter:policy:b", "charter:policy:a"] if source == "cards" else ["charter:policy:a"]
    cited = ["charter:policy:z", *ids] if source == "cards" else ids
    draft = ReplyDraft(session_id=visitor.state.session_id, generation=visitor.state.generation,
                       prose=parts[0] if source == "prose" else "",
                       clauses=[Clause(template="policy", fact_id=fact_id) for fact_id in cited])
    verdict = await http.session(visitor.session_token).call("POST /check_reply", CheckReplyRequest(draft=draft))
    assert verdict.ok is False
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("unknown_fact", "policy_combined", ids)]
    assert len(verdict.blocks) == 1 and verdict.blocks[0].template == "handoff"
    assert verdict.signature and all(block.template != "policy" for block in verdict.blocks)

@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize("parts", [
    *[(text,) for text in policy_cases.PAYMENT_TIMING],
    *[(text,) for text in policy_cases.COST_AMENITIES],
    *[(text,) for text in policy_cases.HUMAN_OCCUPATIONS],
    *[(text,) for text in policy_cases.AI_DENIAL_CONTROLS],
    *[(text,) for text in policy_cases.AMENITY_ACCEPTED],
    ("Portland Beaverton", "Cash card"),
    ("Feel free to ask about our services.",),
    ("You are free to ask about our services.",),
    ("Puede preguntar por nuestros servicios.",),
    ("Se requiere un garante.",),
    ("Garage parking available", "Offering estimates by appointment"),
    ("Service area: Portland, Beaverton, Hillsboro, Tigard", "Cash, card, Venmo accepted",
     "Emergency service available"),
    ("No cobramos por adelantado.", "No cobramos nada más que lo acordado."),
    ("Talk to a real person by phone.",),
    ("Call to speak with a live agent.",),
    ("Call to speak with a live person.",),
    ("This is an AI assistant, not a real person.",),
    ("A real person will call back in the morning.",),
    ("I'm a human resources consultant.",),
    ("I am a human rights lawyer.",),
    ("Our photos are not AI-generated.",),
    ("Nothing to pay until the job is done.",),
    ("Habla con una persona real por teléfono.",),
    ("Una persona real le devolverá la llamada.",),
    ("Nada que pagar hasta que el trabajo esté hecho.",),
    ("Complimentary parking.",),
    ("Free parking.",),
    ("Free wi-fi while you wait.",),
    ("Complimentary coffee while you wait.",),
    ("Estacionamiento gratis.",),
])
async def test_policy_unmarked_words_pass_write_public_read_and_reply(kernel, ro_read, parts):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    path = {"id": copy.desk_ids[0]}
    claims = [Claim(key=f"policy:{index}", kind="text", value=text) for index, text in enumerate(parts)]
    await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims), path=path)
    slug = desk_slug(ro_read, schema, copy)
    page = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug})
    assert [block.text for block in page.charter if block.template == "policy"] == list(parts)
    visitor = await new_visitor(http, slug)
    draft = ReplyDraft(session_id=visitor.state.session_id, generation=visitor.state.generation, prose="",
                       clauses=[Clause(template="policy", fact_id=f"charter:{claim.key}") for claim in claims])
    verdict = await http.session(visitor.session_token).call("POST /check_reply", CheckReplyRequest(draft=draft))
    assert verdict.ok and verdict.violations == []
    assert [block.text for block in verdict.blocks] == list(parts)
    assert verdict.signature


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("text", "rules"), [
    ("Within 25 miles of Oakland.", []),
    ("We drive a few miles past Oakland.", []),
    ("The East Bay, seven days a week.", []),
    ("Serving the East Bay since 1998.", []),
    ("We do evenings and weekends.", []),
    ("Trabajamos fines de semana.", []),
    ("Within a 25-mile radius of Oakland.", []),
    ("We serve a 30 mile radius around Oakland.", []),
    ("Within 1 mile of Lake Merritt.", []),
    ("A 50-km radius.", []),
    ("Dentro de 1 kilómetro.", []),
    ("Within 25 miles, $50 trip fee.", ["currency", "digit"]),
    ("Outside Oakland, half off.", ["lex.en.number"]),
    ("Mitad de precio fuera de Oakland.", ["lex.es.number"]),
    ("Within 25 miles. Trip fee 1500.", ["digit"]),
    ("Service in Oakland within two hours.", ["lex.en.date"]),
    ("We serve all nine Bay Area counties.", []),
    ("Dos sucursales: Oakland y Berkeley.", []),
    ("Within half a mile of Lake Merritt.", []),
    ("Within a hundred miles of Oakland.", []),
    ("Outside Oakland, a hundred off.", ["lex.en.number"]),
    ("Oakland and Berkeley, 7 days a week.", []),
    ("Trabajamos 7 días a la semana.", []),
    ("We cover 20-30 miles around Oakland.", []),
    ("Within 20–30 miles of Oakland.", []),
    ("Trip fee 20 to 30.", ["digit"]),
    ("Trabajamos por la mañana.", []),
    ("Serving the East Bay desde 1998.", []),
    ("In 1998.", []),
    ("From 1998.", []),
    ("Est. 1998.", []),
    ("Established 1998.", []),
    ("Founded 1998.", []),
    ("Desde 1998.", []),
    ("En 1998.", []),
    ("Since 1900.", []),
    ("Since 2099.", []),
    ("Trip fee 2000.", ["digit"]),
    ("Within 25 miles. Trip fee 2000.", ["digit"]),
    ("Cargo de viaje: 2000.", ["digit"]),
    ("Oakland 1998.", ["digit"]),
    ("For 1998 years.", ["digit"]),
    ("Since 1899.", ["digit"]),
    ("Since 2100.", ["digit"]),
    ("Begin 1998.", ["digit"]),
    ("Since 1998, trip fee 2000.", ["digit"]),
    ("Oakland and Berkeley, 24/7.", []),
    ("Oakland, Berkeley and Alameda (zip codes 94601-94612).", []),
    ("ZIP 94601.", []),
    ("ZIP code 94601.", []),
    ("ZIP codes 94601.", []),
    ("Código postal 94601.", []),
    ("Oakland, CA 94601.", []),
    ("Along I-580.", []),
    ("Along Highway 101.", []),
    ("Along Hwy 24.", []),
    ("24/7, $50 trip fee.", ["currency", "digit"]),
    ("Trip fee 94601.", ["digit"]),
    ("ZIP 9460.", ["digit"]),
    ("ZIP 946012.", ["digit"]),
    ("Highway 101, trip fee 50.", ["digit"]),
    ("Llegamos mañana.", ["lex.es.date"]),
    # A known limit: a fee written in words passes, since any cardinal number word does.
    ("Cargo de viaje: cincuenta.", []),
    ("Same-day service in Oakland.", ["lex.en.date"]),
])
async def test_service_area_policy_contract(kernel, ro_read, text, rules):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    claims = [Claim(key="policy:service_area", kind="text", value=text)]
    if rules:
        with pytest.raises(KernelFailed) as refused:
            await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims),
                             path={"id": copy.desk_ids[0]})
        assert (refused.value.code, refused.value.detail) == ("invalid", {"policy:service_area": rules})
        return
    await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims),
                     path={"id": copy.desk_ids[0]})
    slug = desk_slug(ro_read, schema, copy)
    page = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug})
    assert [block.text for block in page.charter if block.template == "policy"] == [text]
    visitor = await new_visitor(http, slug)
    verdict = await http.session(visitor.session_token).call("POST /check_reply", CheckReplyRequest(draft=ReplyDraft(
        session_id=visitor.state.session_id, generation=visitor.state.generation, prose="",
        clauses=[Clause(template="policy", fact_id="charter:policy:service_area")])))
    assert verdict.ok and verdict.violations == [] and verdict.signature
    assert [block.text for block in verdict.blocks] == [text]


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize("stored", ["discount", "other_commitment", "private", "expired"])
async def test_public_read_withholds_only_unsafe_stored_policy_lines(kernel, ro_read, arrange, stored):
    http, schema, _ = kernel
    copy = await new_copy(http)
    path = {"desk_slug": desk_slug(ro_read, schema, copy)}
    if stored in ("discount", "other_commitment"):
        arrange.stored_policy(copy, "arrival", "20% off for first-time clients" if stored == "discount"
                              else "Consultas sem custo para todos os clientes.")
    else:
        texts = {"arrival": "No", "first_visit": "Ask about our services.",
                 "service_area": "charge for consultations."}
        for key, text in texts.items():
            arrange.stored_policy(copy, key, text)
        # The visible middle card separates the promise until read filtering removes it.
        before = await http.public().call("GET /public/{desk_slug}", path=path)
        assert [block.text for block in before.charter if block.template == "policy"] == list(texts.values())
        arrange.stored_policy(copy, "first_visit", texts["first_visit"],
                              readers=("owner",) if stored == "private" else ("public",),
                              expired=stored == "expired")
    for language in ("en", "es"):
        page = await http.public().call("GET /public/{desk_slug}", path=path, query={"lang": language})
        kept = ["charter:policy:first_visit", "charter:policy:service_area"] if stored in (
            "discount", "other_commitment") else []
        assert [block.fact_id for block in page.charter if block.template == "policy"] == kept
        assert {"hours", "contact"} <= {block.template for block in page.charter}
    if stored == "other_commitment":
        visitor = await new_visitor(http, path["desk_slug"])
        draft = ReplyDraft(session_id=visitor.state.session_id, generation=visitor.state.generation, prose="",
                           clauses=[Clause(template="policy", fact_id="charter:policy:arrival")])
        verdict = await http.session(visitor.session_token).call("POST /check_reply", CheckReplyRequest(draft=draft))
        assert not verdict.ok
        assert [(v.rule_id, v.fact_ids) for v in verdict.violations] == [
            ("policy_combined", ["charter:policy:arrival"])]
        assert len(verdict.blocks) == 1 and verdict.blocks[0].template == "handoff"
        assert verdict.signature


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
        "desk.emergency-callback", "native.capture_lead", "native.request_callback"}
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
    """The kernel holds a draft's cards to the draft's own money cap, whatever the API sends: lowering the Turner cap
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
    the draft: raising the Turner cap from $500 to $800 drafts a version at $800 while the active one stays at $500;
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
    """The Turner Desk's active version, its owner cards, and the presets' own card for starting a verification
    among them (auto, for anyone, on the tool), which every preset and the Turner seed carry."""
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


@pytest.mark.kernel_plan("01c")
async def test_confirming_payments_drafts_enables_until_policy_confirmation(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    configured = await owner.call("POST /policy/draft", PolicyDraftRequest(
        desk_id=created.desk_id, cards=[*owner_cards(active), quote_card(max_amount_cents=1_000)],
        expected_parent=active["version"], auto_money_cap_cents=2_300))
    proved_or_skip(configured)
    await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=created.desk_id, version=configured.version))
    active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    profiles = await owner.call("POST /tools/connect", ToolsConnectRequest(
        desk_id=created.desk_id, server="mock_payments"))
    body = ToolsConfirmRequest(desk_id=created.desk_id, enable=True, tools=[
        ToolPin(tool=profile.tool, definition_sha256=profile.definition_sha256) for profile in profiles])
    reviewed = await owner.call("POST /tools/confirm", body)
    assert reviewed.profiles == profiles
    assert reviewed.draft is not None
    proved_or_skip(reviewed.draft)
    assert reviewed.draft.parent_version == active["version"]
    assert [card for card in reviewed.draft.cards if not card.is_default] == owner_cards(active)
    assert reviewed.draft.auto_money_cap_cents == active["auto_money_cap_cents"]
    assert active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)["version"] == active["version"]
    assert (await owner.call("POST /tools/confirm", body)).draft == reviewed.draft
    probe = PolicyProbeRequest(desk_id=created.desk_id, probes=[Probe(
        actor="visitor", who="record_owner", resource_kind="charge", resource_owner="caller",
        call=ToolCall(call_id="review-charges", tool="payments.list_charges", args={}))])
    result = await owner.call("POST /policy/{version}/probe", probe, path={"version": reviewed.draft.version})
    assert result[0].outcome == "hold"
    result = await owner.call("POST /policy/{version}/probe", probe, path={"version": active["version"]})
    assert result[0].outcome == "refuse"

    await owner.call("POST /policy/confirm", PolicyConfirmRequest(
        desk_id=created.desk_id, version=reviewed.draft.version))
    rows = ro_read(ro_schema, copy.copy_id,
                   "SELECT tool, status FROM {ro}.tools WHERE desk_id = %s AND source = 'mcp'", (created.desk_id,))
    assert {row["tool"]: row["status"] for row in rows} == {profile.tool: "enabled" for profile in profiles}
    assert (await owner.call("POST /tools/confirm", body)).draft is None


@pytest.mark.kernel_plan("01c")
async def test_tool_review_refusals_and_disable_are_atomic(kernel, ro_read):
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    unknown = ToolsConfirmRequest(desk_id=created.desk_id, enable=True, tools=[
        ToolPin(tool="payments.create_refund", definition_sha256="0" * 64)])
    assert await refused(owner.call("POST /tools/confirm", unknown)) == (404, "not_found")
    profiles = await owner.call("POST /tools/connect", ToolsConnectRequest(
        desk_id=created.desk_id, server="mock_payments"))
    pins = [ToolPin(tool=profile.tool, definition_sha256=profile.definition_sha256) for profile in profiles]
    for enable in (True, False):
        stale = ToolsConfirmRequest(desk_id=created.desk_id, enable=enable, tools=[
            pins[0], pins[1].model_copy(update={"definition_sha256": "0" * 64})])
        assert await refused(owner.call("POST /tools/confirm", stale)) == (409, "conflict")
    rows = ro_read(ro_schema, copy.copy_id,
                   "SELECT status FROM {ro}.tools WHERE desk_id = %s AND source = 'mcp'", (created.desk_id,))
    assert [row["status"] for row in rows] == ["needs_review", "needs_review"]
    disabled = await owner.call("POST /tools/confirm", ToolsConfirmRequest(
        desk_id=created.desk_id, enable=False, tools=pins))
    assert disabled.draft is None and all(profile.status == "disabled" for profile in disabled.profiles)
    reviewed = await owner.call("POST /tools/confirm", ToolsConfirmRequest(
        desk_id=created.desk_id, enable=True, tools=pins))
    assert reviewed.draft is not None
    proved_or_skip(reviewed.draft)
    await owner.call("POST /tools/simulate_change", ToolsSimulateChangeRequest(
        desk_id=created.desk_id, tool=pins[-1].tool))
    assert await refused(owner.call("POST /policy/confirm", PolicyConfirmRequest(
        desk_id=created.desk_id, version=reviewed.draft.version))) == (409, "conflict")
    rows = ro_read(ro_schema, copy.copy_id,
                   "SELECT tool, status FROM {ro}.tools WHERE desk_id = %s AND source = 'mcp'", (created.desk_id,))
    # a drift on a disabled tool leaves it disabled, its changed definition pending (`mcp_pins.check_pin`)
    assert {row["tool"]: row["status"] for row in rows} == {
        pins[0].tool: "disabled", pins[-1].tool: "disabled"}


@pytest.mark.kernel_plan("01c")
async def test_a_tool_review_draft_is_refused_once_the_desks_tools_change(kernel, ro_read):
    # The draft was proved against the tools enabled then plus its own enables; turning another tool off before it is
    # confirmed changes what it would enable, so the confirm is refused and nothing it enables is turned on.
    http, ro_schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    created = await owner.call("POST /desks", a_new_desk())
    profiles = await owner.call("POST /tools/connect", ToolsConnectRequest(
        desk_id=created.desk_id, server="mock_payments"))
    reviewed = await owner.call("POST /tools/confirm", ToolsConfirmRequest(desk_id=created.desk_id, enable=True, tools=[
        ToolPin(tool=profile.tool, definition_sha256=profile.definition_sha256) for profile in profiles]))
    assert reviewed.draft is not None
    proved_or_skip(reviewed.draft)
    active = active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)
    (book,) = ro_read(ro_schema, copy.copy_id, "SELECT tool, definition_sha256 FROM {ro}.tools"
                                               " WHERE desk_id = %s AND tool = 'native.book'", (created.desk_id,))
    disabled = await owner.call("POST /tools/confirm", ToolsConfirmRequest(
        desk_id=created.desk_id, enable=False,
        tools=[ToolPin(tool=book["tool"], definition_sha256=book["definition_sha256"])]))
    assert disabled.draft is None and disabled.profiles[0].status == "disabled"
    assert await refused(owner.call("POST /policy/confirm", PolicyConfirmRequest(
        desk_id=created.desk_id, version=reviewed.draft.version))) == (409, "conflict")
    assert active_version(ro_read, ro_schema, copy.copy_id, created.desk_id)["version"] == active["version"]
    rows = ro_read(ro_schema, copy.copy_id, "SELECT tool, status FROM {ro}.tools WHERE desk_id = %s"
                                            " AND (source = 'mcp' OR tool = 'native.book')", (created.desk_id,))
    assert {row["tool"]: row["status"] for row in rows} == {
        **{profile.tool: "needs_review" for profile in profiles}, "native.book": "disabled"}


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
                      text="The price list Mike gave in setup covers the service call deposit, drain clearing, a "
                           "water heater flush, leak repair, pipe repair (starting price) and a short-notice fee. "
                           "The short-notice fee is added to an urgent visit that Mike fits in at short notice. Each price is given in a quote from this list.",
                      label=Label(readers=["public"])),
        KnowledgeItem(item_id="kn-website", source="website",
                      title="Your website, turner-plumbing.example, read during setup",
                      text="Turner Plumbing is Mike Turner's home plumbing business: drain clearing, leak repair and "
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
async def test_knowledge_created_at_reads_in_kernel_order_and_survives_replacement(kernel, arrange, api_ro_conn):
    """The API's reader exposes each stored first-added time, ordered by time then ID, even after replacement."""
    http, ro_schema, state = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    reader = KernelRO(api_ro_conn, copy.copy_id, ro_schema, own_transactions=True)
    for item_id in ("upload-z", "upload-a"):
        item = knowledge_item(["owner"]).model_copy(update={"item_id": item_id})
        await owner.call("POST /knowledge", KnowledgeRequest(desk_id=desk_id, item=item))

    async def read() -> list[dict]:
        rows = await reader.rows("knowledge_items", desk_id=desk_id, order_by=("created_at", "item_id"))
        recorded = arrange.recorded_knowledge_created_at(desk_id)
        assert {row["item_id"]: row["created_at"] for row in rows} == recorded
        assert all(isinstance(row["created_at"], datetime) and row["created_at"].tzinfo for row in rows)
        assert [(row["created_at"], row["item_id"]) for row in rows] == sorted(
            (at, item_id) for item_id, at in recorded.items())
        return rows

    first = await read()
    first_times = {row["item_id"]: row["created_at"] for row in first}
    # Fake time is fixed; move it so resetting created_at on replacement would fail on both kernels.
    if state is not None:
        state.now += timedelta(seconds=1)
    later = knowledge_item(["owner"]).model_copy(update={"item_id": "upload-later"})
    await owner.call("POST /knowledge", KnowledgeRequest(desk_id=desk_id, item=later))
    replacement = knowledge_item(["public"], text="Updated parking directions.").model_copy(
        update={"item_id": "upload-z"})
    await owner.call("POST /knowledge", KnowledgeRequest(desk_id=desk_id, item=replacement))
    after = await read()
    assert {row["item_id"]: row["created_at"] for row in after if row["item_id"] in first_times} == first_times
    updated = next(row for row in after if row["item_id"] == "upload-z")
    assert (updated["text"], updated["readers"]) == (replacement.text, ["public"])
    assert after[-1]["item_id"] == "upload-later"
    assert after[-1]["created_at"] > max(first_times.values())


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
    body = "Turner Plumbing\nEstimate, leak repair\nFor Dana Whitfield\n"
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
        "Revisado con las reglas de Mike Turner")
    neither = ("\U0001F44D", "Bonjour, je voudrais un rendez-vous.", "\U0001F44D")
    for said in neither:
        assert await turn(view, session_id, 0, said) == TurnStarted(language="es"), said
    english = "Can someone look at my water heater tomorrow?"
    assert await turn(view, session_id, 0, english) == TurnStarted(language="en")
    assert (await decide(view, session_id, 0, "call-2", "native.quote", quote_args(drain))).visitor_plain == (
        "Checked against Mike Turner's rules")

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


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize("create", [False, True])
async def test_public_contact_is_structured(kernel, create):
    http, _, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    seq = (await ledger_page(owner, copy.desk_ids[0])).entries[-1].seq
    claims = [Claim(key="contact", kind="text", value="help@example.test. All consultations are $1, guaranteed.")]
    with pytest.raises(KernelFailed) as refused:
        if create:
            body = a_new_desk()
            body.desk.charter = claims
            await owner.call("POST /desks", body)
        else:
            await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims),
                             path={"id": copy.desk_ids[0]})
    assert (refused.value.status, refused.value.detail) == (422, {"contact": ["contact_format"]})
    page = await ledger_page(owner, copy.desk_ids[0])
    [entry] = [entry for entry in page.entries if entry.seq > seq]
    assert page.chain_ok
    assert (entry.event.kind, entry.event.summary) == ("desk_data", {
        "part": "desk" if create else "charter", "refused": "contact", "fields": {"charter:contact": ["contact_format"]}})
    assert "guaranteed" not in entry.event.model_dump_json()
    await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[
        Claim(key="contact", kind="text", value="help@example.test · +1 (510) 555-0142; https://example.test")]),
        path={"id": copy.desk_ids[0]})


PUBLIC_CONTACTS = [*policy_cases.CONTACT_FORMS, "(510) 555-0142 ext. 2", "+1 (510) 555-0142 ext. 12", "Call us at (510) 555-0142",
                   "Email: help@example.test · Llámanos al 555-0142",
                   "https://example.test/book?services=drain,repair", "https://example.test/book;location=oakland",
                   "mike@example.test or (510) 555-0142", "help@example.test / (510) 555-0142", "www.example.com",
                   "example.com", "help@example.test\r\nother@example.test",
                   "Call us at (510) 555-0142 or email hello@example.com",
                   "(510) 555-0142 ext. 12, hello@example.com, example.com",
                   "Phone: (510) 555-0142, Email: hello@example.com, Website: example.com",
                   "Office: (510) 555-0142 ext. 12", "Call or text (510) 555-0142"]
PUBLIC_CONTACT_PROSE = [*policy_cases.CONTACT_SCAN_INPUTS, "https://example.test/" + "a" * 481, "Call us at (510) 555-0142 for a free quote", "mike@example.test or call for a free quote",
                        "https://example.test/book for a free quote", "Call us for a free quote",
                        "Call us at (510) 555-0142 anytime"]


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("contact", "valid"), [*[(c, True) for c in PUBLIC_CONTACTS],
                                                *[(c, False) for c in PUBLIC_CONTACT_PROSE]])
async def test_public_contact_endpoint_shapes(kernel, ro_read, contact, valid):
    """An honest contact is written, shown on the public page and cited alone in a reply; prose is refused."""
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner = http.owner(copy.owner_token)
    write = owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=[
        Claim(key="contact", kind="text", value=contact)]), path={"id": copy.desk_ids[0]})
    if not valid:
        with pytest.raises(KernelFailed) as refused:
            await write
        assert (refused.value.status, refused.value.detail) == (422, {"contact": ["contact_format"]})
        return
    await write
    slug = desk_slug(ro_read, schema, copy)
    page = await http.public().call("GET /public/{desk_slug}", path={"desk_slug": slug})
    assert [block.text for block in page.charter if block.template == "contact"] == [contact]
    visitor = await new_visitor(http, slug)
    draft = ReplyDraft(session_id=visitor.state.session_id, generation=visitor.state.generation, prose="",
                       clauses=[Clause(template="contact", fact_id="charter:contact")])
    verdict = await http.session(visitor.session_token).call("POST /check_reply", CheckReplyRequest(draft=draft))
    assert verdict.ok and verdict.violations == []
    assert [block.text for block in verdict.blocks] == [contact]


@pytest.mark.kernel_plan("01b")
async def test_one_charter_refusal_names_the_contact_and_every_refused_policy(kernel):
    http, _, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    seq = (await ledger_page(owner, desk_id)).entries[-1].seq
    claims = [Claim(key=key, kind="text", value=value) for key, value in (
        ("contact", "help@example.test. All consultations are $1, guaranteed."),
        ("policy:about", "Ask about our services."), ("policy:custom", "You are chatting with a human."))]
    with pytest.raises(KernelFailed) as refused:
        await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=claims), path={"id": desk_id})
    assert (refused.value.status, refused.value.detail) == (422, {
        "contact": ["contact_format"], "policy:custom": ["policy.ai_denial"]})
    page = await ledger_page(owner, desk_id)
    [entry] = [entry for entry in page.entries if entry.seq > seq]
    assert page.chain_ok
    assert entry.event.summary == {"part": "charter", "refused": "promise", "fields": {
        "charter:contact": ["contact_format"], "policy:custom": ["policy.ai_denial"]}}
    kept = [claim for claim in claims if claim.key not in refused.value.detail]
    await owner.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=kept), path={"id": desk_id})
