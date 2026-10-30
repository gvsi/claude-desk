"""The kernel contract the API relies on, checked against FakeKernel and the real kernel.

Each test runs twice through the API's own typed client: `fake` always, `real` when `DESK_KERNEL_URL`
names a running kernel and `DESK_KERNEL_PLANS` lists the plan in its `kernel_plan` marker (`make
kernel-contract` sets both for the plans in `evals/tier1/landed.toml`). Arguments come from the kernel's
read-only views, never from the fake's internals, so both variants take the same path.
"""

import httpx
import pytest

from desk.api.kernel_client import CredentialView, KernelFailed, KernelHttp
from desk.contracts import (
    ApprovalResult,
    CopyCreated,
    Decision,
    DemoInboxEntry,
    ExecResult,
    LedgerEvent,
    LedgerPage,
    ReplyDraft,
    ReplyVerdict,
    SessionCreated,
    ToolCall,
)
from desk.kernel_api import (
    KERNEL_ROUTES,
    AnswerRequest,
    CancelRequest,
    CheckReplyRequest,
    CreateCopyRequest,
    CreateSessionRequest,
    DecideRequest,
    DeskAnsweringRequest,
    DeskUpdated,
    ExecuteRequest,
    Health,
    KernelError,
    LedgerAppendRequest,
    PublicDesk,
    SessionContext,
    WhoAmI,
)
from tests.kernel_contract import ro_tables
from tests.kernel_contract.fake_kernel import FAKE_ROUTES, fake_kernel_app


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
    assert public.brand and {"hours", "contact", "policy"} <= {block.template for block in public.charter}
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
    names. Another copy's owner never reads them, and a visitor's token isn't the owner's."""
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
    assert not {entry.entry_id for entry in theirs} & set(entries)
    assert await refused(view.call("GET /demo_inbox")) == (401, "auth")
