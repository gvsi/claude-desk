"""Each provider's list prices, and what one model call's usage costs at them.

`PRICES[provider][model]` is a `Price` in US dollars per million tokens, by production model name:
fresh input, cache reads, 5-minute cache writes and output, each priced apart. The Claude API's rows
are the master plan's ("Model cost and latency budget": Anthropic's list prices, checked on
2026-10-28). Amazon Bedrock's rows are filled from AWS's pricing page before the first Bedrock pass,
for the models `BEDROCK_MODEL_IDS` maps, at the endpoint type that table's ids bill as (the page puts
regional endpoints 10 percent above global); until then they are empty, so a pass on Bedrock refuses
to start (`evals.tier2.passes`) and `cost_usd` raises.

`cost_usd(usage, model, provider)` reads token counts by the SDK's names (`input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`) or by the names the API's
`app.model_calls` rows and the kernel's ledger summaries use (`cached_tokens`, `cache_write_tokens`),
and takes a model by its production name or by the id its provider sends.
The soft-promise check now uses the Sonnet row; Haiku stays for triage, translation and historical
records. SDK output_tokens includes thinking tokens, charged once at the output price.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from evals.tier2.simulator import production_name


@dataclass(frozen=True)
class Price:
    """US dollars per million tokens."""

    input: Fraction
    cache_read: Fraction
    cache_write: Fraction        # a 5-minute cache write
    output: Fraction


PRICES: dict[str, dict[str, Price]] = {
    "anthropic": {
        "claude-opus-5-5": Price(Fraction(4), Fraction("0.20"), Fraction(5), Fraction(20)),
        "claude-sonnet-5-5": Price(Fraction(2), Fraction("0.10"), Fraction("2.50"), Fraction(10)),
        "claude-haiku-5-5": Price(Fraction("0.10"), Fraction("0.01"), Fraction("0.125"), Fraction("0.50")),
    },
    "bedrock": {},   # from AWS's pricing page, before the first Bedrock pass
}

# A token count's names: the SDK's first, then the API's and the kernel's records'.
_COUNTS = {"input": ("input_tokens",), "cache_read": ("cache_read_input_tokens", "cached_tokens"),
           "cache_write": ("cache_creation_input_tokens", "cache_write_tokens"), "output": ("output_tokens",)}


class NoPrice(LookupError):
    """The provider has no list price for the model, so its usage can't be priced."""


def price_of(model: str, provider: str, prices: Mapping[str, Mapping[str, Price]] = PRICES) -> Price:
    """The provider's list price for `model` (a production name or the provider's id for it)."""
    row = (prices.get(provider) or {}).get(production_name(model))
    if row is None:
        raise NoPrice(f"no {provider} list price for {model} in evals.pricing.PRICES")
    return row


def cost_usd(usage: Mapping[str, Any], model: str, provider: str, *,
             prices: Mapping[str, Mapping[str, Price]] = PRICES) -> float:
    """What one call's usage costs at the provider's list prices, in US dollars."""
    price = price_of(model, provider, prices)
    tokens = {kind: _count(usage, names) for kind, names in _COUNTS.items()}
    dollars = sum((tokens[kind] * getattr(price, kind) for kind in _COUNTS), Fraction(0)) / 1_000_000
    return float(dollars)


def _count(usage: Mapping[str, Any], names: tuple[str, ...]) -> int:
    """A token count by the first of its names the usage holds; input and output must be there."""
    value = next((usage[name] for name in names if usage.get(name) is not None), None)
    if value is None:
        if names[0] in ("input_tokens", "output_tokens"):
            raise ValueError(f"the usage has no {names[0]}, so it can't be priced")
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{names[0]} is a count of tokens, not {value!r}")
    return value


__all__ = ["PRICES", "NoPrice", "Price", "cost_usd", "price_of"]
