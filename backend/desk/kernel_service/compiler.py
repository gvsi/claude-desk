"""The Cedar inputs every Desk shares, and (from Task 6) the rule-card compiler.

Everything here loads from `CEDAR_DIR`, found from this file's path and never from the working
directory, so the kernel reads the same files from a test, the repo root or the image
(`/app/kernel/cedar`):

- `BASE_SCHEMA`: the master plan's "Cedar request shape" with one action per native tool, each a
  member of its effect groups (`effect:*`), which every Desk's schema starts from.
- `BASELINE`: set `B`, the always-on forbids, which `PolicyEngine(BASELINE)` adds to every
  evaluation.
- `INVARIANTS`: the proof spec sets `desk-prove` checks every activation against
  (`invariants/always/` for `baseline_auto` and `baseline_approvable`, `invariants/auto/` for
  `baseline_auto`), by kind and file name.

The hashes name what a proof covered, so a report proved for other inputs is never reused.
"""

import copy
import hashlib
import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Literal

import desk_kernel

from desk.contracts import ToolProfile

CEDAR_DIR = Path(__file__).resolve().parents[3] / "kernel" / "cedar"

BASE_SCHEMA: dict[str, Any] = json.loads((CEDAR_DIR / "schema.cedarschema.json").read_bytes())
_BASELINE_BYTES = (CEDAR_DIR / "baseline.cedar").read_bytes()
BASELINE: str = _BASELINE_BYTES.decode("utf-8")


def _invariant_files(kind: str) -> dict[str, bytes]:
    files = {path.stem: path.read_bytes() for path in sorted((CEDAR_DIR / "invariants" / kind).glob("*.cedar"))}
    if not files:
        # desk-prove would refuse an empty list anyway; a kernel without invariants doesn't start
        raise RuntimeError(f"no invariants in {CEDAR_DIR / 'invariants' / kind}")
    return files


_INVARIANT_BYTES: dict[Literal["always", "auto"], dict[str, bytes]] = {
    "always": _invariant_files("always"),
    "auto": _invariant_files("auto"),
}
INVARIANTS: dict[Literal["always", "auto"], dict[str, str]] = {
    kind: {name: data.decode("utf-8") for name, data in files.items()} for kind, files in _INVARIANT_BYTES.items()
}


def _sha256_canonical(value: Any) -> str:
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(value)).encode()).hexdigest()


def desk_schema(profiles: Iterable[ToolProfile]) -> dict[str, Any]:
    """The Cedar schema for a Desk with these tool profiles: a fresh copy of the base schema,
    which declares every native tool. MCP actions are appended by Plan 01c; until then an MCP
    profile is refused rather than left out of the schema without a word."""
    for profile in profiles:
        if profile.source != "native":
            raise ValueError(f"{profile.tool}: MCP actions aren't in the schema yet")
    return copy.deepcopy(BASE_SCHEMA)


def schema_sha256(schema: dict[str, Any]) -> str:
    """sha256 of `canonical_json(schema)`."""
    return _sha256_canonical(schema)


def baseline_sha256() -> str:
    """sha256 of the baseline file's bytes, the text `BASELINE` holds."""
    return hashlib.sha256(_BASELINE_BYTES).hexdigest()


def invariants_sha256(checks: Iterable[str]) -> str:
    """sha256 of `canonical_json({files: {"<kind>/<name>.cedar": sha256 of its bytes}, checks,
    prove_version: desk_kernel.version()})`, the check names sorted. A changed invariant file,
    check list or prover makes every earlier report stale."""
    names = list(checks)
    if len(set(names)) != len(names):
        raise ValueError("each check is named once")
    files = {f"{kind}/{name}.cedar": hashlib.sha256(data).hexdigest()
             for kind, by_name in _INVARIANT_BYTES.items() for name, data in by_name.items()}
    return _sha256_canonical({"files": files, "checks": sorted(names), "prove_version": desk_kernel.version()})
