"""What the Claude Desk stacks are built from.

Each setting comes from `cdk synth|deploy -c <key>=<value>` or, failing that, the `DESK_<KEY>`
environment variable; an empty value counts as unset. Nothing here is a secret: the domain and
certificate ARN come from the owner's shell (`DESK_DOMAIN_NAME`, `DESK_CERTIFICATE_ARN`), never
the repo.
"""

import os
import re
import warnings
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal, cast
from urllib.parse import urlsplit

from constructs import Construct

REGION = "us-west-2"
COMPUTE_MODES = ("express", "alb")
INFRA_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = INFRA_DIR.parent
DEFAULT_WEB_DIST = REPO_ROOT / "web" / "dist"
# A labelled stand-in page (`<meta name="desk-site" content="placeholder">`) served when the
# stacks are synthesized before the web app is built, so synth never needs a web build.
PLACEHOLDER_SITE = INFRA_DIR / "site-placeholder"
# The API builds every absolute link from PUBLIC_ORIGIN; before the first deploy names the
# distribution there is none, and `.invalid` never resolves.
PENDING_ORIGIN = "https://pending.invalid"

# A fully qualified host name: dot-separated labels of letters, digits and inner hyphens.
_DOMAIN_NAME = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]")
_GIT_SHA = re.compile(r"[0-9a-f]{7,40}")
# CloudFront takes certificates only from ACM in us-east-1, whatever the stacks' region.
_CLOUDFRONT_CERTIFICATE = re.compile(r"arn:aws:acm:us-east-1:\d{12}:certificate/[A-Za-z0-9-]+")


class ConfigError(ValueError):
    """A setting the stacks can't be built from; synth stops before any template is written."""


class ConfigWarning(UserWarning):
    """A setting fell back to a stand-in that is fine for synth and wrong for a real deploy."""


@dataclass(frozen=True)
class DeskConfig:
    """The settings, checked. Keys (`-c <key>=` / `DESK_<KEY>`), defaults first:

    - `compute`: `express` (ECS Express Mode) or `alb` (the fallback behind a VPC origin).
    - `domain_name`, `certificate_arn`: both or neither; the certificate in us-east-1.
    - `public_origin`: `https://<domain_name>`, else the given https origin, else `PENDING_ORIGIN`.
    - `image_dir`, `image_file`, `kernel_image`: the repo root, `infra/app.Dockerfile`, `desk-kernel:dev`.
    - `web_dist`: the web build to serve; `placeholder_site` (derived) says it is the placeholder.
    - `git_sha`: the deployed commit (deploy.sh passes HEAD), else `unset`.
    """

    compute: Literal["express", "alb"]
    domain_name: str | None
    certificate_arn: str | None
    public_origin: str
    image_dir: Path
    image_file: str
    kernel_image: str
    web_dist: Path
    placeholder_site: bool
    git_sha: str
    region: str = REGION

    @classmethod
    def from_app(cls, app: Construct, environ: Mapping[str, str] | None = None) -> "DeskConfig":
        environ = os.environ if environ is None else environ

        def setting(key: str) -> str | None:
            value = app.node.try_get_context(key)
            if value is None or value == "":
                value = environ.get(f"DESK_{key.upper()}") or None
            return None if value is None else str(value)

        compute = setting("compute") or "express"
        if compute not in COMPUTE_MODES:
            raise ConfigError("compute must be express or alb")

        domain_name, certificate_arn = setting("domain_name"), setting("certificate_arn")
        if (domain_name is None) != (certificate_arn is None):
            raise ConfigError("domain_name and certificate_arn come together: set both or neither")
        if domain_name is not None:
            domain_name = domain_name.lower()
            if not _DOMAIN_NAME.fullmatch(domain_name):
                raise ConfigError("domain_name must be a bare host name such as desk.example.com")
        if certificate_arn is not None and not _CLOUDFRONT_CERTIFICATE.fullmatch(certificate_arn):
            raise ConfigError(
                "certificate_arn must be an ACM certificate in us-east-1 "
                "(arn:aws:acm:us-east-1:<account>:certificate/<id>), the only region CloudFront reads"
            )

        image_dir = Path(setting("image_dir") or REPO_ROOT).resolve()
        image_file = setting("image_file") or "infra/app.Dockerfile"
        _check_image(image_dir, image_file)

        git_sha = setting("git_sha") or "unset"
        if git_sha != "unset" and not _GIT_SHA.fullmatch(git_sha):
            raise ConfigError("git_sha must be a commit hash (deploy.sh passes HEAD)")

        web_dist, placeholder_site = _web_dist(setting("web_dist"))

        return cls(
            compute=cast(Literal["express", "alb"], compute),
            domain_name=domain_name,
            certificate_arn=certificate_arn,
            public_origin=_public_origin(domain_name, setting("public_origin")),
            image_dir=image_dir,
            image_file=image_file,
            kernel_image=setting("kernel_image") or "desk-kernel:dev",
            web_dist=web_dist,
            placeholder_site=placeholder_site,
            git_sha=git_sha,
        )


def _check_image(image_dir: Path, image_file: str) -> None:
    """The Dockerfile is a relative path inside the build context, and exists."""
    path = PurePosixPath(image_file)
    if path.is_absolute() or ".." in path.parts or not (image_dir / path).is_file():
        raise ConfigError(f"image_file {image_file} must be a Dockerfile inside image_dir {image_dir}")


def _public_origin(domain_name: str | None, value: str | None) -> str:
    """`https://<domain_name>` with a custom domain, else the given origin (deploy.sh passes the
    distribution's PublicUrl), else the pending placeholder, with a warning."""
    if domain_name is not None:
        return f"https://{domain_name}"
    if value is not None:
        parts = urlsplit(value)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.username is not None
            or parts.path not in ("", "/")
            or parts.query
            or parts.fragment
        ):
            raise ConfigError("public_origin must be an https origin with no path, such as https://d111.cloudfront.net")
        return f"https://{parts.netloc}"
    warnings.warn(
        f"no public_origin yet, so links use {PENDING_ORIGIN}; deploy.sh passes the distribution's PublicUrl",
        ConfigWarning,
        stacklevel=3,
    )
    return PENDING_ORIGIN


def _web_dist(value: str | None) -> tuple[Path, bool]:
    """The web build to serve and whether it is the placeholder. A named build must exist; without
    one, `web/dist` when it has been built, else the placeholder, with a warning."""
    if value is not None:
        named = Path(value).resolve()
        if not (named / "index.html").is_file():
            raise ConfigError(f"web_dist {named} has no index.html: build the web app first")
        return named, False
    if (DEFAULT_WEB_DIST / "index.html").is_file():
        return DEFAULT_WEB_DIST, False
    warnings.warn(
        f"{DEFAULT_WEB_DIST} has no build, so the site is the labelled placeholder in {PLACEHOLDER_SITE}; "
        "deploy.sh builds the web app first",
        ConfigWarning,
        stacklevel=3,
    )
    return PLACEHOLDER_SITE, True
