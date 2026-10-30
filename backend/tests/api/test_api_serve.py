"""`make api-serve`, the API process run locally: the deploy's command (Plan 06b's seam), bound to loopback.

A request path can carry a single-use token (`/api/d/<token>`, `/api/pay/<token>`), so the API never runs with
uvicorn's access log, locally as in the deploy image.
"""

import os
import shlex
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
# The deploy's command, with the host it binds locally.
LOCAL_COMMAND = ["uvicorn", "--factory", "desk.api.main:app_factory", "--host", "127.0.0.1", "--port", "8700",
                 "--timeout-keep-alive", "310", "--no-access-log"]


def test_api_serve_runs_uvicorn_without_an_access_log():
    make = shutil.which("make")
    assert make is not None, "make reads the Makefile's api-serve recipe"
    env = {name: value for name, value in os.environ.items() if name not in ("MAKEFLAGS", "MAKELEVEL", "MFLAGS")}
    printed = subprocess.run([make, "--no-print-directory", "-n", "api-serve"], cwd=REPO_ROOT, env=env,
                             capture_output=True, text=True, check=True).stdout   # -n prints the recipe, runs nothing
    words = shlex.split(printed.replace("\\\n", " "))
    assert words[words.index("uvicorn"):] == LOCAL_COMMAND
