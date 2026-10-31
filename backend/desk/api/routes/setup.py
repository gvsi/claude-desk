"""The setup interview's routes (Plan 02b, Tasks 6 and 7): the owner cookie names the copy, as on every owner route,
and an interview is read only within it.

- Under `/api/owner/setup`: the interview (start, consent, answers), and the new Desk's tools and their connection.
- Under `/api/owner/policy/setup/{id}` (`id` is the interview's), the proving routes: the rules draft, the
  situations, the safety check, the confirm and going live. Each runs its work through `desk.api.proving`: past
  `PROVING_WAIT_S` it answers 202 `ProvingPending`, and the same request sent again joins the work or takes its
  answer.

Each request that moves the interview on counts on the copy's `setup_turn` limit (80 an hour; a proving re-post that
joins work already running counts once) and, on a route that calls the model, answers 503 `demo_budget` in
production once today's model budget is spent. What each step does is in `desk.api.setup`.
"""

import hashlib
import json
from collections.abc import Awaitable, Callable
from time import monotonic
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from desk.api import proving, setup
from desk.api.deps import OwnerCtx, Runtime, owner_ctx, public_origin, require_model_budget, runtime
from desk.api.schemas import (
    ApiError,
    ProvingPending,
    ProvingRetry,
    RulesChanged,
    RulesDraft,
    SafetyCheck,
    SetupAnswerIn,
    SetupConsentIn,
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


@router.post("", status_code=201, response_model=SetupState, responses=error_responses(401, 422, 429, 503))
async def start_setup(body: SetupStartIn, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SetupState:
    """Start setting up a new Desk from the owner's own words: Claude reads them, the kernel makes the Desk with
    Answering off, and Claude asks whether it may read the owner's Claude memory and website. A name the owner gives
    here is the one customers see, and one the kernel wouldn't take is 422. 503 `model_unavailable` when Claude
    couldn't answer, with nothing made."""
    state = await _moving_on(request, ctx)
    return await setup.start(ctx, state.database(), state.model, body)


@router.get("/{id}", response_model=SetupState, responses=error_responses(401, 404, 422, 503))
async def setup_interview(interview_id: InterviewId, request: Request,
                          ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SetupState:
    """The setup interview as it stands."""
    return await setup.read(ctx, runtime(request).started().database(), interview_id)


@router.post("/{id}/consent", response_model=SetupState,
             responses=error_responses(401, 404, 409, 422, 429, 503))
async def setup_consent(interview_id: InterviewId, body: SetupConsentIn, request: Request,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SetupState:
    """The owner's answer to whether Claude may read their Claude memory and website, given once (409 `conflict`
    after). On yes, both are read through the kernel as the owner's setup tools, each shown as a label; on no,
    neither ever is. Then the first question."""
    state = await _moving_on(request, ctx)
    return await setup.consent(ctx, state.database(), interview_id, body.allow)


@router.post("/{id}/answer", response_model=SetupState,
             responses=error_responses(401, 404, 409, 422, 429, 503))
async def setup_answer(interview_id: InterviewId, body: SetupAnswerIn, request: Request,
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> SetupState:
    """The owner's answer to the question waiting, which the answer names (409 `conflict` when none is waiting or
    another is, so an answer sent twice answers once): Claude replies, the answers are updated and, once the question
    is covered, the next one is asked. 503 `model_unavailable` when Claude couldn't answer, with nothing stored, so the
    same answer can be sent again."""
    state = await _moving_on(request, ctx)
    return await setup.answer(ctx, state.database(), state.model, interview_id, body.question, body.text)


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


# The proving routes ----------------------------------------------------------------------------------------------

Work = Callable[[OwnerCtx, Runtime], Awaitable[Any]]
PROVING_RESPONSES: dict[int | str, dict[str, Any]] = {202: {"model": ProvingPending},
                                                      **error_responses(401, 404, 409, 422, 429, 503)}
NO_BODY = hashlib.sha256(b"").hexdigest()


def body_sha256(body: dict[str, Any] | None) -> str:
    """The sha256 of a request body's canonical JSON (keys sorted, no spaces), or of no body."""
    if body is None:
        return NO_BODY
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
                          ).hexdigest()


async def proving_answer(request: Request, ctx: OwnerCtx, desk_id: str, work: Work, *, started: float,
                         admit: Callable[[], Awaitable[None]], body: BaseModel | None = None,
                         changes_rules: bool = False) -> Any:
    """Run `work` through the process's proving tasks, keyed by the Desk, the path and the body: its answer, or 202
    `ProvingPending` naming the same request (path and JSON body) once `PROVING_WAIT_S` has passed since `started`.
    `admit` (the route's limits) runs for new work only; a re-post that joins it isn't counted again. The work runs
    on its own database connection, since it may outlive the request. Work that `changes_rules` drops the Desk's other
    kept answers once it ends, since they were about the rules before."""
    state = runtime(request).started()
    payload = None if body is None else body.model_dump(mode="json")

    async def run() -> Any:
        try:
            async with setup.detached(ctx, state.database(), state.settings.kernel_ro_schema) as owner:
                return await work(owner, state)
        finally:
            if changes_rules:
                state.proving.forget(desk_id)

    answer = await state.proving.run((desk_id, request.url.path, body_sha256(payload)), run, admit=admit,
                                     deadline=started + proving.PROVING_WAIT_S)
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


@policy_router.post("/{id}/rules", response_model=RulesDraft, responses=PROVING_RESPONSES)
async def setup_rules(interview_id: InterviewId, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """The new Desk's first rules: its hours, prices, calendar and public details go to the kernel, Claude drafts rule
    cards from the owner's answers (the template cards when its draft can't be used), and the kernel compiles and
    proves them. Sent again, it re-posts the same cards and never drafts again. 409 `rules_cannot_be_checked` when
    the kernel couldn't check them ("Rules can't be checked right now"); 409 `conflict` before the questions are
    done or once the rules are confirmed."""
    async def work(owner: OwnerCtx, state: Runtime) -> RulesDraft:
        return await setup.rules(owner, state.database(), state.model, interview_id, state.clock())

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
                    responses={**PROVING_RESPONSES, 409: {"model": RulesChanged | ApiError}})
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
