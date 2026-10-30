"""Which `DESK_ENV` values name a development environment.

Only in one of these does anything fall back to a development default: the kernel's signer uses
its public dev key when `DESK_SIGNING_SEED` is missing, and `database_url()` reads a missing URL
from the repository's `.env`. Anywhere else, `production` and any misspelling of it included, both
refuse. Unset counts as `""`; a value matches after trimming ASCII whitespace, ignoring ASCII case.
The kernel's Rust signer holds the same list (`desk_kernel.DEVELOPMENT_ENVS`, compared by
tests/test_env.py). Since unset counts as development, a deploy must set `DESK_ENV=production`.
"""

import os

DEVELOPMENT_ENVS = frozenset({"", "dev", "development", "test", "ci", "local"})


def is_development(value: str | None = None) -> bool:
    """True when `value` (by default the process's `DESK_ENV`) names a development environment."""
    if value is None:
        value = os.environ.get("DESK_ENV", "")
    value = value.strip(" \t\n\f\r")   # the ASCII whitespace Rust's str::trim_ascii drops
    return value.isascii() and value.lower() in DEVELOPMENT_ENVS
