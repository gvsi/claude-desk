"""Load the tier 2 suite, its splits and its recorded rates, and hash what the gate compares.

`load_suite(dir)` reads every scenario file once and keeps its bytes, so the hashes cover exactly
what was parsed. YAML is read strictly: a repeated key is an error, never a silent overwrite, so
a file can't drop one of its oracles without failing to load.
"""

import hashlib
from collections import Counter
from collections.abc import Hashable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, ValidationError

from evals.oracles.canonical import sha256_hex
from evals.tier2.schema import RecordedRates, Scenario, ScenarioId

TIER2_DIR = Path(__file__).resolve().parent
EVALS_DIR = TIER2_DIR.parent
REPO_ROOT = EVALS_DIR.parent
SCENARIOS_DIR = TIER2_DIR / "scenarios"
SPLITS_FILE = EVALS_DIR / "splits.yaml"
RECORDED_RATES_FILE = EVALS_DIR / "recorded_rates.json"

SplitName = Literal["calibration", "heldout"]


class _StrictLoader(yaml.SafeLoader):
    """PyYAML's safe loader, refusing a mapping that repeats a key or has an unhashable one."""

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        seen = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, Hashable):
                raise yaml.constructor.ConstructorError(None, None, "unhashable key", key_node.start_mark)
            if key in seen:
                raise yaml.constructor.ConstructorError(
                    None, None, f"repeated key {key!r}", key_node.start_mark,
                )
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


_StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _StrictLoader.construct_mapping)


def read_yaml(raw: bytes, name: str) -> Any:
    """Parse YAML strictly; a syntax error, a repeated key or an unhashable key raises ValueError naming the file."""
    try:
        return yaml.load(raw, Loader=_StrictLoader)   # a SafeLoader subclass: no Python objects
    except yaml.YAMLError as error:
        raise ValueError(f"{name}: {error}") from None


@dataclass(frozen=True)
class Suite:
    """Every scenario in a directory, by id in id order, with each file's bytes."""

    scenarios: dict[str, Scenario]
    sources: dict[str, bytes]


def load_suite(directory: Path = SCENARIOS_DIR) -> Suite:
    """The scenarios in `directory`. A file that doesn't parse, an id that isn't its file name, a
    file that isn't `.yaml` or an empty directory raises ValueError, so nothing is skipped silently."""
    if not directory.is_dir():
        raise ValueError(f"{directory} is not a directory of tier 2 scenarios")
    scenarios: dict[str, Scenario] = {}
    sources: dict[str, bytes] = {}
    for path in sorted(directory.iterdir()):
        if path.name.startswith("."):
            continue
        if path.suffix != ".yaml" or not path.is_file():
            raise ValueError(f"{path.name}: the scenarios directory holds only .yaml scenario files")
        raw = path.read_bytes()
        data = read_yaml(raw, path.name)
        try:
            scenario = Scenario.model_validate(data)
        except ValidationError as error:
            raise ValueError(f"{path.name}: {error}") from None
        if scenario.id != path.stem:
            raise ValueError(f"{path.name}: its id is {scenario.id}; a scenario file is named by its id")
        scenarios[scenario.id] = scenario
        sources[scenario.id] = raw
    if not scenarios:
        raise ValueError(f"{directory} holds no tier 2 scenarios")
    return Suite(scenarios=dict(sorted(scenarios.items())), sources=dict(sorted(sources.items())))


# Splits

class _SplitsFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    calibration: list[ScenarioId]
    heldout: list[ScenarioId]


@dataclass(frozen=True)
class Splits:
    """`splits.yaml`: the calibration ids (which set the reviewer thresholds) and the held-out ids
    (which the gate and the report judge), with the file's bytes for the hashes."""

    calibration: tuple[str, ...]
    heldout: tuple[str, ...]
    source: bytes

    def split_of(self, scenario_id: str) -> SplitName | None:
        """The split a scenario is in; when `split_problems` finds none, exactly one."""
        if scenario_id in self.heldout:
            return "heldout"
        if scenario_id in self.calibration:
            return "calibration"
        return None


def load_splits(path: Path = SPLITS_FILE) -> Splits:
    """The splits file; a malformed file raises ValueError. Whether it matches a suite is `split_problems`."""
    raw = path.read_bytes()
    try:
        lists = _SplitsFile.model_validate(read_yaml(raw, path.name))
    except ValidationError as error:
        raise ValueError(f"{path.name}: {error}") from None
    return Splits(calibration=tuple(lists.calibration), heldout=tuple(lists.heldout), source=raw)


def split_problems(suite: Suite, splits: Splits) -> list[str]:
    """Why the splits don't put every scenario in exactly one split, one line each; empty when they do."""
    problems = []
    for sid in suite.scenarios:
        listed = [name for name in ("calibration", "heldout") if sid in getattr(splits, name)]
        if not listed:
            problems.append(f"{sid} is in no split")
        elif len(listed) == 2:
            problems.append(f"{sid} is in both splits")
    for name in ("calibration", "heldout"):
        ids = getattr(splits, name)
        problems += [f"{sid} is listed twice in {name}" for sid, n in Counter(ids).items() if n > 1]
        problems += [f"{sid} is in {name} but has no scenario file" for sid in dict.fromkeys(ids)
                     if sid not in suite.scenarios]
    return problems


# Recorded rates

def load_recorded_rates(path: Path = RECORDED_RATES_FILE) -> RecordedRates:
    """`recorded_rates.json`; a malformed file raises ValueError naming it."""
    try:
        return RecordedRates.model_validate_json(path.read_bytes())
    except ValidationError as error:
        raise ValueError(f"{path.name}: {error}") from None


# Hashes

def heldout_sha256(suite: Suite, splits: Splits) -> str:
    """The held-out set's hash: the sorted held-out ids with each file's sha256, and splits.yaml's.
    The gate compares a run with the recorded rate only when this hash matches the one recorded."""
    _require_consistent(suite, splits)
    return sha256_hex({
        "heldout": {sid: _sha256(suite.sources[sid]) for sid in sorted(splits.heldout)},
        "splits": _sha256(splits.source),
    })


def suite_sha256(suite: Suite, splits: Splits) -> str:
    """The whole suite's hash: every scenario file's sha256 by id, and splits.yaml's."""
    _require_consistent(suite, splits)
    return sha256_hex({
        "scenarios": {sid: _sha256(suite.sources[sid]) for sid in sorted(suite.scenarios)},
        "splits": _sha256(splits.source),
    })


def _require_consistent(suite: Suite, splits: Splits) -> None:
    if problems := split_problems(suite, splits):
        raise ValueError("the splits don't put every scenario in exactly one split: " + "; ".join(problems))


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()
