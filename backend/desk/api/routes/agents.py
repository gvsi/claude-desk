"""The agents router: `POST /api/a2a/{slug}`, where another person's agent talks to a Desk (Plan 02b, Task 4).

The route reads no cookie and sets none: an agent is known only by the signature the kernel checks. Its work is
`a2a.serve`'s, which reads the raw body itself, since the agent signs those exact bytes; the body's model,
`A2ARequest`, is documented in the OpenAPI document (`with_request_schemas`) for the clients built from it. Every
answer, errors included, says it comes from an AI.
"""

from typing import Annotated

from fastapi import APIRouter, Header, Request
from fastapi.responses import Response
from pydantic.json_schema import models_json_schema

from desk.api.a2a import serve
from desk.api.deps import runtime
from desk.api.schemas import operation_ids
from desk.contracts import A2ARequest
from desk.db.models import A2AError
from desk.events import A2AResponse

router = APIRouter(prefix="/api", generate_unique_id_function=operation_ids("agents"))
ERROR_STATUSES = (400, 401, 409, 422, 429, 500, 503)
REQUEST_BODY = {"requestBody": {"required": True, "content": {"application/json": {
    "schema": {"$ref": "#/components/schemas/A2ARequest"}}}}}


@router.post("/a2a/{slug}", response_model=A2AResponse, openapi_extra=REQUEST_BODY,
             responses={status: {"model": A2AError} for status in ERROR_STATUSES})
async def a2a_request(
        slug: str, request: Request,
        agent_key_id: Annotated[str | None, Header(alias="X-Agent-Key-Id")] = None,
        agent_ts: Annotated[str | None, Header(alias="X-Agent-Ts")] = None,
        agent_nonce: Annotated[str | None, Header(alias="X-Agent-Nonce")] = None,
        agent_sig: Annotated[str | None, Header(alias="X-Agent-Sig")] = None) -> Response:
    """An agent's request to the Desk, signed with its key over `{desk_slug, ts, nonce, body_sha256}` (the Agent
    Card says how). The answer is what the Desk showed since the agent's last answer, Claude's reply last; a request
    sent again with the same nonce gets the answer its first try got and runs nothing."""
    return await serve(runtime(request).started(), request, slug, agent_key_id, agent_ts, agent_nonce, agent_sig)


def with_request_schemas(document: dict) -> dict:
    """The OpenAPI document with `A2ARequest` and the models it names among its components, which the route's
    request body refers to (FastAPI only adds a body model it parses itself)."""
    _, found = models_json_schema([(A2ARequest, "validation")], ref_template="#/components/schemas/{model}")
    schemas = document.setdefault("components", {}).setdefault("schemas", {})
    for name, schema in found.get("$defs", {}).items():
        schemas.setdefault(name, schema)
    return document
