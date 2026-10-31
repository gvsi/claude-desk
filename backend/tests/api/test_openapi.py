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
                    # a rule change above the money cap names the cap the owner must raise first
                    **{(operation, "422"): ("AboveMoneyCap", "ApiError")
                       for operation in ("owner_rule_chat", "owner_draft_rules", "owner_draft_preset",
                                         "owner_draft_suggestion")},
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


def test_every_route_has_typed_responses():
    document = export_openapi()
    schemas = document["components"]["schemas"]
    assert schemas["ApiError"]["required"] == ["error"]
    assert set(schemas["ApiError"]["properties"]) == {"error", "code", "retry_after"}
    assert "HTTPValidationError" not in schemas            # a bad body is an ApiError too
    assert set(schemas["AlreadyResolved"]["properties"]) == {"error", "decision"}
    assert set(schemas["PaymentConflict"]["properties"]) == {"error", "code", "state", "cancel_reason"}
    assert {"state", "cancel_reason"} <= set(schemas["PaymentConflict"]["required"])   # the checkout reads both
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
                   "id"}
SETUP_PATHS = {"/api/owner/setup/{id}", "/api/owner/setup/{id}/consent", "/api/owner/setup/{id}/answer",
               "/api/owner/setup/{id}/tools", "/api/owner/setup/{id}/tools/connect",
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
                    if parameter["in"] == "path"] == [("id", "path")], path


def test_the_keyed_starts_document_their_answers():
    # The web reads these: the answers a keyed start or send can give, the one failure rule both follow, and that
    # setup's messages open at Claude's consent question, the owner's description not shown back.
    document = export_openapi()
    start = document["paths"]["/api/owner/setup"]["post"]
    send = document["paths"]["/api/public/desks/{slug}/send_agent"]["post"]
    assert {"404", "409", "422", "429", "503"} <= set(start["responses"])
    assert {"409", "422", "429", "503"} <= set(send["responses"])
    for operation in (start, send):
        assert "One rule for failures" in operation["description"]
    assert "a repeat that finds the key never counts" in send["description"]
    # What the start shares with the send is when a key is freed or kept; only the start answers `key_spent`.
    sentences = " ".join(start["description"].split()).split(". ")
    (shared,) = [sentence for sentence in sentences if "as when sending the built-in agent" in sentence]
    assert "key_spent" not in shared and "key_spent" not in send["description"]
    assert any("key_spent" in sentence for sentence in sentences)
    described = " ".join(document["components"]["schemas"]["SetupState"]["description"].split())
    assert "start at Claude's consent question" in described and "isn't shown back" in described
