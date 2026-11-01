"""The setup interview's routes (Plan 02b, Tasks 6 and 7): the owner cookie names the copy, as on every owner route,
and an interview is read only within it.

- Under `/api/owner/setup`: the interview (start, consent, answers), and the new Desk's tools and their connection.
  Consent and answers use one turn runner. An answer is 200 when done within its wait, otherwise 202 `SetupState`
  with `busy`; consent is 202 with `busy` as soon as it is stored.
  A busy repeat runs nothing and never counts on the limits. GET recovers abandoned turns.
- Under `/api/owner/policy/setup/{id}` (`id` is the interview's), the proving routes: the rules draft, the
  situations, the safety check, the confirm and going live. Each runs its work through `desk.api.proving`: past
  `PROVING_WAIT_S` it answers 202 `ProvingPending`, and the same request sent again joins the work or takes its
  answer. A draft holding cards that would change starting a verification is 422 `changes_always_on` naming them,
  with nothing sent to the kernel (`proving_answer`, which the Rules page's proving routes share).

Each request that moves the interview on counts on the copy's `setup_turn` limit (80 an hour; a proving re-post that
joins work already running counts once) and, on a route that calls the model, answers 503 `demo_budget` in
production once today's model budget is spent. What each step does is in `desk.api.setup`.
"""

from collections.abc import Awaitable, Callable
from time import monotonic
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette import EventSourceResponse

from desk.api import proving, setup, versions
from desk.api.deps import OwnerCtx, Runtime, owner_ctx, public_origin, require_model_budget, runtime
from desk.api.idempotency import body_sha256
from desk.api.owner_streaming import event, response as stream_response
from desk.api.schemas import (
    ApiError,
    ChangesAlwaysOn,
    ProvingPending,
    ProvingRetry,
    RulesChanged,
    RulesDraft,
    SafetyCheck,
    SetupAnswerIn,
    SetupConsentIn,
    SetupProposalIn,
    SetupPublicLineError,
    SetupPublicLineIn,
    SetupPublicLines,
    SetupPublicLinesConfirmIn,
    SetupSuggestionsIn,
    SetupStartIn,
    SetupState,
    SetupTools,
    SituationResult,
    ToolRow,
    WentLive,
    error_responses,
    operation_ids,
)
from desk.contracts import PolicyVersion

router = APIRouter(prefix="/api/owner/setup", generate_unique_id_function=operation_ids("owner"))
policy_router = APIRouter(prefix="/api/owner/policy/setup", generate_unique_id_function=operation_ids("owner"))

# The interview's path parameter is `id`, as the master plan names a setup interview's ("Shared seams").
InterviewId = Annotated[str, Path(alias="id", max_length=64)]


async def _moving_on(request: Request, ctx: OwnerCtx, *, model: bool = True) -> Runtime:
    """The runtime, once the copy's setup turn limit and, for a route that calls the model, the daily model budget let
    the request through."""
    state = runtime(request).started()
    await state.limiter.enforce("setup_turn", ctx.copy_id, ledger=ctx.ledger())
    if model:
        await require_model_budget(request)
    return state


@router.post("", status_code=201, response_model=SetupState,
             responses=error_responses(401, 404, 409, 422, 429, 503))
async def start_setup(body: SetupStartIn, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)], cards: bool = False) -> SetupState:
    """Start setting up a new Desk from the owner's own words: Claude reads them, the kernel makes the Desk with
    Answering off, and Claude asks whether it may read the owner's Claude memory and website. A name the owner gives
    here is the one customers see, and one the kernel wouldn't take is 422. 503 `model_unavailable` when Claude
    couldn't answer, with nothing made.

    Each start carries an `idempotency_key`, one per click (422 without one, as for any missing field). A repeat in
    the copy answers the interview the first made, as it stands now, and makes nothing: no model call, no Desk, no
    count on the limits. A repeat with another body is 409 `conflict`, and one sent while the first is still starting
    answers 409 `in_progress` at once, to be sent again after `retry_after`. A first that stopped before the kernel
    was asked for the Desk (its process did, say) frees the key once it is older than the longest a start can take. A
    start is admitted (looked up, counted and claimed) under its key's lock in this process, so a repeat sent
    meanwhile waits for that admission and is never counted; another process admits on its own, so during a deploy's
    overlap a repeat routed to the other task can be counted twice.

    409 `key_spent` (no `retry_after`) means this key is spent: its start asked the kernel for the Desk and then
    failed, or stopped with no answer kept and is now older than the longest a start can take. The Desk may exist,
    so the key never starts again and waiting changes nothing; a new click needs a new key. The first request still
    answers its own failure.

    A start that fails before the kernel is asked for the Desk (refused by the limits, or Claude couldn't answer)
    frees its key, so the same request can be sent again. Once the Desk was asked for, the key keeps the outcome
    whatever the kernel answered, a refusal too, and a repeat of a start that failed answers 409 `key_spent`."""
    state = runtime(request).started()

    async def admit() -> None:
        await _moving_on(request, ctx)

    return await setup.start(ctx, state.database(), state.model, body, admit=admit, cards=cards,
                             business_tools_enabled=state.settings.business_tools_enabled)


@router.get("/{id}", response_model=SetupState, responses=error_responses(401, 404, 409, 422, 503))
async def setup_interview(interview_id: InterviewId, request: Request,
                          ctx: Annotated[OwnerCtx, Depends(owner_ctx)], cards: bool = False) -> SetupState:
    """The setup interview as it stands, removing abandoned turn entries and reopening consent if needed."""
    state = runtime(request).started()
    return await setup.read(ctx, state.database(), interview_id, runs=state.turn_runs, cards=cards,
                            business_tools_enabled=state.settings.business_tools_enabled)


@router.get("/{id}/events", response_class=EventSourceResponse,
            responses={200: {"content": {"text/event-stream": {}}}, **error_responses(401, 404, 422, 503)})
async def setup_events(interview_id: InterviewId, request: Request,
                       # Its connection closes when the route returns, so an open stream holds none.
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx, scope="function")]) -> EventSourceResponse:
    """One owner turn's whole reply so far, then done once its state is saved and the interview takes the next turn,
    or error after rollback.

    No running turn sends done with run null immediately. Choices, cards and plans are read only
    from the existing state route. Authentication and interview scoping finish before SSE starts.
    """
    state = runtime(request).started()
    await setup.interview_desk(ctx, state.database(), interview_id)
    display = state.turn_runs.display(interview_id)

    async def events():
        if display is None:
            yield event("done", {"run": None})
        else:
            async for item in display.events():
                yield item

    return stream_response(events())


@router.post("/{id}/consent", response_model=SetupState,
             responses={202: {"model": SetupState}, **error_responses(401, 404, 409, 422, 429, 503)})
async def setup_consent(interview_id: InterviewId, body: SetupConsentIn, request: Request,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)], cards: bool = False) -> Any:
    """Use the shared turn runner to store consent, then read Claude memory and the named website through the
    kernel on yes, or skip both on no. Claude's first question and the read labels land together. Wait for the
    busy commit, then answer 202 `SetupState` with `busy: true` at once; the turn's events stream follows the
    reads and Claude's opening, and the state route has the result. Cancelling the request leaves the run
    working. A repeat while busy answers 202 without starting or counting another run; after it lands, consent
    is 409 `conflict`. Failed or abandoned runs reopen consent."""
    state = runtime(request).started()

    async def admit() -> None:
        await _moving_on(request, ctx)

    answer = await setup.consent(ctx, state.database(), state.model, interview_id, body.allow,
                                 runs=state.turn_runs, ro_schema=state.settings.kernel_ro_schema, admit=admit,
                                 cards=cards, business_tools_enabled=state.settings.business_tools_enabled)
    if answer.busy:
        return JSONResponse(answer.model_dump(mode="json"), status_code=202)
    return answer


@router.post("/{id}/answer", response_model=SetupState,
             responses={202: {"model": SetupState}, **error_responses(401, 404, 409, 422, 429, 503)})
async def setup_answer(interview_id: InterviewId, body: SetupAnswerIn, request: Request,
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx)], cards: bool = False) -> Any:
    """Use the shared turn runner for the owner's answer to the question waiting, which the answer names
    (409 `conflict` when none is waiting or another is, so an answer sent twice answers once). Claude replies,
    updates the answers and asks the next question once this one is covered. Wait for the busy commit, then up to
    25 seconds: 200 with the landed state or 202 `SetupState` with `busy: true`. Any turn while busy answers 202
    without running or counting on the limits. Cancelling the request leaves the turn working. Failure or
    abandonment removes the staged answer and leaves the same question waiting, so the owner can retry.
    503 `model_unavailable` when Claude couldn't answer or the run deadline expires."""
    state = runtime(request).started()

    async def admit() -> None:
        await _moving_on(request, ctx)

    answer = await setup.answer(ctx, state.database(), state.model, interview_id, body.question, body.text, card=body.card,
                                runs=state.turn_runs, ro_schema=state.settings.kernel_ro_schema, admit=admit,
                                cards=cards, business_tools_enabled=state.settings.business_tools_enabled)
    if answer.busy:
        return JSONResponse(answer.model_dump(mode="json"), status_code=202)
    return answer


@router.post("/{id}/proposals/{proposal_id}", response_model=SetupState,
             responses={202: {"model": SetupState}, **error_responses(401, 404, 409, 422, 429, 503)})
async def setup_proposal(interview_id: InterviewId, proposal_id: Annotated[str, Path(max_length=64)],
                          body: SetupProposalIn, request: Request,
                          ctx: Annotated[OwnerCtx, Depends(owner_ctx)], cards: bool = False) -> Any:
    """Answer the waiting proposal and receive Claude's reply and next ask."""
    state = runtime(request).started()

    async def admit() -> None:
        await _moving_on(request, ctx)

    answer = await setup.decide_proposal(ctx, state.database(), state.model, interview_id, proposal_id, body, cards=cards,
                                         business_tools_enabled=state.settings.business_tools_enabled,
                                         runs=state.turn_runs, ro_schema=state.settings.kernel_ro_schema, admit=admit)
    if answer.busy:
        return JSONResponse(answer.model_dump(mode="json"), status_code=202)
    return answer


@router.post("/{id}/suggestions", response_model=SetupState,
             responses={202: {"model": SetupState}, **error_responses(401, 404, 409, 422, 429, 503)})
async def setup_suggestions(interview_id: InterviewId, body: SetupSuggestionsIn, request: Request,
                             ctx: Annotated[OwnerCtx, Depends(owner_ctx)], cards: bool = False) -> Any:
    """Use the current proposals and finish questions with safe defaults for unanswered limits."""
    state = runtime(request).started()

    async def admit() -> None:
        await _moving_on(request, ctx)

    answer = await setup.use_suggestions(ctx, state.database(), state.model, interview_id, cards=cards,
                                         business_tools_enabled=state.settings.business_tools_enabled,
                                         runs=state.turn_runs, ro_schema=state.settings.kernel_ro_schema, admit=admit)
    if answer.busy:
        return JSONResponse(answer.model_dump(mode="json"), status_code=202)
    return answer


@router.get("/{id}/tools", response_model=SetupTools, responses=error_responses(401, 404, 422, 503))
async def setup_tools(interview_id: InterviewId, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SetupTools:
    """The new Desk's tools, and the mock payments server while it isn't connected."""
    return await setup.setup_tools(ctx, runtime(request).started().database(), interview_id)


@router.post("/{id}/tools/connect", response_model=list[ToolRow],
             responses=error_responses(401, 404, 409, 422, 429, 503))
async def setup_connect_tools(interview_id: InterviewId, request: Request,
                              ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[ToolRow]:
    """Connect the mock payments server (test mode, no money moves) before the rules are confirmed: its tools come
    back pinned and waiting for the owner's review. 409 `conflict` once the rules are confirmed."""
    state = await _moving_on(request, ctx, model=False)
    return await setup.connect_tools(ctx, state.database(), interview_id)


@router.get("/{id}/public_lines", response_model=SetupPublicLines,
            responses=error_responses(401, 404, 409, 422, 503))
async def setup_public_lines(interview_id: InterviewId, request: Request,
                             ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SetupPublicLines:
    """Read nonblank public lines in board order, hours and prices, with their provenance.
    Allowed at `rules` or `situations`; 409 `conflict` at any other step or while a turn is pending."""
    return await setup.public_lines(ctx, runtime(request).started().database(), interview_id)


PUBLIC_LINES_WRITE_RESPONSES = {
    **error_responses(401, 404, 409, 422, 503),
    409: {"model": ApiError, "description": (
        "A stale item id, an unavailable setup step, an active turn or a failed save returns `error: conflict`. "
        "A kernel part conflict returns `error: kernel`, `code: conflict`, after attempting repair of sent parts."
    )},
    422: {"model": SetupPublicLineError | ApiError},
}


@router.put("/{id}/public_lines", response_model=SetupPublicLines, responses=PUBLIC_LINES_WRITE_RESPONSES)
async def setup_put_public_line(interview_id: InterviewId, body: SetupPublicLineIn, request: Request,
                                ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Edit one public line and strictly publish the charter before saving its owner provenance.
    Allowed at `rules` or `situations`, without changing the step; 409 `conflict` otherwise. Every write publishes
    the confirmed lines and leaves out held lines (`held`), values still suggested, and every policy line while
    setup's policy claims are switched off; a rewording that is published clears its line's hold. A refused charter
    is 422 `line_refused`, naming the refused key and reason codes when available; a charter cap names no key.
    `policy:how_we_help` is 422 `not_editable`. A failed save restores the stored charter once, then answers 409."""
    state = runtime(request).started()
    return await _public_lines_answer(setup.put_public_line(
        ctx, state.database(), interview_id, body.key, body.text, state.clock(),
        setup_policy_claims_enabled=state.settings.setup_policy_claims_enabled))


async def _public_lines_answer(work: Awaitable[SetupPublicLines]) -> SetupPublicLines | JSONResponse:
    try:
        return await work
    except setup.PublicLineProblem as refused:
        return JSONResponse(refused.answer.model_dump(mode="json", exclude_none=True), status_code=422)


@router.post("/{id}/public_lines/confirm", response_model=SetupPublicLines,
             responses=PUBLIC_LINES_WRITE_RESPONSES)
async def setup_confirm_public_lines(interview_id: InterviewId, body: SetupPublicLinesConfirmIn, request: Request,
                                     ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Confirm only the listed keys at the displayed revision; publish before saving without changing the step.
    Allowed at `rules` or `situations`; 409 `conflict` otherwise. A stale revision is 409 `conflict`, checked before
    the keys, so a key removed since the owner's view isn't an invalid request. A refused charter is 422
    `line_refused`, naming the refused key and reason codes when available; a charter cap names no key. A held key
    is 422 `line_refused` naming it, with nothing changed: only a rewording can publish it. A failed save restores
    the stored parts once, then answers 409. Blank lines and empty hours or prices remain unconfirmed."""
    state = runtime(request).started()
    return await _public_lines_answer(setup.confirm_public_lines(
        ctx, state.database(), interview_id, state.clock(), keys=body.keys, revision=body.revision,
        setup_policy_claims_enabled=state.settings.setup_policy_claims_enabled))


@router.delete("/{id}/public_lines/{key}", response_model=SetupPublicLines,
               responses=PUBLIC_LINES_WRITE_RESPONSES)
async def setup_delete_public_line(interview_id: InterviewId, key: str, request: Request,
                                   ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Remove a suggested public item, publishing before saving. Owner items are 422 `not_suggested`;
    `policy:how_we_help` is 422 `not_editable`, and unknown keys are 422 `invalid`.
    Allowed at `rules` or `situations`, under the same turn guard, publication and repair as edits."""
    state = runtime(request).started()
    return await _public_lines_answer(setup.delete_public_line(
        ctx, state.database(), interview_id, key, state.clock(),
        setup_policy_claims_enabled=state.settings.setup_policy_claims_enabled))


@router.delete("/{id}/public_lines/prices/{item_id}", response_model=SetupPublicLines,
               responses=PUBLIC_LINES_WRITE_RESPONSES)
async def setup_delete_public_price(interview_id: InterviewId, item_id: str, request: Request,
                                    ctx: Annotated[OwnerCtx, Depends(owner_ctx)],
                                    title: Annotated[str, Query(min_length=1, max_length=80, pattern=r"\S")],
                                    unit_cents: Annotated[int, Query(ge=0, le=1_000_000)]) -> Any:
    """Remove one suggested price only when its current id, title and amount match what the owner saw.
    Owner prices are 422 `not_suggested`; a missing or mismatched item is 409 `conflict`.
    Allowed at `rules` or `situations`, under the same turn guard, publication and repair as edits."""
    state = runtime(request).started()
    return await _public_lines_answer(setup.delete_public_price(
        ctx, state.database(), interview_id, item_id, state.clock(), title=title, unit_cents=unit_cents,
        setup_policy_claims_enabled=state.settings.setup_policy_claims_enabled))


# The proving routes ----------------------------------------------------------------------------------------------

Work = Callable[[OwnerCtx, Runtime], Awaitable[Any]]
PROVING_RESPONSES: dict[int | str, dict[str, Any]] = {202: {"model": ProvingPending},
                                                      **error_responses(401, 404, 409, 422, 429, 503)}
# The 422 of a proving route that posts owner cards to `POST /policy/draft` (`versions.post_draft`).
ALWAYS_ON_RESPONSES: dict[int | str, dict[str, Any]] = {422: {"model": ChangesAlwaysOn | ApiError}}


async def proving_answer(request: Request, ctx: OwnerCtx, desk_id: str, work: Work, *, started: float,
                         admit: Callable[[], Awaitable[None]], body: BaseModel | None = None,
                         changes_rules: bool = False, owner_stream: bool = False, stream: bool = False) -> Any:
    """Run `work` through the process's proving tasks, keyed by the Desk, the path and the body: its answer, or 202
    `ProvingPending` naming the same request (path and JSON body) once `PROVING_WAIT_S` has passed since `started`.
    `admit` (the route's limits) runs for new work only; a re-post that joins it isn't counted again. The work runs
    on its own database connection, since it may outlive the request. Work that `changes_rules` drops the Desk's other
    kept answers once it ends, since they were about the rules before. Cards the work's draft refused before the
    kernel was asked, for changing starting a verification (`versions.ChangesAlwaysOn`), are 422 `changes_always_on`
    naming them."""
    state = runtime(request).started()
    payload = None if body is None else body.model_dump(mode="json")

    async def run() -> Any:
        try:
            async with setup.detached(ctx, state.database(), state.settings.kernel_ro_schema) as owner:
                return await work(owner, state)
        finally:
            if changes_rules:
                state.proving.forget(desk_id)

    key = (desk_id, request.url.path, body_sha256(payload))
    if stream:
        events = await state.proving.stream(key, run, admit=admit)
        return stream_response(events)
    try:
        answer = await state.proving.run(key, run, admit=admit,
                                         deadline=started + proving.PROVING_WAIT_S, display=owner_stream)
    except versions.ChangesAlwaysOn as refused:
        return JSONResponse(ChangesAlwaysOn(card_ids=refused.card_ids).model_dump(mode="json"), status_code=422)
    if answer is proving.PENDING:
        pending = ProvingPending(retry=ProvingRetry(path=request.url.path, body=payload))
        return JSONResponse(pending.model_dump(mode="json"), status_code=202)
    return answer


async def _proving(request: Request, ctx: OwnerCtx, interview_id: str, work: Work, *, model: bool,
                   changes_rules: bool = False) -> Any:
    """Run `work` for the interview's Desk through `proving_answer`, with no body. New work counts on the setup turn
    limit (and the model budget, when it calls the model)."""
    started = monotonic()
    desk_id = await setup.interview_desk(ctx, runtime(request).started().database(), interview_id)

    async def admit() -> None:
        await _moving_on(request, ctx, model=model)

    return await proving_answer(request, ctx, desk_id, work, started=started, admit=admit,
                                changes_rules=changes_rules)


@policy_router.post("/{id}/rules", response_model=RulesDraft, responses={**PROVING_RESPONSES, **ALWAYS_ON_RESPONSES})
async def setup_rules(interview_id: InterviewId, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """The new Desk's first rules: its hours, prices, calendar and public details go to the kernel, Claude drafts rule
    cards from the owner's answers (the template cards when its draft can't be used), and the kernel compiles and
    proves them. Sent again, it re-posts the same cards and never drafts again. 409 `rules_cannot_be_checked` when
    the kernel couldn't check them ("Rules can't be checked right now"); 409 `conflict` before the questions are
    done or once the rules are confirmed."""
    async def work(owner: OwnerCtx, state: Runtime) -> RulesDraft:
        return await setup.rules(owner, state.database(), state.model, interview_id, state.clock(),
                                 setup_policy_claims_enabled=state.settings.setup_policy_claims_enabled)

    return await _proving(request, ctx, interview_id, work, model=True)


@policy_router.post("/{id}/situations", response_model=list[SituationResult], responses=PROVING_RESPONSES)
async def setup_situations(interview_id: InterviewId, request: Request,
                           ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Six situations Claude writes from the owner's answers, each tried against the drafted rules without running
    anything, with whether the rules do what the owner would want. 409 `conflict` without a draft."""
    async def work(owner: OwnerCtx, state: Runtime) -> list[SituationResult]:
        return await setup.situations(owner, state.database(), state.model, interview_id, state.clock())

    return await _proving(request, ctx, interview_id, work, model=True)


@policy_router.post("/{id}/safety_check", response_model=SafetyCheck, responses=PROVING_RESPONSES)
async def setup_safety_check(interview_id: InterviewId, request: Request,
                             ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """What a bad actor would try against the drafted rules, each with the kernel's verdict, run nowhere. 409
    `conflict` without a draft."""
    async def work(owner: OwnerCtx, state: Runtime) -> SafetyCheck:
        return await setup.safety_check(owner, state.database(), interview_id)

    return await _proving(request, ctx, interview_id, work, model=False)


@policy_router.post("/{id}/confirm", response_model=PolicyVersion,
                    responses={**PROVING_RESPONSES, 409: {"model": RulesChanged | ApiError}, **ALWAYS_ON_RESPONSES})
async def setup_confirm(interview_id: InterviewId, request: Request,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Activate the drafted rules, with Answering still off, so the owner can try the Desk before it goes live. When
    the rules changed after the draft, the same cards are drafted again and the answer is 409
    `rules_changed_since_draft` with the new `draft` to confirm; 409 `conflict` without a proved draft."""
    async def work(owner: OwnerCtx, state: Runtime) -> PolicyVersion:
        return await setup.confirm(owner, state.database(), interview_id)

    try:
        return await _proving(request, ctx, interview_id, work, model=False, changes_rules=True)
    except setup.RulesChangedSinceDraft as changed:
        return JSONResponse(RulesChanged(draft=changed.draft).model_dump(mode="json"), status_code=409)


@policy_router.post("/{id}/go_live", response_model=WentLive, responses=PROVING_RESPONSES)
async def setup_go_live(interview_id: InterviewId, request: Request,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Turn Answering on once the rules are confirmed (409 `conflict` before): the Desk answers the public at
    `public_url`."""
    origin = public_origin(request)

    async def work(owner: OwnerCtx, state: Runtime) -> WentLive:
        return await setup.go_live(owner, state.database(), interview_id, origin)

    return await _proving(request, ctx, interview_id, work, model=False)
