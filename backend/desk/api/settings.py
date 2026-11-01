"""The API process's settings, read once at startup.

Plan 06b's runtime seam sets them: `DESK_ENV`, `API_DATABASE_URL`, `ANTHROPIC_API_KEY`,
`PASSCODE_HASH`, `KERNEL_URL`, `PUBLIC_ORIGIN` and `TRUSTED_PROXY_HOPS`. `ANTHROPIC_BASE_URL` is a
test hook that points the model client at a fake server. `a2a_loopback`, `kernel_ro_schema` and
`replay_night` are not read from the environment; tests override them with `dataclasses.replace`,
which checks the result again, and the evals' `make_api_target` builds `Settings` directly, never
through `Settings.from_env`. `replay_night` asks the kernel to replay the recorded night into each
new demo copy (Plan 01d); it is on for the hosted app and off for the evals target, and the kernel's
`REPLAY_NIGHT_OFF=1` is the switch that turns replay off.

The model provider (`MODEL_PROVIDER`) is the Claude API (`anthropic`, the default) or, for local
evals, Amazon Bedrock (`bedrock`) in `AWS_REGION` with the one Bedrock credential the API ever
holds: a short-term Bedrock API key in `BEDROCK_BEARER_TOKEN`, a name the SDK never reads.
The SDK's own key variables (`AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_AWS_API_KEY`) are never used
as a credential, and `AWS_REGION` is read only for Bedrock, so ECS setting it changes nothing.

Outside a development `DESK_ENV` (`desk.env`) the process is in production: the key, the passcode
hash and an `https://` public origin are required, and the test hook is refused. Production also
refuses `bedrock` and any Bedrock key in the environment, so the hosted API never holds a Bedrock
credential or builds a Bedrock client. Errors name the variable, never its value, and `repr`
leaves the secrets out.

`BUSINESS_TOOLS_ENABLED=1` allows setup's proposal cards to carry configurations once the kernel's
business-tool blocks are deployed. It is off by default; setup still proposes the jobs in words.
`SETUP_POLICY_CLAIMS_ENABLED=0` stops setup publishing business policy claims in the charter.
It is on by default; turning it off leaves setup's answers and other Desk parts unchanged.
"""

import os
from dataclasses import dataclass, field
from typing import Self
from urllib.parse import urlsplit

from desk.db.session import database_url
from desk.env import is_development

PROVIDERS = ("anthropic", "bedrock")
# The SDK's own Bedrock key variables: never a credential here, and refused in production.
SDK_BEDROCK_KEYS = ("AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_AWS_API_KEY")


def _env(name: str) -> str | None:
    """A variable's value, with an empty one counted as unset."""
    return os.environ.get(name) or None


def _origin_error(origin: str, *, https_only: bool) -> str | None:
    """Why `origin` is not a scheme and host with nothing after them, or None when it is."""
    parts = urlsplit(origin)
    schemes = ("https",) if https_only else ("http", "https")
    if parts.scheme not in schemes:
        return "an https:// origin" if https_only else "an http:// or https:// origin"
    if not parts.hostname or parts.username is not None or parts.password is not None:
        return "an origin with a host and no user"
    if parts.path or parts.query or parts.fragment or origin.endswith(("?", "#")):
        return "an origin with no path"
    return None


@dataclass(frozen=True, kw_only=True)
class Settings:
    api_database_url: str = field(repr=False)
    desk_env: str = ""
    anthropic_api_key: str | None = field(default=None, repr=False)
    passcode_hash: str | None = field(default=None, repr=False)
    kernel_url: str = "http://127.0.0.1:8701"
    public_origin: str = "http://localhost:5173"
    trusted_proxy_hops: int = 0
    anthropic_base_url: str | None = None   # tests only
    model_provider: str = "anthropic"
    aws_region: str = "us-west-2"           # read only for bedrock
    bedrock_bearer_token: str | None = field(default=None, repr=False)   # local Bedrock evals only
    a2a_loopback: str = "http://127.0.0.1:8700"
    kernel_ro_schema: str = "kernel_ro"
    replay_night: bool = True               # each new copy asks for the recorded night; never from the environment
    business_tools_enabled: bool = False   # enable configurations only once the kernel's blocks are deployed
    setup_policy_claims_enabled: bool = True   # runtime switch for publishing setup's policy claims

    @property
    def production(self) -> bool:
        return not is_development(self.desk_env)

    def __post_init__(self) -> None:
        if type(self.trusted_proxy_hops) is not int or self.trusted_proxy_hops < 0:
            raise RuntimeError("TRUSTED_PROXY_HOPS must be a whole number, 0 or more")
        kernel = urlsplit(self.kernel_url)
        if kernel.scheme not in ("http", "https") or not kernel.hostname:
            raise RuntimeError("KERNEL_URL must be an http:// URL")
        if why := _origin_error(self.public_origin, https_only=self.production):
            raise RuntimeError(f"PUBLIC_ORIGIN must be {why}")
        if self.model_provider not in PROVIDERS:
            raise ValueError(f"MODEL_PROVIDER must be one of {', '.join(PROVIDERS)}")
        if self.production:
            for name, value in (("ANTHROPIC_API_KEY", self.anthropic_api_key), ("PASSCODE_HASH", self.passcode_hash)):
                if not value:
                    raise RuntimeError(f"{name} is not set")
            if self.anthropic_base_url is not None:
                raise RuntimeError("ANTHROPIC_BASE_URL is a test hook; production refuses it")
            if self.model_provider != "anthropic":
                raise RuntimeError("MODEL_PROVIDER names a provider for local evals; production runs on the Claude API")
            if self.bedrock_bearer_token:
                raise RuntimeError("BEDROCK_BEARER_TOKEN is set; production holds no Bedrock credential")

    @classmethod
    def from_env(cls) -> Self:
        """The settings in the process environment; raises RuntimeError naming what is missing or invalid."""
        desk_env = os.environ.get("DESK_ENV", "")
        hops = _env("TRUSTED_PROXY_HOPS") or "0"
        if not (hops.isascii() and hops.isdigit()):
            raise RuntimeError("TRUSTED_PROXY_HOPS must be a whole number, 0 or more")
        public_origin = _env("PUBLIC_ORIGIN")
        if public_origin is None and not is_development(desk_env):
            raise RuntimeError("PUBLIC_ORIGIN is not set")
        if public_origin is not None and public_origin.endswith("/") and not public_origin.endswith("//"):
            public_origin = public_origin[:-1]   # "https://host/" names the same origin as "https://host"
        if not is_development(desk_env):
            for name in SDK_BEDROCK_KEYS:
                if _env(name) is not None:
                    raise RuntimeError(f"{name} is set; production holds no Bedrock credential")
        model_provider = _env("MODEL_PROVIDER") or cls.model_provider
        return cls(
            desk_env=desk_env,
            api_database_url=database_url("API"),
            anthropic_api_key=_env("ANTHROPIC_API_KEY"),
            passcode_hash=_env("PASSCODE_HASH"),
            kernel_url=_env("KERNEL_URL") or cls.kernel_url,
            public_origin=public_origin or cls.public_origin,
            trusted_proxy_hops=int(hops),
            anthropic_base_url=_env("ANTHROPIC_BASE_URL"),
            model_provider=model_provider,
            aws_region=(_env("AWS_REGION") or cls.aws_region) if model_provider == "bedrock" else cls.aws_region,
            bedrock_bearer_token=_env("BEDROCK_BEARER_TOKEN"),
            business_tools_enabled=_env("BUSINESS_TOOLS_ENABLED") == "1",
            setup_policy_claims_enabled=_env("SETUP_POLICY_CLAIMS_ENABLED") != "0",
        )
