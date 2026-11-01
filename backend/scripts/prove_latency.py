"""Time `desk-prove` on the Turner rules and a 30-card set inside the kernel image.

    uv run python -m scripts.prove_latency           # p50 and p95 per set, in milliseconds
    uv run python -m scripts.prove_latency --json    # {rivera: {p50_ms, p95_ms}, cards_30: {p50_ms, p95_ms}}

The proof inputs are written here with `activation.write_prove_files`, over a profile for every
native tool the schema declares (what a Desk with all its native tools enabled proves), at the
money cap the Turner seed is proved at (`activation.SHIPPED_CAPS`, as `make proofs` uses), and
mounted read-only into the image (`desk-kernel:dev` by default, built as `kernel/Dockerfile`
says; it holds no backend code). Inside it, `desk-prove` runs on each set `--runs` times in a row,
timed by the image's own Python, so container start-up isn't counted. A run that doesn't prove
every obligation stops the script: only passing proofs are timed.
"""

import argparse
import json
import math
import subprocess
import sys
import tempfile
from datetime import time
from pathlib import Path

from desk.contracts import HoursWindow, RuleCard, ToolProfile
from desk.kernel_service import activation, compiler
from desk.kernel_service.seed import RIVERA_CARDS

# Runs inside the image: times desk-prove on each set under /inputs and prints {set: [ms, ...]}.
TIMER = """
import json, subprocess, sys, time
names, runs, timeout_ms = sys.argv[1].split(","), int(sys.argv[2]), sys.argv[3]
times = {}
for name in names:
    files = [f"/inputs/{name}/{part}.json" for part in ("schema", "sets", "checks")]
    argv = ["desk-prove", "--schema", files[0], "--sets", files[1], "--checks", files[2], "--timeout-ms", timeout_ms]
    times[name] = []
    for _ in range(runs):
        started = time.perf_counter()
        run = subprocess.run(argv, capture_output=True, text=True)
        elapsed = (time.perf_counter() - started) * 1000
        if run.returncode != 0:
            sys.exit(f"{name}: desk-prove exited {run.returncode}: {run.stdout} {run.stderr}")
        times[name].append(elapsed)
print(json.dumps(times))
"""


def schema_profiles() -> list[ToolProfile]:
    """A profile per native tool in the base schema, with the effects and resource it declares."""
    profiles = []
    for tool, action in sorted(compiler.BASE_SCHEMA[""]["actions"].items()):
        if "appliesTo" not in action:
            continue                                     # an effect group, not a tool
        profiles.append(ToolProfile(
            tool=tool, source="native", effects=[group["id"].removeprefix("effect:") for group in action["memberOf"]],
            reversible=False, adapter=f"latency.{tool}", resource_kind=action["appliesTo"]["resourceTypes"][0].lower(),
            description_confirmed=f"Stand-in for {tool}.", input_schema={}, status="enabled"))
    return profiles


def thirty_cards() -> list[RuleCard]:
    """Thirty cards, most with limits of their own, for ten people and four agent keys."""
    def card(card_id: str, applies_to: str, mode: str = "auto", who: str = "anyone", **fields) -> RuleCard:
        return RuleCard(card_id=card_id, applies_to=applies_to, mode=mode, who=who, reason=f"Card {card_id}.", **fields)

    days = [["mon", "tue", "wed"], ["thu", "fri"], ["sat"], ["sun"], ["mon", "fri"], ["tue", "sat", "sun"]]
    cards = [card(f"quote-p{i}", "native.quote", who="person", person_id=f"p{i}", max_discount_bp=100 * i,
                  max_amount_cents=1000 * (i + 1)) for i in range(10)]
    cards += [card(f"book-{i}", "native.book", who=("anyone", "verified")[i % 2], review=i % 2 == 0,
                   hours=HoursWindow(days=days[i], start=time(7 + i), end=time(12 + i))) for i in range(6)]
    cards += [card(f"link-p{i}", "native.payment_link", who="person", person_id=f"p{i}", max_amount_cents=500 * (i + 1))
              for i in range(5)]
    cards += [card(f"charge-a{i}", "native.charge_mandate", who="agent", agent_key_id=f"a{i}",
                   max_amount_cents=2500 * (i + 1)) for i in range(4)]
    cards += [card("changes-verified", "effect:change", who="verified", review=True, max_amount_cents=20_000),
              card("charges-ask", "effect:charge", mode="ask"), card("reads", "effect:read"),
              card("no-pay-out-a0", "effect:pay_out", mode="never", who="agent", agent_key_id="a0"),
              card("no-leads-p3", "native.capture_lead", mode="never", who="person", person_id="p3")]
    assert len(cards) == 30
    return cards


def percentile(samples: list[float], fraction: float) -> float:
    """The nearest-rank percentile."""
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="print {set: {p50_ms, p95_ms}} for the evals report")
    parser.add_argument("--image", default="desk-kernel:dev")
    parser.add_argument("--runs", type=int, default=20)
    args = parser.parse_args(argv)
    profiles = schema_profiles()
    schema = compiler.desk_schema(profiles)
    cap = activation.SHIPPED_CAPS["rivera"]
    sets = {"rivera": RIVERA_CARDS, "cards_30": thirty_cards()}
    with tempfile.TemporaryDirectory(prefix="desk-prove-latency-") as directory:
        for name, cards in sets.items():
            (Path(directory) / name).mkdir()
            inputs = activation.build_proof_inputs(cards, profiles, schema, auto_money_cap_cents=cap)
            activation.write_prove_files(inputs, Path(directory) / name)
        run = subprocess.run(
            ["docker", "run", "--rm", "--network", "none", "-v", f"{directory}:/inputs:ro", args.image,
             "python", "-c", TIMER, ",".join(sets), str(args.runs), str(activation.PROVE_TIMEOUT_MS)],
            capture_output=True, text=True)
    if run.returncode != 0:
        print(run.stderr.strip() or f"docker exited {run.returncode}", file=sys.stderr)
        return 1
    times = json.loads(run.stdout)
    result = {name: {"p50_ms": round(percentile(samples, 0.50), 1), "p95_ms": round(percentile(samples, 0.95), 1)}
              for name, samples in times.items()}
    if args.json:
        print(json.dumps(result))
    else:
        for name, numbers in result.items():
            print(f"{name}: p50 {numbers['p50_ms']} ms, p95 {numbers['p95_ms']} ms ({args.runs} runs in {args.image})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
