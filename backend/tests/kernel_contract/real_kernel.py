"""`make kernel-contract`: the contract suite's real-kernel variants, for the kernel plans that have landed.

Run as `cd backend && uv run python -m tests.kernel_contract.real_kernel`. It reads the kernel ids (those
starting `01`) from `evals/tier1/landed.toml`; with none, it prints "no kernel plan landed" and exits 0.
Otherwise it starts `make kernel-serve` in a process group of its own, waits up to 30 s for
`http://127.0.0.1:8701/health`, runs `pytest tests/kernel_contract -m real_kernel -q` with
`DESK_KERNEL_URL` and `DESK_KERNEL_PLANS` set, stops the kernel's whole process group and exits with
pytest's status. A kernel already answering on the port is refused rather than tested, since it may be
another checkout's.
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

REPO_ROOT = Path(__file__).resolve().parents[3]
LANDED = REPO_ROOT / "evals" / "tier1" / "landed.toml"
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


def _healthy() -> bool:
    try:
        return httpx.get(f"{KERNEL_URL}/health", timeout=1.0).status_code == 200
    except httpx.HTTPError:
        return False


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
    if _healthy():
        print(f"kernel-contract: a kernel already answers at {KERNEL_URL}; stop it first", file=sys.stderr)
        return 1
    with tempfile.NamedTemporaryFile("w+", prefix="kernel-contract-", suffix=".log") as log:
        kernel = subprocess.Popen(["make", "kernel-serve"], cwd=REPO_ROOT, stdout=log, stderr=subprocess.STDOUT,
                                  start_new_session=True)
        try:
            deadline = time.monotonic() + STARTUP_S
            while not _healthy():
                if kernel.poll() is not None or time.monotonic() > deadline:
                    log.seek(0)
                    why = "exited" if kernel.poll() is not None else f"didn't answer within {STARTUP_S:.0f} s"
                    print(f"kernel-contract: the kernel {why} ({KERNEL_URL}/health); its output:", file=sys.stderr)
                    print(log.read()[-4000:], file=sys.stderr)
                    return 1
                time.sleep(0.5)
            env = {**os.environ, "DESK_KERNEL_URL": KERNEL_URL, "DESK_KERNEL_PLANS": ",".join(plans)}
            print(f"kernel-contract: real kernel, plans {', '.join(plans)}")
            return subprocess.run([sys.executable, "-m", "pytest", "tests/kernel_contract", "-m", "real_kernel", "-q"],
                                  cwd=REPO_ROOT / "backend", env=env).returncode
        finally:
            _stop(kernel)


if __name__ == "__main__":
    sys.exit(main())
