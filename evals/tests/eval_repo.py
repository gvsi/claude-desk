"""A throwaway git repository laid out like this one, for the pass runner's and the results check's tests.

It holds what a pass and `results-check` read: tier 2 scenarios, `splits.yaml`, `landed.toml`,
`recorded_rates.json`, `budget.toml`, a file under each gated path, and files outside the key (the
rest of the Desk's code, its database, migrations and dependencies, the harness plumbing, scripts,
tests, the command line, the gate and the results check), so a test can commit a change to any of
them and see what moves.
"""

import json
import subprocess
from pathlib import Path
from typing import Any

import yaml

from evals.tier1.harness import PLANS

ATTACK: dict[str, Any] = {
    "suite": "attack", "category": "money", "language": "en", "visitor": "visitor", "requires": ["01a", "02"],
    "persona": "A crafted attacker.", "goal": "A crafted goal.", "targets": ["native.quote"],
    "assumptions": ["demo_inbox_out_of_reach"],
}
LEGIT: dict[str, Any] = {
    "suite": "legit", "category": "quote", "language": "en", "visitor": "visitor", "requires": ["01a", "02"],
    "persona": "A crafted customer.", "goal": "A crafted goal.", "require": [{"card": "quote"}],
    "expected_outcomes": {"native.quote": "allow"},
}
# The default suite: one attack and one legitimate task in each split.
SPLITS = {"calibration": ["atk-cal", "leg-cal"], "heldout": ["atk-held", "leg-held"]}
OTHER_FILES = {
    "kernel/src/lib.rs": "// the kernel\n",
    "backend/desk/kernel_service/app.py": "# the kernel service\n",
    "backend/desk/api/setup_templates.py": "# setup templates\n",
    "backend/desk/api/prompts.py": "# prompts\n",
    "backend/desk/money_cap.py": "# money cap\n",
    "backend/desk/presets.py": "# presets\n",
    "backend/desk/rewrites.py": "# the violations a rewrite can fix\n",
    "backend/desk/next_steps.py": "# fixed session next steps\n",
    "backend/desk/contracts.py": "# contracts\n",
    "backend/desk/kernel_api.py": "# the kernel API\n",
    "backend/desk/mockpay/server.py": "# the mock payments server\n",
    "backend/desk/api/tools.py": "# the API's tool calls\n",
    "backend/desk/api/deliver.py": "# reply delivery\n",
    "backend/desk/api/loop.py": "# the agent loop\n",
    "backend/desk/api/kernel_client.py": "# the kernel client\n",
    "backend/desk/db/roles.sql": "-- the database roles and grants\n",
    "backend/alembic/versions/0001_core.py": "revision = '0001_core'\ndown_revision = None\n",
    "evals/oracles/markers.py": "# an oracle\n",
    "evals/tier2/verdict.py": "# the verdict\n",
    "evals/tier2/schema.py": "# the scenario schema\n",
    "evals/tier2/runner.py": "# the runner\n",
    "evals/tier2/suite.py": "# the suite loader\n",
    "evals/tier2/prompts.py": "# the simulator's prompts\n",
    "evals/tier2/simulator.py": "# the simulator\n",
    "evals/records.py": "# the records reader\n",
    "evals/client.py": "# the Desk client\n",
    "backend/desk/api/store.py": "# the store and its untrusted-text wrapper\n",
    "backend/desk/api/model.py": "# the conversation model, effort and thinking\n",
    "backend/desk/api/routes/public.py": "# the visitor's endpoints\n",
    "backend/desk/api/sse.py": "# the visitor's event stream\n",
    "backend/desk/events.py": "# the SSE and A2A events\n",
    "backend/pyproject.toml": "# the backend's dependencies\n",
    "backend/uv.lock": "# the backend's locked dependency versions\n",
    "backend/alembic.ini": "# the migrations' configuration\n",
    "evals/tier2/artifact.py": "# what a run leaves to be judged\n",
    "evals/tier2/passes.py": "# the pass runner\n",
    "evals/routes.py": "# the routes the Desk client calls\n",
    "evals/tier1/api_impl.py": "# the in-process API a pass runs on\n",
    "evals/tier1/targets.py": "# the kernel target a pass starts\n",
    "evals/tier1/harness.py": "# the tier 1 harness\n",
    "evals/fakes/anthropic_server.py": "# the loopback server\n",
    "backend/desk/ops/admin.py": "# the deploy's admin task\n",
    "backend/desk/ops/entrypoint.py": "# the container entrypoint\n",
    "backend/scripts/export_openapi.py": "# a script\n",
    "backend/tests/api/test_store.py": "# a backend test\n",
    "evals/tests/test_results.py": "# an evals test\n",
    "evals/tier1/test_sessions.py": "# a tier 1 test\n",
    "evals/run.py": "# the command line\n",
    "evals/gate.py": "# the gate\n",
    "evals/results.py": "# the results check\n",
    "evals/reports/README.md": "How to read a report.\n",
    "evals/budget.toml": "monthly_limit_usd = 1000\ndemo_reserve_usd = 400\n",
    "README.md": "A repository.\n",
    ".gitignore": "evals/out/\n/*.csv\n",
}


def git(root: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)
    return done.stdout.strip()


def scenario_yaml(scenario_id: str, **changes: Any) -> str:
    base = ATTACK if scenario_id.startswith("atk-") else LEGIT
    return yaml.safe_dump({"id": scenario_id, **base, **changes}, sort_keys=False)


def write(root: Path, path: str, text: str) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def make_repo(root: Path, *, splits: dict[str, list[str]] | None = None, landed: tuple[str, ...] = PLANS,
              scenarios: dict[str, dict[str, Any]] | None = None) -> Path:
    """A committed repository at `root` with the default suite (or `splits`' ids, each a crafted
    scenario with `scenarios`' changes), `landed` plans and an empty rate history."""
    splits = splits or SPLITS
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "evals@example.invalid")
    git(root, "config", "user.name", "Evals")
    git(root, "config", "commit.gpgsign", "false")
    for path, text in OTHER_FILES.items():
        write(root, path, text)
    for sid in [*splits["calibration"], *splits["heldout"]]:
        write(root, f"evals/tier2/scenarios/{sid}.yaml", scenario_yaml(sid, **(scenarios or {}).get(sid, {})))
    write(root, "evals/splits.yaml", yaml.safe_dump(splits, sort_keys=False))
    set_landed(root, landed)
    write(root, "evals/recorded_rates.json", json.dumps({"history": []}) + "\n")
    commit(root, "the eval layout")
    return root


def set_landed(root: Path, landed: tuple[str, ...]) -> None:
    write(root, "evals/tier1/landed.toml", "plans = [" + ", ".join(f'"{p}"' for p in landed) + "]\n")


def commit(root: Path, message: str) -> str:
    git(root, "add", "-A")
    git(root, "commit", "-q", "--allow-empty", "-m", message)
    return git(root, "rev-parse", "HEAD")
