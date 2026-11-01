"""The model client: Claude's conversation call and the structured routes (master plan, "Model cost and latency
budget"; Plan 02a, Task 4).

`ModelClient` is what the loop and the routes call: `await model.call(ModelRequest(...))` returns a
`ModelResponse` or raises `ModelUnavailable`. `AnthropicModel` and `BedrockModel` ("The provider" below) are the
real ones, on the Anthropic SDK with `max_retries=2`; tests use `tests/api/fakes.py`'s `ScriptedModel`, or point
`AnthropicModel` at a fake server (`ANTHROPIC_BASE_URL`, refused in production by `Settings`).

- **The conversation call** (route `conversation`) streams `claude-opus-5-5` with adaptive thinking and an
  explicit effort, under the mid-conversation tool changes beta. The tools are frozen per model context, so
  the request is append-only and caches: the last system block carries `cache_control` for the static prefix
  (tools and system prompt), and the top-level `cache_control` caches the growing history; the two compose.
  No `tool_choice` (it stays `auto`), and no tool sets `eager_input_streaming` (nothing is shown before the
  reply check, so the server keeps validating tool JSON) or `strict` (the kernel refuses bad arguments).
- **Structured routes** ask for JSON matching a Pydantic model through `output_config.format`, never a forced
  `tool_choice` (a 400 on Opus 5.5 and Sonnet 5.5). The schema sent is `strict_schema(model)`; the answer is
  parsed strictly (`parse_structured`), which checks again what the schema had to leave out.

Every SDK error (after the SDK's retries), a stream cut halfway, and an answer that doesn't parse raise
`ModelUnavailable`, which carries the call's `ModelResponse` so its usage row can still be written
(`metrics.record_model_call`). The 400 for a replayed thinking block bound to a different conversation raises it as
`ThinkingBoundElsewhere`, known by its message (`THINKING_BINDING_400`), so the loop can start a fresh context. A
response's `finished_at` is the call's finish and `latency_ms` its duration.

**The provider.** `make_model(settings)` builds the client `Settings.model_provider` names: `AnthropicModel` on
the Claude API, or `BedrockModel` on Amazon Bedrock for local evals, which sends the same body with the model
mapped through `BEDROCK_MODEL_IDS` (the one table, the three production names to their inference profiles) and
records a served model by its production name. Both close what the pinned SDK leaves open ("The credentials",
safety invariant 5):

- The Claude API client always gets an explicit key (`ANTHROPIC_API_KEY`, or in development the placeholder
  `NO_API_KEY`, never an empty one, which httpx2 wouldn't send) and an explicit host, so it never reads
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, workload-identity variables, the on-disk profile or
  `ANTHROPIC_BASE_URL` itself. `ANTHROPIC_CUSTOM_HEADERS`, whose lines that client sends after its own auth
  headers, is refused before any client exists, whichever the provider.
- The Bedrock client is built only from `bedrock_client_kwargs`: the one credential is a Bedrock API key from
  `BEDROCK_BEARER_TOKEN`, passed as `api_key`, which the SDK takes before any other source, so it reads no key
  variable, never signs with the AWS credential chain and never imports boto3 or botocore; `base_url` and
  `aws_region` are always passed, the region fully matching a region name, so `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`,
  `AWS_REGION` and `AWS_DEFAULT_REGION` are never read by the SDK. It carries no middleware: a refusal still hands
  off.
- Keys must be one run of printable ASCII, so a malformed one never reaches an error message or a log.
"""

import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

import anthropic
import httpx2
from pydantic import BaseModel, ValidationError

from desk.api.metrics import ROUTES
from desk.api.settings import Settings

CONVERSATION_MODEL = "claude-opus-5-5"
ANTHROPIC_API_URL = "https://api.anthropic.com"
# The development placeholder key: the Claude API answers it 401, a fake at ANTHROPIC_BASE_URL ignores it, and
# the SDK, given a key, reads no ambient credential. Production requires the real key.
NO_API_KEY = "no-key"
# The production models on Amazon Bedrock: each name to the account's cross-region inference profile. Tests and
# the tier 2 evals read this table, so a refused profile id changes only this table. Its names are the priced
# models' (metrics.PRICES_PER_MTOK), which test_model.py checks.
BEDROCK_MODEL_IDS: dict[str, str] = {
    "claude-opus-5-5": "us.anthropic.claude-opus-5-5",
    "claude-sonnet-5-5": "us.anthropic.claude-sonnet-5-5",
    "claude-haiku-5-5": "us.anthropic.claude-haiku-5-5",
}
# What a Bedrock answer may call a model, back to its production name.
_BEDROCK_SERVED_NAMES = {served: name for name, profile in BEDROCK_MODEL_IDS.items()
                         for served in (name, profile, profile.removeprefix("us."))}
# A key is one run of printable ASCII (h11 refuses whitespace in a header and quotes the value in its error), and a
# region is a whole region name (a prefix match would let `us-west-2.example.com#` move the host).
_KEY = re.compile(r"[!-~]+")
_REGION = re.compile(r"[a-z]{2}(-[a-z]+)+-[0-9]+")
TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01"
# How the Messages API's 400 for a replayed thinking block whose conversation changed (its system prompt, tools or an
# earlier message) is known: its message says the block "is bound to a different conversation"
# (`ThinkingBoundElsewhere`).
THINKING_BINDING_400 = "bound to a different conversation"
# Where that 400 says the refused block is: a path into the request, never its content.
_BINDING_PATH = re.compile(r"\bmessages\.\d+(?:\.content\.\d+)?")
EPHEMERAL = {"type": "ephemeral"}
# Tool fields no model call sends (see the module docstring).
REFUSED_TOOL_FIELDS = frozenset({"eager_input_streaming", "strict"})
# JSON Schema that structured outputs accept, as `strict_schema` keeps it: these keys, the string formats below and
# `minItems` of 0 or 1. Numeric, length and pattern constraints (and anything else) are left out, and checked again
# when the answer is parsed.
SCHEMA_KEYS = frozenset({"type", "properties", "required", "items", "enum", "const", "anyOf", "allOf", "$ref", "$defs",
                         "description", "title"})
STRING_FORMATS = frozenset({"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6",
                            "uuid"})

MAX_RETRIES = 2

Effort = Literal["low", "medium", "high", "xhigh", "max"]


@dataclass(frozen=True)
class ModelRequest:
    """One model call. `system` is a list of text blocks; `output_schema` (a Pydantic model) makes it a structured
    route, and the conversation route has none. `timeout_s` bounds each try the SDK makes (the client's own timeout
    otherwise); it is sent as the SDK's request option, never in the body."""

    route: str
    system: list[dict]
    messages: list[dict]
    tools: list[dict] = field(default_factory=list)
    model: str = CONVERSATION_MODEL
    effort: Effort = "medium"
    max_tokens: int = 16000
    output_schema: Any = None
    timeout_s: float | None = None
    # Raw structured text for an ephemeral owner display; never sent as a model setting.
    on_text: Callable[[str], None] | None = field(default=None, compare=False, repr=False)

    def __post_init__(self) -> None:
        if self.route not in ROUTES:
            raise ValueError(f"{self.route!r} is not a model route")
        if (self.route == "conversation") != (self.output_schema is None):
            raise ValueError("the conversation route has no output schema, and every other route has one")
        if not self.system or not all(isinstance(block, dict) and block.get("type") == "text" for block in self.system):
            raise ValueError("system is a list of text blocks")
        if self.timeout_s is not None and not self.timeout_s > 0:
            raise ValueError("a request's timeout is a positive number of seconds")


def _strict(node: Any) -> Any:
    if isinstance(node, list):
        return [_strict(item) for item in node]
    if not isinstance(node, dict):
        return node
    closed: dict[str, Any] = {}
    for key, value in node.items():
        if key in ("properties", "$defs"):
            closed[key] = {name: _strict(schema) for name, schema in value.items()}
        elif key in ("items", "anyOf", "allOf", "oneOf"):
            closed["anyOf" if key == "oneOf" else key] = _strict(value)
        elif key == "format":
            if value in STRING_FORMATS:
                closed[key] = value
        elif key == "minItems":
            if value in (0, 1):
                closed[key] = value
        elif key == "additionalProperties":
            if value is not False:
                raise ValueError("structured outputs take closed objects only")
        elif key in SCHEMA_KEYS:
            closed[key] = value
    if node.get("type") == "object" or "properties" in node:
        closed["additionalProperties"] = False
    return closed


def strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """`model`'s JSON schema as structured outputs take it: every object closed (`additionalProperties: false`),
    and the constraints they don't support left out (numeric bounds, lengths, patterns, item counts above one).
    `parse_structured` checks them again."""
    return _strict(model.model_json_schema())


def parse_structured(model: type[BaseModel], text: str) -> BaseModel:
    """The answer as `model`, strictly: no coercion, no extra fields, every constraint the schema left out."""
    return model.model_validate_json(text, strict=True, extra="forbid")


def _cached_system(system: list[dict]) -> list[dict]:
    """The system blocks with `cache_control` on the last one (copies; the request's blocks stay as they are)."""
    return [*(dict(block) for block in system[:-1]), {**system[-1], "cache_control": dict(EPHEMERAL)}]


def build_kwargs(request: ModelRequest) -> dict[str, Any]:
    """The SDK call's keyword arguments for `request`: pure, so a test reads exactly what is sent."""
    for tool in request.tools:
        if REFUSED_TOOL_FIELDS & set(tool):
            raise ValueError(f"tool {tool.get('name')!r} sets a field no model call sends")
    if request.output_schema is not None:
        structured: dict[str, Any] = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": request.messages,
            "output_config": {"format": {"type": "json_schema", "schema": strict_schema(request.output_schema)},
                              "effort": request.effort},
        }
        return {**structured, "tools": request.tools} if request.tools else structured
    return {
        "model": request.model,
        "max_tokens": request.max_tokens,
        "system": _cached_system(request.system),
        "tools": request.tools,
        "messages": request.messages,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": request.effort},
        "cache_control": dict(EPHEMERAL),
        "betas": [TOOL_CHANGES_BETA],
    }


@dataclass(frozen=True)
class ModelUsage:
    """A call's tokens, by the SDK's names (what `metrics.record_model_call` reads)."""

    input_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class ModelResponse:
    """A finished call. `content` is the response's blocks as stored (`model_dump(mode="json", exclude_none=True)`,
    thinking included), replayed unchanged; `parsed` is a structured route's validated model. A failed call has
    no usage and the stop reason `"error"`."""

    content: list[dict]
    stop_reason: str
    usage: ModelUsage | None
    latency_ms: int
    finished_at: datetime
    model: str
    parsed: Any = None


class ModelUnavailable(Exception):
    """No usable answer: an SDK error (after its retries) or an answer that doesn't parse. `response` is the call
    as it ended, for its usage row."""

    def __init__(self, response: ModelResponse, reason: str):
        super().__init__(f"model unavailable: {reason}")
        self.response = response


class ThinkingBoundElsewhere(ModelUnavailable):
    """A 400 saying a replayed thinking block is bound to a different conversation (`THINKING_BINDING_400`): the
    history sent isn't the one the block was made in. Still a `ModelUnavailable` wherever that is caught; the loop
    starts a fresh model context and calls once more. `path` is the refused block's place in the request, such as
    `messages.7.content.0`, as the 400 names it (None when it names none): it holds no content, so it can be logged."""

    def __init__(self, response: ModelResponse, reason: str, *, path: str | None = None):
        super().__init__(response, reason)
        self.path = path


def _thinking_bound_elsewhere(error: Exception) -> bool:
    return isinstance(error, anthropic.BadRequestError) and THINKING_BINDING_400 in error.message


def _binding_path(error: Exception) -> str | None:
    """The refused block's path in a thinking-binding 400's message, as `messages.7.content.0`."""
    found = _BINDING_PATH.search(str(getattr(error, "message", "")))
    return found.group(0) if found else None


class ModelClient(Protocol):
    async def call(self, request: ModelRequest) -> ModelResponse: ...


def _utc_now() -> datetime:
    return datetime.now(UTC)


class _SdkModel:
    """`ModelClient` on one of the SDK's clients: every provider sends `build_kwargs(request)`, streams the
    conversation and, when an owner display callback is present, structured text; other structured routes use
    `create`. A provider maps the model name it sends (`_sent_model`) and
    the one it records (`_served_model`); `clock` is a test hook."""

    _client: anthropic.AsyncAnthropic | anthropic.AsyncAnthropicBedrockMantle

    def __init__(self, client: anthropic.AsyncAnthropic | anthropic.AsyncAnthropicBedrockMantle,
                 clock: Callable[[], datetime]):
        self._client = client
        self._clock = clock

    async def aclose(self) -> None:
        await self._client.close()

    def _sent_model(self, name: str) -> str:
        return name

    def _served_model(self, name: str) -> str:
        return name

    async def call(self, request: ModelRequest) -> ModelResponse:
        kwargs = {**build_kwargs(request), "model": self._sent_model(request.model)}
        if request.timeout_s is not None:
            kwargs["timeout"] = request.timeout_s
        started = time.monotonic()
        try:
            if request.output_schema is None:
                async with self._client.beta.messages.stream(**kwargs) as stream:
                    message = await stream.get_final_message()
            elif request.on_text is not None:
                async with self._client.messages.stream(**kwargs) as stream:
                    async for text in stream.text_stream:
                        request.on_text(text)
                    message = await stream.get_final_message()
            else:
                message = await self._client.messages.create(**kwargs)
        except (anthropic.AnthropicError, httpx2.HTTPError) as error:   # a stream cut halfway raises httpx2's own
            if _thinking_bound_elsewhere(error):
                raise ThinkingBoundElsewhere(self._failed(request, started), type(error).__name__,
                                             path=_binding_path(error)) from None
            raise ModelUnavailable(self._failed(request, started), type(error).__name__) from None
        usage = message.usage
        response = ModelResponse(
            content=[block.model_dump(mode="json", exclude_none=True) for block in message.content],
            stop_reason=message.stop_reason or "error",
            usage=ModelUsage(input_tokens=usage.input_tokens,
                             cache_read_input_tokens=usage.cache_read_input_tokens or 0,
                             cache_creation_input_tokens=usage.cache_creation_input_tokens or 0,
                             output_tokens=usage.output_tokens),
            latency_ms=self._latency_ms(started), finished_at=self._clock(), model=self._served_model(message.model))
        if request.output_schema is None:
            return response
        return replace(response, parsed=self._parsed(request.output_schema, response))

    @staticmethod
    def _parsed(output_schema: type[BaseModel], response: ModelResponse) -> BaseModel:
        """A structured answer: one finished JSON text that parses as the route's model, else unavailable."""
        texts = [block["text"] for block in response.content if block.get("type") == "text"]
        if response.stop_reason != "end_turn" or len(texts) != 1:
            raise ModelUnavailable(response, f"structured answer stopped with {response.stop_reason}")
        try:
            return parse_structured(output_schema, texts[0])
        except ValidationError:
            raise ModelUnavailable(response, "structured answer doesn't parse") from None

    def _failed(self, request: ModelRequest, started: float) -> ModelResponse:
        return ModelResponse(content=[], stop_reason="error", usage=None, latency_ms=self._latency_ms(started),
                             finished_at=self._clock(), model=request.model)

    @staticmethod
    def _latency_ms(started: float) -> int:
        return round((time.monotonic() - started) * 1000)


class AnthropicModel(_SdkModel):
    """`ModelClient` on the Claude API. `base_url` is the `ANTHROPIC_BASE_URL` test hook (`make_model` always
    passes one); `http_client` and `clock` are test hooks too."""

    def __init__(self, api_key: str, base_url: str | None = None, *, http_client: httpx2.AsyncClient | None = None,
                 clock: Callable[[], datetime] = _utc_now):
        super().__init__(anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url, max_retries=MAX_RETRIES,
                                                  http_client=http_client), clock)


def bedrock_client_kwargs(aws_region: str, *, bearer_token: str | None) -> dict[str, str]:
    """The Bedrock client's arguments, from the one credential rule: a Bedrock API key from `BEDROCK_BEARER_TOKEN`
    as `api_key` (so the SDK reads no key variable and never signs), the region's host as `base_url` and the region
    itself. Raises `RuntimeError` naming the variable, never its value, before any client exists; the tier 2
    simulator builds its client from this too."""
    if not bearer_token or not _KEY.fullmatch(bearer_token):
        raise RuntimeError("BEDROCK_BEARER_TOKEN must be set to one Bedrock API key: printable ASCII with no spaces")
    if not _REGION.fullmatch(aws_region):
        raise RuntimeError("AWS_REGION must be a region name, such as us-west-2")
    return {"aws_region": aws_region, "base_url": f"https://bedrock-mantle.{aws_region}.api.aws/anthropic",
            "api_key": bearer_token}


class BedrockModel(_SdkModel):
    """`ModelClient` on Amazon Bedrock, for local evals: the same calls as `AnthropicModel` with the model mapped
    through `BEDROCK_MODEL_IDS` (a name outside it raises `ValueError` before any request) and a served model
    recorded by its production name when it maps back to one, so `app.model_calls.model` names the model that
    served the call on both providers. No middleware: a refusal still hands off."""

    def __init__(self, aws_region: str, *, bearer_token: str | None, http_client: httpx2.AsyncClient | None = None,
                 clock: Callable[[], datetime] = _utc_now):
        kwargs = bedrock_client_kwargs(aws_region, bearer_token=bearer_token)
        super().__init__(anthropic.AsyncAnthropicBedrockMantle(**kwargs, max_retries=MAX_RETRIES,
                                                               http_client=http_client), clock)

    def _sent_model(self, name: str) -> str:
        if name not in BEDROCK_MODEL_IDS:
            raise ValueError(f"{name!r} is not a production model, so it has no Bedrock model id")
        return BEDROCK_MODEL_IDS[name]

    def _served_model(self, name: str) -> str:
        return _BEDROCK_SERVED_NAMES.get(name, name)


def make_model(settings: Settings, *, http_client: httpx2.AsyncClient | None = None,
               clock: Callable[[], datetime] = _utc_now) -> AnthropicModel | BedrockModel:
    """The model client `settings` names, with every credential and host passed explicitly (the module docstring);
    its owner closes it with `aclose()`.
    Raises `RuntimeError` naming a variable, never its value, before any client exists: `ANTHROPIC_CUSTOM_HEADERS`
    set to anything but empty refuses either provider."""
    if os.environ.get("ANTHROPIC_CUSTOM_HEADERS"):
        raise RuntimeError("ANTHROPIC_CUSTOM_HEADERS is set; the API sends no custom headers, which could replace "
                           "its key")
    if settings.model_provider == "bedrock":
        return BedrockModel(settings.aws_region, bearer_token=settings.bedrock_bearer_token, http_client=http_client,
                            clock=clock)
    api_key = settings.anthropic_api_key or NO_API_KEY
    if not _KEY.fullmatch(api_key):
        raise RuntimeError("ANTHROPIC_API_KEY must be one API key: printable ASCII with no spaces")
    return AnthropicModel(api_key, settings.anthropic_base_url or ANTHROPIC_API_URL, http_client=http_client,
                          clock=clock)
