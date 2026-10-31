"""The API target for the evals: `make_api_target`, the API process over a running kernel target.

`load_api_target()` (`targets.py`) imports this module only when a case asks for the `api` fixture,
and tier 2's runner the same way, so collecting tier 1 imports no API code. `make_api_target(kernel,
models=..., provider=...)` gives an `ApiTarget` whose `start()` serves the API's `create_app` under
uvicorn on a free 127.0.0.1 port, in this process, on the kernel target's clock, its lifespan
running the database pools, the run events listener and the job worker until `stop()`. The kernel
target's fake model server and records are the API's too.

The API's settings are built here (`target_settings`), never read from the environment, so what a
shell exports changes nothing:

- `models="fake"` (tier 1, and tier 2's dry runs): the Claude API client at the kernel target's
  fake model server (`ANTHROPIC_BASE_URL` at `kernel.fake.url`) with the dummy key,
  `DESK_ENV=test` and `MODEL_PROVIDER=anthropic`, whatever the environment or `provider` says, so
  scripted models are never bypassed.
- `models="real"` (tier 2): `DESK_ENV=dev` and `MODEL_PROVIDER=<provider>` with that provider's
  credential from the repository's `.env`, else the environment, as the kernel target reads its
  key: `ANTHROPIC_API_KEY` on `anthropic`; on `bedrock`, `BEDROCK_BEARER_TOKEN` (the API's one
  Bedrock credential) and `AWS_REGION`. A tier 1 process, which refused real models, refuses it.

Either way `KERNEL_URL` is the kernel target's, `PASSCODE_HASH` the hash of a fresh passcode the
target keeps in `passcode` (the app holds only the hash), `a2a_loopback` the target's own base
URL, so the built-in agent's A2A calls reach this app, and `replay_night` is false, so eval copies
never replay the recorded night (Plan 01d). Errors name a variable, never its value.

The job queue is the database's, shared by every case, so a triage or translation job one case
left waiting would run in the next case's worker, against that case's fake model. `start()`
cancels every annotation job waiting before its worker runs, and `stop()` every one still waiting
once its worker stopped (`cancel_waiting_annotations`); the resume queue's jobs are left as they
are.

The served app also answers `GET /openapi.json` with its own OpenAPI document (`serve_openapi`),
which Plan 05a's conformance case compares with the committed export. Only this target adds it:
the app production runs (`create_app`, `app_factory`) serves no OpenAPI document.
"""

import asyncio
import errno
import os
import secrets
import socket
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from desk.api.jobs import ANNOTATION_QUEUE, jobs_app
from desk.api.main import create_app
from desk.api.passcode import hash_passcode
from desk.api.settings import PROVIDERS, Settings
from desk.db.session import database_url, procrastinate_connector
from evals.fakes import LoopbackServer
from evals.tier1 import targets
from evals.tier1.targets import DUMMY_KEY, REPO_ROOT, KernelTarget, TargetError

__all__ = ["DeskApiTarget", "cancel_waiting_annotations", "make_api_target", "serve_openapi", "target_settings"]

ENV_FILE = REPO_ROOT / ".env"
MODELS = ("fake", "real")
START_TRIES = 3   # tries at a free port, for one another process took after `_free_port` freed it


def make_api_target(
    kernel: KernelTarget,
    *,
    models: Literal["fake", "real"],
    provider: Literal["anthropic", "bedrock"] = "anthropic",
) -> "DeskApiTarget":
    """The API over the started `kernel`, not yet running: `await target.start()` serves it."""
    return DeskApiTarget(kernel, models=models, provider=provider)


def target_settings(
    kernel: Any,
    *,
    models: str,
    provider: str,
    passcode_hash: str,
    base_url: str,
    api_dsn: str,
    env_file: Path = ENV_FILE,
) -> Settings:
    """The API's settings over the started `kernel` (its `url`, and with fake models its fake model
    server's), for an app served at `base_url`: from the arguments alone and, with real models, the
    provider's credential (the module docstring)."""
    _check(models, provider)
    if not kernel.url:
        raise TargetError("the API runs over a running kernel: start() the kernel target first")
    common: dict[str, Any] = {"api_database_url": api_dsn, "passcode_hash": passcode_hash, "kernel_url": kernel.url,
                              "a2a_loopback": base_url, "replay_night": False}
    if models == "fake":
        if kernel.fake is None:
            raise TargetError("an API target with fake models needs the kernel target's fake model server: "
                              "KernelTarget(models='fake')")
        return Settings(**common, desk_env="test", model_provider="anthropic", anthropic_api_key=DUMMY_KEY,
                        anthropic_base_url=kernel.fake.url)
    if provider == "anthropic":
        key = _credential("ANTHROPIC_API_KEY", env_file)
        if key is None or key == DUMMY_KEY:
            raise TargetError("an API target with real models on the Claude API needs ANTHROPIC_API_KEY in the "
                              "repository's .env")
        return Settings(**common, desk_env="dev", model_provider="anthropic", anthropic_api_key=key)
    token = _credential("BEDROCK_BEARER_TOKEN", env_file)
    if token is None:
        raise TargetError("an API target with real models on Amazon Bedrock needs BEDROCK_BEARER_TOKEN in the "
                          "repository's .env")
    region = _credential("AWS_REGION", env_file) or Settings.aws_region
    return Settings(**common, desk_env="dev", model_provider="bedrock", aws_region=region,
                    bedrock_bearer_token=token)


class DeskApiTarget:
    """The API process as an `ApiTarget` (the module docstring). Once started, `settings` and `app`
    are the running app's, for cases that check how it was built."""

    def __init__(self, kernel: KernelTarget, *, models: str, provider: str = "anthropic",
                 env_file: Path = ENV_FILE):
        _check(models, provider)
        # The flag `refuse_real_models()` sets for a tier 1 process, read as KernelTarget reads it.
        if models == "real" and targets._real_models_refused:
            raise TargetError("tier 1 makes no model calls: make_api_target(models='real') is tier 2's")
        self.kernel, self.models, self.provider = kernel, models, provider
        self.passcode = secrets.token_urlsafe(24)
        self.api_dsn = database_url("API")
        self.base_url = ""
        self.settings: Settings | None = None
        self.app: FastAPI | None = None
        self._passcode_hash = hash_passcode(self.passcode)
        self._env_file = env_file
        self._server: LoopbackServer | None = None

    async def start(self) -> "DeskApiTarget":
        """Serve the app on a free loopback port, its lifespan started; a start that fails leaves
        nothing running. The port is free when chosen but bound only once the app is built, so a
        port another process took meanwhile is tried again on a fresh one (`START_TRIES` in all)."""
        if self._server is not None:
            raise TargetError("the API target is already running")
        await cancel_waiting_annotations(self.api_dsn)       # none an earlier case left runs in this one
        for tried in range(1, START_TRIES + 1):
            port = _free_port()
            base_url = f"http://127.0.0.1:{port}"
            settings = target_settings(self.kernel, models=self.models, provider=self.provider,
                                       passcode_hash=self._passcode_hash, base_url=base_url, api_dsn=self.api_dsn,
                                       env_file=self._env_file)
            app = serve_openapi(create_app(settings, clock=self.kernel.clock.now))
            server = LoopbackServer(app, port=port, name="API")
            try:
                await asyncio.to_thread(server.start)
            except OSError as error:
                # The server didn't start, so its lifespan, which closes the model client create_app
                # built, didn't run (or already closed it, after a startup timeout): close it here.
                await app.state.runtime.model.aclose()
                if error.errno != errno.EADDRINUSE or tried == START_TRIES:
                    raise
                continue
            self._server, self.settings, self.app, self.base_url = server, settings, app, base_url
            return self
        raise AssertionError("unreachable: the last try returns or raises")

    async def stop(self) -> None:
        """Stop the app: its lifespan stops the job worker first, then closes the pools and its
        model client. Then the annotation jobs still waiting are cancelled, so none runs in the
        next case."""
        server, self._server = self._server, None
        if server is not None:
            await asyncio.to_thread(server.stop)
            await cancel_waiting_annotations(self.api_dsn)


async def cancel_waiting_annotations(api_dsn: str) -> int:
    """Cancel every triage and translation job waiting (`todo`) in the job queue at `api_dsn`, as
    the API's role, with Procrastinate's own cancel; how many it cancelled. A job a worker is
    running is left to it."""
    queue = jobs_app(procrastinate_connector(api_dsn), schedule=False)
    async with queue.open_async():
        waiting = await queue.job_manager.list_jobs_async(queue=ANNOTATION_QUEUE, status="todo")
        return sum([await queue.job_manager.cancel_job_by_id_async(job.id) for job in waiting])


def serve_openapi(app: FastAPI) -> FastAPI:
    """`app`, also answering `GET /openapi.json` with its own OpenAPI document (left out of the
    document itself), for the evals' conformance case: `create_app` serves none."""

    async def openapi() -> JSONResponse:
        return JSONResponse(app.openapi())

    app.add_api_route("/openapi.json", openapi, methods=["GET"], include_in_schema=False)
    return app


def _check(models: str, provider: str) -> None:
    if models not in MODELS:
        raise ValueError(f"models is 'fake' or 'real', not {models!r}")
    if provider not in PROVIDERS:
        raise ValueError(f"provider is 'anthropic' or 'bedrock', not {provider!r}")


def _credential(name: str, env_file: Path) -> str | None:
    """`name` from `env_file`, else the environment, read with the kernel target's reader; an empty
    value is unset. Nothing read is printed."""
    return targets._dotenv(env_file).get(name) or os.environ.get(name) or None


def _free_port() -> int:
    """A free loopback port, taken before the app is built so that its `a2a_loopback` names it; the
    server binds it again once the app is built, and `start` tries again if another process took it
    in between."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
