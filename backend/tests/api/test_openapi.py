"""The API's HTTP contract: the committed OpenAPI document Plan 04's client is built from."""

import json
import re

from scripts.export_openapi import OPENAPI_PATH, export_openapi

ROUTERS = {"system", "owner", "public", "agents", "proxy"}
ERROR = {"$ref": "#/components/schemas/ApiError"}
# The error answers whose body is a model of its own (or one of several), by (operation, status).
OWN_ERROR_BODIES = {("system_health", "503"): ("HealthOut",),
                    ("owner_answer_approval", "409"): ("AlreadyResolved", "ApiError"),
                    ("owner_setup_confirm", "409"): ("RulesChanged", "ApiError"),
                    # a rule change above the money cap names the cap the owner must raise first, and one that
                    # would change starting a verification names the cards
                    **{(operation, "422"): ("AboveMoneyCap", "ChangesAlwaysOn", "ApiError")
                       for operation in ("owner_rule_chat", "owner_draft_rules", "owner_draft_preset",
                                         "owner_draft_suggestion")},
                    **{(operation, "422"): ("ChangesAlwaysOn", "ApiError")
                       for operation in ("owner_draft_money_cap", "owner_setup_rules", "owner_setup_confirm")},
                    **{(operation, "422"): ("SetupPublicLineError", "ApiError")
                       for operation in ("owner_setup_put_public_line", "owner_setup_confirm_public_lines",
                                         "owner_setup_delete_public_line", "owner_setup_delete_public_price")},
                    ("proxy_complete_payment", "409"): ("PaymentConflict",),
                    ("proxy_cancel_payment", "409"): ("PaymentConflict",),
                    # every A2A answer says it comes from an AI, its errors included
                    **{("agents_a2a_request", status): ("A2AError",)
                       for status in ("400", "401", "409", "422", "429", "500", "503")}}


def typed(schema: dict) -> bool:
    """A named model, a list of them, or one of them; never an untyped body."""
    if "$ref" in schema:
        return schema["$ref"].startswith("#/components/schemas/")
    if schema.get("type") == "array":
        return typed(schema.get("items", {}))
    return bool(schema.get("anyOf")) and all(typed(option) for option in schema["anyOf"])


def test_openapi_export_is_current():
    assert export_openapi() == json.loads(OPENAPI_PATH.read_text()), "run: cd backend && uv run python scripts/export_openapi.py"


def test_public_desk_starters_are_optional_with_an_empty_default():
    schema = export_openapi()["components"]["schemas"]["PublicDesk"]
    assert "starters" not in schema["required"]
    assert schema["properties"]["starters"] == {
        "default": [], "items": {"type": "string"}, "title": "Starters", "type": "array"}


def test_business_definition_and_setup_proposals_have_distinct_config_schemas():
    schemas = export_openapi()["components"]["schemas"]
    mapping = schemas["BusinessToolDef"]["properties"]["config"]["discriminator"]["mapping"]
    assert mapping == {block: f"#/components/schemas/{name}" for block, name in (
        ("intake", "IntakeConfig"), ("typed_booking", "TypedBookingConfig"),
        ("purpose_payment", "PurposePaymentConfig"), ("urgent", "UrgentConfig"))}
    # A proposal may still need the owner's amount; a configured business tool never does.
    amount = schemas["PurposePaymentProposalConfig"]["properties"]["amount_cents"]
    assert {"type": "null"} in amount["anyOf"]
    assert schemas["PurposePaymentConfig"]["properties"]["amount_cents"]["type"] == "integer"


def test_briefing_contract_counts_only_turned_down_requests():
    schemas = json.loads(OPENAPI_PATH.read_text())["components"]["schemas"]
    item = schemas["BriefingItem"]
    assert item["properties"]["kind"]["enum"] == ["turned_down", "booking", "lead", "answer"]
    assert "cause" in item["required"]
    assert item["properties"]["cause"] == schemas["Attempt"]["properties"]["cause"]
    for name in ("Briefing", "BriefingNewest"):
        assert "turned_down" in schemas[name]["required"]
        assert "blocked" not in schemas[name]["properties"]


def test_knowledge_list_has_required_nullable_fields():
    document = export_openapi()
    operation = document["paths"]["/api/owner/desks/{desk_id}/knowledge"]["get"]
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "type": "array", "items": {"$ref": "#/components/schemas/KnowledgeRow"}, "title": "Response Owner Knowledge"}
    schema = document["components"]["schemas"]["KnowledgeRow"]
    fields = ["item_id", "title", "text", "readers", "source", "created_at"]
    assert schema["required"] == fields
    assert set(schema["properties"]) == set(fields)
    assert all("default" not in prop for prop in schema["properties"].values())
    for field in ("title", "text"):
        assert schema["properties"][field]["anyOf"] == [{"type": "string"}, {"type": "null"}]
    assert schema["properties"]["created_at"]["anyOf"] == [
        {"type": "string", "format": "date-time"}, {"type": "null"}]
    assert schema["properties"]["readers"]["items"] == {"type": "string"}
    assert schema["properties"]["source"]["enum"] == ["website", "upload", "setup", "memory_import", "web_search"]


def test_owner_refusal_reasons_are_required_and_nullable():
    schemas = export_openapi()["components"]["schemas"]
    for name in ("OwnerTranscriptItem", "ToolDecisionRow"):
        assert "owner_plain" in schemas[name]["required"], name
        field = schemas[name]["properties"]["owner_plain"]
        assert field["anyOf"] == [{"type": "string"}, {"type": "null"}]
        assert "default" not in field


def test_public_line_writes_document_kernel_conflicts():
    paths = export_openapi()["paths"]
    for path, method in (
        ("/api/owner/setup/{id}/public_lines", "put"),
        ("/api/owner/setup/{id}/public_lines/confirm", "post"),
        ("/api/owner/setup/{id}/public_lines/{key}", "delete"),
        ("/api/owner/setup/{id}/public_lines/prices/{item_id}", "delete"),
    ):
        conflict = paths[path][method]["responses"]["409"]
        assert conflict["content"]["application/json"]["schema"] == ERROR
        assert "error: kernel" in conflict["description"], path
        assert "code: conflict" in conflict["description"], path


def test_public_fact_confirmation_and_price_removal_require_displayed_values():
    document = export_openapi()
    schemas = document["components"]["schemas"]
    assert "revision" in schemas["SetupPublicLines"]["required"]
    confirm = schemas["SetupPublicLinesConfirmIn"]
    assert set(confirm["required"]) == {"keys", "revision"}
    assert confirm["properties"]["keys"]["minItems"] == 1
    assert confirm["properties"]["revision"]["minLength"] == 1
    removal = document["paths"]["/api/owner/setup/{id}/public_lines/prices/{item_id}"]["delete"]
    query = {parameter["name"]: parameter for parameter in removal["parameters"] if parameter["in"] == "query"}
    assert set(query) == {"title", "unit_cents"}
    assert all(parameter["required"] for parameter in query.values())
    assert query["title"]["schema"]["minLength"] == 1
    assert query["unit_cents"]["schema"]["type"] == "integer"
    assert query["unit_cents"]["schema"]["minimum"] == 0


def test_every_route_has_typed_responses():
    document = export_openapi()
    schemas = document["components"]["schemas"]
    assert schemas["ApiError"]["required"] == ["error"]
    assert set(schemas["ApiError"]["properties"]) == {"error", "code", "retry_after"}
    assert "HTTPValidationError" not in schemas            # a bad body is an ApiError too
    assert set(schemas["AlreadyResolved"]["properties"]) == {"error", "decision"}
    assert set(schemas["PaymentConflict"]["properties"]) == {"error", "code", "state", "cancel_reason"}
    assert {"state", "cancel_reason"} <= set(schemas["PaymentConflict"]["required"])   # the checkout reads both
    # Each Desk the owner's lists name carries its unfinished setup interview, or null, always sent (#233).
    assert "setup" in schemas["DeskSummary"]["required"]
    assert schemas["DeskSetup"]["required"] == ["interview_id", "step"] == list(schemas["DeskSetup"]["properties"])
    assert schemas["DeskSetup"]["properties"]["step"]["enum"] == [   # a live interview is finished: never listed
        "questions", "tools", "rules", "situations", "safety_check", "preview"]
    assert schemas["SetupState"]["properties"]["step"]["enum"][-1] == "live"
    assert schemas["A2AError"]["properties"]["disclosure"] == {"const": "ai", "title": "Disclosure", "type": "string"}
    assert schemas["A2AResponse"]["properties"]["disclosure"]["const"] == "ai"

    operations = {op["operationId"]: (path, method, op)
                  for path, item in document["paths"].items() for method, op in item.items()}
    assert {"system_health", "owner_create_copy", "owner_start_over", "owner_me"} <= set(operations)
    for operation_id, (path, method, op) in operations.items():
        router, _, name = operation_id.partition("_")
        assert router in ROUTERS and name, operation_id                     # <router>_<name>
        assert path.startswith("/api/"), operation_id
        responses = op["responses"]
        media = {status: set(response.get("content", {})) for status, response in responses.items()}
        if any(types and "application/json" not in types for types in media.values()):
            continue                                                        # the event stream and document bytes
        assert any(status.startswith("2") for status in responses), operation_id
        for status, response in responses.items():
            if status == "204":
                assert "content" not in response, operation_id
                continue
            schema = response["content"]["application/json"]["schema"]
            if status.startswith("2"):
                assert typed(schema) and schema != ERROR, (operation_id, status)
            elif (operation_id, status) in OWN_ERROR_BODIES:
                refs = [{"$ref": f"#/components/schemas/{name}"} for name in OWN_ERROR_BODIES[operation_id, status]]
                assert (schema if len(refs) == 1 else schema.get("anyOf")) == (refs[0] if len(refs) == 1 else refs)
            else:
                assert schema == ERROR, (operation_id, status)
        if op.get("requestBody"):
            assert "422" in responses, operation_id                         # a body that doesn't fit


def test_document_refusals_are_copy_or_json():
    """A document link's refusals are static copy for its browser tab, or the `ApiError` for a request asking JSON."""
    responses = export_openapi()["paths"]["/api/d/{token}"]["get"]["responses"]
    assert set(responses) == {"200", "404", "422", "429", "503"}
    assert responses["200"]["content"] == {"application/octet-stream": {}}
    for status in ("404", "422", "429", "503"):
        assert responses[status]["content"] == {"application/json": {"schema": ERROR},
                                                "text/plain": {"schema": {"type": "string"}}}, status


def test_a2a_request_body_is_documented():
    """The A2A endpoint reads its raw body itself (the agent signs those bytes), so its model is documented by hand."""
    document = export_openapi()
    body = document["paths"]["/api/a2a/{slug}"]["post"]["requestBody"]
    assert body == {"required": True, "content": {"application/json": {
        "schema": {"$ref": "#/components/schemas/A2ARequest"}}}}
    schemas = document["components"]["schemas"]
    assert set(schemas["A2ARequest"]["properties"]) == {"desk_slug", "session_id", "message", "mandate",
                                                        "verify_code"}
    assert "Mandate" in schemas


# Path parameters are named after their resource, `id` for a setup interview (master plan, "Shared seams").
PATH_PARAMETERS = {"desk_id", "session_id", "decision_id", "handoff_id", "slug", "token", "version", "run_id", "tool",
                   "id", "proposal_id", "key", "item_id"}
SETUP_PATHS = {"/api/owner/setup/{id}", "/api/owner/setup/{id}/events", "/api/owner/setup/{id}/consent", "/api/owner/setup/{id}/answer",
               "/api/owner/setup/{id}/tools", "/api/owner/setup/{id}/tools/connect",
               "/api/owner/setup/{id}/proposals/{proposal_id}", "/api/owner/setup/{id}/suggestions",
               "/api/owner/setup/{id}/reopen",
               "/api/owner/setup/{id}/public_lines", "/api/owner/setup/{id}/public_lines/confirm",
               "/api/owner/setup/{id}/public_lines/{key}",
               "/api/owner/setup/{id}/public_lines/prices/{item_id}",
               *(f"/api/owner/policy/setup/{{id}}/{step}"
                 for step in ("rules", "situations", "safety_check", "confirm", "go_live"))}


def test_path_parameters_are_named_after_their_resource():
    document = export_openapi()
    named = {name for path in document["paths"] for name in re.findall(r"{(\w+)}", path)}
    assert named <= PATH_PARAMETERS, sorted(named - PATH_PARAMETERS)
    setup = {path for path in document["paths"] if "/setup/" in path}
    assert setup == SETUP_PATHS
    for path in setup:
        for operation in document["paths"][path].values():
            assert [(parameter["name"], parameter["in"]) for parameter in operation.get("parameters", [])
                    if parameter["in"] == "path"] == [(name, "path") for name in re.findall(r"{(\w+)}", path)], path


def test_the_keyed_starts_document_their_answers():
    # The web reads these: the answers a keyed start or send can give, each one's own rule for when its key is freed or
    # kept, and that setup's messages open at Claude's consent question, the owner's description not shown back.
    document = export_openapi()
    start = document["paths"]["/api/owner/setup"]["post"]
    send = document["paths"]["/api/public/desks/{slug}/send_agent"]["post"]
    assert {"404", "409", "422", "429", "503"} <= set(start["responses"])
    assert {"409", "422", "429", "503"} <= set(send["responses"])
    starting, sending = (" ".join(operation["description"].split()) for operation in (start, send))
    assert "a repeat that finds the key never counts" in sending
    # The rules differ, so neither claims the other's: a kernel 4xx frees the send's key, while the start's key keeps
    # its outcome once the Desk was asked for, whatever the kernel answered. Only the start answers `key_spent`.
    for described in (starting, sending):
        assert not any(claim in described for claim in ("One rule for failures", "as when sending", "as when starting",
                                                         "as sending the agent"))
    assert "the kernel refused to mint the agent with a 4xx) frees its key" in sending
    assert "the key keeps the outcome whatever the kernel answered, a refusal too" in starting
    assert "key_spent" in starting and "key_spent" not in sending
    described =" ".join(document["components"]["schemas"]["SetupState"]["description"].split())
    assert "start at Claude's consent question" in described and "isn't shown back" in described
