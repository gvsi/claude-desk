"""Copies: every visitor of the demo gets their own Turner Plumbing.

`POST /copies` (the API checks the passcode first; the kernel is loopback only) writes a copy row,
the Turner seed through `desks.create_desk`, its seed-only public starter questions, the Desk's public knowledge of its website and price
list through the owner's own path (`seed.seed_knowledge`), the seed's MCP servers connected with their tools
enabled at the hashes the seed is proved with (`mcp_pins.connect`), Dana's and Bob's past payments at
the mock payments server with their facts (`seed.seed_charges`), Mike's urgent business tool through
the owner's own replacement (`seed.seed_business_tools`), its rule cards activated from their
CI-proved report at the seed's money cap of $500, turning the urgent tool on as they activate
(`activation.activate_shipped` with `enables`), the held request waiting on Today
(`seed.seed_held_request`) and the copy's owner session, all in one transaction. Without a report
for the cards as compiled, with a tool listed at a hash the seed wasn't proved with, or with a
business tool the card-text check refuses, nothing is created: 503 `seed_unproved`. A mock
payments server that can't be reached is 503 `internal`, logged `mockpay_unavailable`, and
nothing is created either. The owner token in the answer is the copy's credential: it is shown
once and stored only as its hash.
"""

from fastapi import APIRouter

from desk.contracts import CopyCreated
from desk.db.models import Copy
from desk.kernel_api import CreateCopyRequest
from desk.kernel_service import activation, auth, desks, mcp_client, mcp_pins, seed
from desk.kernel_service.auth import SessionRow
from desk.kernel_service.repo import Ctx, KernelCtx, new_id
from desk.kernel_service.sessions import session_state

router = APIRouter()


async def create_copy(ctx: KernelCtx) -> CopyCreated:
    """A new copy seeded with Turner Plumbing, and its owner session, in the caller's transaction."""
    copy_id = new_id("copy")
    ctx.bind(copy_id)
    now = ctx.clock.now()
    ctx.db.add(Copy(copy_id=copy_id, created_at=now))
    business, desk = seed.rivera_seed(now)
    created = await desks.create_desk(ctx, copy_id, business, desk, answering=True)
    await seed.seed_starters(ctx, created.desk_id)
    await seed.seed_knowledge(ctx, created.desk_id, seed.RIVERA_KNOWLEDGE)
    for server in desk.connections:
        await mcp_pins.connect(ctx, created.desk_id, server, seed_pins=mcp_client.seed_pins())
    await seed.seed_charges(ctx, created.desk_id, seed.RIVERA_MOCKPAY_CHARGES)
    urgent = await seed.seed_business_tools(ctx, created.desk_id, seed.RIVERA_BUSINESS_TOOLS)
    await activation.activate_shipped(ctx, created.desk_id, "rivera", desk.auto_money_cap_cents, enables=urgent)
    seeded_chat = await seed.seed_held_request(ctx, copy_id, created.desk_id)
    token = auth.new_token()
    owner = SessionRow(session_id=auth.new_session_id(), copy_id=copy_id, desk_id=None, kind="owner",
                       secret_hash=auth.hash_token(token), verified=True, assurance="owner_session", mode="ai",
                       generation=0, strikes=0, preview=False, created_at=now, last_seen_at=now)
    ctx.db.add(owner)
    await ctx.db.flush()
    return CopyCreated(copy_id=copy_id, desk_ids=[created.desk_id], owner_session=session_state(owner),
                       owner_token=token, seeded_chat=seeded_chat)


@router.post("/copies", response_model=CopyCreated)
async def post_copies(body: CreateCopyRequest, ctx: Ctx) -> CopyCreated:
    return await create_copy(ctx)
