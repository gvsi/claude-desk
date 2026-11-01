"""Prove the Turner seed's cards and the starter presets, and write or check their reports.

    uv run python -m scripts.prove_presets          # make proofs: prove each set and write its report
    uv run python -m scripts.prove_presets --check  # make check-presets: prove each set again and compare

Each set is compiled over the profiles a Desk made from it enables (`activation.shipped_profiles`:
the registered native adapters, and for the Turner seed also both mock payments tools pinned at the
hashes of the server's default definitions, so no server runs) and that Desk's schema, at the money
cap it ships at (`activation.SHIPPED_CAPS`: the Turner seed at its $500, the presets at 0), twice,
to show its hashes are deterministic, then proved with `desk-prove`
(`DESK_PROVE`, else `desk-prove` on PATH; cvc5 through `CVC5` or PATH). A report is written only
when all seven obligations hold. `--check` writes nothing and exits 1 unless every fresh report
holds and equals the shipped file exactly, so a missing, stale, failing or hand-edited report fails.
The kernel activates these sets only from the reports, so CI runs `--check`.
"""

import argparse
import asyncio
import sys

import desk.kernel_service.app  # noqa: F401  (registers every adapter the kernel registers)
from desk.contracts import RuleCard, ToolProfile
from desk.kernel_service import activation, compiler


async def prove_set(preset: str, cards: list[RuleCard], profiles: list[ToolProfile],
                    auto_money_cap_cents: int) -> activation.ShippedReport:
    """The report for one shipped set at its money cap. Raises RuntimeError when compiling isn't
    deterministic."""
    cap = auto_money_cap_cents
    schema = compiler.desk_schema(profiles)
    hashes = activation.version_hashes(compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap), schema,
                                       profiles, cards=cards, auto_money_cap_cents=cap)
    again = activation.version_hashes(compiler.compile_cards(list(cards), list(profiles), auto_money_cap_cents=cap),
                                      compiler.desk_schema(profiles), profiles, cards=list(cards),
                                      auto_money_cap_cents=cap)
    if hashes != again:
        raise RuntimeError(f"{preset}: compiling twice gave different hashes")
    proof = await activation.prove(activation.build_proof_inputs(cards, profiles, schema, auto_money_cap_cents=cap))
    return activation.shipped_report(preset, hashes, proof)


def failing_checks(report: activation.ShippedReport) -> str:
    if report.proof.timed_out:
        return "desk-prove timed out or couldn't run"
    return ", ".join(c.name for c in report.proof.checks if not c.ok) or "the report is incomplete"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="prove again and compare with the shipped reports, writing nothing")
    args = parser.parse_args(argv)
    ok = True
    for preset, cards in activation.SHIPPED_PRESETS.items():
        path = activation.PROOFS_DIR / f"{preset}.json"
        report = asyncio.run(prove_set(preset, cards, activation.shipped_profiles(preset),
                                       activation.SHIPPED_CAPS[preset]))
        if not activation.proved(report.proof):           # the kernel's own activation test
            print(f"{preset}: not proved ({failing_checks(report)})", file=sys.stderr)
            ok = False
        elif args.check:
            shipped = path.read_text() if path.exists() else None
            if shipped != activation.report_text(report):
                print(f"{preset}: {path.name} is missing or doesn't match this build; run make proofs",
                      file=sys.stderr)
                ok = False
            else:
                print(f"{preset}: proved, and {path.name} matches")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(activation.report_text(report))
            print(f"{preset}: proved, wrote {path.name}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
