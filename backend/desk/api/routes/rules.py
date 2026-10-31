"""The owner's rules after setup (Plan 02b, Task 9), on the copy the owner cookie names, each Desk checked to be one
of its own before anything is read or sent.

- Under `/api/owner/desks/{desk_id}`: the Rules page (`rules`), suggestions drawn from the owner's approvals, the
  mock payments connection and the demo's tool change, and the owner's knowledge and documents, each sent to the
  kernel with the owner's credential.
- Under `/api/owner/policy/{desk_id}`, the proving routes: each drafts a change the kernel compiles and proves
  (asked of Claude in plain words, an approval's cards, a preset or a suggestion), and `confirm` activates a draft.
  Each runs its work through `routes.setup.proving_answer`: past `PROVING_WAIT_S` it answers 202 `ProvingPending`
  naming the same path and body, and that request sent again joins the work or takes its answer. A draft with a new
  or changed card above the Desk's money cap is 422 `above_money_cap` with the cap, and nothing reaches the kernel.
  New work counts on a limit of the copy's before anything runs: a chat on `owner_ai`, every other draft and the
  confirm on `drafts` (40 an hour), since the kernel proves each.
"""

from collections.abc import Awaitable, Callable
from time import monotonic
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from desk.api import rules
from desk.api.deps import OwnerCtx, Runtime, owner_ctx, require_model_budget, runtime
from desk.api.ratelimit import RateLimitLedger
from desk.api.routes.setup import PROVING_RESPONSES, proving_answer
from desk.api.schemas import (
    AboveMoneyCap,
    ApiError,
    ConfirmRulesIn,
    DocumentIn,
    DraftAddIn,
    DraftCardsIn,
    KnowledgeIn,
    PresetIn,
    RuleChatIn,
    RuleChatOut,
    RulesDraft,
    RulesView,
    SimulateChangeIn,
    Suggestion,
    ToolDecisions,
    ToolRow,
    error_responses,
    operation_ids,
)
from desk.api.versions import connect_payments
from desk.contracts import KnowledgeItem, PolicyVersion, ToolProfile
from desk.kernel_api import (
    DocumentCreated,
    DocumentUploadRequest,
    KnowledgeRequest,
    ToolsSimulateChangeRequest,
)

router = APIRouter(prefix="/api/owner/desks/{desk_id}", generate_unique_id_function=operation_ids("owner"))
policy_router = APIRouter(prefix="/api/owner/policy/{desk_id}", generate_unique_id_function=operation_ids("owner"))

DeskId = Annotated[str, Path(max_length=128)]
DRAFTING_RESPONSES: dict[int | str, dict[str, Any]] = {**PROVING_RESPONSES, 422: {"model": AboveMoneyCap | ApiError}}


@router.get("/rules", response_model=RulesView, responses=error_responses(401, 404, 409, 422, 503))
async def rules_page(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> RulesView:
    """The Desk's active rules: the version in force (its money cap is the Desk's), each tool with the cards that
    cover it (its own, those on its effects, and the compiler's default ask where nothing else does) and its status,
    and the preset the owner cards are, if exactly one."""
    return await rules.rules_view(ctx, ctx.desk(desk_id))


@router.get("/rules/drafts/{version}", response_model=RulesDraft, responses=error_responses(401, 404, 409, 422, 503))
async def rule_draft(desk_id: DeskId, version: int, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> RulesDraft:
    """One of the Desk's drafts, read again as it was made (its cards, money cap, proof and summary), with how it
    differs from the active rules now. A version that isn't a draft of the Desk's is 404."""
    return await rules.read_draft(ctx, ctx.desk(desk_id), version)


@router.get("/suggestions", response_model=list[Suggestion], responses=error_responses(401, 404, 409, 422, 503))
async def suggestions(desk_id: DeskId, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[Suggestion]:
    """Rules the owner's own approvals suggest: a tool they approved at least 3 times in the last 30 days that no
    auto card covers, with the card that would let Claude handle it ("You approved 3 quote requests. Let me handle
    these?"). Drafting one is `POST /api/owner/policy/{desk_id}/suggestions/{tool}`."""
    return await rules.suggestions(ctx, ctx.desk(desk_id), runtime(request).clock())


@router.get("/tools/{tool}/decisions", response_model=ToolDecisions,
            responses=error_responses(401, 404, 422, 503))
async def tool_decisions(desk_id: DeskId, tool: Annotated[str, Path(max_length=64)],
                         ctx: Annotated[OwnerCtx, Depends(owner_ctx)],
                         before: Annotated[str | None, Query(max_length=256)] = None,
                         limit: Annotated[int, Query(ge=1, le=50)] = 20) -> ToolDecisions:
    """The tool's recent decisions on the Desk, for its page: newest first, `limit` at a time, the next page from
    `before` (the last page's `next_before`). A tool the Desk doesn't have is 404."""
    return await rules.tool_decisions(ctx, ctx.desk(desk_id), tool, before=before, limit=limit)


@router.post("/tools/connect", response_model=list[ToolRow], responses=error_responses(401, 404, 409, 422, 503))
async def connect_tools(desk_id: DeskId, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> list[ToolRow]:
    """Connect the mock payments server (test mode, no money moves) to the Desk: its tools come back pinned by their
    definition's hash and `needs_review`, so no one is given them until the owner reviews them; a tool already
    connected is left as it is."""
    return await connect_payments(ctx, ctx.desk(desk_id))


@router.post("/tools/simulate_change", response_model=ToolProfile, responses=error_responses(401, 404, 409, 422, 503))
async def simulate_tool_change(desk_id: DeskId, body: SimulateChangeIn,
                               ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> ToolProfile:
    """The demo's "Simulate a tool change": the mock payments server changes the connected tool's definition for this
    copy, and the kernel finds it at once, so the tool needs the owner's review before Claude uses it again (its
    changed definition is pending, as untrusted text). The kernel refuses a native tool (422)."""
    return await ctx.kernel.call("POST /tools/simulate_change",
                                 ToolsSimulateChangeRequest(desk_id=ctx.desk(desk_id), tool=body.tool))


@router.post("/knowledge", response_model=KnowledgeItem, responses=error_responses(401, 404, 409, 422, 503))
async def add_knowledge(desk_id: DeskId, body: KnowledgeIn,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> KnowledgeItem:
    """Tell Claude something about the business, kept by the kernel under its `item_id` (posting it again replaces
    it): owner-only, or public once the owner marks it so (`Label(readers=["public"])`). It is information for Claude,
    never a rule; the kernel refuses other readers or a text over 100 KiB (422), and keeps an item that quotes a
    private document owner-only."""
    return await ctx.kernel.call("POST /knowledge", KnowledgeRequest(desk_id=ctx.desk(desk_id), item=body.item))


@router.post("/documents", status_code=201, response_model=DocumentCreated,
             responses=error_responses(401, 404, 409, 422, 503))
async def add_document(desk_id: DeskId, body: DocumentIn,
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> DocumentCreated:
    """Add a document to the Desk, the owner's alone or a customer's on record (`record_owner_ref`). The kernel keeps
    its text, which only a single-use link releases to that verified customer, and refuses one naming no one on
    record (422)."""
    return await ctx.kernel.call("POST /documents", DocumentUploadRequest(desk_id=ctx.desk(desk_id),
                                                                          document=body.document))


# The proving routes ----------------------------------------------------------------------------------------------

Work = Callable[[OwnerCtx, Runtime], Awaitable[Any]]


async def _drafting(request: Request, ctx: OwnerCtx, desk_id: str, work: Work, *, body: BaseModel | None = None,
                    admit: Callable[[], Awaitable[None]] | None = None, changes_rules: bool = False) -> Any:
    """`work` on one of the copy's Desks through `proving_answer`; a card above the money cap is 422. New work counts
    on `admit`, by default the copy's `drafts` limit (drafting and confirming call no model, but the kernel proves
    each)."""
    started = monotonic()
    desk_id = ctx.desk(desk_id)

    async def drafts() -> None:
        ledger = RateLimitLedger(ctx.kernel, desk_id=desk_id, session_id=ctx.owner_session_id)
        await runtime(request).started().limiter.enforce("drafts", ctx.copy_id, ledger=ledger)

    if admit is None:
        admit = drafts
    try:
        return await proving_answer(request, ctx, desk_id, work, started=started, admit=admit, body=body,
                                    changes_rules=changes_rules)
    except rules.AboveMoneyCap as above:
        return JSONResponse(AboveMoneyCap(cap_cents=above.cap_cents).model_dump(mode="json"), status_code=422)


@policy_router.post("/chat", response_model=RuleChatOut, responses=DRAFTING_RESPONSES)
async def rule_chat(desk_id: DeskId, body: RuleChatIn, request: Request,
                    ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Ask Claude about the Desk's rules in plain words. A question gets an answer and drafts nothing; a change comes
    back as a draft the kernel compiled and proved, with how it differs from the active rules, which nothing changes
    until `confirm`. Counts on the copy's `owner_ai` limit (40 an hour) and, in production, the daily model budget
    (503 `demo_budget`); 503 `model_unavailable` when Claude couldn't answer."""
    async def admit() -> None:
        state = runtime(request).started()
        ledger = RateLimitLedger(ctx.kernel, desk_id=desk_id, session_id=ctx.owner_session_id)
        await state.limiter.enforce("owner_ai", ctx.copy_id, ledger=ledger)
        await require_model_budget(request)

    async def work(owner: OwnerCtx, state: Runtime) -> RuleChatOut:
        return await rules.chat(owner, state.database(), state.model, desk_id, body.text)

    return await _drafting(request, ctx, desk_id, work, body=body, admit=admit)


@policy_router.post("/draft", response_model=RulesDraft, responses=DRAFTING_RESPONSES)
async def draft_rules(desk_id: DeskId, body: DraftCardsIn | DraftAddIn, request: Request,
                      ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Draft owner cards for the kernel to compile and prove: `cards` as they should stand, on the version they were
    read from (`expected_parent`), or cards to `add` to the active ones, such as an approval's `card_diff` (one with an
    active card's ID takes its place). The answer is the draft with its cards and how they differ from the active
    rules; nothing changes until `confirm`. 409 `rules_cannot_be_checked` when the kernel couldn't check them."""
    async def work(owner: OwnerCtx, state: Runtime) -> RulesDraft:
        if isinstance(body, DraftAddIn):
            return await rules.draft_added(owner, desk_id, body.add)
        return await rules.draft(owner, desk_id, body.cards, expected_parent=body.expected_parent)

    return await _drafting(request, ctx, desk_id, work, body=body)


@policy_router.post("/preset", response_model=RulesDraft, responses=DRAFTING_RESPONSES)
async def draft_preset(desk_id: DeskId, body: PresetIn, request: Request,
                       ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Draft a preset in place of the Desk's owner cards: "Ask me first for everything" (`ask_first`) or "Recommended
    rules" (`auto`). Every owner card goes, those for one person and "never" ones included, and the draft's diff lists
    each; nothing changes until `confirm`."""
    async def work(owner: OwnerCtx, state: Runtime) -> RulesDraft:
        return await rules.draft_preset(owner, desk_id, body.preset)

    return await _drafting(request, ctx, desk_id, work, body=body)


@policy_router.post("/suggestions/{tool}", response_model=RulesDraft, responses=DRAFTING_RESPONSES)
async def draft_suggestion(desk_id: DeskId, tool: Annotated[str, Path(max_length=64)], request: Request,
                           ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Draft the card a suggestion offers for `tool`, added to the active owner cards; 404 when the owner's approvals
    suggest nothing for it now. Nothing changes until `confirm`."""
    async def work(owner: OwnerCtx, state: Runtime) -> RulesDraft:
        return await rules.draft_suggestion(owner, desk_id, tool, state.clock())

    return await _drafting(request, ctx, desk_id, work)


@policy_router.post("/confirm", response_model=PolicyVersion, responses=PROVING_RESPONSES)
async def confirm_rules(desk_id: DeskId, body: ConfirmRulesIn, request: Request,
                        ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> Any:
    """Activate a draft the owner read: its cards, and its money cap, become the Desk's. 409
    `rules_changed_since_draft` when the rules changed after the draft (draft again from the rules now in force), 409
    `conflict` for a draft the kernel didn't prove, 404 for a version that isn't one of the Desk's."""
    async def work(owner: OwnerCtx, state: Runtime) -> PolicyVersion:
        return await rules.confirm(owner, desk_id, body.version)

    return await _drafting(request, ctx, desk_id, work, body=body, changes_rules=True)
