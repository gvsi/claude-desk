"""The structured outputs' schema budget: every schema the API asks Claude to answer in stays small enough to compile
fast.

Claude's structured outputs compile each schema into a grammar on its first use, then cache it for 24 hours. The Claude
API refuses a request whose strict schemas together carry more than 24 optional parameters or 16 union-typed ones
(`anyOf`, or a type list such as `["string", "null"]`), and union types make the compile cost grow exponentially, so a
schema just under those limits can compile for longer than a model call may take. Each schema the API sends keeps to a
budget well inside them (`SCHEMA_*_MAX`), counted through every `$ref` at each place it is used, and no request's
strict schemas together pass the API's own limits (`REQUEST_*_MAX`).
"""

from dataclasses import dataclass

import pytest
from pydantic import BaseModel

from desk.api.metrics import ROUTES
from desk.api.model import ModelRequest, build_kwargs, strict_schema
from desk.api.prompts import (
    SETUP_TURNS,
    AgentStep,
    DraftedRules,
    DraftedSituations,
    RuleChat,
    SetupStart,
    SetupNextStep,
    SetupUnderstanding,
    Translation,
    Triage,
)

SCHEMA_OPTIONAL_MAX, SCHEMA_UNION_MAX = 8, 6
REQUEST_OPTIONAL_MAX, REQUEST_UNION_MAX = 24, 16

# Every structured output the API sends, by the route that sends it.
OUTPUTS: dict[str, tuple[type[BaseModel], ...]] = {
    "setup": (SetupStart, SetupUnderstanding, SetupNextStep, *SETUP_TURNS.values()),
    "card_draft": (DraftedRules,),
    "situations": (DraftedSituations,),
    "rules_chat": (RuleChat,),
    "visiting_agent": (AgentStep,),
    "triage": (Triage,),
    "translation": (Translation,),
}
SENT = [(route, output) for route, outputs in OUTPUTS.items() for output in outputs]


@dataclass
class Complexity:
    optional: int = 0
    union: int = 0

    def __add__(self, other: "Complexity") -> "Complexity":
        return Complexity(self.optional + other.optional, self.union + other.union)


def complexity(schema: dict) -> Complexity:
    """A strict schema's optional parameters (a property its object doesn't require) and union-typed ones (`anyOf` or
    a type list), over every object in it: a `$ref` is followed at each place it is used."""
    defs = schema.get("$defs", {})
    counted = Complexity()

    def walk(node: object, seen: frozenset[str]) -> None:
        if not isinstance(node, dict):
            return
        if "$ref" in node:
            name = node["$ref"].removeprefix("#/$defs/")
            assert name not in seen, "structured outputs take no recursive schema"
            walk(defs[name], seen | {name})
            return
        required = set(node.get("required", []))
        for name, sub in node.get("properties", {}).items():
            counted.optional += name not in required
            counted.union += "anyOf" in sub or isinstance(sub.get("type"), list)
            walk(sub, seen)
        for sub in node.get("anyOf", []) + node.get("allOf", []):
            walk(sub, seen)
        walk(node.get("items"), seen)

    walk(schema, frozenset())
    return counted


def request(route: str, output: type[BaseModel]) -> dict:
    """What the API sends for a structured call on `route` answering in `output` (`build_kwargs`)."""
    return build_kwargs(ModelRequest(route=route, system=[{"type": "text", "text": "System."}],
                                     messages=[{"role": "user", "content": [{"type": "text", "text": "Hello."}]}],
                                     output_schema=output))


def strict_schemas(kwargs: dict) -> list[dict]:
    """A request's strict schemas: its output format's, and each strict tool's input schema (the API sends none:
    `build_kwargs` refuses a tool that sets `strict`)."""
    output = kwargs.get("output_config", {}).get("format")
    return ([output["schema"]] if output else []) + [tool["input_schema"] for tool in kwargs.get("tools", [])
                                                     if tool.get("strict")]


class Inner(BaseModel):
    maybe: int | None = None
    text: str


class Outer(BaseModel):
    first: Inner
    second: Inner | None
    many: list[Inner]


# As wide as setup's one answer turn was: 15 nullable fields, each optional.
Wide = type("Wide", (BaseModel,), {"__annotations__": {f"field_{n}": str | None for n in range(15)},
                                   **{f"field_{n}": None for n in range(15)}})


def test_the_count_follows_every_ref_where_it_is_used():
    # Inner's optional, nullable `maybe` counts at each of its three uses; `second` is one more union, required.
    assert complexity(strict_schema(Outer)) == Complexity(optional=3, union=4)
    wide = complexity(strict_schema(Wide))
    assert wide == Complexity(optional=15, union=15)
    assert wide.optional > SCHEMA_OPTIONAL_MAX and wide.union > SCHEMA_UNION_MAX


def test_every_structured_route_is_counted():
    assert set(OUTPUTS) == ROUTES - {"conversation"}


@pytest.mark.parametrize(("route", "output"), SENT, ids=[f"{route}-{output.__name__}" for route, output in SENT])
def test_each_structured_output_keeps_to_its_budget(route, output):
    counted = complexity(strict_schema(output))
    assert counted.optional <= SCHEMA_OPTIONAL_MAX, counted
    assert counted.union <= SCHEMA_UNION_MAX, counted


@pytest.mark.parametrize(("route", "output"), SENT, ids=[f"{route}-{output.__name__}" for route, output in SENT])
def test_no_request_passes_the_apis_limits(route, output):
    schemas = strict_schemas(request(route, output))
    assert schemas == [strict_schema(output)]
    total = sum((complexity(schema) for schema in schemas), Complexity())
    assert total.optional <= REQUEST_OPTIONAL_MAX and total.union <= REQUEST_UNION_MAX, total
