"""The owner's routes, under `/api/owner/`: the only paths the owner cookie is sent to.

Creating a copy is the one call that needs the passcode. Every other owner route takes the copy from the
kernel's `GET /whoami` answer for the owner cookie (`deps.owner_ctx`), never from the browser.
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from desk.api.cookies import set_owner_cookie
from desk.api.deps import ApiProblem, OwnerCtx, Runtime, client_ip, owner_context, owner_ctx, runtime
from desk.api.passcode import check_passcode
from desk.api.schemas import CopyOut, DeskSummary, error_responses, operation_ids
from desk.kernel_api import CreateCopyRequest

router = APIRouter(prefix="/api/owner", generate_unique_id_function=operation_ids("owner"))


class CopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passcode: Annotated[str, StringConstraints(min_length=1, max_length=200)]


async def copy_out(ctx: OwnerCtx) -> CopyOut:
    """The copy's Desks, from its kernel_ro rows, in the order they were made."""
    desks = [row for row in await ctx.ro.desks() if row["desk_id"] in ctx.desk_ids]
    businesses = {row["business_id"]: row["name"]
                  for row in await ctx.ro.rows("businesses", business_id=[desk["business_id"] for desk in desks])}
    return CopyOut(copy_id=ctx.copy_id, desks=[
        DeskSummary(desk_id=desk["desk_id"], slug=desk["slug"], name=desk["name"],
                    business_name=businesses[desk["business_id"]], hours=desk["hours"], answering=desk["answering"])
        for desk in desks])


async def _new_copy(state: Runtime, response: Response) -> CopyOut:
    """A new copy of the Rivera seed, read back through its own owner token, which goes only into the cookie."""
    created = await state.kernel.public().call("POST /copies", CreateCopyRequest())
    async with owner_context(state, created.owner_token) as ctx:
        copy = await copy_out(ctx)
    set_owner_cookie(response, created.owner_token)
    return copy


@router.post("/copies", status_code=201, response_model=CopyOut, responses=error_responses(401, 422, 429, 503))
async def create_copy(body: CopyRequest, request: Request, response: Response) -> CopyOut:
    """A fresh copy of the Rivera seed for whoever holds the passcode, and the owner cookie for it."""
    state = runtime(request).started()
    ip = client_ip(request)
    await state.limiter.enforce("passcode", ip)          # counts the attempt; a right passcode gives it back
    if not await asyncio.to_thread(check_passcode, body.passcode, state.settings.passcode_hash):
        raise ApiProblem(401, "wrong_passcode")
    state.limiter.forget("passcode", ip)
    await state.limiter.enforce("copies", ip)
    return await _new_copy(state, response)


@router.post("/start_over", response_model=CopyOut, responses=error_responses(401, 429, 503))
async def start_over(request: Request, response: Response, ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> CopyOut:
    """A fresh copy for an owner who already has one; the old copy is left as it is, and the cookie moves on."""
    state = runtime(request).started()
    await state.limiter.enforce("copies", client_ip(request), ledger=ctx.ledger())
    return await _new_copy(state, response)


@router.get("/me", response_model=CopyOut, responses=error_responses(401, 503))
async def me(ctx: Annotated[OwnerCtx, Depends(owner_ctx)]) -> CopyOut:
    """The copy the owner cookie names."""
    return await copy_out(ctx)
