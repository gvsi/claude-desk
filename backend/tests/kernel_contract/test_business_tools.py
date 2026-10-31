"""The business-tools write contract, run unchanged against the fake and real kernel."""

import hashlib
import json

import pytest

from desk.api.schemas import ToolRow
from desk.contracts import BusinessTool
from desk.kernel_api import BusinessToolsRequest
from tests.kernel_contract.test_contract import desk_slug, new_copy, new_visitor, refused


@pytest.mark.kernel_plan("01c")
async def test_business_tools_replace_and_expose_review_definition(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool="desk.enquiry", title="Customer enquiry", description="Take the details.",
                        config={"block": "intake", "questions": ["What do you need?"]})
    request = BusinessToolsRequest(tools=[tool])
    answer = await owner.call("PUT /desks/{id}/business_tools", request, path={"id": desk_id})
    assert answer.desk_id == desk_id

    def stored():
        return ro_read(schema, copy.copy_id, "SELECT * FROM {ro}.tools WHERE desk_id = %s AND tool = %s",
                       (desk_id, tool.tool))[0]

    row = stored()
    assert (row["source"], row["status"], row["review_reason"]) == ("business", "needs_review", "new")
    assert row["business"] == tool.model_dump(mode="json", exclude={"tool"})
    expected = hashlib.sha256(json.dumps(row["business"], sort_keys=True, separators=(",", ":"),
                                         ensure_ascii=False).encode()).hexdigest()
    assert row["definition_sha256"] == expected
    assert ToolRow(**row, cards=[]).business.title == tool.title
    await owner.call("PUT /desks/{id}/business_tools", request, path={"id": desk_id})
    assert stored() == row
    changed = tool.model_copy(update={"title": "Client enquiry"})
    await owner.call("PUT /desks/{id}/business_tools", BusinessToolsRequest(tools=[changed]), path={"id": desk_id})
    assert stored()["review_reason"] == "changed"
    assert stored()["definition_sha256"] != expected
    await owner.call("PUT /desks/{id}/business_tools", BusinessToolsRequest(tools=[]), path={"id": desk_id})
    assert stored()["status"] == "disabled"


@pytest.mark.kernel_plan("01c")
async def test_business_tools_invalid_batches_are_atomic_and_owner_only(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool="desk.enquiry", title="Customer enquiry", description="Take details.",
                        config={"block": "intake", "questions": ["What do you need?"]})
    valid = BusinessToolsRequest(tools=[tool])
    await owner.call("PUT /desks/{id}/business_tools", valid, path={"id": desk_id})
    for invalid in (BusinessToolsRequest(tools=[tool, tool]),
                    BusinessToolsRequest.model_construct(tools=[tool.model_copy(update={"tool": f"desk.enquiry-{i}"})
                                                                 for i in range(9)]),
                    BusinessToolsRequest(tools=[tool.model_copy(update={"title": "Guaranteed help"})])):
        assert await refused(owner.call("PUT /desks/{id}/business_tools", invalid, path={"id": desk_id})) == (422, "invalid")
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    assert await refused(http.session(visitor.session_token).call(
        "PUT /desks/{id}/business_tools", valid, path={"id": desk_id})) == (401, "auth")
    rows = ro_read(schema, copy.copy_id, "SELECT tool, status, business FROM {ro}.tools"
                                       " WHERE desk_id = %s AND source = 'business'", (desk_id,))
    assert len(rows) == 1 and rows[0]["status"] == "needs_review"
    assert rows[0]["business"]["title"] == tool.title
