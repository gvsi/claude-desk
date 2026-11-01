"""Write the shared contracts as one JSON Schema document, desk/contracts.schema.json.

Run from backend/ after changing a contract: uv run python scripts/export_schema.py
The web app generates its TypeScript types from the committed file.
"""

import json
from pathlib import Path

from pydantic import BaseModel, TypeAdapter

from desk import contracts
from desk.events import A2AResponse, SseEvent
from desk.kernel_api import KERNEL_REQUESTS, KERNEL_RESPONSES

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "desk" / "contracts.schema.json"


def _contract_models() -> list[type[BaseModel]]:
    """Every model defined in desk.contracts, in order, except the kernel-internal Principal."""
    return [
        value
        for value in vars(contracts).values()
        if isinstance(value, type)
        and issubclass(value, BaseModel)
        and value.__module__ == contracts.__name__
        and value is not contracts.Principal
    ]


def export_schema() -> dict:
    """The JSON Schema of every contract but Principal, every kernel request and response, SseEvent and A2AResponse."""
    exported: dict[str, object] = {
        model.__name__: model for model in (*_contract_models(), *KERNEL_REQUESTS, *KERNEL_RESPONSES, A2AResponse)
    }
    exported["SseEvent"] = SseEvent
    # Keep the closed native/MCP name available after ToolProfile also accepts desk.* names.
    exported.update(ToolName=contracts.ToolName, AnyToolName=contracts.AnyToolName,
                    BusinessToolName=contracts.BusinessToolName)
    by_name, document = TypeAdapter.json_schemas(
        [(name, "validation", TypeAdapter(annotation)) for name, annotation in exported.items()]
    )
    defs = dict(document.get("$defs", {}))
    for (name, _mode), schema in by_name.items():
        if schema != {"$ref": f"#/$defs/{name}"}:   # a union such as SseEvent has no def of its own yet
            defs[name] = schema
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Claude Desk shared contracts",
        "description": "Generated from backend/desk/contracts.py, events.py and kernel_api.py by "
        "backend/scripts/export_schema.py; do not edit by hand.",
        "$defs": dict(sorted(defs.items())),
    }


def main() -> None:
    SCHEMA_PATH.write_text(json.dumps(export_schema(), indent=2) + "\n")


if __name__ == "__main__":
    main()
