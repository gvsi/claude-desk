"""The API's HTTP contract: the committed OpenAPI document Plan 04's client is built from."""

import json

from scripts.export_openapi import OPENAPI_PATH, export_openapi

ROUTERS = {"system", "owner", "public", "agents", "proxy"}
ERROR = {"$ref": "#/components/schemas/ApiError"}
# The error answers whose body is a model of its own, by (operation, status).
OWN_ERROR_BODIES = {("system_health", "503"): "HealthOut", ("owner_answer_approval", "409"): "AlreadyResolved"}


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
                assert schema == {"$ref": f"#/components/schemas/{OWN_ERROR_BODIES[operation_id, status]}"}
            else:
                assert schema == ERROR, (operation_id, status)
        if op.get("requestBody"):
            assert "422" in responses, operation_id                         # a body that doesn't fit
