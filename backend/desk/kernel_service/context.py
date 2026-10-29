"""Session context (`GET /context/{session_id}`): what Claude is given for one session.

`session_context` answers with:

- `tools`: the profiles of the tools the session may call now (`decide.tools_given` over the
  Desk's enabled tools), the same set `/decide` checks a call against;
- `tools_declared`: every profile on the Desk that a session of its kind could ever be given
  (`decide.declared_tools`), in any standing and status, so the API can declare them all when a
  conversation starts and load each one only once it is given;
- `facts` and `knowledge`: the Desk's unexpired rows the session's labels let it read
  (`labels.session_readers`): the public's and its own session's, its person's once verified;
  the owner reads the business's and the public's. A row with no readers is the owner's alone.
  `labels.can_read` decides each row in Python, so there is one rule for who reads what; a
  Desk's rows stay few in a demo copy, where a real Desk would filter in SQL first.

A profile carries what Claude is given, the confirmed description and the adapter's input
schema, and never the text of a changed MCP definition, which only the owner reviews.

The route answers "Session state responses" for `/context`: a session's own token, or the
owner's token for its own session and a Desk of its copy (`desk_id`, which the owner must name).
A bad token is 401, another copy or Desk 404, a closed session or deleted Desk 409 `closed`,
each ledgered `auth` on the Desk of the session it names (logged when it names none of them).
The call carries no generation, and a session the owner took over or the breaker paused still
reads its context.
"""

from fastapi import APIRouter, Request
from sqlalchemy import or_, select

from desk.contracts import KnowledgeItem, Label, Principal, ToolProfile
from desk.db.models import Desk, Tool
from desk.db.models import Fact as FactRow
from desk.db.models import KnowledgeItem as KnowledgeRow
from desk.kernel_api import SessionContext
from desk.kernel_service import auth, decide, labels
from desk.kernel_service.auth import SessionRow
from desk.kernel_service.repo import Ctx, KernelCtx
from desk.kernel_service.sessions import principal_for


def _profile(row: Tool) -> ToolProfile:
    """The row's profile at the row's status, without a pending MCP definition's text."""
    return row.profile.model_copy(update={"status": row.status, "pending_definition_text": None,
                                          "pending_sha256": None})


async def session_context(ctx: KernelCtx, principal: Principal, session_row: SessionRow,
                          desk_row: Desk) -> SessionContext:
    """The tools, facts and knowledge of `desk_row` given to the authenticated session."""
    desk_id = desk_row.desk_id
    rows = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.desk_id == desk_id).order_by(Tool.tool)))
    profiles = {row.tool: _profile(row) for row in rows if row.profile is not None}
    given = decide.tools_given(principal, session_row, desk_row, await decide.enabled_tools(ctx, desk_id))
    declared = decide.declared_tools(principal.kind)

    readers = labels.session_readers(session_row)
    now = ctx.clock.now()
    facts = await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.status != "expired",
        or_(FactRow.expires_at.is_(None), FactRow.expires_at > now)).order_by(FactRow.created_at, FactRow.fact_id)))
    knowledge = await ctx.db.scalars(ctx.repo.scoped(
        select(KnowledgeRow).where(KnowledgeRow.desk_id == desk_id).order_by(KnowledgeRow.item_id)))
    return SessionContext(
        tools=[profile for tool, profile in profiles.items() if tool in given],
        tools_declared=[profile for tool, profile in profiles.items() if tool in declared],
        facts=[labels.fact_of(row) for row in facts if labels.can_read(row.readers, readers)],
        knowledge=[KnowledgeItem(item_id=row.item_id, source=row.source, title=row.title, text=row.text,
                                 label=Label(readers=row.readers or list(labels.OWNER_ONLY)))
                   for row in knowledge if labels.can_read(row.readers, readers)],
    )


router = APIRouter()


@router.get("/context/{session_id}", response_model=SessionContext)
async def get_context(session_id: str, ctx: Ctx, request: Request, desk_id: str | None = None) -> SessionContext:
    session_row, desk_row = await auth.require_caller(ctx, request, session_id, desk_id)
    return await session_context(ctx, principal_for(session_row, desk_id=desk_row.desk_id), session_row, desk_row)
