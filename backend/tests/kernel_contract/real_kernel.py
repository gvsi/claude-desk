"""`make kernel-contract`: the contract suite's real-kernel variants, for the kernel plans that have landed.

Run as `cd backend && uv run python -m tests.kernel_contract.real_kernel`. It reads the kernel ids (those
starting `01`) from `evals/tier1/landed.toml`; with none, it prints "no kernel plan landed" and exits 0.
Otherwise it starts `make kernel-serve` in a process group of its own, waits up to 30 s for
`http://127.0.0.1:8701/health`, prints the proof mode the kernel reports there, runs
`pytest tests/kernel_contract -m real_kernel -q` with `DESK_KERNEL_URL` and `DESK_KERNEL_PLANS` set, stops
the kernel's whole process group and exits with pytest's status. A kernel already answering on the port is
refused rather than tested, since it may be another checkout's.

The kernel runs with the development test hooks its own tests use, set in its environment only:
`DESK_DECISIONS=offline` (its offline reviewer and soft-promise check, so a reply is judged on its content
rather than handed off for want of a model) and `DESK_PROVE` at the release build of `desk-prove` when it
exists (else unset, and the kernel finds a prover through `PATH` and cvc5 through `CVC5` or `PATH`, or runs
in `bounded` mode). The kernel refuses both outside development, and so does the runner.
"""

import os
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path

import httpx

from desk.env import is_development

REPO_ROOT = Path(__file__).resolve().parents[3]
LANDED = REPO_ROOT / "evals" / "tier1" / "landed.toml"
PROVER = REPO_ROOT / "kernel" / "target" / "release" / "desk-prove"   # `make kernel` builds it
KERNEL_URL = "http://127.0.0.1:8701"
STARTUP_S = 30.0


def landed_kernel_plans(path: Path = LANDED) -> list[str]:
    """The kernel plan ids `landed.toml` lists, in its order; none when the file doesn't exist yet."""
    if not path.is_file():
        return []
    plans = tomllib.loads(path.read_text()).get("plans", [])
    if not isinstance(plans, list) or not all(isinstance(plan, str) for plan in plans):
        raise ValueError(f"{path}: plans is a list of plan ids")
    return [plan for plan in plans if plan.startswith("01")]


def kernel_env() -> dict[str, str]:
    """The kernel's environment: the runner's, with the kernel's development test hooks set in this copy only.
    `DESK_PROVE` names the release `desk-prove` when it is built and is otherwise left out, whatever the runner's
    own environment holds."""
    env = {**os.environ, "DESK_DECISIONS": "offline"}
    env.pop("DESK_PROVE", None)
    if PROVER.is_file():
        env["DESK_PROVE"] = str(PROVER)
    return env


def _health() -> dict | None:
    """`/health`'s body when something answers it with 200 (empty if the body isn't a JSON object), else None."""
    try:
        response = httpx.get(f"{KERNEL_URL}/health", timeout=1.0)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _stop(kernel: subprocess.Popen) -> None:
    if kernel.poll() is not None:
        return
    os.killpg(kernel.pid, signal.SIGTERM)
    try:
        kernel.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(kernel.pid, signal.SIGKILL)
        kernel.wait()


def main() -> int:
    plans = landed_kernel_plans()
    if not plans:
        print("no kernel plan landed")
        return 0
    if not is_development():
        print(f"kernel-contract: the kernel's test hooks run only in development, not DESK_ENV="
              f"{os.environ.get('DESK_ENV')!r}", file=sys.stderr)
        return 1
    if _health() is not None:
        print(f"kernel-contract: a kernel already answers at {KERNEL_URL}; stop it first", file=sys.stderr)
        return 1
    with tempfile.NamedTemporaryFile("w+", prefix="kernel-contract-", suffix=".log") as log:
        kernel = subprocess.Popen(["make", "kernel-serve"], cwd=REPO_ROOT, stdout=log, stderr=subprocess.STDOUT,
                                  start_new_session=True, env=kernel_env())
        try:
            deadline = time.monotonic() + STARTUP_S
            while (health := _health()) is None:
                if kernel.poll() is not None or time.monotonic() > deadline:
                    log.seek(0)
                    why = "exited" if kernel.poll() is not None else f"didn't answer within {STARTUP_S:.0f} s"
                    print(f"kernel-contract: the kernel {why} ({KERNEL_URL}/health); its output:", file=sys.stderr)
                    print(log.read()[-4000:], file=sys.stderr)
                    return 1
                time.sleep(0.5)
            env = {**os.environ, "DESK_KERNEL_URL": KERNEL_URL, "DESK_KERNEL_PLANS": ",".join(plans)}
            print(f"kernel-contract: real kernel, plans {', '.join(plans)}, proof mode {health.get('proof_mode')}")
            return subprocess.run([sys.executable, "-m", "pytest", "tests/kernel_contract", "-m", "real_kernel", "-q"],
                                  cwd=REPO_ROOT / "backend", env=env).returncode
        finally:
            _stop(kernel)


if __name__ == "__main__":
    sys.exit(main())
